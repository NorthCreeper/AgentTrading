import {PaperBroker,feeFor,round,terminal} from '../../paper-broker.mjs';
import {amountQuote,orderSizeAllowed} from '../../amount-order.mjs';
import {researchBook} from '../../dashboard/p2-book.mjs';
import {managedCashflows,validManagedSettlement} from '../../dashboard/managed-position-accounting.mjs';
import {resolutionSource} from '../../dashboard/settlement.mjs';
import {isDeepStrictEqual} from 'node:util';

// Only offline counterfactuals. There is no authenticated transport or I/O.
export const executionPoliciesVersion='history-execution-policies-v1';
const finite=Number.isFinite,eps=1e-7,outcomes=['Up','Down'];
const freeze=x=>{Object.values(x).forEach(v=>{if(v&&typeof v==='object')freeze(v);});return Object.freeze(x);};
export const EXECUTION_CANDIDATES=freeze([
 {id:'p5-retry-once-new-source-v1',stage:'P5',maxRetries:1,retryWindowMs:3000,amountUsd:1,originalProtection:true},
 {id:'p5-reentry-max2-fresh30-v1',stage:'P5',maxOpensPerRound:2,confirmationMs:30000,maxSignalGapMs:3000,amountUsd:1},
 {id:'p6-protection-0tick-v1',stage:'P6',protectionTicks:0,requireFullDepth:true,amountUsd:1},
 {id:'p6-protection-1tick-v1',stage:'P6',protectionTicks:1,requireFullDepth:true,amountUsd:1},
 {id:'p6-protection-2tick-v1',stage:'P6',protectionTicks:2,requireFullDepth:true,amountUsd:1},
 {id:'p6-equal-share-pair-v1',stage:'P6',protectionTicks:0,costBufferPerShare:.005,maxExposure:10,
  legOrder:['Up','Down'],atomicBuy:false,mergeCredit:false,shareModeResearchOnly:true},
 {id:'p6-maker-evidence-only-v1',stage:'P6',verifiability:'unsupported-with-current-history',quoteTouchIsFill:false}
]);
export function executionPolicy(id){
 const p=EXECUTION_CANDIDATES.find(p=>p.id===id);if(!p)throw Error('Unknown finite execution candidate');return p;
}
export function validExecutionMarket(m){
 return Boolean(m&&/^btc-updown-5m-\d+$/.test(m.slug??'')&&finite(m.start)&&m.start===Number(m.slug.split('-').at(-1))*1000&&
 m.end===m.start+300000&&typeof m.conditionId==='string'&&m.conditionId&&typeof m.rules==='string'&&m.rules&&
 m.resolutionSource===resolutionSource&&outcomes.every(o=>typeof m.tokens?.[o]==='string'&&m.tokens[o])&&
 m.tokens.Up!==m.tokens.Down&&finite(m.tick)&&m.tick>0&&m.tick<1&&finite(m.minSize)&&m.minSize>0&&
 typeof m.negRisk==='boolean'&&finite(m.fee?.rate)&&m.fee.rate>=0&&finite(m.fee?.exponent)&&m.fee.exponent>=0);
}
const identity=m=>m&&Object.fromEntries(['slug','conditionId','start','end','tokens','rules','resolutionSource','tick','minSize','negRisk','fee'].map(k=>[k,m[k]]));
export const sameExecutionMarket=(a,b)=>isDeepStrictEqual(identity(a),identity(b));
const immutableIdentity=m=>m&&Object.fromEntries(['slug','conditionId','start','end','tokens','rules','resolutionSource','negRisk'].map(k=>[k,m[k]]));
export function executionBook(frame,market,outcome,now){
 if(!validExecutionMarket(market)||!outcomes.includes(outcome)||!finite(now)||!frame||frame.eventOnly===true||
  !sameExecutionMarket(frame.market,market)||!finite(frame.now)||frame.now>now||now-frame.now>3000||
  now<market.start||now>=market.end||!Array.isArray(frame.books))return null;
 const bs=frame.books.filter(b=>b?.tokenId===market.tokens[outcome]);if(bs.length!==1)return null;const b=bs[0];
 if(!finite(b.timestamp)||!finite(b.receivedAt)||b.timestamp>b.receivedAt||b.receivedAt>frame.now||
  !researchBook(b,market,outcome,now).bookObserved)return null;
 if([...b.bids,...b.asks].some(([p])=>Math.abs(p/market.tick-Math.round(p/market.tick))>1e-6))return null;
 return b;
}
const used=(sources,token,at)=>finite(sources?.[token])&&at<=sources[token];
const invalid=reason=>({allowed:false,executed:false,reason});
function protection(m,p){
 if(p.protectionTicks!==undefined){if(!Number.isInteger(p.protectionTicks)||p.protectionTicks<0||p.protectionTicks>2)throw Error('Unregistered protection');
  return p.protectionTicks*m.tick*100;}
 return p.slippageCents??2;
}
function requestLimitValid(limit,m){return finite(limit)&&limit>0&&limit<1&&
 Math.abs(limit/m.tick-Math.round(limit/m.tick))<1e-6;}
function simulate(book,market,request,now){
 const broker=new PaperBroker(),fills=[];broker.setBook(book);
 const baseFill=broker.fill.bind(broker);
 broker.fill=(order,size,price,fees)=>{fills.push({size,price,notional:round(size*price),fees,
  sourceAt:book.timestamp,receivedAt:book.receivedAt,executedAt:now});baseFill(order,size,price,fees);};
 const report=broker.submit(request,market,now);report.fills=fills;
 return {report,remainderBook:structuredClone(broker.books.get(book.tokenId))};
}
// Empty capital arguments are not accepted by execution. Quote is capital-free.
export function quoteAmountExecution({frame,market=frame?.market,outcome,now,policyId,policy,
 originalLimit,originalSize,consumedSources={}}){
 const p=policy??(policyId?executionPolicy(policyId):{slippageCents:2,requireFullDepth:true});
 const book=executionBook(frame,market,outcome,now);
 if(!book||!book.asks.length)return invalid('fresh-ask-unavailable');
 if(used(consumedSources,book.tokenId,book.timestamp))return invalid('source-already-consumed');
 let q;try{q=amountQuote(book,market,1,protection(market,p));}catch{return invalid('quote-invalid');}
 const limit=originalLimit??q.limit,size=originalSize??q.size;
 if(!requestLimitValid(limit,market)||!finite(size)||size<=0)return invalid('protection-or-size-invalid');
 const {report}=simulate(book,market,{tokenId:book.tokenId,side:'buy',size,price:limit,amountUsd:1,
  orderType:'FAK',postOnly:false},now);
 const complete=report.notional>=1-eps,allowed=report.filled>0&&(!p.requireFullDepth||complete);
 return {...q,allowed,complete,limit,size,filled:report.filled,notional:report.notional,fees:report.fees,
  total:round(report.notional+report.fees),expectedNotional:report.notional,expectedFees:report.fees,
  sourceAt:book.timestamp,receivedAt:book.receivedAt,reason:allowed?null:report.filled?'incomplete-depth':'no-crossing-depth',
  executionVersion:executionPoliciesVersion,policyId:p.id??'baseline-2c'};
}
export function executionReserve({market,side,size,limit,amountUsd}){
 if(side==='sell')return 0;
 return round((amountUsd??size*limit)+size*market.fee.rate*(.25**market.fee.exponent));
}
export function executeFAK({frame,market=frame?.market,outcome,side='buy',now,amountUsd,size,limit,
 consumedSources={},cash,inventoryCost,maxExposure=10,availableShares,orderId,minimumSourceAt,signalAt}){
 const book=executionBook(frame,market,outcome,now);if(!book)return invalid('fresh-book-unavailable');
 if(minimumSourceAt!==undefined&&(!finite(minimumSourceAt)||book.timestamp<=minimumSourceAt))return invalid('new-source-required');
 if(signalAt!==undefined&&(!finite(signalAt)||signalAt>now||now-signalAt>3000))return invalid('execution-window-expired');
 if(!['buy','sell'].includes(side)||!requestLimitValid(limit,market))return invalid('order-invalid');
 if(used(consumedSources,book.tokenId,book.timestamp))return invalid('source-already-consumed');
 if(side==='buy'&&amountUsd!==undefined&&amountUsd!==1)return invalid('fixed-one-dollar-required');
 if(side==='buy'&&amountUsd===1&&size===undefined){
  if(!book.asks.length)return invalid('fresh-ask-unavailable');size=Math.floor(1/book.asks[0][0]*1e8)/1e8;
 }
 const request={tokenId:book.tokenId,side,size,price:limit,orderType:'FAK',postOnly:false,
  ...(amountUsd===undefined?{}:{amountUsd})};
 if(!orderSizeAllowed({...request,mode:'taker',limit},market))return invalid('minimum-order-invalid');
 if(!finite(cash)||cash<0||!finite(inventoryCost)||inventoryCost<0||!finite(maxExposure)||maxExposure<=0)return invalid('capital-unknown');
 if(side==='sell'&&(!finite(availableShares)||size>availableShares+1e-8))return invalid('inventory-insufficient');
 const reserve=executionReserve({market,side,size,limit,amountUsd});
 if(side==='buy'&&(cash+eps<reserve||inventoryCost+reserve>maxExposure+eps))return invalid('capital-or-exposure-blocked');
 const x=simulate(book,market,request,now);
 x.report.id=orderId??['history-paper',market.slug,book.tokenId,side,book.timestamp,now].join(':');
 const cashDelta=round(side==='buy'?-x.report.notional-x.report.fees:x.report.notional-x.report.fees);
 return {allowed:true,executed:true,...x,cashDelta,fee:x.report.fees,reserve,
  nextConsumedSources:{...consumedSources,[book.tokenId]:book.timestamp},sourceAt:book.timestamp,
  reason:x.report.filled?'filled-or-partial':'zero-fill',counterfactual:true,verifiedLiveFill:false};
}
export function retryDecision({attempts,original,frame,market=frame?.market,now,consumedSources={}}){
 const r=original?.report;if(attempts!==1)return invalid('retry-limit');
 if(!r||!terminal(r.status)||!['cancelled','rejected'].includes(r.status)||r.side!=='buy'||r.orderType!=='FAK'||
  r.amountUsd!==1||r.filled!==0||r.notional!==0||r.fees!==0)return invalid('not-proven-zero-fill');
 if(!sameExecutionMarket(original.market,market)||r.tokenId!==market?.tokens?.[original.outcome]||
  !finite(original.signalAt)||!finite(r.createdAt)||original.signalAt>r.createdAt||r.createdAt>now||
  now-original.signalAt>3000||!finite(original.sourceAt)||original.sourceAt>r.createdAt)return invalid('retry-window-or-identity');
 const b=executionBook(frame,market,original.outcome,now);
 if(!b||b.timestamp<=original.sourceAt||used(consumedSources,b.tokenId,b.timestamp))return invalid('new-source-required');
 if(!requestLimitValid(r.price,market)||!finite(r.size)||r.size<=0)return invalid('original-order-invalid');
 return {allowed:true,reason:null,outcome:original.outcome,tokenId:r.tokenId,amountUsd:1,size:r.size,
  limit:r.price,originalSignalAt:original.signalAt,sourceAt:b.timestamp,retryNumber:1};
}
// signalHistory must consist of actual, newly observed eligible decisions. A
// stale cached boolean cannot provide either continuity or a second entry.
export function reentryDecision({opens,closedTrade,signalHistory,selected,market,now}){
 if(!Number.isInteger(opens)||opens!==1)return invalid('max-two-opens-per-round');
 const t=closedTrade,f=managedCashflows(t);
 if(!validExecutionMarket(market)||!validExecutionMarket(t?.market)||!isDeepStrictEqual(immutableIdentity(t.market),immutableIdentity(market))||t.slug!==market.slug||!finite(now)||now>=market.end||
  !finite(t.closedAt)||t.closedAt>now||t.closedAt>=market.end||t.remaining!==0||!f||f.remaining!==0||
  f.settlementSize!==0||!f.orderReports.every(r=>terminal(r.status)&&finite(r.createdAt)&&r.createdAt>=market.start&&r.createdAt<=t.closedAt)||
  t.closeMethod==='verified-paper-settlement')return invalid('full-market-exit-required');
 if(!selected?.eligible||!outcomes.includes(selected.outcome)||selected.tokenId!==market.tokens[selected.outcome])return invalid('current-signal-ineligible');
 const xs=Array.isArray(signalHistory)?signalHistory.filter(s=>finite(s.at)&&s.at>=t.closedAt):[];
 if(xs.length<2)return invalid('new-thirty-second-signal-required');
 for(let i=0;i<xs.length;i++){
  const s=xs[i],prior=xs[i-1];
  if(s.slug!==market.slug||s.outcome!==selected.outcome||s.eligible!==true||
   ![s.at,s.sourceAt,s.receivedAt,s.frameAt].every(finite)||s.sourceAt>s.receivedAt||s.receivedAt>s.frameAt||
   s.frameAt>s.at||s.at>now||s.at-s.sourceAt>3000||
   (prior&&(s.at<=prior.at||s.sourceAt<=prior.sourceAt||s.at-prior.at>3000)))return invalid('signal-continuity-unproven');
 }
 const first=xs[0],last=xs.at(-1);
 if(first.at<=t.closedAt||first.sourceAt<=t.closedAt||last.at-first.at<30000||now-last.at>3000)return invalid('new-thirty-second-signal-required');
 return {allowed:true,reason:null,outcome:selected.outcome,tokenId:selected.tokenId,amountUsd:1,openNumber:2,
  confirmationStart:first.at,confirmationEnd:last.at,observations:xs.length};
}
const ceil8=x=>Math.ceil(x*1e8-1e-8)/1e8;
export function quoteEqualSharePair({frame,market=frame?.market,now,cash,inventoryCost,consumedSources={}}){
 const policy=executionPolicy('p6-equal-share-pair-v1'),bs=outcomes.map(o=>executionBook(frame,market,o,now));
 if(bs.some(b=>!b?.asks?.length))return invalid('paired-fresh-asks-required');
 if(bs.some(b=>used(consumedSources,b.tokenId,b.timestamp)))return invalid('source-already-consumed');
 if(Math.abs(bs[0].timestamp-bs[1].timestamp)>1000)return invalid('paired-source-skew');
 const shares=ceil8(Math.max(...bs.map(b=>1/b.asks[0][0])));
 const legs=outcomes.map((outcome,i)=>{
  const book=bs[i],limit=book.asks[0][0],r=simulate(book,market,{tokenId:book.tokenId,side:'buy',size:shares,
   price:limit,orderType:'FAK',postOnly:false},now).report;
  return {outcome,tokenId:book.tokenId,size:shares,limit,sourceAt:book.timestamp,
   expectedFilled:r.filled,expectedNotional:r.notional,expectedFees:r.fees,complete:r.filled>=shares-1e-8};
 });
 if(legs.some(l=>!requestLimitValid(l.limit,market)||!l.complete||!orderSizeAllowed({mode:'taker',side:'buy',size:shares,limit:l.limit},market)))
  return invalid('full-equal-share-depth-or-minimum-required');
 const expectedCost=round(legs.reduce((s,l)=>s+l.expectedNotional+l.expectedFees,0));
 const reserve=round(legs.reduce((s,l)=>s+executionReserve({market,side:'buy',size:shares,limit:l.limit}),0));
 if(expectedCost/shares>1-policy.costBufferPerShare+1e-10)return invalid('no-after-fee-complete-set-edge');
 if(!finite(cash)||!finite(inventoryCost)||cash<0||inventoryCost<0||cash+eps<reserve||
  inventoryCost+reserve>policy.maxExposure+eps)return invalid('capital-or-exposure-blocked');
 return {allowed:true,reason:null,policyId:policy.id,market:structuredClone(market),signalAt:now,shares,legs,
  expectedCost,reserve,edgePerShare:round(1-expectedCost/shares),atomicBuy:false,mergeCredit:false,
  amountMode:false,shareModeResearchOnly:true};
}
// Different leg frames/times allow the replay runner to stress non-atomic
// execution. The second target is the first leg's actual shares; if too small
// for the second $1 floor, we keep the first inventory and stop.
export function executeEqualSharePair({plan,legFrames,legTimes,cash,inventoryCost,consumedSources={},orderPrefix='history-pair'}){
 if(!plan?.allowed||plan.policyId!=='p6-equal-share-pair-v1'||!Array.isArray(legFrames)||legFrames.length!==2||
  !Array.isArray(legTimes)||legTimes.length!==2||!legTimes.every(finite)||legTimes[0]<plan.signalAt||
  legTimes[1]<legTimes[0]||legTimes[1]-plan.signalAt>3000)return invalid('pair-plan-or-clock-invalid');
 if(!validExecutionMarket(plan.market)||!finite(plan.shares)||plan.shares<=0||!finite(plan.signalAt)||
  !finite(cash)||cash<0||!finite(inventoryCost)||inventoryCost<0||!Array.isArray(plan.legs)||plan.legs.length!==2||
  plan.legs.some((l,i)=>l.outcome!==outcomes[i]||l.tokenId!==plan.market.tokens[l.outcome]||
   !requestLimitValid(l.limit,plan.market)||!finite(l.sourceAt)||l.sourceAt>plan.signalAt))return invalid('pair-plan-or-capital-invalid');
 let sources={...consumedSources},cashNow=cash,locked=inventoryCost,target=plan.shares;
 const executions=[],holdings={Up:0,Down:0},costs={Up:0,Down:0};
 for(let i=0;i<2;i++){
  if(target<=0)break;const l=plan.legs[i];
  const x=executeFAK({frame:legFrames[i],market:plan.market,outcome:l.outcome,side:'buy',now:legTimes[i],
   size:target,limit:l.limit,cash:cashNow,inventoryCost:locked,consumedSources:sources,
   orderId:orderPrefix+':'+i,signalAt:plan.signalAt,
   ...(legTimes[i]>plan.signalAt?{minimumSourceAt:l.sourceAt}:{})});
  executions.push(x);if(!x.executed)break;sources=x.nextConsumedSources;
  cashNow=round(cashNow+x.cashDelta);costs[l.outcome]=round(-x.cashDelta);
  locked=round(locked+costs[l.outcome]);holdings[l.outcome]=x.report.filled;
  target=x.report.filled;
 }
 const mergeable=round(Math.min(holdings.Up,holdings.Down));
 return {allowed:true,executed:executions.some(x=>x.executed),executions,holdings,costs,
  cashDelta:round(cashNow-cash),cash:cashNow,inventoryCost:locked,nextConsumedSources:sources,
  mergeableShares:mergeable,residual:{Up:round(holdings.Up-mergeable),Down:round(holdings.Down-mergeable)},
  payoutRange:{lower:Math.min(holdings.Up,holdings.Down),upper:Math.max(holdings.Up,holdings.Down)},
  mergeCredited:0,atomicBuy:false,sameSnapshotCounterfactual:legTimes[0]===legTimes[1],
  financialNet:null,phase:'owned-unresolved',counterfactual:true};
}
// Labels alone never infer entry fills. They value only already-owned shares.
export function pairedFinancialValue({market,holdings,costs,label,now}){
 if(!validExecutionMarket(market)||!outcomes.every(o=>finite(holdings?.[o])&&holdings[o]>=0&&finite(costs?.[o])&&costs[o]>=0))
  return {known:false,net:null,reason:'inventory-or-cost-unknown'};
 const cost=round(costs.Up+costs.Down),range={lower:round(Math.min(holdings.Up,holdings.Down)-cost),
  upper:round(Math.max(holdings.Up,holdings.Down)-cost)};
 const financial=label?.version==='paper-official-payout-v1'&&label.scope==='paper-financial-only';
 const source=financial?'Gamma resolved + CLOB canonical payout; paper financial only; onchain redemption unconfirmed':
  'Gamma resolved + CLOB winner + eventMetadata cross-check';
 const valid=label?.source===source&&(label.rules===undefined||label.rules===market.rules)&&
  (label.resolutionSource===undefined||label.resolutionSource===market.resolutionSource)&&
  outcomes.every(outcome=>validManagedSettlement({market,slug:market.slug,outcome,tokenId:market.tokens[outcome]},label,now));
 if(!valid)return {known:false,net:null,netRange:range,reason:'verified-observed-label-required'};
 const payout=round(outcomes.reduce((s,o)=>s+holdings[o]*label.payouts[o],0));
 return {known:true,payout,net:round(payout-cost),netRange:{lower:round(payout-cost),upper:round(payout-cost)},
  labelObservedAt:label.observedAt,payoutAvailabilityWaitMs:label.observedAt-market.end,
  valuationDelayMs:now-label.observedAt,scope:financial?'paper-financial-only':'strict-research',
  onchainMergeConfirmed:false};
}
export function makerReplayCapability({tradeEvents=[],queueEvents=[]}={}){
 return {candidateId:'p6-maker-evidence-only-v1',supported:false,verifiedFill:false,
  tradeEvents:tradeEvents.length,queueEvents:queueEvents.length,
  reason:tradeEvents.length?'aggregate-trades-do-not-prove-own-queue-priority':'historical-public-aggressor-trades-and-own-queue-evidence-missing',
  quoteTouchIsFill:false,rebatesAssumed:0,profit:null};
}
