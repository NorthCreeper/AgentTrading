import {existsSync,readFileSync,readdirSync,mkdirSync,appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {writeJsonAtomic} from './atomic-json.mjs';
import {evolutionStudyVersion,evolutionProtocol,evolutionImplementation} from './evolution-study.mjs';
import {validateEvolutionPortfolio,stepEvolutionPortfolio,evolutionPortfolioSummary,evolutionDailySummary} from './evolution-portfolio.mjs';
import {verifyPayoutResolution} from './payout-resolution.mjs';

export const evolutionMaintenanceVersion='existing-evolution-inventory-maintenance-v1';
const digest=x=>createHash('sha256').update(x).digest('hex'),json=p=>JSON.parse(readFileSync(p,'utf8'));
const objectHash=x=>digest(JSON.stringify(x)),fileHash=p=>digest(readFileSync(p));
const operations=['observe-owned-inventory','verify-paper-settlement','cancel-unexecuted-entry'];
const policy={scope:'paper-existing-inventory-maintenance',originalEvidenceReadOnly:true,
 autoAdoption:false,newAccounts:false,newEntries:false,realTrading:false,
 evidencePolicy:'maintenance-separate-from-fixed-batch',allowedOperations:operations};
function validRegistry(r){
 return r&&r.protocolHash===objectHash(r.protocol)&&r.implementationHash===objectHash(r.codeHashes)&&
  r.registryHash===objectHash({version:r.version,protocolHash:r.protocolHash,implementationHash:r.implementationHash});
}
function changedFiles(parent,current){
 return [...new Set([...Object.keys(parent.codeHashes),...Object.keys(current.codeHashes)])].sort()
  .filter(path=>parent.codeHashes[path]!==current.codeHashes[path])
  .map(path=>({path,before:parent.codeHashes[path]??null,after:current.codeHashes[path]??null}));
}
function readParent(directory,state,current){
 const path=join(directory,'evolution-cohorts',state.registryHash+'.json');
 const parent=json(path);
 if(!validRegistry(parent)||!validRegistry(current)||parent.registryHash!==state.registryHash||
  parent.registeredAt!==state.registeredAt||parent.firstBatchStart!==state.firstBatchStart||
  state.governance?.registryHash!==state.registryHash||state.governance?.realTrading!==false||
  state.governance?.effectivePolicy!=='market')throw Error('Invalid parent evolution maintenance identity');
 return {parent,path};
}
function cohortPins(directory,state){
 const prefix=state.registryHash.slice(0,12),root=join(directory,'evolution-cohorts',prefix),pins=[];
 if(!existsSync(root))throw Error('Maintenance cannot create an unknown evolution cohort');
 for(const name of readdirSync(root).sort()){
  if(!new RegExp('^'+prefix+'-[0-9]+$').test(name))continue;
  const path=join(root,name,'evolution-study.json'),journal=join(root,name,'evolution-study.jsonl');
  if(!existsSync(path))continue;
  const s=json(path),index=Number(name.slice(prefix.length+1)),start=state.firstBatchStart+index*604800000;
  if(s.version!==evolutionStudyVersion||s.registryHash!==state.registryHash||
   s.batch?.id!==name||s.batch.start!==start||s.batch.end!==start+604800000||s.batch.labelCutoff!==start+691200000||
   !isDeepStrictEqual(s.protocol,evolutionProtocol)||!isDeepStrictEqual(s.implementation,evolutionImplementation())||
   !Array.isArray(s.accounts)||s.accounts.length!==4||new Set(s.accounts.map(a=>a.id)).size!==4||
   new Set(s.accounts.map(a=>`${a.policy}:${a.executionDelayMs}`)).size!==4||
   s.accounts.some(a=>!['market','consensus'].includes(a.policy)||![0,1000].includes(a.executionDelayMs)))
   throw Error('Maintenance parent cohort identity or frozen portfolio implementation differs');
  for(const a of s.accounts)validateEvolutionPortfolio(a);
  // Pending outbox is part of the original fixed evidence and is never drained
  // into a new maintenance journal. It needs its original recovery path first.
  if(!Array.isArray(s.pending)||s.pending.length)throw Error('Maintenance parent has uncommitted fixed-batch events');
  pins.push({batchId:name,instanceId:s.instanceId,batch:s.batch,createdAt:s.createdAt,
   checkpointSha256:fileHash(path),journalSha256:existsSync(journal)?fileHash(journal):null,
   accountIds:s.accounts.map(a=>a.id),initialCapital:s.accounts.map(a=>a.initialCapital)});
 }
 if(!pins.length)throw Error('Maintenance requires existing funded cohort evidence');
 return pins;
}
function validateContinuation(parent,current){
 validateEvolutionPortfolio(current);
 for(const field of ['id','policy','executionDelayMs','initialCapital','executionSequence','attemptedRounds','lastConsumedSources'])
  if(!isDeepStrictEqual(parent[field],current[field]))throw Error('Maintenance cannot change funded account or execution identity');
 if(current.closedTrades.length<parent.closedTrades.length||
  !isDeepStrictEqual(parent.closedTrades,current.closedTrades.slice(0,parent.closedTrades.length)))
  throw Error('Maintenance cannot rewrite original completed trades');
 const before=[...parent.closedTrades,parent.position,...parent.pendingSettlements].filter(Boolean),
  after=[...current.closedTrades,current.position,...current.pendingSettlements].filter(Boolean);
 if(!isDeepStrictEqual(before.map(t=>t.id).sort(),after.map(t=>t.id).sort()))throw Error('Maintenance cannot add or remove owned trade identity');
 for(const t of before){
  const next=after.find(n=>n.id===t.id);
  for(const field of ['id','slug','market','outcome','tokenId','openedAt','signalAt','size','cost','costPerShare','orderReports'])
   if(!isDeepStrictEqual(t[field],next[field]))throw Error('Maintenance cannot execute or rewrite original inventory cashflows');
 }
}
function resolutionEvidence(directory,state,pins,createdAt,selectedSlugs=null){
 const markets=new Map();
 for(const pin of pins){
  const s=json(join(directory,'evolution-cohorts',state.registryHash.slice(0,12),pin.batchId,'evolution-study.json'));
  for(const a of s.accounts)for(const t of [a.position,...a.pendingSettlements].filter(Boolean)){
   const prior=markets.get(t.slug);if(prior&&!isDeepStrictEqual(prior,t.market))throw Error('Original owned market identities conflict');
   markets.set(t.slug,t.market);
  }
 }
 const result=[];
 for(const slug of selectedSlugs??[...markets.keys()].sort()){
  if(!markets.has(slug))throw Error('Maintenance evidence does not belong to original inventory');
  const relativePath='financial-outcomes/'+slug+'.json',path=join(directory,relativePath);
  if(!existsSync(path)){if(selectedSlugs)throw Error('Pinned maintenance financial archive is missing');continue;}
  const e=json(path),label=verifyPayoutResolution(markets.get(slug),e.gamma,e.clob,e.observedAt);
  if(!label||label.observedAt>createdAt||!isDeepStrictEqual(label,verifyPayoutResolution(e.market,e.gamma,e.clob,e.observedAt)))
   throw Error('Maintenance financial archive is unresolved, future or inconsistent');
  result.push({slug,relativePath,sha256:fileHash(path),labelSha256:objectHash(label)});
 }
 return result;
}

/** Preparation only: the caller writes this once after all maintenance source
 * changes are final. No registration, checkpoint, account or qualification is
 * rewritten, and no new strategy capital is allocated. */
export function prepareEvolutionMaintenanceManifest(directory,{state,currentRegistry,createdAt,resolutionEvidenceSlugs=null}){
 if(!Number.isFinite(createdAt)||createdAt<state.registeredAt)throw Error('Invalid maintenance creation clock');
 const {parent,path}=readParent(directory,state,currentRegistry);
 const cohorts=cohortPins(directory,state);
 return {version:evolutionMaintenanceVersion,createdAt,...structuredClone(policy),
  parentRegistryHash:state.registryHash,parentRegistryFileSha256:fileHash(path),
  parentCoordinatorStateSha256:objectHash(state),currentRegistryHash:currentRegistry.registryHash,
  currentProtocolHash:currentRegistry.protocolHash,currentImplementationHash:currentRegistry.implementationHash,
  currentCodeHashes:structuredClone(currentRegistry.codeHashes),changedCodeFiles:changedFiles(parent,currentRegistry),
  cohorts,resolutionEvidence:resolutionEvidence(directory,state,cohorts,createdAt,resolutionEvidenceSlugs)};
}
export function writeEvolutionMaintenanceManifest(path,manifest){
 // Exclusive create prevents an ordinary repair/restart from resetting the
 // maintenance segment or substituting a second funding baseline.
 writeFileSync(path,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
}
export class EvolutionMaintenance {
 constructor(directory,{state,currentRegistry,manifestPath=join(directory,'evolution-maintenance.json'),now}){
  this.manifestPath=manifestPath;this.manifest=json(manifestPath);
  const expected=prepareEvolutionMaintenanceManifest(directory,{state,currentRegistry,createdAt:this.manifest.createdAt,
   resolutionEvidenceSlugs:this.manifest.resolutionEvidence?.map(e=>e.slug)});
  if(!Number.isFinite(now)||this.manifest.createdAt>now||!isDeepStrictEqual(this.manifest,expected))
   throw Error('Evolution maintenance manifest differs from exact parent/source/scope pins');
  this.id=objectHash(this.manifest);this.cohorts=[];this.archiveLabels=new Map();
  for(const pin of this.manifest.resolutionEvidence){
   const e=json(join(directory,pin.relativePath));
   this.archiveLabels.set(pin.slug,verifyPayoutResolution(e.market,e.gamma,e.clob,e.observedAt));
  }
  for(const pin of this.manifest.cohorts){
   const originalDirectory=join(directory,'evolution-cohorts',state.registryHash.slice(0,12),pin.batchId);
   const parent=json(join(originalDirectory,'evolution-study.json'));
   const sideDirectory=join(directory,'evolution-cohorts','maintenance',this.id,pin.batchId);
   mkdirSync(sideDirectory,{recursive:true});
   const path=join(sideDirectory,'owned-inventory.json'),journal=join(sideDirectory,'owned-inventory.jsonl');
   const maintenance=existsSync(path)?json(path):{version:evolutionMaintenanceVersion,manifestId:this.id,
    parentRegistryHash:state.registryHash,parentCheckpointSha256:pin.checkpointSha256,batchId:pin.batchId,
    instanceId:pin.instanceId,startedAt:this.manifest.createdAt,lastAt:null,observations:0,eventSequence:0,
    pending:[],accounts:structuredClone(parent.accounts)};
   if(maintenance.version!==evolutionMaintenanceVersion||maintenance.manifestId!==this.id||
    maintenance.parentRegistryHash!==state.registryHash||maintenance.parentCheckpointSha256!==pin.checkpointSha256||
    maintenance.batchId!==pin.batchId||maintenance.instanceId!==pin.instanceId||
    maintenance.startedAt!==this.manifest.createdAt||!Number.isInteger(maintenance.eventSequence)||
    maintenance.eventSequence<0||!Array.isArray(maintenance.pending)||
    !isDeepStrictEqual(maintenance.accounts?.map(a=>a.id),pin.accountIds)||
    !isDeepStrictEqual(maintenance.accounts?.map(a=>a.initialCapital),pin.initialCapital))
    throw Error('Evolution maintenance checkpoint identity differs');
   for(const a of maintenance.accounts)validateContinuation(parent.accounts.find(p=>p.id===a.id),a);
   const written=new Map();
   if(existsSync(journal))for(const line of readFileSync(journal,'utf8').split('\n').filter(Boolean)){
    const event=JSON.parse(line),text=JSON.stringify(event);
    if(!event.id||event.manifestId!==this.id||written.has(event.id)&&written.get(event.id)!==text)
     throw Error('Conflicting maintenance journal identity');
    written.set(event.id,text);
   }
   const cohort={pin,path,journal,state:maintenance,written,parentAccounts:parent.accounts};this.cohorts.push(cohort);this.flush(cohort);
   if(!existsSync(path))writeJsonAtomic(path,maintenance);
  }
 }
 flush(cohort){
  for(const event of cohort.state.pending){
   const text=JSON.stringify(event),prior=cohort.written.get(event.id);
   if(prior&&prior!==text)throw Error('Conflicting maintenance outbox event');
   if(!prior){appendFileSync(cohort.journal,text+'\n');cohort.written.set(event.id,text);}
  }
  cohort.state.pending=[];
 }
 resolutionMarkets(){
  const markets=new Map();for(const c of this.cohorts)for(const a of c.state.accounts)
   for(const t of [a.position,...a.pendingSettlements].filter(Boolean)){
    const prior=markets.get(t.slug);if(prior&&!isDeepStrictEqual(prior,t.market))throw Error('Maintenance owned market identities conflict');
    markets.set(t.slug,structuredClone(t.market));
   }
  return [...markets.values()];
 }
 observe(input,financialLabels){
  if(!Number.isFinite(input?.now)||input.now<this.manifest.createdAt)return;
  const labels=new Map(financialLabels??[]);
  for(const [slug,label]of this.archiveLabels){
   const current=labels.get(slug);
   // The shared shadow may expose the same dual-API archive with its legacy
   // source caption. Reverify pinned raw evidence for this maintenance segment,
   // rather than broadening the original candidate portfolio's accepted source.
   if(current&&(current.winner!==label.winner||current.conditionId!==label.conditionId||
    !isDeepStrictEqual(current.tokens,label.tokens)))throw Error('Shared and pinned maintenance financial evidence conflict');
   labels.set(slug,label);
  }
  for(const c of this.cohorts){
   const s=c.state;if(s.lastAt!==null&&input.now<=s.lastAt)continue;
   const events=[];
   for(const a of s.accounts){
    if(!a.position&&!a.pendingSettlements.length&&!a.pendingBuy)continue;
    // Source interruption is past the fixed batch deadline. Only old owned
    // inventory may advance; there are no quote exits, candidate signals or buys.
    const changes=stepEvolutionPortfolio(a,{now:input.now,frame:null,eventOnly:true},labels,null,false);
    if(changes.length)a.daily=evolutionDailySummary(a);
    for(const event of changes)events.push({...event,accountId:a.id,policy:a.policy,executionDelayMs:a.executionDelayMs});
    validateContinuation(c.parentAccounts.find(p=>p.id===a.id),a);
   }
   s.lastAt=input.now;s.observations++;
   s.pending.push(...events.map(e=>({...e,id:`${this.id}:${c.pin.batchId}:${++s.eventSequence}`,
    version:evolutionMaintenanceVersion,manifestId:this.id,parentRegistryHash:this.manifest.parentRegistryHash,
    parentBatchId:c.pin.batchId,scope:policy.scope,fixedBatchAdoptionEvidence:false})));
   // A frame without an ownership change changes no account economics; avoid
   // repeatedly rewriting the large inherited closed-trade history.
   if(events.length){writeJsonAtomic(c.path,s);this.flush(c);}
  }
 }
 save(){for(const c of this.cohorts){writeJsonAtomic(c.path,c.state);this.flush(c);}}
 summary(now){const markets=this.resolutionMarkets();return {version:evolutionMaintenanceVersion,
  status:markets.length?'observing-existing-inventory':'owned-inventory-settlement-complete',
  manifestId:this.id,manifestPath:this.manifestPath,startedAt:this.manifest.createdAt,...structuredClone(policy),
  parentRegistryHash:this.manifest.parentRegistryHash,currentRegistryHash:this.manifest.currentRegistryHash,
  qualificationStatus:'source-mismatch-adoption-disabled',newCapitalAllocated:0,
  unresolvedMarketSlugs:markets.map(m=>m.slug),
  cohorts:this.cohorts.map(c=>({batchId:c.pin.batchId,instanceId:c.pin.instanceId,batch:c.pin.batch,
   originalCheckpointSha256:c.pin.checkpointSha256,maintenanceCheckpointPath:c.path,
   lastAt:c.state.lastAt,observations:c.state.observations,accounts:c.state.accounts.map(a=>evolutionPortfolioSummary(a,now))}))};}
}
