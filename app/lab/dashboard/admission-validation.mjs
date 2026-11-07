import {createHash} from 'node:crypto';
import {evaluateRay} from './ray-strategy.mjs';
import {validRayOpeningEvidence} from './ray-opening.mjs';
import {freshBook} from './strategy.mjs';
import {e18ToPrice} from './chart-model.mjs';
import {computeRayAmountSize} from './ray-onetap-sizing.mjs';
import {oneTapFillSize} from '../one-tap-order.mjs';
import {feeFor,round} from '../paper-broker.mjs';
import {validManagedSettlement} from './managed-position-accounting.mjs';
import {pairedAdmissionComparison} from './admission-comparison.mjs';

export const validationProtocol=Object.freeze({version:'admission-paired-opportunity-v1',scope:'shadow-only',adopted:false,
 arms:['baseline','tail','tail-quote','tail-quote-flow'],referenceEquity:1000,allocation:.025,
 quoteLookbackMs:10000,quoteToleranceMs:3000,flowWindowSeconds:10,featureMaxAgeMs:3000,
 delaysMs:[0,1000,2000,4000],depthFractions:[1,.5],arrivalToleranceMs:2000,
 maximumPendingRounds:128,maximumCompletedRounds:256,minimumIndependentDates:3,
 semantics:'One first qualifying request per arm per observed market; fixed $1000 reference equity, no compounding or account return; delayed FAK keeps original amount, shares and limit; no retries; no actual orders.'});
export const validationProtocolHash=createHash('sha256').update(JSON.stringify(validationProtocol)).digest('hex');
const finite=Number.isFinite,copy=structuredClone;
const ny=t=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(t);
const logit=p=>Math.log(p/(1-p));
const identity=m=>JSON.stringify([m.slug,m.conditionId,m.tokens,m.start,m.end]);
const sourceKey=b=>JSON.stringify([b?.tokenId,b?.timestamp,b?.bids,b?.asks]);
const freshPair=(f,t)=>['Up','Down'].every(o=>{const b=f.books?.find(b=>b.tokenId===f.market.tokens[o]);return freshBook(b,t,3000)&&b.asks?.length&&b.bids?.length&&b.asks[0][0]>b.bids[0][0];});

// Pure execution diagnostic: never receives a broker, wallet or account mutator.
export function frozenRequestFill(request,book,market,depthFraction=1){
 let filled=0,notional=0,fees=0;
 for(const [price,quantity] of book.asks){
  if(price>request.limit)break;
  const q=oneTapFillSize({wanted:Math.min(quantity*depthFraction,request.size-filled),price,
   amountRemaining:request.amountUsd-notional,spendRemaining:request.maxSpend-notional-fees,fee:market.fee});
  if(q<=0)continue;filled=round(filled+q);notional=round(notional+q*price);fees=round(fees+feeFor(q,price,market.fee,5));
 }
 return {filled,notional,fees,total:round(notional+fees),average:filled?notional/filled:null,
  status:filled>0?'hypothetical-fill':'zero-fill',depthFraction};
}

export class AdmissionValidation {
 constructor({clock=Date.now,write=()=>true,saved=null}={}){
  this.clock=clock;this.write=write;this.rounds=new Map();this.completed=[];this.history=[];this.last=null;this.error=null;
  this.startedAt=clock();this.lastObservedAt=null;this.lastRecordedAt=null;this.lastLabelAt=null;
  this.counts={observations:0,rounds:0,completed:0,writeFailures:0,evictedPending:0,labelConflicts:0,restarts:0,gaps:0};
  this.totals=Object.fromEntries(validationProtocol.arms.map(a=>[a,{signals:0,labeled:0,wins:0,losses:0,scenarios:{}}]));
  if(saved?.protocolHash===validationProtocolHash){
   this.startedAt=saved.startedAt;this.counts={...this.counts,...saved.counts,restarts:(saved.counts?.restarts??0)+1};
   this.totals=copy(saved.totals);this.completed=copy(saved.completed??[]).slice(-validationProtocol.maximumCompletedRounds);
   for(const r of (saved.rounds??[]).slice(-validationProtocol.maximumPendingRounds)){
    r.coverage.gaps++;this.rounds.set(r.market.slug,copy(r));
   }
  }
  this.emit({kind:'admission-validation-start',time:clock(),startedAt:this.startedAt,protocol:validationProtocol,
   continuity:'quote lookback resets on restart; pending predictions retain original information times'});
 }
 emit(row){try{if(this.write({...row,protocolHash:validationProtocolHash,adopted:false,scope:'shadow-only'})===false){this.counts.writeFailures++;this.error='validation-recording-rejected';return false;}this.lastRecordedAt=this.clock();return true;}
  catch(e){this.counts.writeFailures++;this.error=e.message;return false;}}
 gap(reason,now=this.clock()){
  this.history=[];this.counts.gaps++;
  for(const r of this.rounds.values())if(now>=r.market.start&&now<=r.market.end)r.coverage.gaps++;
  this.emit({kind:'admission-validation-gap',time:now,reason});
 }
 features(frame,now,outcome,flow){
  const b=frame.books.find(b=>b.tokenId===frame.market.tokens[outcome]),key=sourceKey(b);
  const mid=(b.bids[0][0]+b.asks[0][0])/2;
  const prior=this.history.findLast(p=>p.slug===frame.market.slug&&p.outcome===outcome&&p.at<=b.timestamp-10000&&b.timestamp-p.at<=13000);
  const delta=prior&&prior.mid>0&&prior.mid<1&&mid>0&&mid<1?logit(mid)-logit(prior.mid):null;
  if(!this.history.some(p=>p.key===key))this.history.push({slug:frame.market.slug,outcome,at:b.timestamp,knownAt:now,mid,key});
  this.history=this.history.filter(p=>p.slug===frame.market.slug&&p.at>=now-20000).slice(-512);
  const w=flow?.windows?.['10'];
  const validFlow=flow?.clockReady===true&&finite(flow.time)&&flow.time<=now&&now-flow.time<=3000&&
   w?.status==='observed'&&finite(w.windowEnd)&&w.windowEnd<=now&&now-w.windowEnd<=3000&&finite(w.netUsdt);
  return {quoteLogit10s:delta,quoteKnown:finite(delta),quoteSupports:finite(delta)?delta>0:null,
   midpoint:mid,quoteSourceAt:b.timestamp,quoteKnownAt:b.receivedAt,
   signedNetUsdt10s:validFlow?(outcome==='Up'?1:-1)*w.netUsdt:null,
   flowKnown:validFlow,flowSupports:validFlow?(outcome==='Up'?1:-1)*w.netUsdt>0:null,
   flowTime:validFlow?flow.time:null,flowScope:'Binance BTCUSDT aggregate taker flow; no participant identity'};
 }
 observe(frame,{now=this.clock(),terminal=null,flow=null,reference=frame?.twap,actual=null}={}){
  const m=frame?.market;
  if(!m||!finite(now)||!finite(m.start)||m.end!==m.start+300000||m.slug!==`btc-updown-5m-${m.start/1000}`||!m.tokens?.Up||!m.tokens?.Down||!m.conditionId)return null;
  if(this.lastObservedAt!==null&&now<this.lastObservedAt){this.gap('observation-time-regression',now);return null;}
  this.lastObservedAt=now;this.counts.observations++;
  if(this.completed.some(r=>r.slug===m.slug))return null;
  let r=this.rounds.get(m.slug);
  if(!r&&(now<m.start||now>=m.end))return null;
  if(r&&identity(r.market)!==identity(m)){this.error='same-slug-validation-market-conflict';return null;}
  if(!r){r={market:copy(m),dateNy:ny(now),firstAt:now,lastAt:now,opening:null,coverage:{firstLateAt:null,lastLateAt:null,maxGapMs:0,gaps:0,observations:0},
   reasons:{},arms:{},unknownEvaluations:{},actualEligibleObserved:false,comparisons:[],lastRecordAt:null,lastKey:null};this.rounds.set(m.slug,r);this.counts.rounds++;}
  const remaining=m.end-now;
  if(remaining<=120000&&remaining>0){const c=r.coverage;c.maxGapMs=Math.max(c.maxGapMs,c.lastLateAt===null?Math.max(0,now-(m.end-120000)):now-c.lastLateAt);c.firstLateAt??=now;c.lastLateAt=now;c.observations++;}
  r.lastAt=now;r.actualEligibleObserved||=actual?.eligible===true;
  const f={...frame,twap:reference};
  if(validRayOpeningEvidence(frame.rayOpening,m,now))r.opening=copy(frame.rayOpening);
  // Progress frozen requests before making new signals; features never use a later book.
  for(const signal of Object.values(r.arms))this.arrivals(r,signal,f,now);
  let reason='outside-last-120-seconds',common=false,outcome=null,features=null,baseline=null,quote=null;
  if(remaining>0&&remaining<=120000){
   const value=e18ToPrice(reference?.valueE18),o=frame.rayOpening;
   if(frame.clock?.ready!==true)reason='utc-clock-unknown';
   else if(!validRayOpeningEvidence(o,m,now))reason='opening-unknown';
   else if(!finite(value)||reference?.windowSeconds!==60||![reference.timestamp,reference.receivedAt].every(t=>finite(t)&&t<=now&&now-t<=5000))reason='twap-unknown';
   else if(!freshPair(f,now))reason='book-unknown';
   else if(value===o.value)reason='zero-deviation';
   else{
    r.opening=copy(o);outcome=value>o.value?'Up':'Down';features=this.features(f,now,outcome,flow);
    baseline=evaluateRay({frame:f,now,equity:validationProtocol.referenceEquity,roundUsedShares:0,config:{staleMs:3000,size:100}});
    const b=f.books.find(b=>b.tokenId===m.tokens[outcome]),other=f.books.find(b=>b.tokenId===m.tokens[outcome==='Up'?'Down':'Up']);
    if(b.asks[0][0]<.8||b.asks[0][0]>.85||other.asks[0][0]>.2)reason='price-screen-rejected';
    else if(!finite(m.tick)||m.tick<=0||Math.abs(b.asks[0][0]/m.tick-Math.round(b.asks[0][0]/m.tick))>1e-7)reason='tick-unknown';
    else{
     try{const sizing=computeRayAmountSize({equity:validationProtocol.referenceEquity,book:b,market:m,maxShares:100,roundUsedShares:0,limitCap:.85});
      if(sizing.ok){quote=sizing.quote;common=true;reason='common-executable-screen';}else reason=sizing.reasonCode;
     }catch{reason='execution-metadata-unknown';}
    }
   }
  }
  r.reasons[reason]=(r.reasons[reason]??0)+1;
  const tailKnown=terminal?.predictionId&&terminal.slug===m.slug&&terminal.outcome===outcome&&terminal.time===now&&finite(terminal.thresholdUsd);
  const gates={baseline:common?baseline?.selected?.eligible===true:false,tail:common?(tailKnown?terminal.tailGate:null):false};
  gates['tail-quote']=gates.tail===true?(features?.quoteKnown?features.quoteSupports:null):gates.tail;
  gates['tail-quote-flow']=gates['tail-quote']===true?(features?.flowKnown?features.flowSupports:null):gates['tail-quote'];
  if(remaining>0&&remaining<=120000){r.unknownEvaluations??={};for(const arm of validationProtocol.arms){
   if(gates[arm]===null||reason.includes('unknown'))r.unknownEvaluations[arm]=(r.unknownEvaluations[arm]??0)+1;
  }}
  for(const arm of validationProtocol.arms){
   if(gates[arm]!==true||r.arms[arm]||!quote)continue;
   const b=f.books.find(b=>b.tokenId===m.tokens[outcome]);
   const signal={id:`${m.slug}:${arm}:${now}`,arm,time:now,outcome,tokenId:b.tokenId,sourceKey:sourceKey(b),sourceAt:b.timestamp,
    request:{size:quote.size,amountUsd:quote.amountUsd,maxSpend:quote.maxSpend,limit:quote.limit},features:copy(features),
    thresholdUsd:arm==='baseline'?baseline.thresholdUsd:terminal.thresholdUsd,marketProbability:features.midpoint,
    modelProbability:null,probabilityReason:'tail quantile is not a calibrated probability',scenarios:{}};
   for(const delayMs of validationProtocol.delaysMs)for(const depthFraction of validationProtocol.depthFractions){
    const key=`${delayMs}ms-depth${depthFraction}`;
    signal.scenarios[key]={delayMs,depthFraction,dueAt:now+delayMs,status:'pending',
     ...(delayMs===0?{...frozenRequestFill(signal.request,b,m,depthFraction),arrivalAt:now,sourceAt:b.timestamp}:{} )};
   }
   r.arms[arm]=signal;this.totals[arm].signals++;
   this.emit({kind:'admission-validation-signal',time:now,slug:m.slug,dateNy:r.dateNy,signal});
  }
  const key=JSON.stringify([reason,gates]);
  this.last={time:now,slug:m.slug,reason,gates,features,common,tailKnown:Boolean(tailKnown)};
  if(key!==r.lastKey||r.lastRecordAt===null||now-r.lastRecordAt>=5000){
   this.emit({kind:'admission-validation-observation',...this.last,coverage:copy(r.coverage),actual:copy(actual)});r.lastKey=key;r.lastRecordAt=now;
  }
  while(this.rounds.size>validationProtocol.maximumPendingRounds){const [slug,old]=this.rounds.entries().next().value;
   this.emit({kind:'admission-validation-unresolved',time:now,slug,reason:'bounded-pending-round-limit',round:old});this.rounds.delete(slug);this.counts.evictedPending++;}
  return copy(this.last);
 }
 arrivals(r,signal,frame,now){
  for(const [key,s] of Object.entries(signal.scenarios)){
   if(s.status!=='pending'||now<s.dueAt)continue;
   const b=frame.books?.find(b=>b.tokenId===signal.tokenId);
   if(now>Math.min(r.market.end-1,s.dueAt+validationProtocol.arrivalToleranceMs)){s.status='unknown';s.reason='no-qualified-arrival-in-window';}
   else if(frame.clock?.ready!==true||!freshPair(frame,now)||!b||b.timestamp<s.dueAt||b.receivedAt<s.dueAt||sourceKey(b)===signal.sourceKey)continue;
   else Object.assign(s,frozenRequestFill(signal.request,b,r.market,s.depthFraction),{arrivalAt:now,sourceAt:b.timestamp});
   this.emit({kind:'admission-validation-execution',time:now,slug:r.market.slug,signalId:signal.id,key,scenario:copy(s)});
  }
 }
 acceptLabel(label,now=this.clock()){
  const old=this.completed.find(r=>r.slug===label?.slug);if(old){if(old.winner!==label.winner)this.counts.labelConflicts++;return false;}
  const r=this.rounds.get(label?.slug);if(!r)return false;
  const signals=Object.values(r.arms),outcome=signals[0]?.outcome??'Up';
  // No-entry rounds can have a verified official outcome without a known
  // opening. Never backfill that opening into decision-time evidence.
  if(signals.length&&!r.opening)return false;
  if(!validManagedSettlement({market:r.market,slug:r.market.slug,outcome,tokenId:r.market.tokens[outcome],opening:r.opening?.value},label,now)||
   signals.some(s=>label.observedAt<s.time)||now<r.market.end)return false;
  const c=r.coverage,complete=c.firstLateAt!==null&&c.firstLateAt<=r.market.end-115000&&c.lastLateAt>=r.market.end-5000&&c.maxGapMs<=5000&&c.gaps===0;
  const result={slug:r.market.slug,dateNy:r.dateNy,winner:label.winner,observedAt:label.observedAt,
   coverage:{...c,completeObservedWindow:complete},openingKnownAtDecision:Boolean(r.opening),reasons:r.reasons,unknownEvaluations:r.unknownEvaluations??{},arms:copy(r.arms),actualEligibleObserved:r.actualEligibleObserved};
  if(!r.opening)for(const arm of validationProtocol.arms)result.unknownEvaluations[arm]=Math.max(1,result.unknownEvaluations[arm]??0);
  for(const signal of Object.values(result.arms)){
   const win=signal.outcome===label.winner;signal.win=win;
   signal.marketBrier=finite(signal.marketProbability)?(signal.marketProbability-Number(win))**2:null;signal.modelBrier=null;
   const totals=this.totals[signal.arm];totals.labeled++;totals[win?'wins':'losses']++;
   for(const [key,s] of Object.entries(signal.scenarios)){
    if(s.status==='pending'){s.status='unknown';s.reason='no-qualified-arrival-before-label';}
    s.net=s.status==='unknown'?null:round((win?s.filled:0)-s.total);
    s.capitalOccupancyMs=s.filled>0?label.observedAt-(s.arrivalAt??signal.time):null;
    const t=totals.scenarios[key]??={observed:0,unknown:0,filled:0,zeroFill:0,wins:0,net:0,fees:0,occupancyMs:0};
    if(s.net===null){t.unknown++;continue;}t.observed++;t.filled+=Number(s.filled>0);t.zeroFill+=Number(s.filled===0);t.wins+=Number(s.filled>0&&win);t.net=round(t.net+s.net);t.fees=round(t.fees+s.fees);t.occupancyMs+=s.capitalOccupancyMs??0;
   }
  }
  const base=result.arms.baseline,tail=result.arms.tail;
  result.pair={baselineSignal:Boolean(base),tailSignal:Boolean(tail),sameDirection:base&&tail?base.outcome===tail.outcome:null,
   classification:base?(tail?'both-signaled':complete&&!result.unknownEvaluations.tail?(base.win?'baseline-win-not-signaled-by-tail':'baseline-loss-not-signaled-by-tail'):'tail-absence-unknown-coverage'):tail?'tail-only-signal':complete&&!Object.values(result.unknownEvaluations).some(Boolean)?'neither-signaled':'no-signal-unknown-coverage'};
  this.counts.completed++;this.lastLabelAt=now;this.completed.push(result);this.completed=this.completed.slice(-validationProtocol.maximumCompletedRounds);this.rounds.delete(label.slug);
  this.emit({kind:'admission-validation-outcome',time:now,result,financialEffect:'none; fixed-budget independent opportunities, not an account backtest'});return true;
 }
 pendingMarkets(){return [...this.rounds.values()].map(r=>copy(r.market));}
 saved(){return {protocolHash:validationProtocolHash,startedAt:this.startedAt,rounds:copy([...this.rounds.values()]),completed:copy(this.completed),counts:copy(this.counts),totals:copy(this.totals)};}
 summary(){const dates=[...new Set(this.completed.map(r=>r.dateNy))];return {version:validationProtocol.version,protocolHash:validationProtocolHash,
  scope:'shadow-only',adopted:false,startedAt:this.startedAt,lastObservedAt:this.lastObservedAt,lastRecordedAt:this.lastRecordedAt,lastLabelAt:this.lastLabelAt,
  counts:copy(this.counts),totals:copy(this.totals),pendingRounds:this.rounds.size,independentDates:dates.length,dates,
  latest:copy(this.last),recentCompleted:copy(this.completed.slice(-12)),error:this.error,
  paired:{...pairedAdmissionComparison(this.completed),retainedCompletedRounds:this.completed.length,
   lifetimeCompletedRounds:this.counts.completed,scope:'retained completed cache, maximum 256 rounds; full history remains in append-only logs'},
  calibration:{status:'not-qualified',probabilityLowerBound:null,modelBrier:null,reason:'No frozen calibrated probability model; tail quantiles are not probabilities. Date counts alone cannot promote.'},
  semantics:validationProtocol.semantics};}
}
