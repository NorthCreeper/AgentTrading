import {randomUUID} from 'node:crypto';
import {OrderflowRecorder} from './orderflow-recorder.mjs';
import {OrderflowShadow} from './orderflow-shadow.mjs';

// Single optional lifecycle for the public feed. Failures stay in research.
export class OrderflowResearch {
 constructor({directory,clock=Date.now,onDepthResnapshot=()=>{},recorderOptions={},shadowOptions={}}={}){
  this.clock=clock;this.runId=randomUUID();this.observationSequence=0;this.closed=false;this.error=null;
  this.clockGateReady=null;this.clockQuality={status:'not-provided',provided:false,ready:null};this.clockTransitions={invalidations:0,recoveries:0};this.transport=null;
  this.shadow=new OrderflowShadow({...shadowOptions,clock,onDepthResnapshot});
  this.recorder=new OrderflowRecorder({...recorderOptions,directory,clock,onGap:gap=>this.shadow.recordingGap(gap)});
 }
 updateClockQuality(quality,time,source){
  if(typeof quality?.ready!=='boolean'){
   this.clockQuality={status:'not-provided',provided:false,ready:null,effectiveReady:this.clockGateReady,lastObservedAt:time,source};return;
  }
  const previous=this.clockGateReady;this.clockGateReady=quality.ready;
  this.clockQuality={...this.clockQuality,...quality,status:quality.ready?'ready':'unavailable',provided:true,ready:quality.ready,effectiveReady:quality.ready,lastObservedAt:time,source};
  if(previous!==false&&quality.ready===false){
   this.clockTransitions.invalidations++;this.shadow.resetFlow('clock-unavailable');this.shadow.resetDepth('clock-unavailable');this.shadow.latest=null;this.shadow.lastSampleSlot=null;
  }else if(previous===false&&quality.ready===true){
   this.clockTransitions.recoveries++;this.shadow.resetFlow('clock-recovered-warming-up');this.shadow.resetDepth('clock-recovered-awaiting-snapshot');this.shadow.latest=null;this.shadow.lastSampleSlot=null;this.shadow.requestSnapshot('clock-recovered');
  }
 }
 trackTransport(row){
  if(row.kind!=='feed-status'||row.venue!=='binance'||!['connected','connecting','disconnected','stale','error','stopped'].includes(row.state))return;
  this.transport={venue:'binance',state:row.state,connectionId:row.connectionId??this.transport?.connectionId??null,receivedAt:row.receivedAt};
  if(this.clockGateReady===false){
   // Transport identity can be tracked without trusting a market timestamp.
   // In particular, do not swallow the first connected event during startup.
   this.shadow.setConnection(this.transport.connectionId);this.shadow.connected=row.state==='connected';
  }
 }
 raw(row){
  if(this.closed)return false;
  try{
   const observed={...row,observationRunId:this.runId,observationSequence:++this.observationSequence};
   this.updateClockQuality(row.clockQuality,row.receivedAt,'raw');this.trackTransport(row);
   if(!this.recorder.record(observed))return false;
   if(this.clockGateReady!==false)this.shadow.ingest(observed);
   return true;
  }
  catch(error){this.error=error.message;this.shadow.recordingGap({reason:'research-callback-failure'});return false;}
 }
 sample(context={}){
  if(this.closed)return null;
  try{
   if(typeof context.clockReady==='boolean')this.updateClockQuality({...context.clockQuality,ready:context.clockReady},context.now??this.clock(),'sample');
   const sample=this.shadow.sample({...context,observationRunId:this.runId,lastObservationSequence:this.observationSequence});if(!sample)return null;
   sample.recording=this.recorder.summary();sample.clockQuality={...this.clockQuality};sample.clockReady=this.clockGateReady;
   if(!this.recorder.record({kind:'shadow-sample',receivedAt:sample.time,sample}))return null;
   return sample;
  }catch(error){this.error=error.message;this.shadow.recordingGap({reason:'research-sample-failure'});return null;}
 }
 summary(now=this.clock()){return {version:'btc-orderflow-research-v1',mode:'shadow-only',closed:this.closed,error:this.error,runId:this.runId,observationSequence:this.observationSequence,clockQuality:{...this.clockQuality},clockReady:this.clockGateReady,clockTransitions:{...this.clockTransitions},transport:this.transport?{...this.transport}:null,recording:this.recorder.summary(),shadow:this.shadow.summary(now),executionConnected:false,validatedAllocationChange:false};}
 async close(){if(this.closed)return;this.closed=true;try{await this.recorder.close();}catch(error){this.error=error.message;}}
}
