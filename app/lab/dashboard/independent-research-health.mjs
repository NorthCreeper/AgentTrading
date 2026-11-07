import {openSync,fstatSync,readSync,closeSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {dirname,join} from 'node:path';
import {performance} from 'node:perf_hooks';

export function readBoundedJson(path,maximumBytes=65536){
  let fd;
  try{
    fd=openSync(path,'r');const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>maximumBytes)throw Error('Diagnostic JSON exceeds its fixed read limit');
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw Error('Diagnostic JSON was truncated');offset+=count;}
    const value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Diagnostic JSON is not an object');
    return {value,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,signature:[stat.ino,stat.size,stat.mtimeMs].join(':')};
  }catch(error){return {error:error.code==='ENOENT'?'missing':error.message};}
  finally{if(fd!==undefined)closeSync(fd);}
}

export function queryObserverProcesses(pids){
  const ids=[...new Set(pids.filter(p=>Number.isSafeInteger(p)&&p>0))];
  if(!ids.length)return Promise.resolve([]);
  const filter=ids.map(id=>'ProcessId='+id).join(' OR ');
  const script="$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter '"+filter+"' | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress";
  return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,timeout:3000,maxBuffer:262144},(error,stdout)=>{
      if(error)return reject(Error(error.killed?'Process identity lookup timed out':error.message));
      try{const parsed=stdout.trim()?JSON.parse(stdout.replace(/^\uFEFF/,'')):[];resolve(Array.isArray(parsed)?parsed:[parsed]);}
      catch{reject(Error('Process identity lookup returned invalid JSON'));}
    }));
}
const finite=Number.isFinite;
const fileSignature=path=>{try{const stat=statSync(path);return[stat.ino,stat.size,stat.mtimeMs].join(':');}catch{return null;}};
const normalize=text=>String(text??'').replaceAll('\\','/').toLowerCase();
export function observerCommandMatches(commandLine,{entryPath,registrationPath,port}){
  if(typeof commandLine!=='string'||!entryPath||!registrationPath)return false;
  const tokens=[];let i=0;
  try{
    while(i<commandLine.length){while(/\s/.test(commandLine[i]??''))i++;if(i>=commandLine.length)break;
      let value='';if(commandLine[i]==='"'){i++;
        while(i<commandLine.length&&commandLine[i]!=='"'){if(commandLine[i]==='\\'&&commandLine[i+1]==='"')return false;value+=commandLine[i++];}
        if(commandLine[i++]!=='"'||i<commandLine.length&&!/\s/.test(commandLine[i]))return false;
      }else{while(i<commandLine.length&&!/\s/.test(commandLine[i])){if(commandLine[i]==='"')return false;value+=commandLine[i++];}}
      tokens.push(value);
    }
    const prefix=tokens[1]==='--max-old-space-size=1024'?1:0;
    return tokens.length===5+prefix&&normalize(tokens[1+prefix])===normalize(entryPath)&&tokens[2+prefix]==='worker'&&
      normalize(tokens[3+prefix])===normalize(registrationPath)&&tokens[4+prefix]===String(port);
  }catch{return false;}
}
const labels={18791:'历史候选独立观察',18792:'状态概率独立观察',18793:'报价时间独立观察'};
const legacyServices=pointerPath=>[18791,18792,18793].map(port=>{
  const directory=join(dirname(pointerPath),'registered-20261015',String(port));
  return {port,directory,registrationVersion:'legacy-inactive',lockPath:join(directory,'worker.lock.json'),
    stopPath:join(directory,'worker-stop.json'),healthStatusPath:join(directory,'health-status.json')};
});

export function createIndependentResearchHealthReader({pointerPath,cacheMs=5000,processCacheMs=10000,
  monotonic=()=>performance.now(),processProbe=queryObserverProcesses}={}){
  let filesAt=-Infinity,files=null,processAt=-Infinity,processRequestedAt=-Infinity,processRows=[],probedPids=[],processError=null,inflight=null,closed=false,registrationCache=null;
  function loadFiles(){
    const pin=readBoundedJson(pointerPath),active=pin.value;
    let registration={active:false,integrityVerified:false,path:null,version:null,error:pin.error??null},services=legacyServices(pointerPath);
    if(active){
      if(active.version!=='btc5m-observer-active-registration-v1'||!Array.isArray(active.services)||active.services.length>16)
        registration.error='Invalid independent-observer active registration pointer';
      else{
        if(!registrationCache||registrationCache.path!==active.registrationPath||registrationCache.sha256!==active.registrationSha256||
          registrationCache.original.signature!==fileSignature(active.registrationPath)||registrationCache.original.error){
          const original=readBoundedJson(active.registrationPath,1048576);
          registrationCache={path:active.registrationPath,sha256:active.registrationSha256,original};
        }
        const original=registrationCache.original;
        const verified=!original.error&&original.sha256===active.registrationSha256;
        registration={active:true,integrityVerified:verified,path:active.registrationPath,sha256:active.registrationSha256,
          version:original.value?.version??null,activatedAt:active.at??null,error:verified?null:original.error??'Independent-observer registration hash differs'};
        services=active.services;
      }
    }
    return {registration,services:services.map(config=>({config,
      status:config.healthStatusPath?readBoundedJson(config.healthStatusPath):{error:'Compact diagnostic status path missing'},
      lock:config.lockPath?readBoundedJson(config.lockPath):{error:'Worker lock path missing'},
      stop:config.stopPath?readBoundedJson(config.stopPath):{error:'missing'}}))};
  }
  function startProcessRefresh(force=false){
    if(closed||inflight||!force&&monotonic()-processRequestedAt<processCacheMs)return;
    const pids=files.services.map(row=>row.lock.value?.pid??row.status.value?.pid).filter(p=>Number.isSafeInteger(p)&&p>0);
    processRequestedAt=monotonic();
    inflight=Promise.resolve().then(()=>processProbe(pids)).then(rows=>{processRows=rows;probedPids=pids;processError=null;},error=>{
      processRows=[];processError=error.message;
    }).finally(()=>{processAt=monotonic();inflight=null;});
  }
  function snapshot({now=Date.now()}={}){
    if(!files||monotonic()-filesAt>=cacheMs){files=loadFiles();filesAt=monotonic();}
    startProcessRefresh();
    const services=files.services.map(({config,status,lock,stop})=>{
      const reported=status.value??{},lockPid=lock.value?.pid??null,statusPid=reported.pid??null,pid=lockPid??statusPid;
      const validPid=Number.isSafeInteger(pid)&&pid>0,record=processRows.find(row=>row.ProcessId===pid);
      const checked=finite(processAt)&&monotonic()-processAt<=processCacheMs*2&&!processError&&probedPids.includes(pid);
      const alive=validPid?(checked?Boolean(record):null):false;
      const expected=config.expectedEntryPath??config.entryPath;
      const commandMatches=alive&&expected&&typeof record?.CommandLine==='string'?
        observerCommandMatches(record.CommandLine,{entryPath:expected,registrationPath:files.registration.path,port:config.port}):alive===false?false:null;
      const statusRegistrationMatches=reported.maintenanceRegistrationSha256===files.registration.sha256&&
        typeof reported.maintenanceRegistrationSha256==='string';
      const statusPortMatches=reported.port===config.port;
      const lockRegistrationMatches=typeof lock.value?.maintenanceRegistrationSha256==='string'&&
        lock.value.maintenanceRegistrationSha256===files.registration.sha256;
      const lockPortMatches=lock.value?.port===config.port;
      const identityMatches=alive&&commandMatches!==null?commandMatches&&statusRegistrationMatches&&statusPortMatches&&lockRegistrationMatches&&lockPortMatches:alive===false?false:null;
      const pollAt=reported.lastPollAt??reported.at??null,progressAt=reported.lastNewFrameAt??reported.lastFrameAt??reported.lastAt??null;
      const age=at=>finite(at)&&finite(now)?now-at:null,pollAgeMs=age(pollAt),progressAgeMs=age(progressAt);
      const maximumAge=finite(config.maximumAgeMs)?Math.min(120000,Math.max(1000,config.maximumAgeMs)):30000;
      const stale=pollAgeMs===null||pollAgeMs<0||pollAgeMs>maximumAge;
      const progressStale=progressAgeMs===null||progressAgeMs<0||progressAgeMs>maximumAge;
      const stopAt=stop.value?.at??null,currentStop=Boolean(stop.value&&(pollAt===null||stopAt>=pollAt));
      const stopReason=stop.value?.error??stop.value?.reason??null,resourceStopped=currentStop&&/resource|budget|cpu|rss|disk|deadline/i.test(stopReason??'');
      const limits=stop.value?.resources,registeredRuntime=registrationCache?.original.value?.budgets?.maximumRuntimeMs;
      const completedDeadline=currentStop&&stopReason==='Registered 24-hour restoration runtime reached'&&
        files.registration.integrityVerified&&statusRegistrationMatches&&statusPortMatches&&
        stop.value?.noAutomaticBudgetReset===true&&stop.value?.recordsRetained===true&&
        finite(registeredRuntime)&&registeredRuntime>0&&finite(limits?.releaseAt)&&finite(limits?.deadlineAt)&&
        limits.deadlineAt-limits.releaseAt===registeredRuntime&&stopAt>=limits.deadlineAt&&now>=limits.deadlineAt&&
        // An expired process-cache entry must not undo an immutable completed
        // window. A positively identified surviving worker still is a fault;
        // an unrelated process that reused the old PID is not that worker.
        !lock.value&&(alive!==true||commandMatches===false);
      const conflictingPid=lockPid!==null&&statusPid!==null&&lockPid!==statusPid;
      const clockReady=reported.runtimeClock?.ready??null;
      const clockWaiting=clockReady===false||/wait.*clock|clock.*wait/i.test(reported.status??'');
      let state;
      if(completedDeadline)state='completed-deadline';
      else if(currentStop)state=resourceStopped?'resource-stopped':'stopped';
      else if(alive===false)state='stopped';
      else if(conflictingPid||commandMatches===false)state='identity-mismatch';
      else if(!files.registration.active||!files.registration.integrityVerified)state='registration-unverified';
      else if(status.error)state='status-unavailable';
      else if(!statusRegistrationMatches||!statusPortMatches||!lockRegistrationMatches||!lockPortMatches)state='registration-mismatch';
      else if(alive===null||identityMatches===null)state='process-unverified';
      else if(reported.fatal||['error','fatal'].includes(reported.status))state='error';
      else if(clockWaiting)state='waiting-for-clock';
      else if(reported.status==='stopped')state='stopped';
      else if(reported.error||reported.healthy===false)state='error';
      else if(stale)state='stale';
      else if(progressStale)state='source-stale';
      else if(reported.status==='starting')state='starting';
      else if(reported.healthy!==true)state='status-unavailable';
      else state='running';
      const recoverable=['waiting-for-clock','source-stale','starting'].includes(state);
      return {port:config.port,label:config.label??labels[config.port]??String(config.port),state,healthy:state==='running',completed:completedDeadline,
        recoverable,processFault:['stopped','identity-mismatch'].includes(state),clockReady,
        independent:true,affectsMainTrading:false,realTrading:false,pid:validPid?pid:null,
        process:{alive,identityMatches,commandMatches,checkedAt:finite(processAt)?now-(monotonic()-processAt):null,
          checking:Boolean(inflight),lookupError:processError,maximumLookupMs:3000},
        registration:{active:files.registration.active,integrityVerified:files.registration.integrityVerified,version:config.registrationVersion??files.registration.version,
          statusRegistrationMatches,statusPortMatches,lockRegistrationMatches,lockPortMatches},
        reportedStatus:reported.status??null,message:currentStop?stopReason:
          state==='registration-mismatch'?'Observer status or lock belongs to another maintenance registration or port':
          state==='identity-mismatch'?'Worker PID or command does not match the active registration and port':reported.error??status.error??
          (state==='waiting-for-clock'?'Waiting for verified UTC; this worker can resume without restart':
            state==='source-stale'?'Worker is alive and polling; source frames have stopped advancing':null),
        lastSuccessfulPollAt:pollAt,lastProgressAt:progressAt,pollAgeMs,progressAgeMs,stale,progressStale,
        frames:reported.frames??null,inputSequence:reported.inputSequence??null,
        lock:{present:Boolean(lock.value),pid:lockPid,conflictingPid},
        resourceStop:{active:resourceStopped,at:currentStop?stopAt:null,reason:currentStop?stopReason:null,recordsRetained:stop.value?.recordsRetained??null},
        paths:{status:config.healthStatusPath??null,lock:config.lockPath??null,stop:config.stopPath??null}};
    });
    const hasErrors=services.some(service=>!service.healthy&&!service.completed);
    return {scope:'Independent paper research; separate from the main trading service',status:hasErrors?'degraded':services.length&&services.every(s=>s.completed)?'completed':'healthy',hasErrors,
      checkedAt:now,cacheMs,registration:files.registration,services};
  }
  return {snapshot,async refresh(options){snapshot(options);if(inflight)await inflight;return snapshot(options);},close(){closed=true;}};
}
