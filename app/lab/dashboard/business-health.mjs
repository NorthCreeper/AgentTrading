import {bookStatus} from './book-status.mjs';
const finite=Number.isFinite;
export function businessHealth(state,now=state.now){
 const active=state.running===true,admission=state.strategy?.admissionResearch,validation=admission?.validation;
 const q=state.strategy?.settlementQueue,rec=admission?.recording,flow=state.strategy?.orderflowResearch;
 const age=at=>finite(at)&&at<=now?now-at:null,books=bookStatus(state.frame,now,state.config?.staleMs??3000);
 const frameAge=age(state.frame?.now),observedAge=age(validation?.lastObservedAt);
 const terminal=admission?.terminal,current=terminal?.current,terminalAge=age(current?.time);
 const market=state.frame?.market;
 const currentMarket=finite(now)&&finite(market?.start)&&finite(market?.end)&&market.start<=now&&now<market.end;
 const predictionMismatch=!!(current?.slug&&market?.slug&&current.slug!==market.slug);
 const wait=active?'unknown':'stopped',metadataAge=age(state.frame?.marketMetadata?.verifiedAt);
 const components={
  process:{status:!active?'stopped':'ok',frameAgeMs:frameAge,semantics:'snapshot produced by backend; unavailable process is detected by the independent service watchdog'},
  clock:{status:!active?'stopped':state.clock?.ready===true?'ok':'degraded',reason:state.clock?.readinessReason??'unknown',
   calibrationAgeMs:state.clock?.calibrationAgeMs??null,validityMs:state.clock?.validityMs??null,
   error:state.clock?.error??null,lastAttempt:state.clock?.lastAttempt??null,
   retrying:state.clock?.lastAttempt?.result==='failed',catchupMs:state.clock?.catchupMs??null,
   transitionRemainingMs:state.clock?.transitionRemainingMs??null},
  metadata:{status:!active?'stopped':metadataAge===null?'unknown':metadataAge>10000?'degraded':'ok',ageMs:metadataAge,
   refreshState:state.sources?.market?.state??'unknown',semantics:'market identity and order parameters; proactive refresh at 5s, expires at 10s'},
  books:{status:!active?'stopped':books.fresh?'ok':'degraded',reason:books.reason,sourceAgeMs:books.sourceAgeMs,receivedAgeMs:books.receivedAgeMs},
  reference:{status:!active?'stopped':state.referenceFresh===true?'ok':'degraded'},
  model:{status:!active?'stopped':!validation?'disabled':!currentMarket||observedAge===null||observedAge>15000?'degraded':validation.error?'degraded':'ok',
   ageMs:observedAge,reason:!currentMarket?'no-current-market-frame':validation?.latest?.reason??'no-observation',calibrated:false,adopted:false},
  prediction:{status:!active?'stopped':!terminal?'disabled':terminal.error||terminal.writeError?'degraded':
   !currentMarket||predictionMismatch||terminalAge===null||terminalAge>15000?'degraded':current?.reason==='outside-last-120-seconds'?'idle':current?.predictionId?'ok':'waiting',
   ageMs:terminalAge,reason:!currentMarket?'no-current-market-frame':predictionMismatch?'prediction-market-mismatch':current?.reason??'not-observed',calibrated:false,adopted:false},
  recording:{status:!active?'stopped':!rec?'disabled':rec.lastError||validation?.counts?.writeFailures>0?'degraded':rec.closed?'degraded':'ok',
   accepted:rec?.counts?.accepted??null,written:rec?.counts?.written??null,dropped:rec?.counts?.dropped??null,queuedRows:rec?.queuedRows??null,
   orderflowDropped:flow?.recording?.counts?.dropped??null,orderflowError:flow?.recording?.lastError??null},
  settlement:{status:!q?wait:q.count===0?'idle':finite(q.longestWaitMs)&&q.longestWaitMs>900000?'degraded':'waiting',
   pending:q?.count??null,longestWaitMs:q?.longestWaitMs??null,cost:q?.cost??null,
   semantics:'unverified payout remains capital occupied; 15 minute warning is not an exit rule'}
 };
 if(components.recording.orderflowError)components.recording.status='degraded';
 return {version:'btc5m-business-health-v1',time:now,components,
  status:Object.values(components).some(c=>c.status==='degraded')?'attention':active?'observing':'stopped',
  executionEffect:'none; diagnostics do not restart, change strategy or release unsettled money'};
}
export class BusinessHealthMonitor {
 constructor({write=()=>true}={}){this.write=write;this.samples=[];this.last=null;this.lastWriteAt=null;this.key=null;this.error=null;this.writeProgress=null;}
 observe(state){const h=businessHealth(state),previous=this.last;
  const rec=h.components.recording,pending=finite(rec.accepted)&&finite(rec.written)&&rec.accepted>rec.written;
  if(!pending||!this.writeProgress||this.writeProgress.written!==rec.written||h.time<this.writeProgress.since)
   this.writeProgress=pending?{written:rec.written,since:h.time}:null;
  rec.noProgressMs=this.writeProgress?h.time-this.writeProgress.since:0;
  if(state.running===true&&rec.noProgressMs>15000){rec.status='degraded';rec.reason='accepted-records-not-written-for-15s';h.status='attention';}
  if(previous&&h.time<previous.time)this.samples=[];
  if(!previous||h.time-previous.time>=4000||h.time<previous.time)this.samples.push({time:h.time,statuses:Object.fromEntries(Object.entries(h.components).map(([k,v])=>[k,v.status]))});
  this.samples=this.samples.filter(s=>h.time-s.time<=1800000).slice(-360);this.last=h;
  const counts={};for(const s of this.samples)for(const [k,v]of Object.entries(s.statuses)){counts[k]??={};counts[k][v]=(counts[k][v]??0)+1;}
  h.window={startedAt:this.samples[0]?.time??null,samples:this.samples.length,counts,semantics:'5s sampled status counts in current process, maximum 30min; not continuous duration or all-history availability'};
  const key=JSON.stringify([Object.values(h.components).map(x=>x.status),h.components.clock.reason,h.components.clock.lastAttempt?.id??null]);
  if(key!==this.key||this.lastWriteAt===null||h.time-this.lastWriteAt>=30000){try{if(this.write({kind:'business-health-heartbeat',time:h.time,health:h})===false)this.error='health-recording-rejected';}catch(e){this.error=e.message;}this.key=key;this.lastWriteAt=h.time;}
  h.recordingError=this.error;if(this.error)h.status='attention';return h;
 }
 summary(){return this.last?{...this.last,recordingError:this.error}:null;}
}
