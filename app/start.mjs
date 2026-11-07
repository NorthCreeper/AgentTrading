import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadStandaloneContext} from '../service/paths.mjs';
import {DashboardController} from './lab/dashboard/controller.mjs';
import {validateStrategyConfig} from './lab/dashboard/strategy.mjs';
import {nextRunIntent} from './lab/dashboard/run-intent.mjs';
import {createDashboardServer} from './lab/dashboard/server.mjs';
import {createRuntimeClock} from './lab/dashboard/runtime-clock.mjs';
import {launchDashboard} from './lab/dashboard/process-runtime.mjs';
import {writeJsonAtomic} from './lab/dashboard/atomic-json.mjs';
import {createLiveExtension} from './integration/live-extension.mjs';

const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const contained=(root,file)=>{const rel=path.relative(root,file);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
function releaseFile(root,relativePath){
 if(typeof relativePath!=='string'||!relativePath||path.isAbsolute(relativePath)||relativePath.includes('\0'))throw Error('发行清单包含无效相对路径');
 const target=path.resolve(root,relativePath);if(!contained(root,target))throw Error('发行资源路径超出应用目录');
 const canonical=fs.realpathSync(target),canonicalRoot=fs.realpathSync(root);if(!contained(canonicalRoot,canonical)||!fs.statSync(canonical).isFile())throw Error('发行资源真实路径超出应用目录或不是普通文件');return target;
}

// Explicit build operation only. Startup never invents a release hash for unknown code.
export function writeReleaseSourceManifest(root=defaultRoot,{extraPaths=[]}={}){
 root=path.resolve(root);const selected=[];
 function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isSymbolicLink())throw Error('发行源码不允许符号链接');if(entry.isDirectory()){if(entry.name==='node_modules')continue;walk(file);}else if(entry.isFile()&&/\.(?:mjs|html|css|json)$/.test(entry.name)&&!entry.name.endsWith('.test.mjs')&&!['release-source-manifest.json'].includes(entry.name))selected.push(file);}}
 walk(path.join(root,'app'));walk(path.join(root,'resources'));
 for(const relativePath of extraPaths)selected.push(releaseFile(root,relativePath));
 const files=[...new Set(selected)].sort().map(file=>{const bytes=fs.readFileSync(file);return{path:path.relative(root,file).replaceAll('\\','/'),bytes:bytes.length,sha256:digest(bytes)};});
 const manifest={version:'btc5m-standalone-source-manifest-v1',builtAt:Date.now(),protocolVersion:'ray-twap-event-onetap-v8',scope:'Standalone release source and immutable resources; excludes financial state, secrets and user configuration.',files};
 const file=path.join(root,'resources/release-source-manifest.json');writeJsonAtomic(file,manifest);return manifest;
}

export function verifyReleaseSourceManifest(root=defaultRoot){
 root=path.resolve(root);const file=path.join(root,'resources/release-source-manifest.json');
 if(!fs.existsSync(file))throw Error('发行源码清单缺失，请先完成独立版构建');
 const bytes=fs.readFileSync(file),manifest=JSON.parse(bytes.toString('utf8'));
 if(manifest.version!=='btc5m-standalone-source-manifest-v1'||manifest.protocolVersion!=='ray-twap-event-onetap-v8'||!Array.isArray(manifest.files)||manifest.files.length===0)throw Error('发行源码清单无效');
 const seen=new Set(),sourceFiles=manifest.files.map(item=>{if(!item||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(item.sha256))throw Error('发行源码校验值无效');const absolute=releaseFile(root,item.path),key=absolute.toLowerCase();if(seen.has(key))throw Error('发行源码清单重复');seen.add(key);const actual=fs.readFileSync(absolute);if(digest(actual)!==item.sha256.toLowerCase()||item.bytes!==undefined&&actual.length!==item.bytes)throw Error('发行文件已改变：'+item.path);return{path:absolute,sha256:item.sha256.toLowerCase(),bytes:actual.length};});
 return{manifestPath:file,manifestSha256:digest(bytes),manifest,sourceFiles};
}

function registerStandaloneSource({context,controller,release}){
 const directory=path.join(context.paths.dataDirectory,'audit');fs.mkdirSync(directory,{recursive:true});
 const registrationPath=path.join(directory,'ray-registration.json'),calendar=path.join(context.root,'app/lab/dashboard/reports/ray-calendar-data.json'),policy=path.join(context.root,'app/lab/dashboard/reports/ray-calendar-policy.json');
 const registration={schema:'ray-alignment-observation-v1',createdAt:controller.clock(),protocolVersion:'ray-twap-event-onetap-v8',sessionId:controller.sessionId,maxExposure:null,
  riskPolicy:{version:'equity-per-order-v1',minimumPct:.025,maximumPct:.1,aggregateCostCap:null,feeInclusive:true},
  calendarSources:{calendarSha256:digest(fs.readFileSync(calendar)),policySha256:digest(fs.readFileSync(policy))},
  sourceFiles:release.sourceFiles,releaseSourceManifest:{relativePath:'resources/release-source-manifest.json',sha256:release.manifestSha256},
  standaloneIdentity:context.identity,scope:'Current independent account and supplied source bytes only; any imported financial history retains its separate migration and recovery provenance. This registration does not certify historical profitability.',
  legacyAudit:{status:fs.existsSync(path.join(context.root,'config/legacy-import-guard.json'))?'migration-provenance-retained':'not-imported',explanation:'Source registration does not recertify old research diagnostics or erase missing historical evidence.'},
  constraints:{realTrading:false,pairedValidation:'shadow-only',actualAllocation:.025,automaticPromotion:false}};
 if(fs.existsSync(registrationPath)){const previous=fs.readFileSync(registrationPath);const archive=path.join(directory,'registration-history');fs.mkdirSync(archive,{recursive:true});const file=path.join(archive,`${Date.now()}-${digest(previous).slice(0,12)}.json`);fs.writeFileSync(file,previous,{flag:'wx'});}
 writeJsonAtomic(registrationPath,registration);return registrationPath;
}

export async function startPortable({root=process.env.BTC5M_STANDALONE_ROOT??defaultRoot,portOverride,recoverIntent,liveFactory=createLiveExtension,installSignals=true,clockFactory=createRuntimeClock}={}){
 const context=loadStandaloneContext(path.resolve(root));
 const release=verifyReleaseSourceManifest(context.root);
 const port=Number(portOverride??process.env.BTC5M_DASHBOARD_PORT??context.config.server.port);
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('控制台端口无效');
 const directory=context.paths.dataDirectory??context.paths.data;
 const legacyGuardPath=path.join(context.root,'config/legacy-import-guard.json');
 const legacyGuard=fs.existsSync(legacyGuardPath)?json(legacyGuardPath):null;
 if(legacyGuard&&legacyGuard.version!=='btc5m-legacy-import-guard-v1')throw Error('旧账户导入保护标记无效');
 const legacyPending=legacyGuard?.requiresExplicitStop===true;let legacyFinancialKey;
 if(legacyPending){
  if(path.resolve(legacyGuard.target)!==path.resolve(directory)||!/^[0-9a-f]{64}$/.test(legacyGuard.sourceFinancialKey??''))throw Error('旧账户导入保护与当前数据目录不一致');
  ({legacyFinancialKey}=await import('../tools/migrate-legacy.mjs'));
  if(legacyFinancialKey(json(path.join(directory,'state.json')))!==legacyGuard.sourceFinancialKey)throw Error('导入账户的关键资金或交易记录发生变化，保持停止');
 }
 const resume=legacyPending?false:recoverIntent??(process.env.BTC5M_RECOVER_INTENT==='1'||context.config.startup?.resumePaper===true);
 const application=await launchDashboard({directory,port,recoverIntent:resume,installSignals,managed:!!process.connected,manager:process.connected?'portable-supervisor':'manual',factory:async({server})=>{
  const runtimeClock=await clockFactory();let extension;
  try{
   const admissionResearchConfig={stage:3,validationEnabled:true,artifactPath:path.join(context.paths.resources,'terminal-admission-artifact.json'),artifactSha256:'fe5865209d2f25b06fd9a15c27f6a7a99acac232ca351087fcda69303fd821f2',directory:path.join(context.root,'data/observations')};
   const controller=new DashboardController({directory,clock:runtimeClock.now,admissionResearchConfig});controller.runtimeClock=runtimeClock;
   if(!fs.existsSync(path.join(directory,'state.json'))){
    const defaults=json(path.join(context.paths.resources,'paper-defaults.json'));
    if(defaults.schema!=='btc5m-standalone-paper-defaults-v1'||defaults.strategyConfig?.model!=='ray-twap-band'||defaults.strategyConfig.execution!=='paper'||defaults.config?.riskPolicy!=='equity-per-order-v1'||defaults.config.maxExposure!==null||defaults.config.size!==100)throw Error('独立实例默认策略配置无效');
    controller.validateConfig(defaults.config);validateStrategyConfig(defaults.strategyConfig);controller.config=structuredClone(defaults.config);controller.strategyConfig=structuredClone(defaults.strategyConfig);controller.mode='auto';controller.paused=true;
    controller.runIntent=nextRunIntent(controller.runIntent,{running:false,mode:'auto',paused:true},runtimeClock.now());controller.newEngine();
   }
   await controller.initialize();
   if(legacyPending){
    if(legacyFinancialKey(controller.savedState())!==legacyGuard.sourceFinancialKey)throw Error('导入初始化改变关键资金或交易记录，保持停止');
    await controller.command('stop');
    if(legacyFinancialKey(controller.savedState())!==legacyGuard.sourceFinancialKey)throw Error('导入停止核对未通过，保持停止');
    writeJsonAtomic(legacyGuardPath,{...legacyGuard,requiresExplicitStop:false,consumedAt:Date.now(),consumedBy:'controller-stop',resultStateSha256:digest(fs.readFileSync(path.join(directory,'state.json')))});
   }
   const registrationPath=registerStandaloneSource({context,controller,release});
   if(liveFactory)extension=await liveFactory({root:context.root,context,controller,clock:runtimeClock.now,runtimeClock,portableIdentity:context.identity});
   const router=typeof extension==='function'?extension:extension?.router;
   const app=await createDashboardServer({directory,controller,controllerInitialized:true,server,portableIdentity:context.identity,admissionResearchConfig,
    researchArchiveManifest:path.join(context.root,'archives/catalog.json'),archiveAllowedRoots:[path.join(context.root,'archives')],archiveProtectedRoots:[context.paths.dataDirectory,context.paths.liveData,path.join(context.root,'config'),path.join(context.root,'service'),path.join(context.root,'runtime'),path.join(context.root,'resources'),path.join(context.root,'app'),path.join(context.root,'node_modules'),context.paths.backups,context.paths.logs].filter(Boolean),archiveRelativePaths:true,
    rayAuditRegistrationPath:registrationPath,independentResearchHealthReader:{snapshot:()=>({status:'not-configured',hasErrors:false,services:[],scope:'No archived independent research workers are started by this fresh standalone instance.'}),close(){}},legacyAuditStatusPath:null,extensionRouter:router,extensionClose:extension?.close,extensionStatus:extension?.summary,extensionBeforeControl:extension?.beforeControl});
   return{...app,extension};
  }catch(error){try{await extension?.close?.();}catch{}runtimeClock.close();throw error;}
 }});
 return{...application,context,port};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 startPortable().then(app=>console.log(JSON.stringify({service:'btc5m-standalone',port:app.port,portableIdentity:app.context.identity,realTrading:false,running:app.controller.running}))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
