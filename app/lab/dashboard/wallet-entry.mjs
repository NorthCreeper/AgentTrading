export const walletProfileKey='btc5m-readonly-wallet-address-v1';
const address=v=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)&&!/^0x0{40}$/i.test(v)?v.toLowerCase():null;
export function loadWalletProfile(storage){try{const p=JSON.parse(storage?.getItem(walletProfileKey)??'null');return p?.version===1?address(p.address):null;}catch{return null;}}
export function saveWalletProfile(storage,value,remember){try{const normalized=address(value);if(!remember||!normalized)storage?.removeItem(walletProfileKey);
 else {if(typeof storage?.setItem!=='function')return false;storage.setItem(walletProfileKey,JSON.stringify({version:1,address:normalized}));}return true;}catch{return false;}}
const statuses={disconnected:'尚未接入',loading:'读取余额中',ready:'已接入 · 只读',stale:'余额已过期',error:'余额查询失败'};
export function walletEntryView(wallet){const connected=!!wallet?.address,status=wallet?.status??'disconnected';
 const amount=wallet?.balance==null?'—':Number.isFinite(wallet.balanceNumber)?`${wallet.balanceNumber.toLocaleString('en-US',{minimumFractionDigits:4,maximumFractionDigits:6})} pUSD`:`${wallet.balance} pUSD`;
 return {connected,status:statuses[status]??'状态未知',address:wallet?.address??'尚未接入',balance:amount,
  short:connected?`${wallet.address.slice(0,6)}…${wallet.address.slice(-4)}`:'接入钱包',
  balanceNote:wallet?.balance==null?'接入后读取指定账户的链上现金':status==='stale'?'上次观测余额，等待更新':'Polygon · 不含持仓价值',
  observed:wallet?.observedAt?`更新于 ${new Date(wallet.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false})} HKT · 区块 ${wallet.blockNumber}`:'支持浏览器钱包公开地址，或填写 Polymarket 账户地址。',
  error:wallet?.error??null};}
export function createWalletReadback({fetchFn=globalThis.fetch,onUpdate=()=>{},onError=()=>{},timeoutMs=8000}={}){
 let generation=0,inflight=null,controller=null;
 const invalidate=()=>{generation++;controller?.abort();controller=null;inflight=null;};
 return {invalidate,accept(wallet){invalidate();onUpdate(wallet);},refresh(){if(inflight)return inflight;
  const g=generation,c=new AbortController();controller=c;let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{c.abort();reject(Error('钱包余额服务响应超时，请稍后刷新'));},timeoutMs);});
  const work=async()=>{try{const response=await Promise.race([fetchFn('/api/wallet-balance',{cache:'no-store',signal:c.signal}),timeout]);
   if(!response.ok)throw Error('钱包余额服务未连接');const result=await Promise.race([response.json(),timeout]);if(g===generation)onUpdate(result);return result;
  }catch(error){if(g===generation)onError(error);return null;}finally{clearTimeout(timer);if(g===generation){inflight=null;controller=null;}}};
  inflight=work();return inflight;
 }};
}
export const isWalletCommand=action=>['walletConnect','walletDisconnect','walletRefresh'].includes(action);
export async function requestWalletCommand({action,input={},token,fetchFn=globalThis.fetch,timeoutMs=12000}){
 if(!isWalletCommand(action))throw Error('仅支持钱包只读操作');
 const controller=new AbortController();let timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('钱包请求超时，请刷新核对连接状态'));},timeoutMs);});
 try{
  const response=await Promise.race([fetchFn('/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Token':token},body:JSON.stringify({action,input}),signal:controller.signal}),timeout]);
  const data=await Promise.race([response.json(),timeout]);if(!response.ok)throw Error(data.error??'钱包操作失败');return data;
 }finally{clearTimeout(timer);}
}
