import {randomUUID} from 'node:crypto';
const address=v=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)&&!/^0x0{40}$/i.test(v)?v.toLowerCase():null;
export function createSignerBridge({timeoutMs=90000,clock=Date.now,verifySignature,canRequest=()=>true}={}){
 let epoch=0,current=null,owner=null;
 function cancelPending(){
  const request=current;
  if(!request)return;
  current=null;
  clearTimeout(request.timer);
  request.reject(Error('浏览器签名请求已取消'));
 }
 function close(){epoch++;owner=null;cancelPending();}
 function ask(kind,payload){
  if(!owner)throw Error('请先连接浏览器签名钱包');
  if(!canRequest())throw Error('当前签名请求已取消');
  if(current)throw Error('已有签名等待处理');
  payload=JSON.parse(JSON.stringify(payload,(_,value)=>typeof value==='bigint'?value.toString():value));
  if(Buffer.byteLength(JSON.stringify(payload))>65536)throw Error('签名请求过大');
  const id=randomUUID(),generation=epoch,signer=owner;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(current?.id===id){current=null;reject(Error('钱包签名等待超时，本次操作未继续提交'));}},timeoutMs);
   current={id,generation,kind,payload:structuredClone(payload),signer,createdAt:clock(),expiresAt:clock()+timeoutMs,resolve,reject,timer};});
 }
 return {close,cancelPending,connect(value){close();owner=address(value);if(!owner)throw Error('签名钱包地址无效');const connectionEpoch=epoch,connectedOwner=owner;
  const active=()=>{if(epoch!==connectionEpoch||owner!==connectedOwner)throw Error('浏览器签名连接已失效');};return{
   getAddress:async()=>{active();return connectedOwner;},
   signTypedData:async data=>{active();if(Number(data?.domain?.chainId)!==137)throw Error('仅支持 Polygon 签名');return ask('typedData',data);},
   signMessage:async message=>{active();return ask('message',message);},
   sendTransaction:async()=>{throw Error('浏览器桥不自动发送链上交易；请使用官方钱包流程');}
  };},
  pending(){if(!current)return null;const {id,kind,payload,signer,createdAt,expiresAt}=current;return structuredClone({id,kind,payload,signer,createdAt,expiresAt});},
  async answer({id,signature,rejected=false,signerAddress}){
   const request=current;if(!request||request.id!==id||request.generation!==epoch)throw Error('签名请求已失效');
   if(rejected){clearTimeout(request.timer);current=null;request.reject(Error('用户取消钱包签名'));return;}
   if(address(signerAddress)!==request.signer||typeof signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(signature))throw Error('钱包签名格式或账户不一致');
   const verifier=verifySignature??(async()=>{const {recoverTypedDataAddress,recoverMessageAddress}=await import('viem');return request.kind==='typedData'?
    await recoverTypedDataAddress({...request.payload,signature}):await recoverMessageAddress({message:request.payload,signature});});
   const recovered=await verifier(request,signature);if(address(recovered)!==request.signer)throw Error('钱包签名账户校验失败');
   if(current!==request||request.generation!==epoch)throw Error('签名请求已取消');clearTimeout(request.timer);current=null;request.resolve(signature);
  }
 };
}
