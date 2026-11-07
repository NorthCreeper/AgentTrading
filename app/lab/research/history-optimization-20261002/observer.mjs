// GET-only independent prospective paper accounts; no main controller/account import.
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync,statSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {resolve,join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ReplayMachine,sourceRegistration,promotionScreen} from './replay.mjs';
import {candidates,candidateExit,suiteProtocol,evidenceOnly} from './suite.mjs';
import {validExecutionMarket} from './execution-policies.mjs';
import {marketKey} from './history-catalog.mjs';
import {evolutionBook,stepEvolutionPortfolio,validateEvolutionPortfolio} from './portfolio.mjs';
import {BidHistory} from '../../dashboard/bid-exit.mjs';
import {verifyResolution} from '../../dashboard/settlement.mjs';
import {verifyPayoutResolution} from '../../dashboard/payout-resolution.mjs';
const here=dirname(fileURLToPath(import.meta.url)),lab=resolve(here,'../..'),finite=Number.isFinite,
 sha=b=>createHash('sha256').update(b).digest('hex'),parse=b=>JSON.parse(String(b).replace(/^\uFEFF/,'')),
 read=p=>parse(readFileSync(p,'utf8')),clone=structuredClone;
export const observerProtocol=Object.freeze({version:'history-prospective-observer-v1',paperOnly:true,
 initialCapital:100,pollMs:1000,host:'127.0.0.1',port:18791,producer:'http://127.0.0.1:18790/api/state',
 methods:['GET'],mainControls:false,bootstrap:false,independentCash:true,officialGlobalIntervalMs:15000,
 officialPerSlugIntervalMs:60000,quoteAgeMs:3000,pause:'main running auto and not paused only; cancel buys; expiry/payment continue',
 promotion:'Prospective results never alter main funds or strategy'});
export function encodeMachine(m){return JSON.parse(JSON.stringify(m,(k,v)=>v instanceof Map?{$type:'Map',entries:[...v]}:
 v instanceof Set?{$type:'Set',values:[...v]}:typeof v==='function'?undefined:v));}
function decode(v){
 if(Array.isArray(v))return v.map(decode);if(v&&typeof v==='object'){
 if(v.$type==='Map')return new Map(v.entries.map(([k,v])=>[k,decode(v)]));if(v.$type==='Set')return new Set(v.values.map(decode));
 return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,decode(v)]));}return v;
}
export function restoreMachine(saved,options){
 const data=decode(saved),m=new ReplayMachine(options),expected=m.arms;
 if(data.prospective!==true||data.arms?.length!==expected.length)throw Error('Invalid prospective checkpoint');
 for(let i=0;i<expected.length;i++){const a=data.arms[i],e=expected[i];
 if(a.account.id!==e.account.id||JSON.stringify(a.candidate)!==JSON.stringify(e.candidate)||
 JSON.stringify(a.scenario)!==JSON.stringify(e.scenario))throw Error('Candidate registration differs');
 validateEvolutionPortfolio(a.account);a.exit=candidateExit(e.candidate);}
 Object.assign(m,data);m.bidHistory=new BidHistory();m.bidHistory.rows=data.bidHistory.rows;return m;
}
function atomic(path,v){const tmp=path+'.'+randomUUID()+'.tmp',fd=openSync(tmp,'wx');
 try{writeFileSync(fd,JSON.stringify(v));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);}
function append(path,line){const fd=openSync(path,'a');try{writeFileSync(fd,line+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
const record=(sequence,prev,payload)=>{const body={sequence,prev,payload};return {...body,hash:sha(JSON.stringify(body))};};
export function journalEvent(input,event,index){
 const entityId=event.entityId??event.id;
 return {...event,...(entityId!==undefined?{entityId}:{}),
 ...(['opened','closed'].includes(event.kind)&&!event.tradeId&&entityId?{tradeId:entityId}:{}),
 id:input.hash+':'+index,inputSequence:input.sequence,inputHash:input.hash};
}
function chain(path){
 if(!existsSync(path))return {rows:[],last:0,hash:null};
 const b=readFileSync(path);if(b.length&&b.at(-1)!==10)throw Error('Incomplete append-only tail retained for review');
 const rows=b.toString('utf8').split('\n').filter(Boolean).map(parse);let n=0,prev=null;
 for(const r of rows){if(r.sequence!==++n||r.prev!==prev||r.hash!==sha(JSON.stringify({sequence:r.sequence,prev:r.prev,payload:r.payload})))throw Error('Evidence chain differs');prev=r.hash;}
 return {rows,last:n,hash:prev};
}
const live=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
export function acquireObserverLock(dir){
 const path=join(dir,'worker.lock.json'),token=randomUUID();
 if(existsSync(path)){const old=read(path);if(!Number.isInteger(old.pid)||old.pid<=0||typeof old.token!=='string')throw Error('Unverifiable worker lock retained');
 if(live(old.pid))throw Error('Live observer lock; no second worker started');unlinkSync(path);}
 const fd=openSync(path,'wx');try{writeFileSync(fd,JSON.stringify({pid:process.pid,token,at:Date.now()}));fsyncSync(fd);}finally{closeSync(fd);}
 return ()=>{if(existsSync(path)&&read(path).token===token)unlinkSync(path);};
}
function inputs(reportPath,registrationPath,certificatePath,now){
 const rb=readFileSync(reportPath),gb=readFileSync(registrationPath),cb=readFileSync(certificatePath),
 r=parse(rb),g=parse(gb),c=parse(cb),current=sourceRegistration(['parallel-replay.mjs']);
 if(r.version!==suiteProtocol.version||!Array.isArray(r.promotion?.checks)||!Array.isArray(r.promotion?.eligible)||
 !finite(r.causalSeed?.knownAt)||r.causalSeed.knownAt>now||!finite(r.cutoff)||r.cutoff>now||!g.sources||
 !isDeepStrictEqual(g.sources,current)||!isDeepStrictEqual(r.sources,current)||!isDeepStrictEqual(c.sources,current)||
 c.version!==suiteProtocol.version||c.realTrading!==false||!finite(c.completedAt)||c.completedAt>now||
 c.reportSha256!==sha(rb)||c.registrationSha256!==sha(gb)||g.cutoff!==r.cutoff||
 !isDeepStrictEqual(c.eligible,r.promotion.eligible))throw Error('Final certificate/report missing, noncausal, or historical source closure changed');
 const expectedKeys=new Set(suiteProtocol.scopes.flatMap(scope=>suiteProtocol.scenarios.flatMap(scenario=>
 candidates.map(candidate=>[scope,scenario.id,candidate.id].join(':'))))),
 accountKeys=Array.isArray(r.accounts)?r.accounts.map(a=>[a.scope,a.scenario,a.id].join(':')):[];
 if(g.version!==suiteProtocol.version||!isDeepStrictEqual(g.protocol,suiteProtocol)||
 !isDeepStrictEqual(g.candidates,candidates)||!isDeepStrictEqual(g.evidenceOnly,evidenceOnly)||
 !isDeepStrictEqual(g.split,r.split)||!/^([a-f0-9]{64})$/.test(g.catalogSha256??'')||
 g.catalogSha256!==r.catalogSha256||accountKeys.length!==expectedKeys.size||
 new Set(accountKeys).size!==expectedKeys.size||accountKeys.some(k=>!expectedKeys.has(k)))
 throw Error('Historical declaration or full independent account coverage is incomplete');
 if(!isDeepStrictEqual(promotionScreen(r),r.promotion))throw Error('Historical promotion screen differs from independent calculation');
 const checks=new Map(r.promotion.checks.map(c=>[c.id,c])),eligible=new Set(r.promotion.eligible);
 if(checks.size!==candidates.length-1||candidates.some(c=>c.id!=='baseline'&&!checks.has(c.id))||
 [...checks.values()].some(c=>typeof c.pass!=='boolean'||c.pass!==eligible.has(c.id)))throw Error('Incomplete or inconsistent historical candidate screen');
 return {report:r,registration:g,reportHash:sha(rb),registrationHash:sha(gb),certificateHash:sha(cb),
 candidateIds:candidates.filter(c=>c.id==='baseline'||checks.get(c.id).pass===false).map(c=>c.id)};
}
const split=now=>({dates:[],train:[],validation:[],test:[],validationAt:now,testAt:now,partialBoundaryDates:[]});
export class ProspectiveObserver{
 constructor({directory,reportPath,registrationPath,certificatePath=reportPath&&join(dirname(reportPath),'certificate.json'),fetchImpl=fetch,now=Date.now,producer=observerProtocol.producer,
 runtime=join(lab,'dashboard/runtime'),launcherPath=resolve(lab,'../../..','启动BTC历史候选观察.ps1')}={}){
 if(!directory||!reportPath||!registrationPath)throw Error('Report, registration and independent directory required');
 this.directory=resolve(directory);this.reportPath=resolve(reportPath);this.registrationPath=resolve(registrationPath);
 this.certificatePath=resolve(certificatePath);
 this.fetch=fetchImpl;this.clock=now;this.producer=producer;this.runtime=resolve(runtime);this.launcherPath=resolve(launcherPath);
 const u=new URL(producer);if(u.origin!=='http://127.0.0.1:18790'||u.pathname!=='/api/state'||u.search||u.hash)throw Error('Only original GET /api/state is allowed');
 if(this.directory===lab||this.directory===this.runtime||!relative(this.directory,this.runtime).startsWith('..')||
 !relative(this.runtime,this.directory).startsWith('..'))throw Error('Output cannot be production runtime or its ancestors');
 this.queue=Promise.resolve();this.closed=false;this.pollBusy=false;this.officialBusy=false;
 }
 async initialize(){
 const now=this.clock();this.inputs=inputs(this.reportPath,this.registrationPath,this.certificatePath,now);
 const marker=join(this.directory,'observer-registration.json');
 if(existsSync(this.directory)&&!existsSync(marker)&&readdirSync(this.directory).some(n=>
 !['worker-output.log','worker-error.log'].includes(n)||statSync(join(this.directory,n)).size!==0))throw Error('Unregistered existing output retained');
 mkdirSync(this.directory,{recursive:true});this.releaseLock=acquireObserverLock(this.directory);
 try{
 const binding={version:observerProtocol.version,reportHash:this.inputs.reportHash,historicalRegistrationHash:this.inputs.registrationHash,
 historicalCertificateHash:this.inputs.certificateHash,sources:sourceRegistration(['observer.mjs','parallel-replay.mjs']),launcherHash:sha(readFileSync(this.launcherPath)),
 uiHash:sha(readFileSync(join(here,'observer.html'))),candidateIds:this.inputs.candidateIds,protocol:observerProtocol};
 if(existsSync(marker)){const old=read(marker);if(JSON.stringify(old.binding)!==JSON.stringify(binding))throw Error('Observer code/launcher/input binding changed');this.registeredAt=old.createdAt;}
 else{this.registeredAt=now;atomic(marker,{createdAt:now,binding});}this.binding=binding;
 this.options={rounds:[],labels:[],cutoff:this.registeredAt,split:split(this.registeredAt),prospective:true,
 seed:this.inputs.report.causalSeed,candidateIds:this.inputs.candidateIds};this.machine=new ReplayMachine(this.options);
 this.state={version:observerProtocol.version,inputSequence:0,inputHash:null,lastFrameNow:null,lastFrameHash:null,lastPollAt:null,
 lastNewFrameAt:null,lastOfficialSweep:null,lastNetworkAt:null,officialAttempts:{},evidenceSeen:[],labelsAccepted:[],
 knownMarkets:{},status:'stale',error:null,fatal:false,frames:0,cached:0,pendingOutbox:[],journalSequence:0,journalHash:null};
 const path=join(this.directory,'checkpoint.json');if(existsSync(path)){const cp=read(path);
 if(cp.hash!==sha(JSON.stringify(cp.payload))||cp.payload.bindingHash!==sha(JSON.stringify(binding)))throw Error('Checkpoint binding/checksum differs');
 this.state=cp.payload.state;this.machine=restoreMachine(cp.payload.machine,this.options);}
 const raw=chain(join(this.directory,'inputs.jsonl')),journal=chain(join(this.directory,'journal.jsonl'));
 this.inputRows=raw.rows;this.journalIds=new Map(journal.rows.map(r=>[r.payload.id,r]));this.journalSequence=journal.last;this.journalHash=journal.hash;
 if(this.journalIds.size!==journal.rows.length||this.state.inputSequence>raw.last||
 this.state.inputSequence&&raw.rows[this.state.inputSequence-1].hash!==this.state.inputHash||
 this.state.journalSequence>journal.last||this.state.journalSequence&&journal.rows[this.state.journalSequence-1].hash!==this.state.journalHash)throw Error('Checkpoint differs from append-only cursors');
 this.flushOutbox();for(const r of raw.rows.slice(this.state.inputSequence))this.applyRecord(r);
 if(this.state.storageFailure){const priorFailure=this.state.storageFailure;delete this.state.storageFailure;
  if(this.state.fatal){this.state.status='error';this.state.error=this.state.fatalReason??priorFailure.previousError??'Fatal strategy input remains rejected';}
  else{this.state.status='stale';this.state.error=null;}}
 this.save();return this;
 }catch(e){this.releaseLock?.();throw e;}
 }
 save(){const payload={bindingHash:sha(JSON.stringify(this.binding)),state:this.state,machine:encodeMachine(this.machine)};
 atomic(join(this.directory,'checkpoint.json'),{payload,hash:sha(JSON.stringify(payload))});}
 flushOutbox(){
 for(const e of this.state.pendingOutbox){const old=this.journalIds.get(e.id);if(old){if(JSON.stringify(old.payload)!==JSON.stringify(e))throw Error('Recovered event content differs');continue;}
 const r=record(++this.journalSequence,this.journalHash,e);append(join(this.directory,'journal.jsonl'),JSON.stringify(r));this.journalHash=r.hash;this.journalIds.set(e.id,r);}
 this.state.pendingOutbox=[];this.state.journalSequence=this.journalSequence;this.state.journalHash=this.journalHash;
 }
 async commit(payload){
 const next=this.queue.then(()=>{if(this.closed)return [];if(this.storageFailed)throw Error(this.storageFailed);
 const r=record(this.state.inputSequence+1,this.state.inputHash,payload);
 append(join(this.directory,'inputs.jsonl'),JSON.stringify(r));this.inputRows.push(r);return this.applyRecord(r);});
 this.queue=next.catch(e=>{const previousError=this.state.error;this.storageFailed=e.message;this.state.status='error';this.state.error='Evidence storage failed; stopped until restart: '+e.message;
 this.state.storageFailure={at:this.clock(),message:e.message,previousError};try{this.save();}catch(saveError){console.error('Cannot persist stopped observer status: '+saveError.message);}});return next;
 }
 applyRecord(r){
 if(r.sequence!==this.state.inputSequence+1||r.prev!==this.state.inputHash)throw Error('Input cursor differs');
 const priorState=clone(this.state),priorMachine=encodeMachine(this.machine);let events;
 try{events=this.applyPayload(r.payload);}catch(e){this.state=priorState;this.machine=restoreMachine(priorMachine,this.options);
 this.state.fatal=true;this.state.fatalReason=e.message;this.state.status='error';this.state.error=e.message;events=[{kind:'fatal-input-rejected',at:r.payload.observedAt,reason:e.message}];}
 this.state.inputSequence=r.sequence;this.state.inputHash=r.hash;
 this.state.pendingOutbox=events.map((e,i)=>journalEvent(r,e,i));
 this.save();this.flushOutbox();this.save();atomic(join(this.directory,'status.json'),this.summary());return events;
 }
 acceptEvidence(raw,learnedAt){
 const expected=this.state.knownMarkets[raw?.market?.slug],hash=sha(JSON.stringify(raw));
 if(this.state.evidenceSeen.includes(hash))return [];
 if(!expected||marketKey(raw.market)!==marketKey(expected)||!finite(raw.observedAt)||raw.observedAt>learnedAt)return [{kind:'official-rejected',at:learnedAt,reason:'unknown-or-future-identity',rawHash:hash}];
 this.state.evidenceSeen.push(hash);const events=[];
 for(const [scope,verify]of [['strict',verifyResolution],['financial',verifyPayoutResolution]]){
 let label;try{label=verify(expected,raw.gamma,raw.clob,raw.observedAt);}catch(e){events.push({kind:'official-unverified',scope,at:learnedAt,rawHash:hash,reason:e.message});continue;}
 if(!label)continue;const old=this.state.labelsAccepted.find(l=>l.scope===scope&&l.label.slug===label.slug),
 any=this.state.labelsAccepted.find(l=>l.label.slug===label.slug);
 if(any&&any.label.winner!==label.winner)throw Error('Conflicting official winner; entries stopped');if(old)continue;
 const event={scope,at:Math.max(learnedAt,label.observedAt),label,rawHash:hash,sourceObservedAt:label.observedAt};
 this.state.labelsAccepted.push(event);events.push({kind:'official-accepted',at:event.at,scope,slug:label.slug,sourceObservedAt:label.observedAt,rawHash:hash});
 if(scope==='strict')this.machine.labels.push(event);
 if(!this.machine.financial.has(label.slug)){this.machine.financial.set(label.slug,label);this.machine.payments.push(event);}
 }return events;
 }
 maintain(now,allowEntry){
 const events=this.machine.advancePayments(now);this.machine.processLabels(now);
 for(const arm of this.machine.arms){const a=arm.account,expired=a.position&&now>=a.position.market.end,
 timeout=a.pendingBuy&&now>a.pendingBuy.executeAt+3000,cancel=!allowEntry&&(a.pendingBuy||a.retryState),
 payment=[a.position,...a.pendingSettlements].some(t=>t&&this.machine.financial.get(t.slug)?.observedAt<=now);
 if(a.lastAt!==null&&now>a.lastAt&&(expired||timeout||cancel||payment))
 for(const e of stepEvolutionPortfolio(a,{frame:null,now,eventOnly:true},this.machine.financial,null,allowEntry,arm.exit))
 events.push({scope:arm.scope,scenario:arm.scenario.id,candidate:arm.candidate.id,...e});
 }return events;
 }
 clearConfirmations(now){
 const events=[];this.machine.history=[];this.machine.bidHistory=new BidHistory();
 for(const arm of this.machine.arms){arm.account.signalHistory=[];const t=arm.account.position;if(!t)continue;
 if(t.pendingExit)events.push({kind:'exit-cancelled',at:now,candidate:arm.candidate.id,scenario:arm.scenario.id,
 tradeId:t.id,slug:t.slug,reason:'main-not-running-auto'});
 for(const k of ['pendingExit','marketReversal','bidReversal','delayedMarketExit','holdingDecision','bidDecision','consensusDecision'])delete t[k];
 }return events;
 }
 applyPayload(p){
 const now=p.observedAt;if(!finite(now)||now<this.registeredAt||now<(this.machine.evidenceAt??this.registeredAt))throw Error('Noncausal input clock');
 if(this.state.fatal)return [];
 this.machine.cutoff=now;this.machine.evidenceAt=now;
 if(p.kind==='official'){const events=this.acceptEvidence(p.raw,now);events.push(...this.maintain(now,this.state.status==='running'));return events;}
 if(p.kind==='error'){this.state.lastPollAt=now;this.state.status='error';this.state.error=p.error;
 return [{kind:'observation-error',at:now,reason:p.error},...this.maintain(now,true)];}
 const s=p.state;this.state.lastPollAt=now;this.state.error=null;
 if(s.realTrading!==false||!finite(s.now)||s.now>now)throw Error('Invalid producer identity/time');
 const allowed=s.running===true&&s.mode==='auto'&&s.paused!==true&&!s.halted&&s.status!=='halted',
 f=s.frame,valid=Boolean(f&&validExecutionMarket(f.market)&&finite(f.now)&&f.now<=now&&now-f.now<=3000&&
 ['Up','Down'].some(o=>evolutionBook(f,f.market,o,now))),signature=f?sha(JSON.stringify(f)):null,
 fresh=valid&&(this.state.lastFrameNow===null||f.now>this.state.lastFrameNow);
 if(f&&f.now===this.state.lastFrameNow&&this.state.lastFrameHash!==signature)throw Error('Same frame time changed content');
 const events=this.maintain(now,allowed);
 if(!allowed){events.push(...this.clearConfirmations(now));this.state.status='paused';return events;}
 if(!fresh){this.state.status=valid?'running':'stale';this.state.cached++;return events;}
 this.state.knownMarkets[f.market.slug]??=clone(f.market);
 if(marketKey(this.state.knownMarkets[f.market.slug])!==marketKey(f.market))throw Error('Immutable market identity changed');
 const prices=(s.priceHistory??[]).filter(r=>finite(r.time)&&finite(r.receivedAt)&&r.time<=r.receivedAt&&r.receivedAt<=now);
 this.state.lastFrameNow=f.now;this.state.lastFrameHash=signature;this.state.lastNewFrameAt=now;this.state.frames++;
 events.push(...this.machine.step(f,prices,now));this.state.status='running';return events;
 }
 async get(url){
 const startedAt=this.clock(),response=await this.fetch(url,{method:'GET',cache:'no-store',signal:AbortSignal.timeout(6000)});
 if(!response.ok)throw Error('GET '+response.status+' '+new URL(url).pathname);
 const bytes=await response.text();return {data:parse(bytes),sha256:sha(bytes),startedAt,completedAt:this.clock()};
 }
 async pollOnce(){
 if(this.closed||this.pollBusy||this.storageFailed)return [];this.pollBusy=true;
 try{const r=await this.get(this.producer),s=r.data,state={now:s.now,sessionId:s.sessionId,realTrading:s.realTrading,
 running:s.running,mode:s.mode,paused:s.paused,status:s.status,halted:s.account?.halted??s.halted??null,frame:s.frame,history:s.history,priceHistory:s.priceHistory};
 return await this.commit({kind:'state',observedAt:r.completedAt,requestStartedAt:r.startedAt,apiSha256:r.sha256,state});}
 catch(e){if(this.storageFailed)throw e;return await this.commit({kind:'error',observedAt:this.clock(),error:e.message});}finally{this.pollBusy=false;}
 }
 subjects(now){
 const wanted=new Set(this.machine.arms.flatMap(a=>[a.account.position,...a.account.pendingSettlements].filter(Boolean).map(t=>t.slug)));
 for(const f of this.machine.forecasts.values())if(!f.updated)wanted.add(f.slug);
 return [...wanted].map(s=>this.state.knownMarkets[s]).filter(m=>m&&now>=m.end);
 }
 async pollOfficial(){
 if(this.closed||this.officialBusy||this.storageFailed)return;const now=this.clock();
 if(this.state.lastOfficialSweep!==null&&now-this.state.lastOfficialSweep<15000)return;
 this.officialBusy=true;this.state.lastOfficialSweep=now;
 try{
 for(const m of this.subjects(now))for(const sub of ['outcomes','financial-outcomes']){
 const path=join(this.runtime,sub,m.slug+'.json');if(!existsSync(path))continue;
 let bytes,raw;try{bytes=readFileSync(path);raw=parse(bytes);}catch{continue;}
 if(this.state.evidenceSeen.includes(sha(JSON.stringify(raw))))continue;
 await this.commit({kind:'official',observedAt:this.clock(),source:'original-runtime-file',path,rawSha256:sha(bytes),raw});}
 const ms=this.subjects(this.clock()).filter(m=>this.clock()-(this.state.officialAttempts[m.slug]??-Infinity)>=60000);
 if(!ms.length||this.state.lastNetworkAt!==null&&this.clock()-this.state.lastNetworkAt<15000)return;
 const m=ms.sort((a,b)=>a.end-b.end||a.slug.localeCompare(b.slug))[0];
 this.state.lastNetworkAt=this.clock();this.state.officialAttempts[m.slug]=this.state.lastNetworkAt;
 const rs=await Promise.all([this.get('https://gamma-api.polymarket.com/markets/slug/'+m.slug),
 this.get('https://clob.polymarket.com/markets/'+m.conditionId)]);
 const observedAt=this.clock(),raw={market:clone(m),gamma:rs[0].data,clob:rs[1].data,observedAt,
 requests:rs.map(r=>({startedAt:r.startedAt,completedAt:r.completedAt,sha256:r.sha256}))},hash=sha(JSON.stringify(raw));
 const dir=join(this.directory,'official');mkdirSync(dir,{recursive:true});const path=join(dir,hash+'.json');
 if(!existsSync(path))writeFileSync(path,JSON.stringify(raw),{flag:'wx'});
 await this.commit({kind:'official',observedAt,source:'own-official-GET',rawSha256:hash,raw});
 }catch(e){if(this.storageFailed)throw e;await this.commit({kind:'error',observedAt:this.clock(),error:'Official evidence: '+e.message});}
 finally{this.officialBusy=false;}
 }
 summary(){
 const report=this.machine.summary(),reasons=new Map(this.inputs.report.promotion.checks.map(c=>[c.id,c.reasons??[]]));
 return {version:observerProtocol.version,realTrading:false,mainCashUsed:false,status:this.state.status,error:this.state.error,
 fatal:this.state.fatal||Boolean(this.storageFailed),healthy:!this.state.fatal&&!this.storageFailed,
 createdAt:this.registeredAt,lastPollAt:this.state.lastPollAt,lastNewFrameAt:this.state.lastNewFrameAt,lastFrameAt:this.state.lastFrameNow,frames:this.state.frames,
 cachedObservations:this.state.cached,inputSequence:this.state.inputSequence,registrationHash:this.inputs.registrationHash,
 reportHash:this.inputs.reportHash,certificateHash:this.inputs.certificateHash,seedKnownAt:this.machine.seedKnownAt,sourceBindingHash:sha(JSON.stringify(this.binding)),
 evidenceOnly:{pair:{...report.pair,profit:null,account:false},maker:{...report.maker,profit:null,account:false}},
 accounts:report.accounts.map(a=>{const arm=this.machine.arms.find(x=>x.candidate.id===a.id&&x.scenario.id===a.scenario);
 return {...a,active:Number(Boolean(arm.account.position)),pending:arm.account.pendingSettlements.length,historicalReasons:reasons.get(a.id)??[]};}),protocol:observerProtocol,directory:this.directory};
 }
 health(){return {version:observerProtocol.version,realTrading:false,status:this.state.status,healthy:!this.state.fatal&&!this.storageFailed,
 fatal:this.state.fatal||Boolean(this.storageFailed),error:this.state.error,lastPollAt:this.state.lastPollAt,
 lastNewFrameAt:this.state.lastNewFrameAt,inputSequence:this.state.inputSequence,sourceBindingHash:sha(JSON.stringify(this.binding))};}
 async listen(port=18791){
 if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
 this.server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET'){res.writeHead(405);res.end('Read-only GET');return;}
 if(url.pathname==='/api/health'){const health=this.health();res.writeHead(health.healthy?200:503,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(health));return;}
 if(url.pathname==='/api/summary'){res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(this.summary()));return;}
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(readFileSync(join(here,'observer.html')));return;}
 res.writeHead(404);res.end('Not found');});
 await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});return this.server.address();
 }
 async close(){
 if(this.closed)return;await this.queue;
 try{if(!this.storageFailed){this.flushOutbox();this.save();}}finally{this.closed=true;await new Promise(r=>this.server?this.server.close(r):r());this.releaseLock?.();}
 }
}
export async function startObserver(options){
 const observer=new ProspectiveObserver(options);try{await observer.initialize();await observer.listen(options.port??18791);}
 catch(e){await observer.close().catch(()=>{});throw e;}return observer;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw Error('Named arguments required');args[process.argv[i].slice(2)]=process.argv[i+1];}
 const observer=await startObserver({directory:args.directory,reportPath:args.report,registrationPath:args.registration,port:args.port?Number(args.port):18791});
 const timer=setInterval(()=>{void observer.pollOnce().catch(e=>console.error(e.message));void observer.pollOfficial().catch(e=>console.error(e.message));},1000);
 await observer.pollOnce();void observer.pollOfficial();
 const stop=async()=>{clearInterval(timer);await observer.close();process.exitCode=0;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
