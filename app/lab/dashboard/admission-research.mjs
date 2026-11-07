import {TerminalAdmissionShadow,loadTerminalAdmissionArtifact} from './terminal-admission-shadow.mjs';
import {computeProbabilitySizingShadow} from './probability-sizing.mjs';
import {OrderflowRecorder} from './orderflow-recorder.mjs';
import {AdmissionValidation} from './admission-validation.mjs';

export const admissionResearchVersion='btc5m-admission-research-v1';
const copy=x=>structuredClone(x),finite=Number.isFinite;
const flags=Object.freeze({scope:'shadow-only',adopted:false,realTrading:false,actualAllocation:.025,actualOrdersPlaced:0});

// This wrapper owns evidence only. No broker, order or account mutator is passed
// to either observer. Stage changes never select a production strategy/profile.
export class AdmissionResearch {
 constructor({config={},clock=Date.now,saved=null,context=()=>({}),recorderFactory=o=>new OrderflowRecorder(o),recorderOptions={}}={}){
  this.clock=clock;this.context=context;this.stage=config.stage??0;this.directory=config.directory??null;
  this.observer=null;this.recorder=null;this.error=null;this.closed=false;this.sizing=null;this.sizingHistory=null;
  this.validation=null;
  this.lastSizingAt=null;this.lastSizingKey=null;this.lastGap=null;this.pendingGapReset=false;this.gapEvents=0;
  if(![0,2,3].includes(this.stage)){this.stage=0;this.error='unsupported-admission-research-stage';return;}
  if(this.stage===0)return;
  try{
   if(typeof config.artifactPath!=='string'||!config.artifactPath||typeof this.directory!=='string'||!this.directory||
    !/^[a-f0-9]{64}$/.test(config.artifactSha256??''))throw Error('shadow-artifact-path-digest-and-directory-required');
   const artifact=loadTerminalAdmissionArtifact(config.artifactPath,{expectedSha256:config.artifactSha256});
   this.artifactSha256=artifact.artifactSha256;
   const cache=saved?.version===admissionResearchVersion&&saved.artifactSha256===this.artifactSha256?saved:null;
   this.sizingHistory=cache?.sizingHistory??null;
   this.gapEvents=Number.isSafeInteger(cache?.gapEvents)&&cache.gapEvents>=0?cache.gapEvents:0;
   this.lastGap=cache?.lastGap??null;
   this.recorder=recorderFactory({maxQueueBytes:2*1024*1024,maxQueueRows:4096,batchBytes:64*1024,...recorderOptions,
    directory:this.directory,clock,onGap:gap=>{this.lastGap=copy(gap);this.gapEvents++;this.pendingGapReset=true;}});
   this.observer=new TerminalAdmissionShadow({artifact,clock,saved:cache?.terminal??null,write:row=>this.record(row)});
   if(config.validationEnabled===true)this.validation=new AdmissionValidation({clock,saved:cache?.validation??null,write:row=>this.record(row)});
   this.record({kind:'admission-research-start',time:clock(),stage:this.stage,modelId:artifact.modelId,
    artifactSha256:this.artifactSha256,continuity:'new-recording-run; saved forecasts retain original information times'});
  }catch(error){this.error=String(error?.message??error);}
 }
 record(row){
  if(!this.recorder)return false;
  try{return this.recorder.record({...row,...flags,researchVersion:admissionResearchVersion,stage:this.stage,
   receivedAt:finite(row.time)?row.time:this.clock(),context:copy(this.context())});}
  catch(error){this.error=String(error?.message??error);return false;}
 }
 guard(work,fallback=null){try{return work();}catch(error){this.error=String(error?.message??error);this.sizing=null;return fallback;}}
 clearCurrent(reason='source-unavailable',now=this.clock()){
  this.sizing=null;this.lastSizingKey=null;
  if(this.observer)this.guard(()=>this.observer.reset(reason,now));
  if(this.validation)this.guard(()=>this.validation.gap(reason,now));
 }
 invalidateBook(reason='book-source-unavailable',now=this.clock()){
  this.sizing=null;this.lastSizingKey=null;
  if(this.observer)this.guard(()=>this.observer.invalidateBook(reason,now));
  if(this.validation)this.guard(()=>this.validation.gap(reason,now));
 }
 prepare(now){
  if(this.pendingGapReset){this.pendingGapReset=false;this.clearCurrent('research-recording-gap',now);}
 }
 observeReference(reference,{now=this.clock(),clockReady=false}={}){
  if(!this.observer||this.closed)return false;
  return this.guard(()=>{this.prepare(now);const accepted=this.observer.observeReference(reference,{now,clockReady});
   if(!accepted)this.sizing=null;return accepted;},false);
 }
 observe(frame,{reference=frame?.twap,opening=frame?.rayOpening,calendar=null,actual=null,equity=null,cash=null,
  roundUsedShares=0,maxShares=100,flow=null,now=this.clock()}={}){
  if(!this.observer||this.closed)return null;
  return this.guard(()=>{
   this.prepare(now);
   const terminal=this.observer.observe(frame,{reference,opening,calendar,actual,now});
   this.validation?.observe({...frame,rayOpening:opening},{now,terminal,flow,reference,actual});
   if(this.stage!==3){this.sizing=null;return terminal;}
   if(!terminal?.predictionId){this.sizing=null;this.lastSizingKey=null;return terminal;}
   const key=[terminal.slug,terminal.outcome,terminal.timeBucket].join(':');
   if(this.sizing?.slug!==terminal.slug||this.sizing?.outcome!==terminal.outcome)this.sizing=null;
   if(this.lastSizingKey===key&&this.lastSizingAt!==null&&now-this.lastSizingAt<1000)return terminal;
   const book=frame.books?.find(b=>b.tokenId===terminal.tokenId);
   // No usable calibrated probability exists. Never pass the tail quantile as p.
   const sizing=computeProbabilitySizingShadow({equity,cash,book,market:frame.market,now,roundUsedShares,maxShares,prediction:null});
   Object.assign(sizing,{slug:terminal.slug,outcome:terminal.outcome,tokenId:terminal.tokenId,
    sourcePredictionId:terminal.predictionId,sourceTwapAt:terminal.twapAt,sourceFrameAt:frame.now,
    sourceClockReady:frame.clock?.ready===true});
   this.sizing=sizing;this.sizingHistory=copy(sizing);this.lastSizingAt=now;this.lastSizingKey=key;
   this.record({kind:'probability-sizing-shadow',...sizing});return terminal;
  });
 }
 acceptLabels(labels,{now=this.clock()}={}){
  if(!this.observer||this.closed)return 0;
  return this.guard(()=>{let accepted=0;for(const slug of new Set([...this.observer.pending.keys(),...this.validation?.rounds.keys()??[]])){
   const label=labels?.get?.(slug);if(label){
    if(this.observer.pending.has(slug)&&this.observer.acceptLabel(label,{now}))accepted++;
    if(this.validation?.rounds.has(slug))this.validation.acceptLabel(label,now);
   }
  }return accepted;},0);
 }
 pendingMarkets(){return this.guard(()=>[...new Map([...(this.observer?copy([...this.observer.pending.values()].map(p=>p.market)):[]),
  ...this.validation?.pendingMarkets()??[]].map(m=>[m.slug,m])).values()],[]);}
 saved(){return this.guard(()=>({version:admissionResearchVersion,stage:this.stage,artifactSha256:this.artifactSha256??null,
  terminal:this.observer?.saved()??null,validation:this.validation?.saved()??null,sizingHistory:copy(this.sizingHistory),lastGap:copy(this.lastGap),gapEvents:this.gapEvents}),null);}
 summary(now=this.clock()){
  return this.guard(()=>{
   const terminal=this.observer?.summary(now)??null,recording=this.recorder?.summary()??null;
   // A retained diagnostic is history after restart/round change or source gap.
   // A fresh frame will create a new one; stale liquidity is never called current.
   const fresh=this.sizing&&finite(now)&&this.sizing.sourceClockReady===true&&now>=this.sizing.time&&now-this.sizing.time<=3000&&
    now>=this.sizing.sourceTwapAt&&now-this.sizing.sourceTwapAt<=5000&&terminal?.current?.slug===this.sizing.slug&&
    terminal.current.outcome===this.sizing.outcome&&terminal.current.book?.bothFresh===true;
   return {version:admissionResearchVersion,...flags,stage:this.stage,
    status:this.stage===0?'disabled':this.error?'unavailable':this.closed?'closed':!this.observer?'unavailable':'observing',
    terminal,validation:this.validation?.summary()??null,sizing:fresh?copy(this.sizing):null,sizingStatus:this.stage<3?'disabled':fresh?'unvalidated':'unknown',
    recording,lastGap:copy(this.lastGap),gapEvents:this.gapEvents,error:this.error};
  },{version:admissionResearchVersion,...flags,stage:this.stage,status:'unavailable',terminal:null,sizing:null,
   sizingStatus:'unknown',recording:null,error:this.error});
 }
 async close(){
  if(this.closePromise)return this.closePromise;
  this.closed=true;this.sizing=null;
  this.closePromise=(async()=>{this.guard(()=>this.observer?.close());try{await this.recorder?.close();}
   catch(error){this.error=String(error?.message??error);}return this.summary();})();
  return this.closePromise;
 }
}
