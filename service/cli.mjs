import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {loadStandaloneContext,verifyRuntime,atomicJson} from './paths.mjs';import {apiProbe,portInUse,serviceRequest,sendWorkflowStop,assertOffline,readStatus,delay} from './control.mjs';
function workflowSummary(state){const live=state?.liveTrading;return{paperWorkflow:{running:state.running,paused:state.paused,mode:state.mode,realTrading:state.realTrading===false?false:null},realTrading:typeof live?.enabled==='boolean'?live.enabled:null,
 liveTrading:{enabled:typeof live?.enabled==='boolean'?live.enabled:null,connected:typeof live?.connected==='boolean'?live.connected:null,locked:typeof live?.locked==='boolean'?live.locked:null,busy:typeof live?.busy==='boolean'?live.busy:null,halt:live?.halt?'请在控制台查看真实交易暂停原因':null,requiresReconciliation:typeof live?.requiresReconciliation==='boolean'?live.requiresReconciliation:null}};}
function serviceSummary(value){if(!value)return null;return{version:value.version,portableIdentity:value.portableIdentity,pid:value.pid,hostPid:value.hostPid,workerPid:value.workerPid,state:value.state,startedAt:value.startedAt,heartbeatAt:value.heartbeatAt,restarts:value.restarts,hasError:!!value.lastError,lastStop:value.lastStop?{at:value.lastStop.at,graceful:value.lastStop.graceful}:null};}
export async function startService(ctx,{open=false,timeoutMs=100000}={}){
 verifyRuntime(ctx);let current=await apiProbe(ctx),service=await serviceRequest(ctx);
 if(current.ready&&!current.own)throw Error('该控制台端口属于其他工作流；未启动第二套实例');
 if(!current.own&&!service&&await portInUse(ctx.config.server.port))throw Error('端口已被其他程序占用；未修改它或创建账户');
 if(!current.own&&!service){
  fs.mkdirSync(ctx.paths.logs,{recursive:true});try{fs.unlinkSync(path.join(ctx.paths.logs,'backend-disabled.json'));}catch{}
  const host=path.join(ctx.paths.service,'headless-host.exe');if(!fs.existsSync(host))throw Error('独立后台启动程序缺失');
  const child=spawn(host,[ctx.paths.node,path.join(ctx.paths.service,'supervisor.mjs'),ctx.root,path.join(ctx.paths.logs,'standalone-host')],{cwd:ctx.root,windowsHide:true,detached:true,stdio:'ignore'});
  await new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});child.unref();
 }
 const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){current=await apiProbe(ctx);if(current.own){if(open){const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',ctx.api],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();}return{ready:true,portableIdentity:ctx.identity,url:ctx.api,running:current.state.running,paused:current.state.paused,...workflowSummary(current.state)};}
  service=await serviceRequest(ctx);if(service?.state==='blocked'||service?.state==='blocked-port')throw Error(service.lastError??'后台启动被阻止');await delay(500);}
 throw Error('后台尚未就绪，请查看 logs 中的状态和工作日志；未宣称策略已启动');
}
export async function stopService(ctx){
 const before=await apiProbe(ctx);if(before.ready&&!before.own)throw Error('端口属于其他工作流，未发送停止命令');const service=await serviceRequest(ctx);
 if(!before.own&&!service){if(await portInUse(ctx.config.server.port))throw Error('端口被其他进程占用，未操作该进程');return{stopped:true,alreadyStopped:true};}
 atomicJson(path.join(ctx.paths.logs,'backend-disabled.json'),{version:'btc5m-explicit-backend-stop-v1',at:Date.now(),portableIdentity:ctx.identity});
 if(before.own)await sendWorkflowStop(ctx);const result=await serviceRequest(ctx,'stop',{timeoutMs:28000});
 if(!result){throw Error('已请求策略停止，但未确认整个后台关闭；请查看日志，不进行备份或覆盖恢复');}
 const alive=pid=>{if(!Number.isInteger(pid))return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
 for(let i=0;i<100;i++){if(!await portInUse(ctx.config.server.port)&&!await serviceRequest(ctx)&&!alive(result.pid)&&!alive(result.hostPid)){if(result.graceful===false)throw Error('后台被强制关闭；需先核对账户，再进行完整备份');return{stopped:true,graceful:true};}await delay(100);}
 throw Error('后台端口仍未释放；未宣称关闭成功');
}
export async function diagnose(ctx){const probe=await apiProbe(ctx),service=await serviceRequest(ctx),status=readStatus(ctx);return{version:'btc5m-diagnostics-v1',at:Date.now(),portableIdentity:ctx.identity,url:ctx.api,ownApi:probe.own??false,portOccupied:await portInUse(ctx.config.server.port),service:serviceSummary(service??status),workflow:probe.own?{...workflowSummary(probe.state),clockReady:probe.state.clock?.ready??false}:null,paths:{data:ctx.paths.data,liveData:ctx.paths.liveData,logs:ctx.paths.logs,backups:ctx.paths.backups},note:'诊断不包含本地控制令牌、真实账户地址、钱包秘密或签名。'};}
export async function main(args=process.argv.slice(2)){
 const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),ctx=loadStandaloneContext(root),action=args[0]??'status';
 if(action==='start')return startService(ctx,{open:args.includes('--open')});if(action==='stop')return stopService(ctx);if(action==='status'||action==='diagnose')return diagnose(ctx);if(action==='identity')return{portableIdentity:ctx.identity,root:ctx.root,config:ctx.config};
 if(action==='backup'){await stopService(ctx);await assertOffline(ctx);const{createBackup}=await import('./backup.mjs');return createBackup(ctx,{includeVault:args.includes('--include-vault')});}
 if(action==='restore'){const source=args[1];if(!source||source.startsWith('--'))throw Error('请提供完整备份目录路径：Restore.cmd "备份目录"');await stopService(ctx);await assertOffline(ctx);const{restoreBackup}=await import('./backup.mjs');return restoreBackup(ctx,path.resolve(source));}
 throw Error('支持 start、stop、status、diagnose、backup、restore、identity');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await main(),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
