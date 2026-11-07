import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {e18ToPrice} from './chart-model.mjs';
import {validRayOpeningEvidence} from './ray-opening.mjs';
import {validManagedSettlement} from './managed-position-accounting.mjs';
import {freshBook} from './strategy.mjs';

export const terminalAdmissionShadowVersion='terminal-admission-shadow-v1';
export const terminalAdmissionArtifactVersion='terminal-adverse-quantile-artifact-v1';
const finite=Number.isFinite,copy=x=>structuredClone(x);
const timeBuckets=[[90,120],[60,90],[30,60],[0,30]];
const ny=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const sessions=new Set(['morning','midday','night']);
const trendName=n=>!finite(n)?'unknown':n>0?'supporting':n<0?'opposing':'flat';
const bucketFor=s=>s>90?0:s>60?1:s>30?2:3;
const sessionFor=t=>{const h=new Date(t+28800000).getUTCHours();return h>=6&&h<12?'morning':h>=12&&h<22?'midday':'night';};
const marketValid=m=>m&&finite(m.start)&&m.end===m.start+300000&&m.slug==='btc-updown-5m-'+m.start/1000&&
 typeof m.conditionId==='string'&&m.conditionId&&typeof m.tokens?.Up==='string'&&typeof m.tokens?.Down==='string'&&m.tokens.Up!==m.tokens.Down;
const pointValid=p=>p&&[p.referenceAt,p.knownAt,p.value].every(finite)&&p.value>0&&p.referenceAt<=p.knownAt&&typeof p.valueE18==='string'&&e18ToPrice(p.valueE18)===p.value;
const baseFlags=Object.freeze({mode:'shadow',adopted:false,validated:false,realTrading:false,tradesExecuted:0,allocationEffect:'none',probabilityLowerBound:null});
const pendingSample=r=>Object.fromEntries(['predictionId','modelId','time','timeBucket','outcome','twap','opening','thresholdUsd','calendar','selection']
 .map(k=>[k,k==='selection'?{key:r.selection.key}:copy(r[k])]));

export function validateTerminalAdmissionArtifact(a){
 if(!a||a.schema!==terminalAdmissionArtifactVersion||typeof a.modelId!=='string'||!a.modelId||a.validated!==false||a.adopted!==false||
  !finite(a.trainingInformationCutoff)||!finite(a.builtAt)||a.trainingInformationCutoff>a.builtAt||
  a.target?.kind!=='signed-terminal-adverse-normalized'||a.target?.alpha!==.05||a.normalization?.windowSeconds!==180||
  a.normalization?.sampleSeconds!==5||a.normalization?.minimumCoverage!==.9||
  !finite(a.minimumSupport?.rounds)||a.minimumSupport.rounds<20||!finite(a.minimumSupport?.dates)||a.minimumSupport.dates<3||
  !a.cells||typeof a.cells!=='object'||Array.isArray(a.cells))return {ok:false,reason:'invalid-artifact-schema-or-policy'};
 for(const [key,c]of Object.entries(a.cells))if(!/^[0-3]\|(?:morning|midday|night|\*)\|(?:supporting|opposing|flat|unknown|\*)\|[^|]+$/.test(key)||
  !finite(c.q)||!Number.isInteger(c.rounds)||c.rounds<1||!Array.isArray(c.dates)||!c.dates.length||new Set(c.dates).size!==c.dates.length||
  c.dates.some(d=>typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)))return {ok:false,reason:'invalid-artifact-cell'};
 if(![0,1,2,3].every(i=>a.cells[`${i}|*|*|*`]))return {ok:false,reason:'missing-pooled-time-cells'};
 return {ok:true,reason:'shadow-artifact-only'};
}

// One small artifact is read at initialization, never fitted in the controller.
export function loadTerminalAdmissionArtifact(path,{expectedSha256=null}={}){
 const bytes=readFileSync(path),sha256=createHash('sha256').update(bytes).digest('hex');
 if(expectedSha256&&sha256!==expectedSha256)throw Error('Terminal admission artifact digest mismatch');
 const artifact=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),validation=validateTerminalAdmissionArtifact(artifact);
 if(!validation.ok)throw Error(validation.reason);
 return {...artifact,artifactSha256:sha256,artifactPath:path};
}

export function terminalPastVolatility(points,referenceAt){
 const min=referenceAt-180000,available=points.filter(p=>p.referenceAt>=min-10000&&p.referenceAt<=referenceAt),rows=[];
 // Match the registered historical feature sampler: the five-source-second
 // phase is chosen inside each trailing window, not a process-start grid.
 for(const p of available)if(!rows.length||p.referenceAt-rows.at(-1).referenceAt>=5000)rows.push(p);
 let square=0,seconds=0;
 for(let i=1;i<rows.length;i++){
  const a=rows[i-1],b=rows[i],dt=(b.referenceAt-a.referenceAt)/1000;
  // A partially overlapping interval cannot certify the entire interval's
  // change within this window. Missing time never becomes a zero return.
  if(a.referenceAt<min||dt<=0||dt>10)continue;
  square+=(b.value-a.value)**2;seconds+=dt;
 }
 const coverage=Math.min(1,seconds/180);
 return {sigma:coverage>=.9&&seconds>0?Math.sqrt(square/seconds):null,coverage,coveredSeconds:seconds};
}

export function selectTerminalAdmissionCell(artifact,{bucket,session,trend,calendarType}){
 const requested=`${bucket}|${session}|${trend}|${calendarType}`;
 const keys=[requested,`${bucket}|${session}|${trend}|*`,`${bucket}|${session}|*|*`,`${bucket}|*|*|*`];
 const attempts=[];
 for(const key of [...new Set(keys)]){
  const cell=artifact?.cells?.[key];
  const sufficient=cell&&cell.rounds>=artifact.minimumSupport.rounds&&cell.dates.length>=artifact.minimumSupport.dates;
  attempts.push({key,rounds:cell?.rounds??0,dates:cell?.dates?.length??0,sufficient:Boolean(sufficient)});
  if(sufficient)return {cell,key,requested,pooled:key!==requested,attempts,
   fallbackReason:key===requested?null:'date-or-feature-cell-has-insufficient-independent-training-support'};
 }
 return {cell:null,key:null,requested,pooled:true,attempts,fallbackReason:'no-supported-training-cell'};
}

function emptyStatistics(){return {observedFrames:0,predictions:0,shadowEligibleFrames:0,shadowEntryRounds:0,officiallyLabeledRounds:0,
 completedShadowEntries:0,wins:0,losses:0,residualChecks:0,tailBreaches:0,missingOfficialFinal:0,
 ignoredLabels:0,labelConflicts:0,pendingDropped:0,writeAttempts:0,writeAccepted:0,writeFailed:0,writeDropped:0,pendingWrites:0,resets:0};}

// This observer has no reference to a broker, order method, account, controller
// command or production threshold. Even a qualified shadow prediction cannot
// mutate trading allocation, prices or financial inventory.
export class TerminalAdmissionShadow {
 constructor({artifact=null,write=null,clock=Date.now,saved=null,modelKnownAt=null,maxPending=128,maxOutcomes=128,maxPendingWrites=16}={}){
  this.artifact=artifact?copy(artifact):null;this.artifactValidation=validateTerminalAdmissionArtifact(this.artifact);
  this.artifactBinding=this.artifact?.artifactSha256??createHash('sha256').update(JSON.stringify(this.artifact)).digest('hex');
  this.write=typeof write==='function'?write:null;this.clock=clock;
  this.modelKnownAt=finite(modelKnownAt)?modelKnownAt:clock();
  this.maxPending=Math.max(4,Math.min(256,Number.isInteger(maxPending)?maxPending:128));
  this.maxOutcomes=Math.max(4,Math.min(256,Number.isInteger(maxOutcomes)?maxOutcomes:128));
  this.maxPendingWrites=Math.max(1,Math.min(64,Number.isInteger(maxPendingWrites)?maxPendingWrites:16));
  this.points=[];this.latestReference=null;this.pending=new Map();this.outcomes=new Map();this.latest=null;
  this.lastFrameAt=null;this.lastNow=null;this.lastReset=null;this.lastWriteAt=null;this.writeError=null;this.restoreError=null;this.closed=false;
  this.statistics=emptyStatistics();
  if(saved)this._restore(saved);
 }
 _restore(s){
  const valid=s?.version===terminalAdmissionShadowVersion&&s.modelId===this.artifact?.modelId&&s.artifactSha256===this.artifactBinding&&Array.isArray(s.points)&&s.points.length<=512&&
   s.points.every((p,i)=>pointValid(p)&&(!i||p.referenceAt>s.points[i-1].referenceAt&&p.knownAt>=s.points[i-1].knownAt))&&
   Array.isArray(s.pending)&&s.pending.length<=this.maxPending&&s.pending.every(p=>marketValid(p.market)&&Array.isArray(p.samples)&&p.samples.length>0&&p.samples.length<=4&&
    p.samples.every(x=>x.modelId===this.artifact.modelId&&finite(x.time)&&x.time<p.market.end&&finite(x.twap)&&x.twap>0&&finite(x.opening)&&x.opening>0&&
     finite(x.thresholdUsd)&&['Up','Down'].includes(x.outcome)&&[0,1,2,3].includes(x.timeBucket))&&
    (!p.entry||p.entry.modelId===this.artifact.modelId&&finite(p.entry.time)&&p.entry.time<p.market.end))&&
   Array.isArray(s.outcomes)&&s.outcomes.length<=this.maxOutcomes;
  if(!valid){this.restoreError='invalid-or-different-model-shadow-cache; warming up';return;}
  this.points=copy(s.points);this.latestReference=pointValid(s.latestReference)?copy(s.latestReference):this.points.at(-1)??null;
  if(finite(s.modelKnownAt)&&s.modelKnownAt>=this.artifact.trainingInformationCutoff)this.modelKnownAt=s.modelKnownAt;
  this.pending=new Map(copy(s.pending).map(p=>[p.market.slug,p]));this.outcomes=new Map(copy(s.outcomes).map(p=>[p.slug,p]));
  this.statistics={...emptyStatistics(),...(s.statistics??{}),pendingWrites:0};this.lastNow=finite(s.lastNow)?s.lastNow:null;
  this.lastFrameAt=finite(s.lastFrameAt)?s.lastFrameAt:null;this.lastReset=s.lastReset??null;
 }
 _emit(record){
  this.statistics.writeAttempts++;
  if(this.statistics.pendingWrites>=this.maxPendingWrites){this.statistics.writeFailed++;this.statistics.writeDropped++;
   this.writeError='bounded-pending-write-limit';return;}
  if(!this.write){this.statistics.writeFailed++;this.writeError='shadow-write-unconfigured';return;}
  const failed=e=>{this.statistics.writeFailed++;this.writeError=String(e?.message??e);};
  try{const result=this.write(copy(record));
   if(result&&typeof result.then==='function'){this.statistics.pendingWrites++;Promise.resolve(result).then(v=>{
    if(v===false)failed('shadow-write-rejected');else this.statistics.writeAccepted++;
   },failed).finally(()=>this.statistics.pendingWrites--);}
   else if(result===false)failed('shadow-write-rejected');else this.statistics.writeAccepted++;
  }catch(error){failed(error);}
 }
 reset(reason='explicit-reset',now=this.clock()){
  this.points=[];this.latestReference=null;this.latest=null;this.statistics.resets++;
  this.lastReset={time:now,reason};this._emit({...baseFlags,kind:'terminal-admission-shadow-reset',version:terminalAdmissionShadowVersion,
   modelId:this.artifact?.modelId??null,time:now,reason,pendingOutcomesPreserved:this.pending.size});
 }
 invalidateBook(reason='book-source-unavailable',now=this.clock()){
  this.latest={...baseFlags,version:terminalAdmissionShadowVersion,status:'waiting',reason:'book-source-unavailable',time:now,
   modelId:this.artifact?.modelId??null,sourceReason:reason};
  this._emit({...baseFlags,kind:'terminal-admission-shadow-book-gap',version:terminalAdmissionShadowVersion,time:now,
   modelId:this.artifact?.modelId??null,reason,referenceHistoryPreserved:true,pendingOutcomesPreserved:this.pending.size});
 }
 _reference(ref,now){
  const value=e18ToPrice(ref?.valueE18),p={referenceAt:ref?.timestamp??ref?.time,knownAt:ref?.receivedAt,value,valueE18:ref?.valueE18};
  if(ref?.windowSeconds!==60||!pointValid(p)||p.knownAt>now||p.referenceAt>now||now-p.referenceAt>5000||now-p.knownAt>5000)
   return {ok:false,reason:'twap-source-or-receipt-not-fresh'};
  const last=this.latestReference;
  if(last&&p.referenceAt===last.referenceAt&&p.valueE18!==last.valueE18){this.reset('conflicting-same-source-time-twap',now);return {ok:false,reason:'twap-conflict'};}
  if(last&&(p.referenceAt<last.referenceAt||p.knownAt<last.knownAt))return {ok:false,reason:'twap-time-regression'};
  if(last&&(p.referenceAt-last.referenceAt>10000||p.knownAt-last.knownAt>10000))this.reset('source-or-receipt-gap',now);
  this.latestReference=p;
  const sample=this.points.at(-1);
  if(!sample||p.referenceAt>sample.referenceAt)this.points.push(p);
  while(this.points.length>1&&this.points[1].referenceAt<p.referenceAt-240000)this.points.shift();
  if(this.points.length>512)this.points.splice(0,this.points.length-512);
  return {ok:true,point:p};
 }
 observeReference(reference,{now=this.clock(),clockReady=true}={}){
  if(this.closed||!finite(now))return false;
  if(!clockReady){if(this.points.length)this.reset('utc-clock-not-ready',now);return false;}
  return this._reference(reference,now).ok;
 }
 observe(frame,{reference=frame?.twap,opening=frame?.rayOpening,calendar=null,now=this.clock(),actual=null}={}){
  if(this.closed)return null;this.statistics.observedFrames++;
  const waiting=reason=>{this.latest={...baseFlags,version:terminalAdmissionShadowVersion,status:'waiting',reason,time:now,
   modelId:this.artifact?.modelId??null,modelKnownAt:this.modelKnownAt,slug:frame?.market?.slug??null};return copy(this.latest);};
  if(!finite(now)||!finite(frame?.now)||frame.now>now||this.lastNow!==null&&now<this.lastNow)return waiting('observation-time-invalid-or-regressed');
  this.lastNow=now;this.lastFrameAt=frame.now;
  if(frame.clock?.ready!==true){if(this.points.length)this.reset('utc-clock-not-ready',now);return waiting('utc-clock-not-ready');}
  const ref=this._reference(reference,now);if(!ref.ok)return waiting(ref.reason);
  if(!this.artifactValidation.ok)return waiting(this.artifactValidation.reason);
  if(this.modelKnownAt>now||this.artifact.trainingInformationCutoff>now||this.artifact.builtAt>now)return waiting('model-information-not-yet-known');
  const m=frame.market;if(!marketValid(m))return waiting('market-identity-invalid');
  const remaining=(m.end-now)/1000;if(remaining<=0||remaining>120)return waiting('outside-last-120-seconds');
  if(!validRayOpeningEvidence(opening,m,now))return waiting('accurate-opening-not-known-or-conflicting');
  const vol=terminalPastVolatility(this.points,ref.point.referenceAt);
  if(!finite(vol.sigma)||vol.sigma<=0)return waiting(vol.coverage<.9?'past-180-second-volatility-warming':'past-volatility-zero-or-unknown');
  const deviation=ref.point.value-opening.value;if(deviation===0)return waiting('direction-unknown-at-opening');
  const outcome=deviation>0?'Up':'Down',sign=outcome==='Up'?1:-1,session=sessionFor(now),bucket=bucketFor(remaining);
  const before=this.points.findLast(p=>p.referenceAt<=ref.point.referenceAt-15000&&ref.point.referenceAt-p.referenceAt<=25000);
  const trend15=before?ref.point.value-before.value:null,trend=trendName(finite(trend15)?sign*trend15:null);
  const calType=calendar?.known===true&&calendar.retrospectiveClassification!==true&&calendar.knowledgeStatus==='known-by-decision-or-calendar-date'?
   calendar.primaryType??'calendar_unknown':'calendar_unknown';
  const selection=selectTerminalAdmissionCell(this.artifact,{bucket,session,trend,calendarType:calType});
  if(!selection.cell)return waiting(selection.fallbackReason);
  const threshold=Math.max(0,selection.cell.q*vol.sigma*Math.sqrt(remaining));
  const side=frame.books?.find(b=>b.tokenId===m.tokens[outcome]),other=frame.books?.find(b=>b.tokenId===m.tokens[outcome==='Up'?'Down':'Up']);
  const bothFresh=[side,other].every(b=>freshBook(b,now,3000)&&b.asks?.length&&b.bids?.length&&b.asks[0][0]>b.bids[0][0]);
  const ask=side?.asks?.[0]?.[0]??null,oppositeAsk=other?.asks?.[0]?.[0]??null;
  const bookEligible=Boolean(bothFresh&&ask>=.8&&ask<=.85&&oppositeAsk<=.2);
  const record={...baseFlags,kind:'terminal-admission-shadow-prediction',version:terminalAdmissionShadowVersion,
   modelId:this.artifact.modelId,artifactSha256:this.artifactBinding,modelKnownAt:this.modelKnownAt,
   trainingInformationCutoff:this.artifact.trainingInformationCutoff,
   predictionId:`${this.artifact.modelId}:${m.slug}:${ref.point.referenceAt}:${outcome}:b${bucket}:t${now}`,time:now,frameAt:frame.now,
   slug:m.slug,market:copy(m),outcome,tokenId:m.tokens[outcome],status:'observing',reason:'unvalidated-terminal-tail-candidate-only',
   remainingSeconds:remaining,timeBucket:bucket,timeBucketBounds:timeBuckets[bucket],twap:ref.point.value,twapAt:ref.point.referenceAt,
   twapKnownAt:ref.point.knownAt,opening:opening.value,openingKnownAt:opening.knownAt,signedDeviationUsd:deviation,
   sigma180:vol.sigma,volatilityCoverage:vol.coverage,trend15,trend,session,
   calendar:{dateNy:calendar?.dateNy??ny.format(now),primaryType:calType,tags:copy(calendar?.tags??['calendar_unknown']),
    knowledgeStatus:calendar?.knowledgeStatus??'unavailable',retrospectiveClassification:calendar?.retrospectiveClassification??false},
   selection,alphaResearchTarget:.05,thresholdUsd:threshold,tailGate:Math.abs(deviation)>=threshold,
   book:{ask,oppositeAsk,bothFresh,eligible:bookEligible},shadowEligible:Math.abs(deviation)>=threshold&&bookEligible,
   actual:actual?copy(actual):null,probabilityReason:'no-independent-date-calibration-admitted; no size increase authorized',
   entryScope:'shadow terminal-tail and book-price screen only; order sizing and actual fills are not assessed'};
  this.statistics.predictions++;if(record.shadowEligible)this.statistics.shadowEligibleFrames++;
  let pending=this.pending.get(m.slug);
  if(pending&&JSON.stringify([pending.market.conditionId,pending.market.tokens])!==JSON.stringify([m.conditionId,m.tokens])){
   return waiting('same-slug-shadow-market-conflict');
  }
  if(!pending){pending={market:copy(m),samples:[],entry:null};this.pending.set(m.slug,pending);}
  if(!pending.samples.some(s=>s.timeBucket===bucket))pending.samples.push(pendingSample(record));
  if(record.shadowEligible&&!pending.entry){pending.entry=pendingSample(record);this.statistics.shadowEntryRounds++;}
  while(this.pending.size>this.maxPending){const first=this.pending.keys().next().value;this.pending.delete(first);this.statistics.pendingDropped++;
   this._emit({...baseFlags,kind:'terminal-admission-shadow-gap',version:terminalAdmissionShadowVersion,time:now,slug:first,reason:'bounded-pending-outcome-buffer'});}
  const previous=this.latest;this.latest=record;
  if(!previous||previous.slug!==record.slug||previous.shadowEligible!==record.shadowEligible||previous.timeBucket!==record.timeBucket||
   this.lastWriteAt===null||now-this.lastWriteAt>=1000){this._emit(record);this.lastWriteAt=now;}
  return copy(record);
 }
 acceptLabel(label,{now=this.clock()}={}){
  if(this.closed||!finite(now))return false;
  const prior=this.outcomes.get(label?.slug);
  if(prior){if(prior.winner!==label?.winner){this.statistics.labelConflicts++;this._emit({...baseFlags,kind:'terminal-admission-shadow-label-conflict',
   version:terminalAdmissionShadowVersion,time:now,slug:label?.slug,originalWinner:prior.winner,conflictingWinner:label?.winner});}return false;}
  const pending=this.pending.get(label?.slug);if(!pending){this.statistics.ignoredLabels++;return false;}
  const any=pending.samples[0]??pending.entry;
  const trade={market:pending.market,slug:pending.market.slug,outcome:any.outcome,tokenId:pending.market.tokens[any.outcome],opening:any.opening};
  if(!validManagedSettlement(trade,label,now)||label.observedAt<any.time){this.statistics.ignoredLabels++;return false;}
  const evaluations=pending.samples.map(p=>{
   const actualChange=finite(label.final)?label.final-p.twap:null;
   const adverse=finite(actualChange)?(p.outcome==='Up'?-1:1)*actualChange:null;
   return {predictionId:p.predictionId,time:p.time,timeBucket:p.timeBucket,outcome:p.outcome,thresholdUsd:p.thresholdUsd,
    actualTerminalChangeUsd:actualChange,adverseTerminalChangeUsd:adverse,tailBreach:finite(adverse)?adverse>p.thresholdUsd:null,
    finalDirectionMatches:p.outcome===label.winner};
  });
  const entry=pending.entry,entryWin=entry?entry.outcome===label.winner:null;
  const record={...baseFlags,kind:'terminal-admission-shadow-outcome',version:terminalAdmissionShadowVersion,modelId:this.artifact.modelId,
   slug:pending.market.slug,time:now,officialObservedAt:label.observedAt,winner:label.winner,
   numericOfficialFinal:finite(label.final)?label.final:null,evaluations,shadowEntry:entry?{predictionId:entry.predictionId,time:entry.time,
    outcome:entry.outcome,win:entryWin,calendar:entry.calendar,selection:entry.selection.key}:null,
   financialEffect:'none; shadow direction and residual evaluation only; no simulated or real PnL credited'};
  this.statistics.officiallyLabeledRounds++;
  if(entry){this.statistics.completedShadowEntries++;this.statistics[entryWin?'wins':'losses']++;}
  for(const e of evaluations)if(e.tailBreach!==null){this.statistics.residualChecks++;this.statistics.tailBreaches+=Number(e.tailBreach);}
  if(!finite(label.final))this.statistics.missingOfficialFinal++;
  this.outcomes.set(record.slug,record);this.pending.delete(record.slug);
  while(this.outcomes.size>this.maxOutcomes)this.outcomes.delete(this.outcomes.keys().next().value);
  this._emit(record);return copy(record);
 }
 saved(){return {version:terminalAdmissionShadowVersion,modelId:this.artifact?.modelId??null,artifactSha256:this.artifactBinding,modelKnownAt:this.modelKnownAt,points:copy(this.points),latestReference:copy(this.latestReference),
  pending:copy([...this.pending.values()]),outcomes:copy([...this.outcomes.values()]),statistics:copy({...this.statistics,pendingWrites:0}),
  lastNow:this.lastNow,lastFrameAt:this.lastFrameAt,lastReset:copy(this.lastReset)};}
 summary(now=this.clock()){
  const n=this.statistics.completedShadowEntries;
  return {...baseFlags,version:terminalAdmissionShadowVersion,time:now,status:this.closed?'closed':this.writeError?'observation-write-error':this.latest?.status??'warming-up',
   modelId:this.artifact?.modelId??null,artifactSha256:this.artifactBinding,modelKnownAt:this.modelKnownAt,
   artifactValidation:copy(this.artifactValidation),trainingInformationCutoff:this.artifact?.trainingInformationCutoff??null,
   modelCalibration:copy(this.artifact?.calibration??null),probabilityReason:'unvalidated-model-no-automatic-promotion',
   lastFrameAt:this.lastFrameAt,lastReset:copy(this.lastReset),restoreError:this.restoreError,writeError:this.writeError,
   points:this.points.length,pendingRounds:this.pending.size,statistics:copy(this.statistics),
   descriptiveWinRate:n?this.statistics.wins/n:null,current:copy(this.latest),lastOutcome:copy([...this.outcomes.values()].at(-1)??null)};
 }
 close(){if(!this.closed){this._emit({...baseFlags,kind:'terminal-admission-shadow-stop',version:terminalAdmissionShadowVersion,time:this.clock(),modelId:this.artifact?.modelId??null});this.closed=true;}return this.summary();}
}
