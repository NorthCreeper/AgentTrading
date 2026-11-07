import http from 'node:http';
import {acquireRuntimeLease} from './runtime-lease.mjs';
import {createIntentRecovery} from './run-intent.mjs';

export async function launchDashboard({directory,port,factory,recoverIntent=false,installSignals=true,managed=false,manager=null}) {
  const lease=await acquireRuntimeLease(directory);
  const server=http.createServer((req,res)=>{
    if(req.url==='/'&&(req.method==='GET'||req.method==='HEAD')){
      // A browser that arrives during clock/storage recovery must retry by
      // itself. APIs still return 503, so startup is never reported healthy.
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      res.end(req.method==='HEAD'?'':'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="2"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC 控制台正在恢复</title><body style="font:18px system-ui;background:#101820;color:#e6edf3;padding:10vh 8vw"><h1>后台正在恢复</h1><p>正在读取账户和校准时间，页面会自动重试。</p><p>此页面尚未连接策略。</p></body></html>');
      return;
    }
    res.writeHead(503,{'Content-Type':'application/json','Retry-After':'2','Cache-Control':'no-store'});
    res.end(JSON.stringify({service:'btc5m-local-dashboard',status:'starting'}));
  });
  try {
    // Bind the real API port BEFORE loading the financial store. This also
    // rejects an older, unsupervised server that has no lease yet.
    await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
  }catch(error){await lease.release();throw error;}
  let app,recovery,closePromise=null;
  const close=()=>{
    if(closePromise)return closePromise;
    closePromise=(async()=>{recovery?.close();let failure;
      try{await app?.extension?.close?.();}catch(error){failure=error;}
      try{if(app)await app.controller.command('stop',{}, {preserveRunIntent:recoverIntent});}catch(error){failure??=error;}
      finally{server.closeAllConnections();await new Promise(ok=>server.close(ok));await lease.release();}
      if(failure)throw failure;
    })();return closePromise;
  };
  try {
    app=await factory({directory,server});
    app.controller.serviceRuntime={managed:managed||recoverIntent,manager:manager??(recoverIntent?'windows-task-scheduler':'manual'),pid:process.pid,
      startedAt:app.controller.clock(),nodePath:process.execPath,singleWriter:true,leasePort:lease.port};
    if(recoverIntent){recovery=createIntentRecovery(app.controller);await recovery.check();}
    if(installSignals){
      process.once('SIGINT',()=>void close().catch(error=>{console.error(error.message);process.exitCode=1;}));
      process.once('SIGTERM',()=>void close().catch(error=>{console.error(error.message);process.exitCode=1;}));
      process.on('message',message=>{if(message?.type==='btc5m-managed-shutdown')void close().then(()=>process.exit(0),()=>process.exit(1));});
      // If the Windows-owned supervisor dies, close the child as well. The
      // scheduler can then recover a whole process tree without an orphan
      // occupying the API port. Preserve the user's durable run/stop intent.
      if((recoverIntent||managed)&&process.connected)process.once('disconnect',()=>void close().then(()=>process.exit(0),()=>process.exit(1)));
    }
    server.once('close',()=>{recovery?.close();void lease.release();});
    return {...app,close,lease};
  }catch(error){try{await close();}catch{}throw error;}
}
