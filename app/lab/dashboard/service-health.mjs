import {readFileSync} from 'node:fs';
import {bookStatus} from './book-status.mjs';

export function readAuditStatus(path) {
  try { return JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,'')); }
  catch(error) { return {status:error.code==='ENOENT'?'missing':'unreadable',message:error.code==='ENOENT'?null:error.message}; }
}

// Waiting for an entry, a completed study or a paid position is not a service failure.
export function serviceHealth(state,{now=state.now,auditStatus={status:'missing'},clock=null,
  independentResearch={status:'unconfigured',hasErrors:false,services:[]}}={}) {
  const age=at=>Number.isFinite(at)&&Number.isFinite(now)?now-at:null;
  const frameAt=state.frame?.now??null,frameAgeMs=age(frameAt);
  const books=bookStatus(state.frame,now,state.config?.staleMs??3000);
  const researchErrors=Object.fromEntries(Object.entries(state.strategy??{})
    .filter(([name,value])=>(name.startsWith('research')||['evolution','observation','admissionResearch'].includes(name))&&value?.error)
    .map(([name,value])=>[name,String(value.error)]));
  if(state.dataAudit?.error)researchErrors.dataAudit=String(state.dataAudit.error);
  const admission=state.strategy?.admissionResearch;
  const admissionError=admission?.recording?.lastError??admission?.terminal?.writeError??null;
  if(admissionError)researchErrors.admissionResearch=String(admissionError);
  const independentErrors=Object.fromEntries((independentResearch.services??[]).filter(service=>!service.healthy&&!service.completed)
    .map(service=>['independent:'+service.port,service.message??service.state]));
  const allResearchErrors={...researchErrors,...independentErrors};
  const lastSuccessAt=Number.isFinite(auditStatus.lastSuccessAt)?auditStatus.lastSuccessAt:null;
  const auditConfigured=auditStatus.status!=='not-configured';
  const auditAgeMs=age(lastSuccessAt),auditStale=auditConfigured&&(auditAgeMs===null||auditAgeMs<0||auditAgeMs>660000);
  const frameStale=state.running===true&&(frameAgeMs===null||frameAgeMs<0||frameAgeMs>10000);
  return {service:'btc5m-local-dashboard',version:1,checkedAt:now,serviceAlive:true,
    main:{running:state.running===true,paused:state.paused===true,paper:state.realTrading===false,
      realTrading:state.realTrading??null,mode:state.mode??null,status:state.status??null,
      halted:state.account?.halted??null,step:state.step??null,sessionId:state.sessionId??null,
      lastFrameAt:frameAt,frameAgeMs,stale:frameStale},
    market:{slug:state.frame?.market?.slug??null,frameAvailable:Boolean(state.frame),
      referenceAvailable:state.referenceFresh===true,booksAvailable:books.fresh,books,
      sources:Object.fromEntries(Object.entries(state.sources??{}).map(([name,value])=>[name,
        {state:value.state??null,lastAt:value.now??null,message:value.message??null}]))},
    research:{errors:allResearchErrors,hasErrors:Object.keys(allResearchErrors).length>0,
      mainErrors:researchErrors,mainHasErrors:Object.keys(researchErrors).length>0,
      independentHasErrors:independentResearch.hasErrors===true},
    independentResearch,
    admissionResearch:admission?{stage:admission.stage,status:admission.status,adopted:false,actualAllocation:admission.actualAllocation,
      error:admission.error??admissionError,recording:admission.recording?{status:admission.recording.status,counts:admission.recording.counts,
        queuedRows:admission.recording.queuedRows,directory:admission.recording.directory}:null}:null,
    automaticAudit:{status:auditStale?'stale':auditStatus.status,reportedStatus:auditStatus.status,configured:auditConfigured,
      lastSuccessAt,ageMs:auditAgeMs,stale:auditStale,pid:auditStatus.pid??null,
      allHistoryVerified:auditStatus.allHistoryVerified??null,fullHistory:auditStatus.fullHistory??null,
      forwardSegment:auditStatus.forwardSegment??null,lastFullHistorySuccessAt:auditStatus.lastFullHistorySuccessAt??null,
      lastForwardSegmentSuccessAt:auditStatus.lastForwardSegmentSuccessAt??null,
      registrationId:auditStatus.registrationId??null,message:auditStatus.message??null},
    clock:state.clock??clock};
}
