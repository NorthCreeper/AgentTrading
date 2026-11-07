// Deliberately no authenticated transport. This broker cannot place real orders.
import {oneTapAmountAllowed,oneTapFillSize,oneTapComplete,oneTapFeePrecision,oneTapExecutionVersion} from './one-tap-order.mjs';
export const terminal = status => ['filled', 'cancelled', 'rejected'].includes(status);
export const round = n => Math.round(n * 1e8) / 1e8;
export const feeFor = (size, price, fee, precision=8) => {
  const scale=10**precision;
  return Math.round(size * fee.rate * (price * (1 - price)) ** fee.exponent*scale)/scale;
};

export class PaperBroker {
  orders = new Map();
  books = new Map();
  sequence = 0;
  staleMs = 3000;
  setBook(book) { this.books.set(book.tokenId, structuredClone(book)); }
  getOrder(id) { return structuredClone(this.orders.get(id) ?? null); }

  submit(request, market, now) {
    const id = `paper-${++this.sequence}`;
    const order = { ...request, id, status: 'open', filled: 0, notional: 0, fees: 0, createdAt: now };
    this.orders.set(id, order);
    const oneTap=request.maxSpend!==undefined;
    if(oneTap){
      order.feePrecision=oneTapFeePrecision;order.marketFee=structuredClone(market.fee);order.executionVersion=oneTapExecutionVersion;order.fills=[];
      if(request.orderType!=='FAK'||request.postOnly||!oneTapAmountAllowed({...request,mode:'taker'},market)){
        order.status='rejected';return this.getOrder(id);
      }
    }
    const book = this.books.get(request.tokenId);
    if (!book || now - book.receivedAt > this.staleMs || now - book.timestamp > this.staleMs) {
      order.status = 'rejected';
      return this.getOrder(id);
    }
    const levels = request.side === 'buy' ? book.asks : book.bids;
    const crosses = p => request.side === 'buy' ? p <= request.price : p >= request.price;
    if (request.postOnly) {
      if (levels.length && crosses(levels[0][0])) order.status = 'rejected';
      const ownLevels = request.side === 'buy' ? book.bids : book.asks;
      order.queueAhead = ownLevels.filter(([p]) => p === request.price).reduce((sum, [, q]) => sum + q, 0);
      return this.getOrder(id);
    }
    if (!['FAK', 'FOK'].includes(request.orderType)) throw new Error('Paper taker must be FAK/FOK');
    const available = levels.filter(([p]) => crosses(p)).reduce((sum, [, q]) => sum + q, 0);
    const amountBuy = request.side === 'buy' && request.amountUsd !== undefined;
    if (amountBuy && !oneTap && (!Number.isInteger(request.amountUsd) || request.amountUsd < 1 || request.amountUsd > 1000 || request.orderType !== 'FAK')) {
      order.status = 'rejected'; return this.getOrder(id);
    }
    if (request.orderType === 'FOK' && available + 1e-8 < request.size) {
      order.status = 'cancelled';
      return this.getOrder(id);
    }
    for (const level of levels) {
      if (!crosses(level[0]) || order.filled >= request.size) break;
      const budgetSize = amountBuy ? Math.floor(Math.max(0, request.amountUsd - order.notional) / level[0] * 1e8) / 1e8 : Infinity;
      const quantity = oneTap?oneTapFillSize({wanted:Math.min(level[1],round(request.size-order.filled)),price:level[0],
        amountRemaining:round(request.amountUsd-order.notional),spendRemaining:round(request.maxSpend-order.notional-order.fees),fee:market.fee}):
        Math.min(level[1], round(request.size - order.filled), budgetSize);
      if (quantity <= 0) {if(oneTap)continue;break;}
      this.fill(order, quantity, level[0], feeFor(quantity, level[0], market.fee,oneTap?oneTapFeePrecision:8));
      level[1] = round(level[1] - quantity);
    }
    order.status = (oneTap?oneTapComplete(order):amountBuy ? order.notional >= request.amountUsd - 1e-7 : order.filled >= request.size) ? 'filled' : 'cancelled';
    return this.getOrder(id);
  }

  fill(order, size, price, fee) {
    const nextNotional=round(order.notional+size*price);
    // Record the actual cash increment. Independent per-level notional
    // rounding can differ by 1e-8 from the retained cumulative cash algorithm.
    if(order.maxSpend!==undefined)order.fills.push({size,price,notional:round(nextNotional-order.notional),fee,feePrecision:oneTapFeePrecision});
    order.filled = round(order.filled + size);
    order.notional = nextNotional;
    order.fees = round(order.fees + fee);
    if (order.filled >= order.size) order.status = 'filled';
  }

  // Only explicit replay trade events fill makers. A quote touching the limit does not.
  // Conservative same-price FIFO approximation; cancellations ahead do not improve queue position.
  trade({ tokenId, price, size, side, timestamp }) {
    let remaining = size;
    for (const order of this.orders.values()) {
      if (terminal(order.status) || !order.postOnly || order.tokenId !== tokenId ||
          timestamp <= order.createdAt || order.price !== price || order.side === side) continue;
      const ahead = Math.min(order.queueAhead, remaining);
      order.queueAhead = round(order.queueAhead - ahead);
      remaining = round(remaining - ahead);
      const filled = Math.min(remaining, round(order.size - order.filled));
      this.fill(order, filled, price, 0);
      remaining = round(remaining - filled);
    }
  }

  cancel(id) {
    const order = this.orders.get(id);
    if (!order) return false;
    if (!terminal(order.status)) order.status = 'cancelled';
    return true;
  }
}
