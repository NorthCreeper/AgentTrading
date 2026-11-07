import { terminal, round, feeFor } from './paper-broker.mjs';
import { orderSizeAllowed } from './amount-order.mjs';
import {oneTapAmountAllowed,oneTapComplete,oneTapFeePrecision} from './one-tap-order.mjs';

export const equityPerOrderRiskPolicy='equity-per-order-v1';
const aggregateRiskPolicy='aggregate-cost-v1';
const floorCents=value=>Math.floor(value*100+1e-8)/100;
function perOrderBudgetAllowed(intent,market,now,staleMs){
  const budget=intent.riskBudget;
  if(!budget||budget.policy!==equityPerOrderRiskPolicy||!oneTapAmountAllowed(intent,market)||
      ![budget.equity,budget.pct,budget.maxSpend,budget.at,now,staleMs].every(Number.isFinite)||
      budget.equity<=0||budget.minPct!==.025||budget.maxPct!==.10||budget.pct<.025||budget.pct>.10||
      staleMs<0||budget.at>now||now-budget.at>staleMs||budget.maxSpend!==intent.maxSpend)return false;
  const low=floorCents(budget.equity*.025),high=floorCents(budget.equity*.10),target=floorCents(budget.equity*budget.pct);
  return Number.isFinite(low)&&Number.isFinite(high)&&Number.isFinite(target)&&
    intent.maxSpend===target&&intent.maxSpend>=low&&intent.maxSpend<=high;
}

// Single serialized order lifecycle. A terminal order report is required before replacement.
// Journal snapshots are for audit/replay; this prototype never resumes an authenticated account.
export class Lifecycle {
  active = null;
  halted = null;
  holdings = new Map();
  inventoryCost = new Map();
  applied = new Map();
  usedIntents = new Set();
  cash = 0;
  externalFunds = 0;
  fees = 0;
  busy = false;
  constructor(broker, { journal = () => {}, maxExposure = 10, riskPolicy = aggregateRiskPolicy,
      maxLoss = 2, staleMs = 3000, beforeSubmit = null } = {}) {
    this.broker = broker;
    this.journal = journal;
    this.maxExposure = maxExposure;
    this.riskPolicy = riskPolicy;
    this.maxLoss = maxLoss;
    this.staleMs = staleMs;
    this.beforeSubmit = beforeSubmit;
  }
  snapshot() {
    return { active: this.active, halted: this.halted, holdings: Object.fromEntries(this.holdings),
      cash: this.cash, fees: this.fees, inventoryCost:Object.fromEntries(this.inventoryCost) };
  }
  emit(type, data) { this.journal({ type, ...structuredClone(data) }); }
  halt(reason) { this.halted = reason; this.emit('halt', { reason }); }
  fresh(book, now) {
    return book && now >= book.timestamp && now - book.timestamp <= this.staleMs &&
      now >= book.receivedAt && now - book.receivedAt <= this.staleMs;
  }
  perOrderRiskAllowed(intent,market,now){
    return this.maxExposure===null&&perOrderBudgetAllowed(intent,market,now,this.staleMs)&&
      Number.isFinite(this.cash)&&this.cash>=0&&this.cash+1e-8>=intent.maxSpend&&
      ![...this.holdings].some(([id,size])=>!Number.isFinite(size)||size<0||
        size>0&&(!Number.isFinite(this.inventoryCost.get(id))||this.inventoryCost.get(id)<0));
  }
  canEnter(market, now, intent = null) {
    if(intent?.entryPolicy==='ray-onetap-last-120s-v1')return intent.strategyManaged===true&&intent.side==='buy'&&
      intent.mode==='taker'&&typeof intent.rayEntryLotId==='string'&&intent.rayEntryLotId.length>0&&
      oneTapAmountAllowed(intent,market)&&now>=market.end-120_000&&now<market.end;
    if(intent?.entryPolicy==='ray-last-120s-v1' && intent.strategyManaged===true && intent.mode==='fok')
      return now >= market.end - 120_000 && now < market.end;
    return now >= market.start + 15_000 && now < market.end - 30_000;
  }

  async start(intent, market, now) {
    if (this.busy || this.active || this.halted) return false;
    if (this.usedIntents.has(intent.id)) return false;
    const book = this.broker.books.get(intent.tokenId);
    if (!Object.values(market.tokens).includes(intent.tokenId) || !this.fresh(book, now)) return false;
    if (now >= market.end || (intent.side === 'buy' && !this.canEnter(market, now, intent))) return false;
    if (!['buy', 'sell'].includes(intent.side) || !['maker', 'maker_then_taker', 'taker', 'fok'].includes(intent.mode)) return false;
    if (!orderSizeAllowed(intent, market) ||
        !Number.isFinite(intent.makerMs) || intent.makerMs < 0) return false;
    const amountBuy = intent.amountUsd !== undefined;
    const oneTap=intent.maxSpend!==undefined;
    if (amountBuy && !oneTap && (intent.side !== 'buy' || intent.mode !== 'taker' || !Number.isInteger(intent.amountUsd) ||
        intent.amountUsd < 1 || intent.amountUsd > 1000)) return false;
    for (const price of [intent.makerPrice, intent.limit]) {
      if (!Number.isFinite(price) || price <= 0 || price >= 1 ||
          Math.abs(price / market.tick - Math.round(price / market.tick)) > 1e-7) return false;
    }
    const held = this.holdings.get(intent.tokenId) ?? 0;
    if (intent.side === 'sell' && intent.size > held + 1e-8) return false;
    // Reserve worst-case settlement loss, including a conservative upper bound on fees.
    const pendingCost = oneTap?intent.maxSpend:(amountBuy ? intent.amountUsd : intent.size * Math.max(intent.makerPrice, intent.limit)) +
      intent.size * market.fee.rate * 0.25 ** market.fee.exponent;
    // When the cumulative-loss limit is disabled, realized losses/profits must
    // not silently become another entry limit or enlarge position capacity.
    const tradingCash=round(this.cash-this.externalFunds);
    // All unsold inventory, including expired positions awaiting payout, keeps
    // its acquisition cost in the funded account's exposure reservation.
    const funded=this.externalFunds>0;
    const inventoryExposure=[...this.holdings].reduce((s,[id,size])=>{
      const cost=this.inventoryCost.get(id);
      return s+(Number.isFinite(cost)&&cost>=0?cost:Number.isFinite(size)&&size>=0?size:Infinity);
    },0);
    const exposure=this.maxLoss===0||funded?inventoryExposure:Math.max(inventoryExposure,-tradingCash);
    if(intent.side==='buy'){
      const perOrder=this.riskPolicy===equityPerOrderRiskPolicy;
      // Null is an explicit absence of an aggregate cap only under this named
      // policy. It never disables the cash, cost provenance or per-order checks.
      if(perOrder){
        if(!this.perOrderRiskAllowed(intent,market,now))return false;
      }else if(this.riskPolicy!==aggregateRiskPolicy||!Number.isFinite(this.maxExposure)||this.maxExposure<=0||
          exposure+pendingCost>this.maxExposure)return false;
      if(!Number.isFinite(pendingCost)||pendingCost<0||
          (funded&&(!Number.isFinite(this.cash)||this.cash+1e-8<pendingCost))||
          (this.maxLoss>0&&this.holdings.size===0&&tradingCash<=-this.maxLoss))return false;
    }
    this.usedIntents.add(intent.id);
    this.active = { intent: structuredClone(intent), market: structuredClone(market),
      phase: intent.mode.startsWith('maker') ? 'maker' : 'taker', orderId: null,
      totalFilled: 0, deadline: now + intent.makerMs };
    this.busy = true;
    try { await this.submit(now); } finally { this.busy = false; }
    return true;
  }

  async submit(now) {
    const a = this.active;
    const maker = a.phase === 'maker';
    const request = { tokenId: a.intent.tokenId, side: a.intent.side,
      size: round(a.intent.size - a.totalFilled), price: maker ? a.intent.makerPrice : a.intent.limit,
      orderType: maker ? 'GTC' : a.intent.mode === 'fok' ? 'FOK' : 'FAK', postOnly: maker };
    if (a.intent.amountUsd !== undefined) request.amountUsd = a.intent.amountUsd;
    if(a.intent.maxSpend!==undefined)request.maxSpend=a.intent.maxSpend;
    if (this.beforeSubmit) {
      let allowed;
      try { allowed = await this.beforeSubmit({ intent:a.intent, market:a.market, phase:a.phase, request, now }); }
      catch (error) { this.halt(`Strategy check failed before submission: ${error.message}`); this.finish(now); return; }
      if (!allowed) {
        this.emit('strategy_veto', { now, intentId:a.intent.id, phase:a.phase, reason:'当前策略条件不再支持此订单' });
        this.finish(now); return;
      }
    }
    // Reconciliation of an older report remains independent of new-entry
    // policy. Any *new* buy submission, including a retained maker replacement,
    // must still satisfy the current explicit per-order contract after the veto.
    if(a.intent.side==='buy'&&this.riskPolicy===equityPerOrderRiskPolicy&&
        !this.perOrderRiskAllowed(a.intent,a.market,now)){
      this.emit('risk_veto',{now,intentId:a.intent.id,phase:a.phase,reason:'当前单笔净值预算或可用现金未通过复核'});
      this.finish(now);return;
    }
    this.emit('submit', { now, intentId: a.intent.id, request });
    try {
      const report = await this.broker.submit(request, a.market, now);
      if (!report?.id) throw new Error('Submission outcome unknown');
      a.orderId = report.id;
      a.request = request;
      this.reconcile(report);
      if (!maker && terminal(report.status) && !this.halted) this.finish(now);
    } catch (error) { this.halt(`Submission uncertain: ${error.message}. Reconcile before any retry.`); }
  }

  reconcile(report) {
    const a = this.active;
    if (!a || !report || report.id !== a.orderId || report.tokenId !== a.intent.tokenId ||
        report.side !== a.intent.side || report.size !== a.request.size ||
        !['open', 'filled', 'cancelled', 'rejected'].includes(report.status))
      throw new Error('Invalid order report');
    const old = this.applied.get(report.id) ?? { filled: 0, notional: 0, fees: 0 };
    for (const key of ['filled', 'notional', 'fees']) {
      if (!Number.isFinite(report[key]) || report[key] < old[key] - 1e-8) throw new Error('Invalid cumulative fill');
    }
    const delta = round(report.filled - old.filled);
    const cash = round(report.notional - old.notional), fees = round(report.fees - old.fees);
    const amountBuy = a.request.amountUsd !== undefined;
    const oneTap=a.request.maxSpend!==undefined;
    if (amountBuy && (report.amountUsd !== a.request.amountUsd || report.notional > a.request.amountUsd + 1e-8)) throw new Error('Fill exceeds USD budget');
    if(oneTap&&(report.maxSpend!==a.request.maxSpend||round(report.notional+report.fees)>a.request.maxSpend+1e-8))
      throw new Error('Fill exceeds all-in maxSpend budget');
    if(oneTap&&(report.feePrecision!==oneTapFeePrecision||report.marketFee?.rate!==a.market.fee.rate||
      report.marketFee?.exponent!==a.market.fee.exponent))throw new Error('One-Tap fee metadata mismatch');
    if(oneTap){
      const totals={filled:0,notional:0,fees:0};
      if(!Array.isArray(report.fills))throw new Error('One-Tap fill-level evidence missing');
      for(const fill of report.fills){
        const nextNotional=round(totals.notional+fill?.size*fill?.price),notionalDelta=round(nextNotional-totals.notional);
        if(![fill?.size,fill?.price,fill?.notional,fill?.fee].every(Number.isFinite)||fill.size<=0||
          fill.price<=0||fill.price>=1||fill.price>a.request.price+1e-8||fill.notional<0||fill.fee<0||
          fill.feePrecision!==oneTapFeePrecision||fill.notional!==notionalDelta||
          fill.fee!==feeFor(fill.size,fill.price,a.market.fee,oneTapFeePrecision))throw new Error('Invalid One-Tap fill-level evidence');
        totals.filled=round(totals.filled+fill.size);totals.notional=nextNotional;totals.fees=round(totals.fees+fill.fee);
      }
      if(['filled','notional','fees'].some(key=>Math.abs(totals[key]-report[key])>1e-8))throw new Error('One-Tap fill-level totals mismatch');
    }
    if (report.filled > report.size + 1e-8 || (report.status === 'filled' && (oneTap?!oneTapComplete(report):amountBuy ? report.notional < a.request.amountUsd - 1e-7 : report.filled !== report.size)) ||
        (oneTap&&report.status==='cancelled'&&oneTapComplete(report))||
        (delta === 0 && (cash !== 0 || fees !== 0))) throw new Error('Inconsistent fill totals');
    if (delta > 0 && (cash <= 0 || cash > delta + 1e-8 ||
        (report.side === 'buy' && cash > delta * a.request.price + 1e-8) ||
        (report.side === 'sell' && cash < delta * a.request.price - 1e-8))) throw new Error('Fill violates limit price');
    const held = this.holdings.get(report.tokenId) ?? 0;
    if (report.side === 'sell' && delta > held + 1e-8) throw new Error('Sell fill exceeds inventory');
    const remaining = round(held + (report.side === 'buy' ? delta : -delta));
    const cost=this.inventoryCost.get(report.tokenId)??held;
    if(remaining>0)this.inventoryCost.set(report.tokenId,round(report.side==='buy'?cost+cash+fees:cost*remaining/held));
    else this.inventoryCost.delete(report.tokenId);
    if (remaining > 0) this.holdings.set(report.tokenId, remaining);
    else this.holdings.delete(report.tokenId);
    this.cash = round(this.cash + (report.side === 'buy' ? -cash : cash) - fees);
    this.fees = round(this.fees + fees);
    a.totalFilled = round(a.totalFilled + delta);
    this.applied.set(report.id, { filled: report.filled, notional: report.notional, fees: report.fees });
    this.emit('report', { report, deltaFilled: delta, state: this.snapshot() });
  }

  async cancelAndConfirm(now) {
    const a = this.active;
    this.emit('cancel', { now, orderId: a.orderId });
    // An acknowledgement alone is insufficient. Always read the final cumulative fill.
    await this.broker.cancel(a.orderId);
    const report = await this.broker.getOrder(a.orderId);
    this.reconcile(report);
    if (!terminal(report.status)) throw new Error('Cancellation unconfirmed; replacement blocked');
    return report;
  }

  async tick(now, { stop = false } = {}) {
    if (!this.active || this.busy || this.halted) return;
    this.busy = true;
    try {
      const a = this.active;
      let report = await this.broker.getOrder(a.orderId);
      this.reconcile(report);
      const fresh = this.fresh(this.broker.books.get(a.intent.tokenId), now);
      const allowed = !stop && fresh && now < a.market.end &&
        (a.intent.side === 'sell' || this.canEnter(a.market, now, a.intent));
      if (!allowed || now >= a.deadline || terminal(report.status)) {
        if (!terminal(report.status)) report = await this.cancelAndConfirm(now);
        const left = round(a.intent.size - a.totalFilled);
        if (allowed && a.phase === 'maker' && a.intent.mode === 'maker_then_taker' &&
            now >= a.deadline && orderSizeAllowed({...a.intent, mode:'taker', size:left}, a.market)) {
          a.phase = 'taker';
          await this.submit(now);
        } else this.finish(now);
      }
    } catch (error) { this.halt(error.message); }
    finally { this.busy = false; }
  }

  finish(now) {
    this.emit('complete', { now, intentId: this.active.intent.id, filled: this.active.totalFilled });
    this.active = null;
  }
}
