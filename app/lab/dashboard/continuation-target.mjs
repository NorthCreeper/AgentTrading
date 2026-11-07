// Independent quoted-depth counterfactuals for inventory actually owned at a decision.
// No broker, controller, probability model, or live account is accepted here.
import {researchBook} from './p2-book.mjs';
import {depthQuote} from './strategy.mjs';
import {round} from '../paper-broker.mjs';

export const continuationProtocol=Object.freeze({
  version:'p3-owned-continuation-v1',delayMs:30000,decisionWindowMs:3000,
  executionLatencyMs:1000,executionWindowMs:3000,staleMs:3000,protection:.02,
  quotedDepthCounterfactual:true,actualExecutionVerified:false,
  changesTradingRules:false,acquisitionCostRole:'sunk-cost-excluded',previousSaleProceedsRole:'excluded',
});
const finite=Number.isFinite,clone=x=>structuredClone(x);
const residualShares=(size,sold)=>sold===0?size:Math.max(0,round(size-sold));
const validFee=f=>Boolean(f&&finite(f.rate)&&f.rate>=0&&finite(f.exponent)&&f.exponent>=0);
const validIdentity=m=>Boolean(m&&typeof m.slug==='string'&&m.slug&&typeof m.conditionId==='string'&&m.conditionId&&
  finite(m.start)&&finite(m.end)&&m.end-m.start===300000&&
  ['Up','Down'].every(o=>typeof m.tokens?.[o]==='string'&&m.tokens[o])&&m.tokens.Up!==m.tokens.Down);
const validMarket=m=>Boolean(validIdentity(m)&&finite(m.tick)&&m.tick>0&&m.tick<1&&validFee(m.fee));
function sameMarket(a,b){return Boolean(a&&b&&a.slug===b.slug&&a.conditionId===b.conditionId&&a.start===b.start&&a.end===b.end&&
  ['Up','Down'].every(o=>a.tokens?.[o]===b.tokens?.[o]));}
export function continuationObservation(frame,market,outcome,now){
  const raw=Array.isArray(frame?.books)?frame.books.find(b=>b.tokenId===market.tokens[outcome])??null:null;
  const clocks=Boolean(frame&&finite(frame.now)&&frame.now<=now&&now-frame.now<=continuationProtocol.staleMs&&raw&&
    [raw.timestamp,raw.receivedAt].every(t=>finite(t)&&t<=now&&now-t<=continuationProtocol.staleMs)&&
    raw.timestamp<=raw.receivedAt&&raw.receivedAt<=frame.now);
  // Only the received bid side determines liquidation readiness. Retain original
  // asks below for audit; never invent liquidity or require an ask to sell.
  const p=researchBook(raw?{...raw,asks:[]}:null,market,outcome,now);
  const observed=Boolean(sameMarket(frame?.market,market)&&validMarket(frame?.market)&&clocks&&p.bookObserved&&
    p.bidDepthCoverage==='full-received-book');
  return {observed,status:!sameMarket(frame?.market,market)?'identity-mismatch':!clocks?'stale-missing-or-future-clock':
    !validMarket(frame?.market)?'invalid-market-metadata':!p.bookObserved?'invalid-bid-depth':p.bids.length?'bid-observed':'empty-bid-observed',
    frameAt:frame?.now??null,sourceAt:raw?.timestamp??null,receivedAt:raw?.receivedAt??null,
    bidDepthCoverage:observed?'full-received-book':'unavailable',rawBook:raw?clone(raw):null,
    bids:observed?clone(p.bids):[],bid:observed?(p.bid??null):null,fee:frame?.market?.fee?clone(frame.market.fee):null,
    decisionMarketTick:observed?frame.market.tick:null,
    decisionMarketWitness:observed?{version:'continuation-decision-market-witness-v1',observedAt:now,
      frameAt:frame.now,sourceAt:raw.timestamp,receivedAt:raw.receivedAt,
      market:{slug:frame.market.slug,conditionId:frame.market.conditionId,start:frame.market.start,end:frame.market.end,
        tokens:clone(frame.market.tokens),tick:frame.market.tick,rules:frame.market.rules,resolutionSource:frame.market.resolutionSource}}:null};
}
const arm=name=>({name,status:name==='settlement'?'hold-to-settlement':'pending',signal:null,execution:null,statusObservedAt:null});
function setStatus(a,status,at,reason=null){a.status=status;a.statusObservedAt=at;if(reason)a.reason=reason;}
function decide(a,o,market,size,now){
  a.decisionObservation=clone(o);
  if(!o.bids.length){setStatus(a,'no-bid-at-decision',now);return;}
  const limit=round(Math.max(market.tick,o.bid-continuationProtocol.protection));
  a.signal={at:now,sourceAt:o.sourceAt,receivedAt:o.receivedAt,frameAt:o.frameAt,limit,
    decisionMarketTick:market.tick,
    executionDueAt:now+continuationProtocol.executionLatencyMs,
    executionDeadline:now+continuationProtocol.executionLatencyMs+continuationProtocol.executionWindowMs};
  a.decisionQuote=depthQuote({bids:o.bids},'sell',size,market,limit);
  if(a.signal.executionDueAt>=market.end)setStatus(a,'expired-hold-to-settlement',now,'execution-due-at-or-after-expiry');
}
export function createContinuationTarget({id,trade,size,frame,now,contextId=null,features=null,reasons=[]}){
  if(typeof id!=='string'||!id||!trade||typeof trade.id!=='string'||!trade.id||!validIdentity(trade.market)||
    !sameMarket(trade.market,frame?.market)||!validMarket(frame?.market)||!['Up','Down'].includes(trade.outcome)||
    trade.slug!==trade.market.slug||trade.tokenId!==trade.market.tokens[trade.outcome]||
    !finite(size)||size<=0||!finite(now)||!finite(trade.openedAt)||trade.openedAt<trade.market.start||trade.openedAt>now||
    now<trade.market.start||now>=trade.market.end||
    !Array.isArray(reasons)||reasons.some(r=>typeof r!=='string'))throw Error('Invalid owned continuation anchor or market identity');
  const market=clone(frame.market),o=continuationObservation(frame,market,trade.outcome,now);
  const immediate=arm('immediate'),delay=arm('delay30');
  immediate.decisionDueAt=now;immediate.decisionDeadline=now;
  delay.decisionDueAt=now+continuationProtocol.delayMs;
  delay.decisionDeadline=delay.decisionDueAt+continuationProtocol.decisionWindowMs;
  if(o.observed)decide(immediate,o,market,size,now);
  else setStatus(immediate,'missing-decision',now,o.status);
  if(delay.decisionDueAt>=market.end)setStatus(delay,'expired-hold-to-settlement',now,'delay-target-at-or-after-expiry');
  return {version:continuationProtocol.version,id,at:now,lastAt:now,frameAt:frame.now,tradeId:trade.id,origin:trade.origin??'automatic',
    slug:market.slug,market,outcome:trade.outcome,tokenId:trade.tokenId,size,
    contextId,features:features===null?null:clone(features),reasons:[...new Set(reasons)],
    openedAt:trade.openedAt,decision:trade.holdingDecision?clone(trade.holdingDecision):null,
    parameters:trade.parameters?clone(trade.parameters):null,anchorObservation:o,
    quotedDepthCounterfactual:true,actualExecutionVerified:false,
    acquisitionCostRole:continuationProtocol.acquisitionCostRole,
    previousSaleProceedsRole:continuationProtocol.previousSaleProceedsRole,
    arms:[immediate,delay,arm('settlement')]};
}
export function advanceContinuationTarget(t,{frame,now}){
  if(!finite(now)||now<=t.lastAt||now<t.at)return;
  t.lastAt=now;
  const same=sameMarket(frame?.market,t.market),o=same?continuationObservation(frame,t.market,t.outcome,now):null;
  for(const a of t.arms){
    if(a.name==='settlement'||a.status!=='pending')continue;
    if(!a.signal){
      if(now>a.decisionDeadline){setStatus(a,'missing-decision',now,'decision-window-missed');continue;}
      if(now>=t.market.end){setStatus(a,'missing-decision',now,'pre-expiry-decision-not-observed');continue;}
      if(now<a.decisionDueAt||!o?.observed)continue;
      decide(a,o,frame.market,t.size,now);
    }
    if(a.status!=='pending'||!a.signal)continue;
    if(now>a.signal.executionDeadline){setStatus(a,'missing-quote',now,'execution-window-missed');continue;}
    if(now>=t.market.end){setStatus(a,'missing-quote',now,'pre-expiry-execution-not-observed');continue;}
    if(now<a.signal.executionDueAt||!o?.observed||o.sourceAt<=a.signal.sourceAt)continue;
    const q=depthQuote({bids:o.bids},'sell',t.size,frame.market,a.signal.limit);
    a.execution={at:now,sourceAt:o.sourceAt,receivedAt:o.receivedAt,frameAt:o.frameAt,limit:a.signal.limit,
      bid:o.bid,filled:q.filled,observedFilled:q.filled,notional:q.notional,fees:q.fees,
      netProceeds:round(q.notional-q.fees),remaining:residualShares(t.size,q.filled),fee:clone(frame.market.fee),
      bidDepthCoverage:o.bidDepthCoverage,rawBook:clone(o.rawBook),quotedDepthCounterfactual:true,actualExecutionVerified:false};
    setStatus(a,q.complete&&q.filled>0?'filled':q.filled?'partial':o.bids.length?'protection-unfilled':'no-bid-at-execution',now);
  }
}
function validLabel(t,l,cutoff){return Boolean(l&&finite(l.observedAt)&&l.observedAt>=t.market.end&&l.observedAt<=cutoff&&
  l.slug===t.slug&&sameMarket(l,t.market)&&['Up','Down'].every(o=>[0,1].includes(l.payouts?.[o]))&&
  l.payouts.Up+l.payouts.Down===1&&['Up','Down'].includes(l.winner)&&l.payouts.Up===Number(l.winner==='Up'));}
export function finishContinuationTarget(target,label,cutoff){
  if(!finite(cutoff)||cutoff<target.at)throw Error('Invalid continuation cutoff');
  const t=clone(target),verified=validLabel(t,label,cutoff);
  t.cutoff=cutoff;t.labelObservedAt=verified?label.observedAt:null;t.payout=verified?label.payouts[t.outcome]:null;
  for(const a of t.arms){
    // Retrospective cutoffs cannot use a future decision, failure or fill.
    if(a.signal?.at>cutoff){a.signal=null;delete a.decisionObservation;delete a.decisionQuote;a.status='pending';a.statusObservedAt=null;delete a.reason;}
    if(a.execution?.at>cutoff){a.execution=null;a.status='pending';a.statusObservedAt=null;delete a.reason;}
    if(a.statusObservedAt>cutoff){a.status='pending';a.statusObservedAt=null;delete a.reason;
      if(!a.signal){delete a.decisionObservation;delete a.decisionQuote;}}
    if(a.name!=='settlement'&&a.status==='pending'){
      if(!a.signal&&(cutoff>a.decisionDeadline||cutoff>=t.market.end))setStatus(a,'missing-decision',cutoff,'decision-window-not-observed');
      else if(a.signal&&(cutoff>a.signal.executionDeadline||cutoff>=t.market.end))setStatus(a,'missing-quote',cutoff,'execution-window-not-observed');
    }
    const unknown=['missing-decision','missing-quote'].includes(a.status);
    if(unknown){Object.assign(a,{complete:false,terminalValue:null,perShareValue:null,knownAt:null,remaining:null,
      remainingBeforeSettlement:null,cashFromSale:null,settlementProceeds:null,valueBounds:null,
      inventoryShareSeconds:null,tradingHoldingMs:null,settlementWaitMs:null,settlementWaitShareSeconds:null,
      occupiedMs:null,reason:a.reason??a.status});continue;}
    const e=a.execution,sold=e?.filled??0,residual=residualShares(t.size,sold),cash=e?.netProceeds??0;
    const actionPending=a.name!=='settlement'&&a.status==='pending';
    // Even a verified winner cannot fill in a still-pending/missing sale observation.
    const complete=!actionPending&&(residual===0||verified),knownAt=complete?(residual===0?e.at:label.observedAt):null;
    const until=knownAt??cutoff,settlementProceeds=!actionPending&&verified?round(residual*t.payout):0;
    const value=complete?round(cash+settlementProceeds):null;
    Object.assign(a,{complete,terminalValue:value,perShareValue:value===null?null:round(value/t.size),knownAt,
      remaining:complete?0:residual,remainingBeforeSettlement:residual,cashFromSale:cash,settlementProceeds,
      valueBounds:complete?null:[cash,round(cash+residual)],
      inventoryShareSeconds:round((sold*((e?.at??t.at)-t.at)+residual*(until-t.at))/1000),
      tradingHoldingMs:Math.max(0,Math.min(until,t.market.end)-t.at),
      settlementWaitMs:Math.max(0,until-t.market.end),
      settlementWaitShareSeconds:round(residual*Math.max(0,until-t.market.end)/1000),occupiedMs:until-t.at,
      reason:complete?null:actionPending?'awaiting-execution-observation':'awaiting-verified-settlement'});
  }
  const immediate=t.arms.find(a=>a.name==='immediate');
  t.pairs=t.arms.filter(a=>a.name!=='immediate').map(a=>({policy:a.name,complete:immediate.complete&&a.complete,
    perShareDifference:immediate.complete&&a.complete?round((a.terminalValue-immediate.terminalValue)/t.size):null,
    targetKnownAt:immediate.complete&&a.complete?Math.max(immediate.knownAt,a.knownAt):null}));
  return t;
}
