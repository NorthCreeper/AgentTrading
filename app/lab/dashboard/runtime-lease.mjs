import net from 'node:net';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {realpathSync} from 'node:fs';

// A kernel-owned loopback lease disappears on process death: no stale PID-file
// deletion race and no second writer may initialize the same financial store.
export function runtimeLeasePort(directory,kind='account') {
  let canonical;try{canonical=realpathSync.native(directory);}catch{canonical=resolve(directory);}
  const key=kind+':'+canonical.toLowerCase();
  return 20000+createHash('sha256').update(key).digest().readUInt32BE(0)%30000;
}
export async function acquireRuntimeLease(directory,{kind='account'}={}) {
  const port=runtimeLeasePort(directory,kind),server=net.createServer(socket=>socket.destroy());
  try { await new Promise((ok,no)=>{server.once('error',no);server.listen({port,host:'127.0.0.1',exclusive:true},ok);}); }
  catch(error){server.close();throw new Error(`后台单实例保护：${kind} 已被占用或无法取得（${error.code}，端口 ${port}）；不读取或修改账户`,{cause:error});}
  let closed=false;
  return {port,release:()=>new Promise(ok=>{if(closed)return ok();closed=true;server.close(ok);})};
}
