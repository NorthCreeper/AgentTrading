import { feeFor, round } from './paper-broker.mjs';
import {oneTapAmountAllowed} from './one-tap-order.mjs';

// Version execution assumptions independently of the strategy signal.
export const amountExecutionVersion = 'amount-market-v2';

// Polymarket web validation: share minimum for resting limits, $1 for
// market BUY, available inventory for market SELL. Paper quantities use 8 dp.
export function orderSizeAllowed(intent, market) {
  if(intent.maxSpend!==undefined)return oneTapAmountAllowed(intent,market);
  if (!Number.isFinite(intent.size) || intent.size < 1e-8) return false;
  if (intent.mode?.startsWith('maker')) return intent.amountUsd === undefined && intent.size >= market.minSize;
  if (!['taker', 'fok'].includes(intent.mode)) return false;
  if (intent.side === 'sell') return intent.amountUsd === undefined;
  if (intent.side !== 'buy') return false;
  if (intent.amountUsd !== undefined) return intent.mode === 'taker' &&
    Number.isInteger(intent.amountUsd) && intent.amountUsd >= 1 && intent.amountUsd <= 1000;
  return Number.isFinite(intent.limit) && intent.size * intent.limit >= 1 - 1e-8;
}

export function amountQuote(book, market, amountUsd, slippageCents = 2) {
  if (!Number.isInteger(amountUsd) || amountUsd < 1 || amountUsd > 1000) throw Error('买入预算须为 1–1000 份，每份 $1');
  if (!Number.isFinite(slippageCents) || slippageCents < 0 || slippageCents > 10) throw Error('价格保护范围无效');
  if (!book?.asks?.length || !Number.isFinite(market.tick) || market.tick <= 0) throw Error('没有可用卖盘');
  const best = book.asks[0][0];
  const limit = round(Math.min(1 - market.tick, Math.floor((best + slippageCents / 100 + 1e-10) / market.tick) * market.tick));
  const size = Math.floor(amountUsd / best * 1e8) / 1e8;
  let notional = 0, fees = 0, filled = 0;
  for (const [price, available] of book.asks) {
    if (price > limit) break;
    const quantity = Math.min(available, Math.floor(Math.max(0, amountUsd - notional) / price * 1e8) / 1e8);
    if (quantity <= 0) break;
    filled = round(filled + quantity); notional = round(notional + price * quantity);
    fees = round(fees + feeFor(quantity, price, market.fee));
  }
  const allowed = filled > 0;
  return { amountUsd, size, filled, notional, fees, total: round(notional + fees), limit, best,
    average: filled ? notional / filled : null, complete: notional >= amountUsd - 1e-7,
    executionVersion: amountExecutionVersion, minimumUsd: 1, allowed,
    reason: allowed ? null : '价格保护范围内没有可成交卖盘' };
}
