import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {loadStandaloneContext,atomicJson,verifyRuntime,sameIdentity} from './paths.mjs';import {apiProbe,portInUse,controlFile,statusFile,removeControl} from './control.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),ctx=loadStandaloneContext(root),disabled=path.join(ctx.paths.logs,'backend-disabled.json');
if((process.argv.includes('--autostart')||process.env.BTC5M_AUTOSTART==='1')&&fs.existsSync(disabled))process.exit(0);
verifyRuntime(ctx);if(await portInUse(ctx.config.server.port))throw Error('控制台端口已占用；未启动第二个后台或读取账户');
const leasePort=20000+createHash('sha256').update('btc5m-installation:'+ctx.identity.instanceId).digest().readUInt32BE()%30000,lease=net.createServer(s=>s.destroy());
await new Promise((ok,no)=>{lease.once('error',no);lease.listen({host:'127.0.0.1',port:leasePort,exclusive:true},ok);});
fs.mkdirSync(ctx.paths.logs,{recursive:true});const token=randomBytes(32).toString('hex');let worker=null,stopping=false,wake=null,lastGraceful=true,control;
const status={version:'btc5m-standalone-service-v1',portableIdentity:ctx.identity,pid:process.pid,hostPid:process.ppid,workerPid:null,startedAt:Date.now(),heartbeatAt:Date.now(),state:'starting',restarts:0,lastError:null};
const save=()=>{status.heartbeatAt=Date.now();atomicJson(statusFile(ctx),status);};
const log=row=>fs.appendFileSync(path.join(ctx.paths.logs,'service-events.jsonl'),JSON.stringify({wallTime:Date.now(),...row})+'\n');
const wait=ms=>new Promise(ok=>{const timer=setTimeout(ok,ms);wake=()=>{clearTimeout(timer);ok();};});
async function stopWorker(){const child=worker;if(!child||child.exitCode!==null||child.signalCode!==null)return true;let timer;
 const exited=new Promise(resolve=>child.once('exit',()=>resolve(true))),timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),20000);});
 try{if(child.connected)child.send({type:'btc5m-managed-shutdown'});}catch{}
 const graceful=await Promise.race([exited,timeout]);clearTimeout(timer);if(!graceful){log({type:'forced-worker-stop',pid:child.pid});child.kill();await Promise.race([exited,new Promise(ok=>{const t=setTimeout(ok,3000);t.unref();})]);}return graceful;
}
async function shutdown(reason='stop'){if(stopping)return;stopping=true;wake?.();status.state='stopping';save();lastGraceful=await stopWorker();status.state=lastGraceful?'stopped':'forced-stopped';status.workerPid=null;status.lastStop={at:Date.now(),reason,graceful:lastGraceful};save();log({type:'service-stop',reason,graceful:lastGraceful});}
control=http.createServer(async(req,res)=>{try{
 const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(403);res.end();return;}
 if(req.method==='GET'&&req.url==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status));return;}
 if(req.method==='POST'&&req.url==='/stop'){await shutdown('local-control');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...status,graceful:lastGraceful}));return;}
 res.writeHead(404);res.end();
}catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
await new Promise((ok,no)=>{control.once('error',no);control.listen(0,'127.0.0.1',ok);});
atomicJson(controlFile(ctx),{version:'btc5m-private-service-control-v1',portableIdentity:ctx.identity,pid:process.pid,startedAt:status.startedAt,port:control.address().port,token});save();
process.once('SIGINT',()=>void shutdown('signal'));process.once('SIGTERM',()=>void shutdown('signal'));process.once('exit',()=>{if(worker&&worker.exitCode===null&&worker.signalCode===null)worker.kill();});
let fastFailures=0;
try{while(!stopping){
 if(await portInUse(ctx.config.server.port)){status.state='blocked-port';status.lastError='端口已被占用，未启动新实例';save();await wait(15000);continue;}
 const run=Date.now()+'-'+status.restarts,out=fs.openSync(path.join(ctx.paths.logs,'worker-'+run+'.out.log'),'a'),err=fs.openSync(path.join(ctx.paths.logs,'worker-'+run+'.err.log'),'a');
 const started=Date.now();let ended=false;worker=spawn(ctx.paths.node,[ctx.paths.start],{cwd:ctx.root,windowsHide:true,env:{...process.env,BTC5M_STANDALONE_ROOT:ctx.root,BTC5M_STANDALONE_INSTANCE_ID:ctx.identity.instanceId,BTC5M_STANDALONE_ROOT_ID:ctx.identity.rootId,BTC5M_RECOVER_INTENT:ctx.config.startup?.resumePaper===true?'1':'0'},stdio:['ignore',out,err,'ipc']});fs.closeSync(out);fs.closeSync(err);
 const child=worker;status.workerPid=child.pid;status.state='worker-starting';status.lastError=null;save();log({type:'worker-start',pid:child.pid});
 child.once('error',error=>{ended=true;status.lastError=error.message;log({type:'worker-error',error:error.message});});child.once('exit',(code,signal)=>{ended=true;status.lastWorkerExit={at:Date.now(),code,signal,pid:child.pid};log({type:'worker-exit',...status.lastWorkerExit});wake?.();});let failures=0;
 while(!stopping&&!ended){await wait(5000);if(stopping||ended)break;const probe=await apiProbe(ctx);
  if(probe.own){failures=0;status.state='healthy';status.lastError=null;status.workflow={running:probe.state.running,paused:probe.state.paused,mode:probe.state.mode,realTrading:probe.state.realTrading,clockReady:probe.state.clock?.ready??false};}
  else{status.state='health-retry';status.lastError=probe.ready?'控制台实例身份不匹配':'后台尚未就绪';if(Date.now()-started>180000&&++failures>=6){await stopWorker();break;}}save();}
 if(worker===child)worker=null;status.workerPid=null;if(stopping)break;
 status.restarts++;fastFailures=Date.now()-started<30000?fastFailures+1:0;if(fastFailures>=5){status.state='blocked';status.lastError='后台连续启动失败，请查看工作日志后手动重新启动';save();while(!stopping)await wait(15000);break;}
 status.state='restart-backoff';save();await wait(Math.min(30000,1000*2**Math.min(status.restarts,5)));
}}finally{if(!stopping)await shutdown('supervisor-finally');while(status.state==='stopping')await new Promise(ok=>setTimeout(ok,10));removeControl(ctx);await new Promise(ok=>control.close(ok));await new Promise(ok=>lease.close(ok));}
