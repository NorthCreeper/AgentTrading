import {existsSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.mjs';
import {continuationProtocol,continuationObservation,createContinuationTarget,advanceContinuationTarget,finishContinuationTarget} from './continuation-target.mjs';
import {readJournalIds} from './journal-ids.mjs';

export const continuationStudyVersion='p3-owned-continuation-study-v1';
export const samplingProtocol=Object.freeze({intervalMs:30000,slotWindowMs:2000,
  first:'first-observable-owned-inventory',exit:'first-executable-exit-signal',
  overlappingReasons:'one-sample-per-frame',originScope:['automatic','manual-one-tap'],
  diagnosticOnly:true,changesTradingRules:false});
const emptyPair=()=>({complete:0,unknown:0,perShareSum:0});
export class ContinuationStudy {
  constructor(directory) {
    this.path=join(directory,'continuation-study.json');this.journal=join(directory,'continuation-study.jsonl');
    this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{
      version:continuationStudyVersion,startedAt:null,lastAt:null,active:[],recent:[],trades:{},rounds:[],pending:[],
      totals:{samples:0,trades:0,finalized:0,slotMisses:0,preObservationSlots:0,
        origins:{},pairs:{delay30:emptyPair(),settlement:emptyPair()}}};
    if(this.state.version!==continuationStudyVersion)throw Error('Unknown owned continuation study version');
    this.written=readJournalIds(this.journal);
    this.views=new Map();this.error=null;this.flush();
  }
  flush() {
    for(const e of this.state.pending)if(!this.written.has(e.id)){appendFileSync(this.journal,JSON.stringify(e)+'\n');this.written.add(e.id);}
    this.state.pending=[];
  }
  save(events) {this.state.pending.push(...events);writeJsonAtomic(this.path,this.state);this.flush();}
  capture(input) {
    if(this.error)return null;
    const {trade,size,frame,now,busy=false,exitSignal=false}=input;
    if(!trade?.id||!Number.isFinite(trade.openedAt)||now<trade.openedAt||!(size>0)||!frame||
      now>=trade.market.end||now<trade.market.start||!samplingProtocol.originScope.includes(trade.origin??'automatic'))return null;
    const m=trade.market,fm=frame.market;
    if(fm.slug!==m.slug||fm.conditionId!==m.conditionId||fm.start!==m.start||fm.end!==m.end||
      ['Up','Down'].some(o=>fm.tokens[o]!==m.tokens[o])||trade.tokenId!==m.tokens[trade.outcome])return null;
    const p=continuationObservation(frame,fm,trade.outcome,now);
    const h=this.state.trades[trade.id]??={firstSeenAt:now,firstCaptured:false,slots:[],exitCaptured:false,lastFrameAt:null,lastSampleId:null,lastReason:null};
    const slot=Math.floor((now-trade.openedAt)/samplingProtocol.intervalMs),scheduledAt=trade.openedAt+slot*samplingProtocol.intervalMs;
    const events=[],reasons=[];
    // Missing fixed slots stay missing. Do not slide them to the next good quote.
    const previousSlot=h.lastCheckedSlot??-1;
    for(let k=previousSlot+1;k<=slot;k++) {
      const at=trade.openedAt+k*samplingProtocol.intervalMs;
      if(h.slots.includes(k)||now<=at+samplingProtocol.slotWindowMs)continue;
      const beforeObservation=at+samplingProtocol.slotWindowMs<h.firstSeenAt;
      h.slots.push(k);
      if(beforeObservation)this.state.totals.preObservationSlots++;
      else this.state.totals.slotMisses++;
      events.push({id:trade.id+':missed-slot:'+k,kind:'missed-slot',tradeId:trade.id,slot:k,scheduledAt:at,at:now,
        reason:beforeObservation?'before-study-observation':k<slot?'unobserved-gap':h.lastReason??(busy?'execution-busy':p.status)});
    }
    h.lastCheckedSlot=slot-1;
    h.lastReason=busy?'execution-busy':p.status;
    const observable=!busy&&p.observed;
    if(observable&&!h.firstCaptured)reasons.push('first-observed');
    if(observable&&!h.slots.includes(slot)&&now<=scheduledAt+samplingProtocol.slotWindowMs)reasons.push('periodic');
    if(observable&&exitSignal&&!h.exitCaptured)reasons.push('exit-signal');
    if(!reasons.length){if(events.length)this.save(events);return null;}
    // The same frame can be seen before place() and after main execution.
    // Keep one fixed inventory fork and attach the extra capture reason.
    const prior=h.lastFrameAt===frame.now?this.state.active.find(t=>t.id===h.lastSampleId):null;
    let t=prior;
    if(prior) {
      const added=reasons.filter(r=>!prior.reasons.includes(r));
      if(added.length){prior.reasons.push(...added);events.push({id:prior.id+':reasons:'+added.join('+'),kind:'sample-reasons',sampleId:prior.id,at:now,reasons:added});}
    } else {
      const id=trade.id+':owned:'+now+':frame:'+frame.now;
      t=createContinuationTarget({id,trade,size,frame,now,contextId:input.contextId??null,features:input.features??null,reasons});
      Object.assign(t,{sessionId:input.sessionId??null,experimentId:trade.experimentId??null,
        scheduledAt:reasons.includes('periodic')?scheduledAt:null,anchorRemainingSize:size,
        decision:trade.holdingDecision&&trade.holdingDecision.time<=now?structuredClone(trade.holdingDecision):null,
        sourceParameters:structuredClone(trade.parameters??null),observationStartedAfterEntry:now-trade.openedAt>2000});
      this.state.active.push(t);h.lastSampleId=id;h.lastFrameAt=frame.now;
      this.state.startedAt??=now;this.state.totals.samples++;
      if(!h.firstCaptured)this.state.totals.trades++;
      const origin=trade.origin??'automatic';this.state.totals.origins[origin]=(this.state.totals.origins[origin]??0)+1;
      if(!this.state.rounds.includes(m.slug))this.state.rounds.push(m.slug);
      events.push({id:id+':sample',kind:'sample',at:now,sample:structuredClone(t)});
    }
    if(reasons.includes('first-observed'))h.firstCaptured=true;
    if(reasons.includes('periodic'))h.slots.push(slot);
    if(reasons.includes('exit-signal'))h.exitCaptured=true;
    this.save(events);return t;
  }
  observe(input,labels=new Map()) {
    if(this.error||!Number.isFinite(input.now)||input.now<(this.state.lastAt??0))return;
    this.state.lastAt=input.now;
    const events=[],keep=[];
    for(const t of this.state.active) {
      const before=JSON.stringify(t.arms);
      advanceContinuationTarget(t,input);
      const view=finishContinuationTarget(t,labels.get(t.market.slug),input.now);
      this.views.set(t.id,view);
      const settlement=view.arms.find(a=>a.name==='settlement');
      const finalized=settlement.complete&&view.arms.every(a=>a.status!=='pending');
      if(finalized) {
        this.state.totals.finalized++;
        for(const p of view.pairs){const s=this.state.totals.pairs[p.policy];if(p.complete){s.complete++;s.perShareSum+=p.perShareDifference;}else s.unknown++;}
        this.state.recent.push(view);this.state.recent=this.state.recent.slice(-80);
        events.push({id:t.id+':finalized',kind:'finalized',at:input.now,sample:view});this.views.delete(t.id);
      } else {
        keep.push(t);
        if(before!==JSON.stringify(t.arms))events.push({id:t.id+':update:'+input.now,kind:'target-update',at:input.now,sampleId:t.id,arms:structuredClone(t.arms)});
      }
    }
    this.state.active=keep;
    if(events.length)this.save(events);
  }
  summary() {
    const t=this.state.totals,latest=this.state.active.at(-1);
    return {version:continuationStudyVersion,protocol:continuationProtocol,sampling:samplingProtocol,
      diagnosticOnly:true,changesTradingRules:false,error:this.error,startedAt:this.state.startedAt,lastAt:this.state.lastAt,
      samples:t.samples,trades:t.trades,rounds:this.state.rounds.length,finalized:t.finalized,pending:this.state.active.length,
      slotMisses:t.slotMisses,preObservationSlots:t.preObservationSlots,origins:t.origins,
      pairs:Object.entries(t.pairs).map(([policy,p])=>({policy,complete:p.complete,unknown:p.unknown,
        meanPerShareDifference:p.complete?p.perShareSum/p.complete:null})),
      latest:latest?(this.views.get(latest.id)??latest):this.state.recent.at(-1)??null,
      scope:'Actual owned inventory forks, overlapping labels are not independent trades or account profit.'};
  }
}
