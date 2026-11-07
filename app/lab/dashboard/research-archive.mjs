import * as fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {basename,dirname,extname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const schema='btc5m-research-archive-v1',maxManifestBytes=64*1024*1024,previewBytes=64*1024;
const portableRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const defaultManifest=join(portableRoot,'archives/catalog.json');
const textTypes=new Set(['.json','.jsonl','.md','.txt','.mjs','.log','.csv','.ps1']);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const normalized=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const inside=(root,path)=>{const rel=relative(normalized(root),normalized(path));return rel===''||!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel);};
const error=(message,status=400,code='archive-denied')=>Object.assign(new Error(message),{status,statusCode:status,code});
const finite=x=>Number.isFinite(x)&&x>=0;
const snapshot=x=>structuredClone(x);
function pathChain(path){let cursor=parse(path).root;const result=[cursor];
 for(const part of path.slice(cursor.length).split(sep).filter(Boolean)){cursor=join(cursor,part);result.push(cursor);}return result;}

// Node identifies symbolic links/junctions. Windows has other reparse tags too;
// check the native attribute without putting a filename in shell source code.
async function nativeReparseInspector(paths){
 if(process.platform!=='win32')return false;
 const script="[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';$paths=ConvertFrom-Json ([Console]::In.ReadToEnd());$found=$false;foreach($p in $paths){$item=Get-Item -LiteralPath $p -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){$found=$true}};if($found){[Console]::Write('true')}else{[Console]::Write('false')}";
 return new Promise((done,reject)=>{
  const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
   {windowsHide:true,timeout:10000,maxBuffer:65536},(cause,stdout)=>{
    if(cause)return reject(error('无法核实归档文件的重解析点属性',503,'archive-path-inspection-unavailable'));
    const value=stdout.trim();if(!['true','false'].includes(value))return reject(error('归档路径属性返回无效',503));done(value==='true');
   });
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(paths));
 });
}

export function createResearchArchive({manifestPath=defaultManifest,allowedRoots=[dirname(defaultManifest)],protectedRoots=[join(portableRoot,'service'),join(portableRoot,'runtime'),join(portableRoot,'config'),join(portableRoot,'data'),join(portableRoot,'app'),join(portableRoot,'resources'),join(portableRoot,'node_modules')],relativePaths=false,cacheMs=15000,
 liveRuntimePath=join(dirname(fileURLToPath(import.meta.url)),'runtime'),getLiveSessionId=null,reparseInspector=nativeReparseInspector}={}){
 const roots=allowedRoots.map(root=>resolve(root)),runtime=resolve(liveRuntimePath);
 const ttl=Math.min(15000,Math.max(0,Number.isFinite(cacheMs)?cacheMs:15000));
 let cached=null,inflight=null;
 const secret=path=>path.split(/[\\/]/).some(part=>/^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.codex|\.git|node_modules)$/i.test(part)||
  /^(?:credentials?|secrets?|private[-_]?key|wallet(?:[-_.].*)?)(?:\..*)?$/i.test(part))||/\.(?:pem|key|pfx|p12|jks|keystore)$/i.test(path);
 function liveSessionId(){
  try{
   if(typeof getLiveSessionId!=='function')return null;
   const value=getLiveSessionId();
   if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});return null;}
   return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)?value.toLowerCase():null;
  }catch{return null;}
 }
 function blockedReason(path,catalog){
  const absolute=resolve(path),name=basename(absolute);
  if(secret(absolute))return 'secret-or-private-path';
  if(protectedRoots.some(root=>inside(root,absolute)))return 'live-service-or-runtime';
  if(/[\\/](?:ray-audit|automatic-audit)[\\/]status\.json$/i.test(absolute)||/^worker\.lock\.json$/i.test(name))return 'live-audit-or-worker-status';
  if(/[\\/]observers[\\/].*[\\/](?:18791|18792|18793)(?:[\\/]|$)/i.test(absolute))return 'live-independent-observer';
  if(inside(runtime,absolute)){
   const rel=relative(runtime,absolute),first=rel.split(sep)[0];
   if(['outcomes','financial-outcomes'].includes(first))return 'live-financial-evidence';
   if(/^(?:state\.json|(?:strategy-observation|p1-study|p3-study|p3-confirmation|p3-value-research|continuation-study|p3-adaptive|p3-adaptive-account|settlement-shadow|settlement-samples)\.(?:json|jsonl)|evolution-maintenance\.json|history-approval\.json)$/i.test(name)||
    /(?:\.tmp|\.pid|\.lock(?:\.json)?)$/i.test(name))return 'live-runtime-state';
   // Identity comes from controller memory, never an async read of its atomic
   // snapshot. A Windows reader handle can otherwise block rename while the
   // synchronous save retry prevents that reader's close from completing.
   const liveSession=liveSessionId(),lower=name.toLowerCase();
   if(liveSession&&(lower===liveSession+'.jsonl'||lower.startsWith(liveSession+'-')))return 'live-session-log';
   if(!liveSession&&/\.jsonl$/i.test(name))return 'live-session-identity-unknown';
  }
  for(const item of catalog.excluded??[]){
   const p=typeof item==='string'?item:item?.path;if(typeof p!=='string'||!isAbsolute(p))continue;
   const marker=p.search(/[?*]/),candidate=marker<0?p:p.slice(0,marker),value=normalized(absolute),excluded=normalized(candidate);
   if(marker<0?value===excluded:value.startsWith(excluded))return 'manifest-excluded';
  }
  return null;
 }
 async function load(){
  const checkedAt=Date.now();
  try{
   const stat=await fs.stat(manifestPath);if(!stat.isFile()||stat.size>maxManifestBytes)throw error('归档目录文件超过允许大小或类型无效',413,'archive-manifest-too-large');
   const bytes=await fs.readFile(manifestPath);if(bytes.length>maxManifestBytes)throw error('归档目录文件超过允许大小',413);
   const value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
   if(relativePaths&&Array.isArray(value?.files))for(const file of value.files)if(record(file)&&typeof file.path==='string'&&!isAbsolute(file.path))file.path=resolve(dirname(manifestPath),file.path);
   if(relativePaths&&Array.isArray(value?.excluded))value.excluded=value.excluded.map(item=>typeof item==='string'&&!isAbsolute(item)?resolve(dirname(manifestPath),item):record(item)&&typeof item.path==='string'&&!isAbsolute(item.path)?{...item,path:resolve(dirname(manifestPath),item.path)}:item);
   if(!record(value)||value.schema!==schema||!Array.isArray(value.files)||!Array.isArray(value.groups)||
    value.excluded!==undefined&&!Array.isArray(value.excluded))throw error('归档目录格式无效',422,'archive-manifest-invalid');
   const groupIds=new Set();for(const group of value.groups){
    if(!record(group)||typeof group.id!=='string'||!group.id||groupIds.has(group.id))throw error('归档分类格式无效',422,'archive-manifest-invalid');
    groupIds.add(group.id);
   }
   const ids=new Set();
   for(const file of value.files){
    if(!record(file)||typeof file.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(file.id)||ids.has(file.id)||
      typeof file.path!=='string'||file.path.includes('\0')||!isAbsolute(file.path)||!groupIds.has(file.groupId)||
      !finite(file.logicalBytes)||file.sha256!==undefined&&file.sha256!==null&&!/^[a-f0-9]{64}$/i.test(file.sha256))
     throw error('归档目录存在无效文件或重复标识',422,'archive-manifest-invalid');
    ids.add(file.id);
   }
   return {status:'ready',checkedAt,value,files:new Map(value.files.map(file=>[file.id,file])),excluded:value.excluded??[],error:null};
  }catch(cause){return {status:cause.code==='ENOENT'?'waiting':'error',checkedAt,value:null,files:new Map(),
   excluded:[],error:cause.code==='ENOENT'?'历史归档目录尚未生成':String(cause.message),errorCode:cause.code??'archive-manifest-invalid'};}
 }
 async function catalog(){
  const now=Date.now();if(cached&&now>=cached.checkedAt&&now-cached.checkedAt<ttl)return cached;
  if(!inflight)inflight=load().then(value=>(cached=value)).finally(()=>{inflight=null;});return inflight;
 }
 const publicFile=(file,c)=>{const accessReason=blockedReason(file.path,c);return {...snapshot(file),access:accessReason?'blocked':'catalog-listed',
  accessReason,verificationScope:'manifest-recorded-sha256-not-recomputed-on-request'};};
 function locate(c,id){
  if(c.status!=='ready')throw error(c.error??'归档目录不可用',c.status==='waiting'?503:422,c.errorCode);
  if(typeof id!=='string'||!c.files.has(id))throw error('归档文件标识不存在',404,'archive-file-not-found');
  const file=c.files.get(id),blocked=blockedReason(file.path,c);if(blocked)throw error('该路径不属于可读取的历史归档',403,blocked);
  return file;
 }
 async function opened(id){
  const c=await catalog(),file=locate(c,id),path=resolve(file.path);
  if(!roots.some(root=>inside(root,path)))throw error('归档路径不在允许目录内',403,'archive-outside-root');
  const chain=pathChain(path);
  try{
   for(const item of chain)if((await fs.lstat(item)).isSymbolicLink())throw error('不允许读取链接或重解析归档路径',403,'archive-reparse-path');
   const canonical=await fs.realpath(path),canonicalRoots=await Promise.all(roots.map(root=>fs.realpath(root).catch(()=>null)));
   if(!canonicalRoots.some(root=>root&&inside(root,canonical)))throw error('归档真实路径超出允许目录',403,'archive-outside-root');
   const expectedStat=await fs.lstat(canonical);
   if(expectedStat.isSymbolicLink()||!expectedStat.isFile())throw error('归档目标不是普通文件',403,'archive-not-file');
   if(await reparseInspector(chain))throw error('不允许读取链接或重解析归档路径',403,'archive-reparse-path');
   locate(c,id); // A session change while checking the path must take effect now.
   const handle=await fs.open(canonical,'r');
   try{
    const stat=await handle.stat();if(!stat.isFile())throw error('归档目标不是普通文件',403,'archive-not-file');
    const pathStat=await fs.stat(canonical);
    if(stat.dev!==pathStat.dev||stat.ino!==pathStat.ino||stat.dev!==expectedStat.dev||stat.ino!==expectedStat.ino)
     throw error('归档文件身份在读取前发生变化',409,'archive-identity-changed');
    locate(c,id);
    const warnings=[];if(stat.size!==file.logicalBytes)warnings.push('logical-size-changed-since-catalog');
    const expectedAt=typeof file.modifiedAt==='string'?Date.parse(file.modifiedAt):file.modifiedAt;
    if(Number.isFinite(expectedAt)&&Math.abs(expectedAt-stat.mtimeMs)>1)warnings.push('modified-time-changed-since-catalog');
    return {handle,path:canonical,file,size:stat.size,verification:{pathVerified:true,contentSha256Verified:false,
     sha256Source:'archive-manifest',recordedSha256:file.sha256??null,recordedStatus:file.status??null,
     recordedLogicalBytes:file.logicalBytes,observedLogicalBytes:stat.size,observedModifiedAt:stat.mtimeMs,warnings}};
   }catch(cause){await handle.close();throw cause;}
  }catch(cause){if(cause.status)throw cause;throw error(cause.code==='ENOENT'?'归档文件当前不存在':'归档文件当前无法读取',cause.code==='ENOENT'?404:503,cause.code??'archive-file-unreadable');}
 }
 return {
  async summary(){const c=await catalog();if(c.status!=='ready')return {schema,status:c.status,createdAt:null,groups:[],files:0,error:c.error,
    verificationScope:'historical-catalog-only-not-current-strategy-or-profit-verification'};
   const files=[...c.files.values()],sum=key=>files.reduce((total,file)=>total+(finite(file[key])?file[key]:0),0);
   return {schema,status:'ready',createdAt:c.value.createdAt??null,cutoff:snapshot(c.value.cutoff??null),storage:snapshot(c.value.storage??null),
    groups:c.value.groups.map(group=>({...snapshot(group),fileCount:files.filter(file=>file.groupId===group.id).length})),
    files:files.length,logicalBytes:sum('logicalBytes'),allocatedBeforeBytes:sum('allocatedBeforeBytes'),allocatedAfterBytes:sum('allocatedAfterBytes'),
    compressedFiles:files.filter(file=>file.compressed===true).length,excludedCount:c.excluded.length,
    checkedAt:c.checkedAt,contentSha256Verified:false,verificationScope:'historical-catalog-only-not-current-strategy-or-profit-verification'};
  },
  async list({groupId=null,q='',offset=0,limit=25}={}){
   if(groupId!==null&&typeof groupId!=='string'||typeof q!=='string'||q.length>120||!Number.isSafeInteger(offset)||offset<0||
    !Number.isSafeInteger(limit)||limit<1||limit>100)throw error('归档筛选或分页参数无效',400,'archive-query-invalid');
   const c=await catalog();if(c.status!=='ready')return {status:c.status,files:[],total:0,offset,limit,error:c.error};
   const term=q.toLocaleLowerCase(),files=[...c.files.values()].filter(file=>(!groupId||file.groupId===groupId)&&
    (!term||`${file.path} ${file.id} ${file.groupId}`.toLocaleLowerCase().includes(term)));
   return {status:'ready',files:files.slice(offset,offset+limit).map(file=>publicFile(file,c)),total:files.length,offset,limit};
  },
  async preview(id){
   const source=await opened(id);try{
    if(!textTypes.has(extname(source.path).toLowerCase()))return {path:source.path,text:'此文件为二进制，请下载查看。',previewable:false,
     truncated:false,bytes:0,size:source.size,verification:source.verification};
    const buffer=Buffer.alloc(Math.min(previewBytes,source.size)),{bytesRead}=await source.handle.read(buffer,0,buffer.length,0);
    return {path:source.path,text:new TextDecoder('utf-8').decode(buffer.subarray(0,bytesRead),{stream:source.size>bytesRead}),previewable:true,truncated:source.size>bytesRead,
     bytes:bytesRead,size:source.size,verification:source.verification};
   }finally{await source.handle.close();}
  },
  async openFile(id){const source=await opened(id);try{
   return {path:source.path,size:source.size,fileName:basename(source.path),stream:source.handle.createReadStream({autoClose:true}),verification:source.verification};
  }catch(cause){await source.handle.close();throw cause;}}
 };
}
