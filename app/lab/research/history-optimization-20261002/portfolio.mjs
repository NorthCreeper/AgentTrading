// Independent historical/prospective research fork of frozen v1.5 portfolio. No production imports are modified.
import {PaperBroker,round} from '../../paper-broker.mjs';
import {amountQuote} from '../../amount-order.mjs';
import {evaluateForward,forwardProtocol} from '../../dashboard/forward-strategy.mjs';
import {marketInformationExit} from '../../dashboard/market-exit.mjs';
import {executableBidExit} from '../../dashboard/bid-exit.mjs';
import {consensusExit} from '../../dashboard/consensus-exit.mjs';
import {researchBook} from '../../dashboard/p2-book.mjs';
import {referenceStatus} from '../../dashboard/reference-price.mjs';
import {managedCashflows,validManagedSettlement} from '../../dashboard/managed-position-accounting.mjs';
import {resolutionSource} from '../../dashboard/settlement.mjs';
import {isDeepStrictEqual} from 'node:util';
import {quoteAmountExecution,retryDecision,reentryDecision} from './execution-policies.mjs';

export const evolutionPortfolioVersion='full-history-research-account-v1';
export const evolutionConfig=Object.freeze({buyUnits:1,staleMs:3000,maxExposure:10});
export const evolutionStrategy=Object.freeze({execution:'paper',model:'forward-momentum',exitPolicy:'market',
 minNetEdge:.005,costBuffer:.005,maxSpread:.04,stopLossUsd:0});
const finite=Number.isFinite,clone=structuredClone,close=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<1e-7;
const observedCache=new WeakMap(),readyCache=new WeakMap(),attemptCache=new WeakMap();
function attempted(a,slug){let c=attemptCache.get(a);if(!c||c.length!==a.attemptedRounds.length){c={length:a.attemptedRounds.length,set:new Set(a.attemptedRounds)};attemptCache.set(a,c);}return c.set.has(slug);}
function observed(book,market,outcome,now){
 const cached=observedCache.get(book);if(cached?.now===now)return cached.value;
 const value=researchBook(book,market,outcome,now).bookObserved;observedCache.set(book,{now,value});return value;
}
export const evolutionDay=at=>new Date(at+28800000).toISOString().slice(0,10);

export function validEvolutionMarket(m){return Boolean(m&&/^btc-updown-5m-\d+$/.test(m.slug??'')&&
 Number(m.slug.split('-').at(-1))*1000===m.start&&finite(m.start)&&m.end===m.start+300000&&
 typeof m.conditionId==='string'&&m.conditionId&&typeof m.rules==='string'&&m.rules&&m.resolutionSource===resolutionSource&&
 ['Up','Down'].every(o=>typeof m.tokens?.[o]==='string'&&m.tokens[o])&&m.tokens.Up!==m.tokens.Down&&
 finite(m.tick)&&m.tick>0&&m.tick<1&&finite(m.fee?.rate)&&m.fee.rate>=0&&finite(m.fee?.exponent)&&m.fee.exponent>=0);}
function marketIdentity(m){return m?{slug:m.slug,conditionId:m.conditionId,tokens:m.tokens,start:m.start,end:m.end,rules:m.rules,
 resolutionSource:m.resolutionSource,negRisk:m.negRisk}:null;}
const sameMarket=(a,b)=>isDeepStrictEqual(marketIdentity(a),marketIdentity(b));
const executionMarket=(saved,frame)=>({...saved,tick:frame.market.tick,minSize:frame.market.minSize,fee:frame.market.fee});

// Enforce three clocks before a quote may affect capital or signal confirmation.
// Source timestamp must precede receipt, then frame capture, then observation.
export function evolutionBook(frame,market,outcome,now){
 if(!frame||!validEvolutionMarket(market)||!sameMarket(frame.market,market)||!finite(frame.now)||frame.now>now||
  now-frame.now>3000||!Array.isArray(frame.books))return null;
 const matches=frame.books.filter(b=>b.tokenId===market.tokens[outcome]);if(matches.length!==1)return null;
 const b=matches[0];
 if(!finite(b.timestamp)||!finite(b.receivedAt)||b.timestamp>b.receivedAt||b.receivedAt>frame.now||
  !observed(b,market,outcome,now))return null;
 return b;
}
export function evolutionFrameReady(input){
 if(input.eventOnly===true)return false;
 const {frame,now}=input;if(!validEvolutionMarket(frame?.market)||!finite(now)||now<frame.market.start||now>=frame.market.end)return false;
 const cached=readyCache.get(frame);if(cached?.now===now)return cached.value;
 const books=['Up','Down'].map(o=>evolutionBook(frame,frame.market,o,now));
 const p=frame.twap;
 const value=Boolean(books.every(b=>b&&b.bids.length&&b.asks.length)&&
  referenceStatus(p,now).ready&&p.timestamp<=p.receivedAt&&p.receivedAt<=frame.now);
 readyCache.set(frame,{now,value});return value;
}
// Exit evidence is independent of entry TWAP availability and the other side's
// asks. The bid rule itself decides whether the owned inventory is sellable.
export function evolutionExitFrame(input){
 if(input.eventOnly===true)return null;
 const {frame,now}=input;if(!frame||!validEvolutionMarket(frame.market)||!finite(now))return null;
 const books=['Up','Down'].map(o=>evolutionBook(frame,frame.market,o,now)).filter(Boolean);
 return books.length?{...frame,books}:null;
}
export function evolutionCandidate(input){
 if(!evolutionFrameReady(input))return null;
 return evaluateForward({...input,config:{...input.config,...evolutionConfig},strategy:{...evolutionStrategy}}).selected;
}
export function newEvolutionPortfolio(policy,executionDelayMs,{id=`${policy}-${executionDelayMs}`,protectionTicks=null,retry=false,reentry=false}={}){
 if(!['market','bid','consensus','settlement'].includes(policy)||![0,1000,2000].includes(executionDelayMs))throw Error('Invalid evolution account arm');
 if(protectionTicks!==null&&![0,1,2].includes(protectionTicks))throw Error('Unregistered protection');
 return {version:evolutionPortfolioVersion,id,policy,executionDelayMs,protectionTicks,retry,reentry,roundState:{},signalHistory:[],retryState:null,tradeSequence:0,initialCapital:100,cash:100,fees:0,realized:0,
 completed:0,wins:0,peak:0,maxRealizedDrawdown:0,position:null,pendingSettlements:[],pendingBuy:null,
 attemptedRounds:[],lastConsumedSources:{},executionSequence:0,lastAt:null,closedTrades:[],daily:{},
 dispositions:{},counts:{unfilled:0,capitalBlockedSignals:0,busySignals:0,pausedPendingBuys:0},settlementIntents:[]};
}
const owned=a=>[a.position,...a.pendingSettlements].filter(Boolean);
export function evolutionLockedCost(a){return round(owned(a).reduce((s,t)=>s+managedCashflows(t).costPerShare*t.remaining,0));}
export function validEvolutionLabel(label,t,now){
 const financial=label?.version==='paper-official-payout-v1'&&label.scope==='paper-financial-only';
 const knownSource=financial?'Gamma resolved + CLOB canonical payout; paper financial only; onchain redemption unconfirmed':
  'Gamma resolved + CLOB winner + eventMetadata cross-check';
 return Boolean(validEvolutionMarket(t?.market)&&label?.source===knownSource&&
  (label.rules===undefined||label.rules===t.market.rules)&&
  (label.resolutionSource===undefined||label.resolutionSource===t.market.resolutionSource)&&
  validManagedSettlement(t,label,now));
}
export function validateEvolutionPortfolio(a){
 if(a?.version!==evolutionPortfolioVersion||!['market','bid','consensus','settlement'].includes(a.policy)||![0,1000,2000].includes(a.executionDelayMs)||
  a.initialCapital!==100||!finite(a.cash)||a.cash< -1e-7||!Array.isArray(a.pendingSettlements)||!Array.isArray(a.closedTrades)||
  !Array.isArray(a.attemptedRounds)||new Set(a.attemptedRounds).size!==a.attemptedRounds.length||
  !Array.isArray(a.settlementIntents)||new Set(a.settlementIntents).size!==a.settlementIntents.length)throw Error('Invalid evolution account checkpoint');
 const all=[...a.closedTrades,...owned(a)],ids=new Set(),reportIds=new Set();let cash=100,fees=0,net=0,wins=0;
 for(const t of all){
  if(ids.has(t.id)||!validEvolutionMarket(t.market)||t.slug!==t.market.slug||t.tokenId!==t.market.tokens[t.outcome]||
   !finite(t.openedAt)||t.openedAt<t.market.start||t.openedAt>=t.market.end||
   !finite(t.lastAt)||t.lastAt<t.openedAt||t.lastAt>a.lastAt||
   !['tradableMs','waitMs','unobservedGapMs'].every(k=>finite(t.timing?.[k])&&t.timing[k]>=0))throw Error('Invalid owned evolution position');ids.add(t.id);
  const f=managedCashflows(t);if(!f||!close(f.remaining,t.remaining)||!close(f.buyCost,t.cost)||!close(f.costPerShare,t.costPerShare))throw Error('Position cashflows differ from checkpoint');
  for(const r of f.orderReports){if(reportIds.has(r.id)||!finite(r.createdAt)||r.createdAt<t.market.start||r.createdAt>=t.market.end)
    throw Error('Invalid or multiply claimed order report');reportIds.add(r.id);}
  cash=round(cash+f.sellNet+f.settlementPayout-f.buyCost);fees=round(fees+f.fees);
  if(t.closedAt!==undefined&&t.closedAt!==null){
   if(t.remaining!==0||!close(f.net,t.net)||!close(f.fees,t.fees)||!finite(t.closedAt)||t.closedAt<t.openedAt)throw Error('Invalid evolution terminal position');
   net=round(net+t.net);wins+=Number(t.net>0);
  }
  if(t.settlement){const p=t.settlement;
   if(!a.settlementIntents.includes(p.id)||p.id!==`paper-settlement:${a.id}:${t.id}`||
    !validEvolutionLabel(p.label,t,p.creditedAt)||p.observedAt!==p.label.observedAt||
    p.winner!==p.label.winner||!close(p.payout,p.size*p.label.payouts[t.outcome]))throw Error('Invalid saved official settlement');}
 }
 if(!close(cash,a.cash)||!close(fees,a.fees)||!close(net,a.realized)||a.completed!==a.closedTrades.length||a.wins!==wins)
  throw Error('Evolution account cash/fee/completed aggregates disagree');
 if(a.pendingSettlements.some(t=>t.market.end>a.lastAt)||a.pendingBuy&&owned(a).some(t=>t.slug===a.pendingBuy.slug))throw Error('Invalid evolution ownership phase');
 if(owned(a).some(t=>!(t.remaining>0)||t.closedAt!==undefined&&t.closedAt!==null))throw Error('Closed or empty position remains owned');
 if(a.pendingBuy){const p=a.pendingBuy;
  if(!validEvolutionMarket(p.market)||p.slug!==p.market.slug||p.tokenId!==p.market.tokens[p.outcome]||
   !finite(p.signalAt)||p.signalAt<p.market.start||p.signalAt>=p.market.end||p.executeAt!==p.signalAt+a.executionDelayMs||
   !finite(p.sourceAt)||p.sourceAt>p.signalAt||!finite(p.limit)||p.limit<=0||p.limit>=1||
   !a.attemptedRounds.includes(p.slug))throw Error('Invalid pending evolution entry');}
 return true;
}
function disposition(a,slug,status){a.dispositions[slug]=status;}
function recordReport(a,t,r){
 t.orderReports[r.id]=clone(r);const f=managedCashflows(t);if(!f)throw Error('Invalid own fill accounting');
 t.remaining=f.remaining;t.fees=f.fees;t.cost=f.buyCost;t.costPerShare=f.costPerShare;
 return f;
}
function execute(a,t,book,side,size,limit,market,now){
 const broker=new PaperBroker();broker.setBook(book);
 const report=broker.submit({tokenId:book.tokenId,side,size,price:limit,orderType:'FAK',postOnly:false,
  ...(side==='buy'?{amountUsd:1}:{})},market,now);
 report.id=`${a.id}:paper:${++a.executionSequence}`;
 report.executionFee={...market.fee};report.executionTick=market.tick;
 a.lastConsumedSources[book.tokenId]=book.timestamp;
 if(side==='buy'){a.cash=round(a.cash-report.notional-report.fees);a.fees=round(a.fees+report.fees);}
 else {a.cash=round(a.cash+report.notional-report.fees);a.fees=round(a.fees+report.fees);}
 if(t)recordReport(a,t,report);
 return report;
}
function finish(a,t,now,events){
 const f=managedCashflows(t);if(!f||f.remaining!==0)throw Error('Cannot close unexplained inventory');
 t.closedAt=now;t.closedDay=evolutionDay(now);t.openedDay=evolutionDay(t.openedAt);t.net=f.net;t.fees=f.fees;
 t.closeMethod=t.settlement?'verified-paper-settlement':'book-sale';t.bought=f.bought;t.sold=f.sold;
 delete t.pendingExit;delete t.marketReversal;delete t.bidReversal;
 a.realized=round(a.realized+t.net);a.completed++;a.wins+=Number(t.net>0);a.peak=Math.max(a.peak,a.realized);
 a.maxRealizedDrawdown=Math.max(a.maxRealizedDrawdown,a.peak-a.realized);
 a.closedTrades.push(clone(t));if(a.position?.id===t.id)a.position=null;
 a.pendingSettlements=a.pendingSettlements.filter(p=>p.id!==t.id);disposition(a,t.slug,'closed');
 events.push({kind:'closed',at:now,...clone(t)});
}
function settle(a,labels,now,events){
 for(const t of owned(a)){
  const l=labels?.get(t.slug);if(!validEvolutionLabel(l,t,now))continue;
  const id=`paper-settlement:${a.id}:${t.id}`;if(a.settlementIntents.includes(id))continue;
  const size=t.remaining,payout=round(size*l.payouts[t.outcome]);
  a.cash=round(a.cash+payout);a.settlementIntents.push(id);
  t.settlement={id,size,payout,winner:l.winner,observedAt:l.observedAt,creditedAt:now,
   verificationVersion:l.version,verificationSource:l.source,scope:'paper-financial-only',label:clone(l)};
  t.remaining=0;events.push({kind:'settled',at:now,tradeId:t.id,slug:t.slug,size,payout,winner:l.winner,observedAt:l.observedAt});finish(a,t,now,events);
 }
}
function pendingEntry(a,input,allowEntry,events){
 const p=a.pendingBuy;if(!p)return;const {frame,now}=input;
 const cancel=reason=>{a.pendingBuy=null;a.counts.unfilled++;disposition(a,p.slug,reason);events.push({kind:'entry-cancelled',at:now,slug:p.slug,reason,signalAt:p.signalAt});};
 if(!allowEntry){a.counts.pausedPendingBuys++;cancel('paused-before-execution');return;}
 if(now>=p.market.end||now>p.executeAt+3000||p.retryDeadline&&now>p.retryDeadline){cancel('execution-window-expired');return;}
 if(!frame){return;}
 if(!sameMarket(frame.market,p.market)){cancel('round-or-identity-changed');return;}
 if(now<p.executeAt||!evolutionFrameReady(input))return;
 const b=evolutionBook(frame,p.market,p.outcome,now);
 if(!b||a.executionDelayMs>0&&b.timestamp<=p.sourceAt||b.timestamp<=(a.lastConsumedSources[b.tokenId]??-Infinity))return;
 const m=executionMarket(p.market,frame);
 if(Math.abs(p.limit/m.tick-Math.round(p.limit/m.tick))>1e-6){cancel('original-limit-incompatible-with-current-tick');return;}
 const size=p.originalSize??Math.floor(1/b.asks[0][0]*1e8)/1e8;
 const reserve=1+size*m.fee.rate*.25**m.fee.exponent;
 if(!finite(reserve)||reserve>a.cash+1e-8||reserve+evolutionLockedCost(a)>10+1e-8){a.counts.capitalBlockedSignals++;cancel('capital-budget');return;}
 if(finite(p.entryDecision?.probability)){
  const preview=new PaperBroker();preview.setBook(b);
  const x=preview.submit({tokenId:b.tokenId,side:'buy',size,price:p.limit,amountUsd:1,orderType:'FAK',postOnly:false},m,now);
  if(x.filled&&x.filled*p.entryDecision.probability-x.notional-x.fees<=1e-8){cancel('value-expired');return;}
 }
 const r=execute(a,null,b,'buy',size,p.limit,m,now);r.executionFee={...m.fee};r.executionTick=m.tick;a.pendingBuy=null;
 events.push({kind:'entry-attempt',at:now,slug:p.slug,signalAt:p.signalAt,sourceAt:b.timestamp,receivedAt:b.receivedAt,
  frameAt:frame.now,limit:p.limit,amountUsd:1,report:clone(r)});
 if(!r.filled){a.counts.unfilled++;disposition(a,p.slug,'unfilled');
  if(a.retry&&!p.retryNumber)a.retryState={market:clone(p.market),outcome:p.outcome,signalAt:p.signalAt,sourceAt:b.timestamp,report:clone(r),id:p.id,entryDecision:p.entryDecision};
  return;}
 a.retryState=null;
 const cost=round(r.notional+r.fees),t={id:p.id,slug:p.slug,market:clone(p.market),tokenId:p.tokenId,outcome:p.outcome,
  signalAt:p.signalAt,openedAt:now,openedDay:evolutionDay(now),remaining:r.filled,size:r.filled,cost,costPerShare:cost/r.filled,fees:r.fees,
  orderReports:{[r.id]:clone(r)},entryDecision:p.entryDecision,timing:{tradableMs:0,waitMs:0,unobservedGapMs:0},lastAt:now};
 a.roundState[p.slug]??={opens:0,attempts:0};a.roundState[p.slug].opens++;a.position=t;disposition(a,p.slug,'active');events.push({kind:'opened',at:now,...clone(t)});
}
function manageExit(a,input,events,exitSignal){
 const t=a.position;if(!t)return;const {frame,now}=input;
 if(now>=t.market.end){
  delete t.pendingExit;delete t.marketReversal;delete t.bidReversal;t.parkedAt=now;
  a.pendingSettlements.push(t);a.position=null;disposition(a,t.slug,'awaiting-resolution');
  events.push({kind:'queued',at:now,tradeId:t.id,slug:t.slug,remaining:t.remaining,cost:round(t.costPerShare*t.remaining)});return;
 }
 // Payment/stop events carry no new quote. They may advance expiry and own
 // payouts, but cannot interrupt or extend a genuine confirmation sequence.
 // The next observed frame still applies the original market/bid gap rules.
 if(input.eventOnly===true)return;
 const b=evolutionBook(frame,t.market,t.outcome,now);
 if(!b){delete t.marketReversal;delete t.bidReversal;t.holdingDecision={time:now,status:'data-unavailable'};return;}
 const m=executionMarket(t.market,frame);
 if(t.pendingExit){
  const p=t.pendingExit;
  if(now>p.executeAt+3000){delete t.pendingExit;t.nextExitAt=now+2000;events.push({kind:'exit-cancelled',at:now,tradeId:t.id,slug:t.slug,reason:'execution-window-expired'});}
  else if(now>=p.executeAt&&(a.executionDelayMs===0||b.timestamp>p.sourceAt)&&b.timestamp>(a.lastConsumedSources[b.tokenId]??-Infinity)){
   if(Math.abs(p.limit/m.tick-Math.round(p.limit/m.tick))>1e-6){delete t.pendingExit;t.nextExitAt=now+2000;return;}
   const r=execute(a,t,b,'sell',t.remaining,p.limit,m,now);delete t.pendingExit;t.nextExitAt=now+2000;
   events.push({kind:'sale-attempt',at:now,tradeId:t.id,slug:t.slug,signalAt:p.signalAt,sourceAt:b.timestamp,receivedAt:b.receivedAt,
    frameAt:frame.now,limit:p.limit,report:clone(r),remaining:t.remaining});
   if(t.remaining===0){finish(a,t,now,events);return;}
  }
 }
 if(t.pendingExit||now<(t.nextExitAt??0))return;
 const fn=exitSignal??(a.policy==='consensus'?consensusExit:a.policy==='bid'?((t,held,b,m,now,c,h,p,bh)=>executableBidExit(t,held,b,m,now,c,bh)):a.policy==='settlement'?(()=>null):marketInformationExit);
 // The bid rule's diagnostic net expects the current inventory's acquisition
 // cost. Keep total acquisition cost immutable for own cashflow accounting.
 const signalTrade=['bid','consensus'].includes(a.policy)&&!exitSignal?{...t,cost:round(t.remaining*t.costPerShare)}:t;
 const args=[signalTrade,t.remaining,b,m,now,evolutionConfig,input.history??[],input.prices??[]];
 const exit=['bid','consensus'].includes(a.policy)||exitSignal?fn(...args,input.bidHistory??[]):fn(...args);
 if(signalTrade!==t)for(const key of ['marketReversal','bidReversal','holdingDecision','bidDecision','consensusDecision','maxFavorableNet','maxAdverseNet']){
  if(Object.hasOwn(signalTrade,key))t[key]=signalTrade[key];else delete t[key];}
 if(exit&&finite(exit.limit)&&exit.limit>0&&exit.limit<1){
  t.pendingExit={signalAt:now,executeAt:now+a.executionDelayMs,limit:exit.limit,sourceAt:b.timestamp,reason:exit.reason};
  events.push({kind:'exit-signal',at:now,tradeId:t.id,slug:t.slug,limit:exit.limit,reason:exit.reason,netAtSignal:exit.net??null});
  if(a.executionDelayMs===0&&b.timestamp>(a.lastConsumedSources[b.tokenId]??-Infinity)){
   const p=t.pendingExit,r=execute(a,t,b,'sell',t.remaining,p.limit,m,now);delete t.pendingExit;t.nextExitAt=now+2000;
   events.push({kind:'sale-attempt',at:now,tradeId:t.id,slug:t.slug,signalAt:now,sourceAt:b.timestamp,receivedAt:b.receivedAt,
    frameAt:frame.now,limit:p.limit,report:clone(r),remaining:t.remaining});
   if(t.remaining===0)finish(a,t,now,events);
  }
 }
}
// Each arm owns its own broker reports, capital and expired inventory. No main-account reference exists.
export function stepEvolutionPortfolio(a,input,labels,selected=null,allowEntry=true,exitSignal=null){
 const {now}=input;if(!finite(now)||a.lastAt!==null&&(now<a.lastAt||now===a.lastAt&&!input.afterEventAtSameTime))return [];
 const events=[];
 for(const t of owned(a)){
  const elapsed=now-t.lastAt;
  t.timing.tradableMs+=Math.max(0,Math.min(now,t.market.end)-Math.min(t.lastAt,t.market.end));
  t.timing.waitMs+=Math.max(0,now-Math.max(t.lastAt,t.market.end));
  if(elapsed>3000)t.timing.unobservedGapMs+=Math.max(0,Math.min(now,t.market.end)-Math.min(t.lastAt,t.market.end));t.lastAt=now;
 }
 a.lastAt=now;settle(a,labels,now,events);manageExit(a,input,events,exitSignal);
 const current=input.frame?.market;
 if(input.eventOnly!==true){
  const sb=selected&&current?evolutionBook(input.frame,current,selected.outcome,now):null;
  if(selected?.eligible&&sb){
   const prev=a.signalHistory.at(-1);
   if(!prev||prev.slug!==current.slug||prev.outcome!==selected.outcome||now-prev.at>3000)a.signalHistory=[];
   if(!a.signalHistory.length||sb.timestamp>a.signalHistory.at(-1).sourceAt)a.signalHistory.push({at:now,slug:current.slug,outcome:selected.outcome,eligible:true,sourceAt:sb.timestamp,receivedAt:sb.receivedAt,frameAt:input.frame.now});
  }else a.signalHistory=[];
  a.signalHistory=a.signalHistory.filter(s=>s.at>=now-40000);
 }
 if(a.retryState){
  const original=a.retryState;
  if(now-original.signalAt>3000||!allowEntry||current&&current.slug!==original.market.slug)a.retryState=null;
  else if(selected?.eligible&&selected.outcome===original.outcome&&evolutionFrameReady(input)){
   const r=retryDecision({attempts:1,original,frame:input.frame,now,consumedSources:a.lastConsumedSources});
   if(r.allowed&&!a.position&&!a.pendingBuy){
    a.pendingBuy={id:original.id,slug:original.market.slug,market:clone(original.market),tokenId:r.tokenId,outcome:r.outcome,
     signalAt:now,executeAt:now+a.executionDelayMs,sourceAt:input.frame.books.find(b=>b.tokenId===r.tokenId).timestamp,limit:r.limit,
     originalSize:r.size,retryDeadline:original.signalAt+3000,entryDecision:clone(selected),retryNumber:1};
    a.retryState=null;events.push({kind:'retry-signal',at:now,slug:original.market.slug,originalSignalAt:original.signalAt,limit:r.limit});
   }
  }
 }
 pendingEntry(a,input,allowEntry,events);
 if(!allowEntry||!selected||!evolutionFrameReady(input))return events;
 const m=input.frame.market;
 const state=a.roundState[m.slug]??={opens:0,attempts:0};
 if(attempted(a,m.slug)){
  const closed=a.closedTrades.findLast(t=>t.slug===m.slug);
  if(!a.reentry||state.attempts>=2||!reentryDecision({opens:state.opens,closedTrade:closed,signalHistory:a.signalHistory,selected,market:m,now}).allowed)return events;
 }
 if(a.position||a.pendingBuy){a.counts.busySignals++;disposition(a,m.slug,'busy');return events;}
 if(!selected.eligible||selected.version!==forwardProtocol.version||selected.amountUsd!==1||!['Up','Down'].includes(selected.outcome)||
  selected.tokenId!==m.tokens[selected.outcome])return events;
 const b=evolutionBook(input.frame,m,selected.outcome,now);let q;
 try{q=a.protectionTicks===null?amountQuote(b,m,1):quoteAmountExecution({frame:input.frame,market:m,outcome:selected.outcome,now,policy:{protectionTicks:a.protectionTicks,requireFullDepth:true}});}catch{return events;}
 if(!q.allowed||!q.complete||!close(q.limit,selected.limit))return events;
 const reserve=1+q.size*m.fee.rate*.25**m.fee.exponent;
 if(reserve>a.cash+1e-8||reserve+evolutionLockedCost(a)>10+1e-8){a.counts.capitalBlockedSignals++;disposition(a,m.slug,'capital-budget');return events;}
 if(b.timestamp<=(a.lastConsumedSources[b.tokenId]??-Infinity))return events;
 if(!attempted(a,m.slug))a.attemptedRounds.push(m.slug);state.attempts++;
 a.pendingBuy={id:`${a.id}:${m.slug}:${++a.tradeSequence}`,slug:m.slug,market:clone(m),tokenId:selected.tokenId,
  outcome:selected.outcome,signalAt:now,executeAt:now+a.executionDelayMs,sourceAt:b.timestamp,limit:q.limit,entryDecision:clone(selected)};
 disposition(a,m.slug,'execution-pending');events.push({kind:'entry-signal',at:now,slug:m.slug,limit:q.limit,sourceAt:b.timestamp});
 pendingEntry(a,input,allowEntry,events);return events;
}
export function evolutionDailySummary(a){
 const active=owned(a);
 const daily={};
 for(const t of [...a.closedTrades,...active]){
  const d=daily[t.openedDay]??={opened:0,completed:0,wins:0,net:0,fees:0,unresolved:0,unresolvedCost:0,maxUnresolvedPayout:0,slugs:[]};
  d.opened++;d.fees=round(d.fees+t.fees);d.slugs.push(t.slug);
  if(t.closedAt!==undefined&&t.closedAt!==null){d.completed++;d.wins+=Number(t.net>0);d.net=round(d.net+t.net);}
  else {d.unresolved++;d.unresolvedCost=round(d.unresolvedCost+t.remaining*t.costPerShare);d.maxUnresolvedPayout=round(d.maxUnresolvedPayout+t.remaining);}
 }
 return daily;
}
export function evolutionPortfolioSummary(a,now){
 const active=owned(a),lockedCost=evolutionLockedCost(a),maxPayout=round(active.reduce((s,t)=>s+t.remaining,0)),daily=evolutionDailySummary(a);
 return {id:a.id,policy:a.policy,executionDelayMs:a.executionDelayMs,initialCapital:a.initialCapital,cash:a.cash,realized:a.realized,
  realizedPnl:a.realized,fees:a.fees,completed:a.completed,wins:a.wins,winRate:a.completed?a.wins/a.completed:null,
  maxRealizedDrawdown:a.maxRealizedDrawdown,lockedCost,maximumPendingPayout:maxPayout,
  payoutRange:{lower:a.cash,upper:round(a.cash+maxPayout),known:active.length===0},
  accountNetRange:{lower:round(a.cash-100),upper:round(a.cash+maxPayout-100)},
  active:clone(a.position),position:clone(a.position),pendingSettlements:clone(a.pendingSettlements),pendingBuy:clone(a.pendingBuy),
  pendingCount:a.pendingSettlements.length,closedTrades:clone(a.closedTrades),daily,dispositions:clone(a.dispositions),counts:clone(a.counts),
  lastAt:a.lastAt,now,independentSamples:false};
}
