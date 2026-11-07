import fs from 'node:fs';import net from 'node:net';import path from 'node:path';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';import {sameIdentity,readJson} from './paths.mjs';
export const installationLeasePort=ctx=>20000+createHash('sha256').update('btc5m-installation:'+ctx.identity.instanceId).digest().readUInt32BE()%30000;
export async function acquireOfflineLeases(ctx,{additionalData=[]}={}){
 const modulePath=path.join(ctx.root,'app/lab/dashboard/runtime-lease.mjs');if(!fs.existsSync(modulePath))throw Error('缺少账户单实例保护模块');const{runtimeLeasePort}=await import(pathToFileURL(modulePath));
 const ports=[...new Set([installationLeasePort(ctx),...new Set([ctx.paths.data,ctx.paths.liveData,...additionalData])].map((v,i)=>i===0?v:runtimeLeasePort(v)))],leases=[];
 try{for(const port of ports){const server=net.createServer(socket=>socket.destroy());await new Promise((ok,no)=>{server.once('error',no);server.listen({port,host:'127.0.0.1',exclusive:true},ok);});leases.push(server);}}
 catch(error){await Promise.all(leases.map(server=>new Promise(ok=>server.close(ok))));throw Error('账户或后台仍在使用，拒绝并发备份/恢复：'+error.code);}
 return async()=>{await Promise.all(leases.map(server=>new Promise(ok=>server.close(ok))));};
}
export const controlFile=ctx=>path.join(ctx.paths.logs,'service-control.json');
export const statusFile=ctx=>path.join(ctx.paths.logs,'service-status.json');
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function portInUse(port){return new Promise(resolve=>{const socket=net.createConnection({port,host:'127.0.0.1'});const done=v=>{socket.destroy();resolve(v);};socket.setTimeout(1000,()=>done(true));socket.once('connect',()=>done(true));socket.once('error',e=>done(e.code!=='ECONNREFUSED'));});}
export async function apiProbe(ctx){try{const r=await fetch(ctx.api+'/api/state',{signal:AbortSignal.timeout(2500)});if(!r.ok)return{reachable:true,ready:false,status:r.status};const state=await r.json();const identity=state.portableIdentity??state.standalone?.portableIdentity??state.serviceRuntime?.portableIdentity;return{reachable:true,ready:true,own:sameIdentity(identity,ctx.identity),identity,state};}catch{return{reachable:false,ready:false};}}
export function readControl(ctx){try{const c=readJson(controlFile(ctx));return sameIdentity(c.portableIdentity,ctx.identity)&&Number.isInteger(c.port)&&c.port>=1024&&c.port<=65535&&/^[0-9a-f]{64}$/i.test(c.token)?c:null;}catch{return null;}}
export async function serviceRequest(ctx,action='status',{timeoutMs=30000}={}){
 const c=readControl(ctx);if(!c)return null;
 try{const r=await fetch('http://127.0.0.1:'+c.port+'/'+action,{method:action==='stop'?'POST':'GET',headers:{Authorization:'Bearer '+c.token},signal:AbortSignal.timeout(timeoutMs)});if(!r.ok)return null;const result=await r.json();return sameIdentity(result.portableIdentity,ctx.identity)?result:null;}catch{return null;}
}
export async function sendWorkflowStop(ctx){const probe=await apiProbe(ctx);if(probe.reachable&&probe.ready&&!probe.own)throw Error('该端口属于其他工作流，未发送停止命令');if(!probe.ready)return false;
 const boot=await fetch(ctx.api+'/api/bootstrap',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());const r=await fetch(ctx.api+'/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Token':boot.token},body:JSON.stringify({action:'stop'}),signal:AbortSignal.timeout(45000)});const result=await r.json();if(!r.ok)throw Error(result.error??'工作流停止失败');
 const after=await apiProbe(ctx);if(!after.own||after.state.running||after.state.account?.active)throw Error('未确认策略已停止并核对订单');return true;
}
export async function assertOffline(ctx){const service=await serviceRequest(ctx);if(service&&service.state!=='stopped')throw Error('请先关闭本应用后台，再备份或恢复');const probe=await apiProbe(ctx);if(probe.own)throw Error('本应用后台仍运行，拒绝读取可能变化的账户');if(probe.reachable&&!probe.own)throw Error('端口被其他服务占用；未操作该服务或账户');}
export function readStatus(ctx){try{const s=readJson(statusFile(ctx));return sameIdentity(s.portableIdentity,ctx.identity)?s:null;}catch{return null;}}
export function removeControl(ctx){try{const c=readControl(ctx);if(c?.pid===process.pid)fs.unlinkSync(controlFile(ctx));}catch{}}
