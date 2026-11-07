// Offline technical binding repair only. No broker, strategy or main-account mutation.
import {readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {sourceRegistration} from './replay.mjs';
const here=dirname(fileURLToPath(import.meta.url)),lab=resolve(here,'../..'),
 sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
function atomic(path,value){const temporary=path+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx');
 try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);}
function chain(path){const bytes=readFileSync(path);if(bytes.length&&bytes.at(-1)!==10)throw Error('Uncommitted partial log; archive retained');
 const rows=bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let previous=null;
 for(let i=0;i<rows.length;i++){const row=rows[i];if(row.sequence!==i+1||row.prev!==previous||
 row.hash!==sha(JSON.stringify({sequence:row.sequence,prev:row.prev,payload:row.payload})))throw Error('Log chain differs');previous=row.hash;}
 return {bytes,rows,hash:previous};}
export function technicalEventIdMigration({directory,archive,now=Date.now()}){
 directory=resolve(directory);archive=resolve(archive);const before=join(archive,'before-runtime');
 if(directory!==join(here,'prospective-observer')||!archive.startsWith(here+'\\')&&!archive.startsWith(here+'/'))throw Error('Unexpected candidate paths');
 if(existsSync(join(directory,'worker.lock.json'))){const lock=read(join(directory,'worker.lock.json'));
  if(!Number.isInteger(lock.pid)||lock.pid<=0)throw Error('Invalid worker lock');
  try{process.kill(lock.pid,0);throw Error('Candidate still running');}catch(e){if(e.code!=='ESRCH')throw e;}}
 const oldRegistrationBytes=readFileSync(join(before,'observer-registration.json')),oldRegistration=JSON.parse(oldRegistrationBytes),
 oldCheckpointBytes=readFileSync(join(before,'checkpoint.json')),oldCheckpoint=JSON.parse(oldCheckpointBytes),
 markerPath=join(directory,'observer-registration.json'),checkpointPath=join(directory,'checkpoint.json');
 if(oldCheckpoint.hash!==sha(JSON.stringify(oldCheckpoint.payload))||
 oldCheckpoint.payload.bindingHash!==sha(JSON.stringify(oldRegistration.binding)))throw Error('Before checkpoint checksum/binding differs');
 if(oldRegistration.createdAt!==1790918394210||oldCheckpoint.payload.machine.arms.length!==38||
 oldCheckpoint.payload.state.pendingOutbox.length||oldCheckpoint.payload.state.fatal||oldCheckpoint.payload.state.storageFailure)
 throw Error('This declared repair requires the exact healthy, quiescent natural instance; no outbox is discarded');
 const inputs=chain(join(before,'inputs.jsonl')),journal=chain(join(before,'journal.jsonl')),state=oldCheckpoint.payload.state;
 if(inputs.rows.length!==state.inputSequence||inputs.hash!==state.inputHash||
 journal.rows.length!==state.journalSequence||journal.hash!==state.journalHash||new Set(journal.rows.map(r=>r.payload.id)).size!==journal.rows.length)
 throw Error('Before cursor/account snapshot differs from complete logs');
 for(const name of ['inputs.jsonl','journal.jsonl'])if(!readFileSync(join(directory,name)).equals(readFileSync(join(before,name))))
 throw Error('Natural evidence changed after the declared stop');
 const current=sourceRegistration(['observer.mjs','parallel-replay.mjs']),old=oldRegistration.binding.sources,
 changed=Object.keys(current).filter(name=>old[name]!==current[name]);
 if(changed.length!==1||changed[0]!=='research/history-optimization-20261002/observer.mjs'||Object.keys(old).length!==Object.keys(current).length)
 throw Error('Only the new observer transport may change');
 const historical=read(join(here,'full-history-1790887800000','registration.json'));
 for(const [name,hash]of Object.entries(historical.sources))if(current[name]!==hash)throw Error('Historical source changed: '+name);
 const binding={...oldRegistration.binding,sources:current};
 if(sha(readFileSync(join(here,'observer.html')))!==binding.uiHash||
 sha(readFileSync(resolve(lab,'../../..','启动BTC历史候选观察.ps1')))!==binding.launcherHash)throw Error('Unrelated observer launcher/UI changed');
 const machineHash=sha(JSON.stringify(oldCheckpoint.payload.machine)),stateHash=sha(JSON.stringify(state)),
 manifestPath=join(archive,'migration.json'),manifest=existsSync(manifestPath)?read(manifestPath):{
 version:'observer-event-id-technical-repair-v1',at:now,createdAt:oldRegistration.createdAt,
 reason:'Keep a unique journal id per input event; retain trade identity separately. No strategy parameter or economic reset.',
 oldRegistrationSha256:sha(oldRegistrationBytes),oldCheckpointSha256:sha(oldCheckpointBytes),machineSha256:machineHash,stateSha256:stateHash,
 inputs:{bytes:inputs.bytes.length,sha256:sha(inputs.bytes),sequence:state.inputSequence,hash:state.inputHash},
 journal:{bytes:journal.bytes.length,sha256:sha(journal.bytes),sequence:state.journalSequence,hash:state.journalHash},
 sourceChanges:changed,historicalSourceCount:Object.keys(historical.sources).length};
 if(manifest.oldRegistrationSha256!==sha(oldRegistrationBytes)||manifest.machineSha256!==machineHash||manifest.stateSha256!==stateHash)
 throw Error('Previously declared migration differs');
 const registration={...oldRegistration,binding,technicalRepairs:[...(oldRegistration.technicalRepairs??[]),{
 version:manifest.version,at:manifest.at,archive,previousRegistrationSha256:manifest.oldRegistrationSha256,machineSha256:machineHash}]},
 payload={...oldCheckpoint.payload,bindingHash:sha(JSON.stringify(binding))},checkpoint={payload,hash:sha(JSON.stringify(payload))};
 const currentRegistration=read(markerPath),currentCheckpoint=read(checkpointPath);
 if(![oldRegistration,registration].some(x=>isDeepStrictEqual(x,currentRegistration))||
 ![oldCheckpoint,checkpoint].some(x=>isDeepStrictEqual(x,currentCheckpoint)))throw Error('Live state is neither the exact declared old nor new checkpoint');
 if(!existsSync(manifestPath))writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{flag:'wx'});
 // Either interruption between these writes fails registration checks. Rerun only accepts the exact old/new pair.
 atomic(checkpointPath,checkpoint);atomic(markerPath,registration);
 const result={...manifest,pass:true,newRegistrationSha256:sha(readFileSync(markerPath)),newCheckpointSha256:sha(readFileSync(checkpointPath)),
 newSourceBindingHash:sha(JSON.stringify(binding)),machineUnchanged:isDeepStrictEqual(oldCheckpoint.payload.machine,read(checkpointPath).payload.machine),
 stateUnchanged:isDeepStrictEqual(state,read(checkpointPath).payload.state),createdAtUnchanged:read(markerPath).createdAt===oldRegistration.createdAt,
 inputAndJournalBytesUnchanged:true,all38AccountsRetained:true,mainAccountTouched:false};
 if(!result.machineUnchanged||!result.stateUnchanged||!result.createdAtUnchanged)throw Error('Economic identity changed');
 atomic(join(archive,'migration-result.json'),result);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(technicalEventIdMigration({directory:process.argv[2],archive:process.argv[3]})));
