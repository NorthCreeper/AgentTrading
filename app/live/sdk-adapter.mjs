import {createHash} from 'node:crypto';
export const SDK_VERSION='0.17.0';
export const PUSD='0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const RPCS=['https://polygon.drpc.org','https://polygon.publicnode.com'];
const walletTypes = Object.freeze({ eoa: 0, proxy: 1, safe: 2, deposit: 3 });
const address=v=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)&&!/^0x0{40}$/i.test(v);
const orderFilledSignature='OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)';
export function toMicros(value){const s=String(value);if(!/^\d+(?:\.\d{1,6})?$/.test(s))throw Error('金额精度无效');return BigInt(s.split('.')[0])*1000000n+BigInt((s.split('.')[1]??'').padEnd(6,'0'));}
export function fromMicros(value){const n=BigInt(value),neg=n<0n,a=neg?-n:n;return(neg?'-':'')+(a/1000000n)+'.'+String(a%1000000n).padStart(6,'0');}
export function orderFingerprint(order){return createHash('sha256').update(JSON.stringify(order,(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex');}
function lower(v){return String(v).toLowerCase();}
export function predictionApprovalRequirements(contracts){
 const {collateralToken,conditionalTokens,positionManager,standardExchange,negRiskExchange,negRiskAdapter,
  collateralAdapter,negRiskCollateralAdapter,protocolV2Router,exchangeV3,binaryModule,negRiskModule}=contracts;
 return [
  ...[standardExchange,negRiskExchange,negRiskAdapter,collateralAdapter,negRiskCollateralAdapter,protocolV2Router,exchangeV3]
   .map(spender=>({token:collateralToken,spender,standard:'ERC20'})),
  ...[standardExchange,negRiskExchange,negRiskAdapter,collateralAdapter,negRiskCollateralAdapter,binaryModule,negRiskModule]
   .map(spender=>({token:conditionalTokens,spender,standard:'ERC1155'})),
  ...[protocolV2Router,exchangeV3].map(spender=>({token:positionManager,spender,standard:'ERC1155'}))
 ];
}
export async function collectPages(paginator,maxPages=100){const rows=[];let n=0;for await(const page of paginator){if(++n>maxPages)throw Error('账户记录分页超限，核对未完成');if(!Array.isArray(page.items))throw Error('账户分页格式无效');rows.push(...page.items);}return rows;}
function bounded(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));}
export async function createPolymarketAdapter({wallet,walletType='deposit',signer,privateKey,credentials,relayerApiKey,clock=Date.now,fetchFn=globalThis.fetch,sdk:injectedSdk,viem:injectedViem,actions:injectedActions,requestTimeoutMs=10000,authorizeWrite=()=>false}={}){
 if(!address(wallet))throw Error('必须指定已有Polymarket账户钱包地址');
 if(!Object.hasOwn(walletTypes,walletType))throw Error('真实钱包类型无效');
 const sdk=injectedSdk??await import('@polymarket/client'),viem=injectedViem??await import('viem'),actions=injectedActions??await import('@polymarket/client/actions');
 const contracts=sdk.production?.contracts;
 if(lower(contracts?.collateralToken)!==lower(PUSD))throw Error('官方 SDK 抵押代币与工作流配置不一致');
 const requiredApprovals=predictionApprovalRequirements(contracts);
 if(requiredApprovals.some(row=>!address(row.token)||!address(row.spender)))throw Error('交易授权合约地址未核实');
 const rpc=async(method,params)=>{let last;for(const endpoint of RPCS){try{const response=await fetchFn(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(requestTimeoutMs)});if(!response.ok)throw Error();const value=await response.json();if(value.error||value.id!==1)throw Error();return value.result;}catch(e){last=e;}}throw Error('Polygon核验服务不可用');};
 const chain=await rpc('eth_chainId',[]);if(BigInt(chain)!==137n)throw Error('链上查询网络不是Polygon');
 const existingCode=await rpc('eth_getCode',[wallet,'latest']);if(typeof existingCode!=='string'||!/^0x(?:[0-9a-fA-F]{2})*$/.test(existingCode))throw Error('账户合约核验失败');
 if(existingCode==='0x'&&walletType!=='eoa')throw Error('账户钱包未部署；连接不会自动创建钱包');
 const checkGeo=()=>fetchFn('https://polymarket.com/api/geoblock',{redirect:'error',signal:AbortSignal.timeout(requestTimeoutMs)}).then(async r=>{if(!r.ok)throw Error();const j=await r.json();if(typeof j.blocked!=='boolean')throw Error();return{blocked:j.blocked};}).catch(()=>{throw Error('地区可用性核验未完成');});
 const geo=await checkGeo();
 if(geo.blocked)throw Error('当前地区不可使用真实交易');
 if(!signer){if(!privateKey)throw Error('请先解锁签名凭据');const adapter=await import('@polymarket/client/viem');signer=adapter.privateKey(privateKey);}
 let capture=null,allowRelayer=false,relayerSubmitted=false;const lifecycle=new AbortController();
 const controlledSigner={getAddress:()=>signer.getAddress(),signTypedData:async payload=>{if(Number(payload.domain?.chainId)!==137)throw Error('签名网络不是Polygon');capture=structuredClone(payload);return signer.signTypedData(payload);},signMessage:message=>signer.signMessage(message),sendTransaction:()=>{throw Error('此连接不允许直接发起链上交易');}};
 const posted=new Set();
 const guardedFetch=async(input,init={})=>{if(lifecycle.signal.aborted)throw Error('真实账户连接已关闭');const u=new URL(typeof input==='string'?input:input.url??String(input)),method=String(init.method??input?.method??'GET').toUpperCase();
  if(!['GET','HEAD'].includes(method)){
   const body=typeof init.body==='string'?init.body:typeof input?.clone==='function'?await input.clone().text():String(init.body??'');
   if(method==='POST'&&u.hostname==='clob.polymarket.com'&&u.pathname==='/order'){const wire=JSON.parse(body);if(!authorizeWrite({kind:'order',order:wire.order??wire}))throw Error('真实写入授权已取消');const fingerprint=createHash('sha256').update(body).digest('hex');if(posted.has(fingerprint))throw Error('已阻止重复提交；请先核对订单');posted.add(fingerprint);}
   else if(method==='POST'&&u.hostname==='relayer-v2.polymarket.com'&&u.pathname==='/submit'){if(!allowRelayer||relayerSubmitted||!authorizeWrite({kind:'redeem'}))throw Error('已阻止未授权或重复的链上提交');relayerSubmitted=true;}
   else if(method==='POST'&&u.hostname==='clob.polymarket.com'&&u.pathname==='/auth/api-key'){}
   else if(method==='DELETE'&&u.hostname==='clob.polymarket.com'&&['/order','/orders'].includes(u.pathname)){}
   else {let calls;try{const j=JSON.parse(body);calls=Array.isArray(j)?j:[j];}catch{throw Error('已阻止不受支持的真实账户写操作');}const reads=new Set(['eth_chainId','eth_call','eth_getCode','eth_blockNumber','eth_getBlockByNumber','eth_getTransactionReceipt','eth_getTransactionCount','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory']);if(method!=='POST'||!calls.length||calls.some(c=>!reads.has(c.method)))throw Error('已阻止不受支持的真实账户写操作');}
  }
  const signals=[lifecycle.signal,AbortSignal.timeout(requestTimeoutMs)];if(init.signal)signals.push(init.signal);else if(input?.signal)signals.push(input.signal);return fetchFn(input,{...init,redirect:'error',signal:AbortSignal.any(signals)});
 };
 const raw=await sdk.createSecureClient({wallet,signer:controlledSigner,fetch:guardedFetch,...(credentials?{credentials}:{}),...(relayerApiKey?{apiKey:sdk.relayerApiKey(relayerApiKey)}:{})});
 const identity=raw.account;
 if(!identity||lower(identity.wallet)!==lower(wallet)||!address(identity.signer))throw Error('认证账户与所选钱包不一致');
 if(identity.walletType!==walletTypes[walletType])throw Error('签名钱包识别出的账户类型与所选类型不一致');
 if(walletType==='eoa'&&lower(identity.signer)!==lower(wallet))throw Error('EOA签名账户不一致');
 async function readPredictionApprovals(){
  const url=new URL('https://data-api.polymarket.com/v2/approvals');
  url.searchParams.set('user',wallet);
  const response=await guardedFetch(url.toString());
  if(!response.ok)throw Error('交易授权接口暂时不可用');
  const {data}=await response.json();
  if(lower(data?.address)!==lower(wallet)||data?.chain_id!==137||!Array.isArray(data.contracts))
   throw Error('授权记录的账户或网络不一致');
  const missing={erc20:0,erc1155:0};
  for(const expected of requiredApprovals){
   const rows=data.contracts.filter(row=>lower(row?.token)===lower(expected.token)&&lower(row?.spender)===lower(expected.spender));
   if(rows.length!==1||rows[0].standard!==expected.standard||typeof rows[0].approved!=='boolean')
    throw Error('交易授权记录缺失或重复，请稍后核对');
   if(!rows[0].approved)missing[expected.standard.toLowerCase()]++;
  }
  return{ready:missing.erc20===0&&missing.erc1155===0,missing};
 }
 const client={identity:{wallet:lower(identity.wallet),signer:lower(identity.signer),walletType:identity.walletType,signerType:identity.signerType},sdkVersion:SDK_VERSION,
  async readAccount(){
   const options={timeout:requestTimeoutMs,retries:0};
   const positionQuery={user:wallet,status:'OPEN',filterType:'TOKENS',filterAmount:0,includeArchived:true,pageSize:100};
   const [collateral,approvals,positions,openOrders,closedOnly,currentGeo]=await Promise.all([
    actions.fetchBalanceAllowance(raw,{assetType:'COLLATERAL'},options),
    readPredictionApprovals(),
    collectPages(raw.listPositions(positionQuery,options)),
    collectPages(raw.listOpenOrders({},options)),
    raw.fetchClosedOnlyMode(options),
    checkGeo()
   ]);
   if(typeof closedOnly!=='boolean')throw Error('账户交易限制尚未核验');
   const block=await rpc('eth_blockNumber',[]);
   const [info,cashHex]=await Promise.all([
    rpc('eth_getBlockByNumber',[block,false]),
    rpc('eth_call',[{to:PUSD,data:'0x70a08231'+wallet.slice(2).toLowerCase().padStart(64,'0')},block])
   ]);
   if(info?.number!==block)throw Error('链上余额区块不一致');
   const sourceAt=Number(BigInt(info.timestamp))*1000;
   if(!Number.isSafeInteger(sourceAt)||clock()-sourceAt>120000||sourceAt-clock()>10000)throw Error('链上余额区块时间无效');
   const chainCash=BigInt(cashHex),clobCash=BigInt(collateral.balance);
   if(chainCash<0n||clobCash<0n)throw Error('余额无效');
   return{observedAt:clock(),cashMicros:String(chainCash),availableMicros:String(chainCash<clobCash?chainCash:clobCash),balanceMatches:chainCash===clobCash,approvalsReady:approvals.ready,missingApprovals:approvals.missing,closedOnly,positions,openOrders,geoBlocked:currentGeo.blocked,sourceAt,block,identity:client.identity};
  },
  async createOrder({assetId,side,price,size,maxSpend}){capture=null;const signed=await raw.createLimitOrder({assetId,side,price,size});signed.orderType='FAK';if(!capture)throw Error('无法核对订单签名内容');const payload=capture.primaryType==='TypedDataSign'?{domain:capture.domain,types:{Order:capture.types.Order},primaryType:'Order',message:capture.message.contents}:capture;const id=viem.hashTypedData(payload);if(!/^0x[0-9a-fA-F]{64}$/.test(id))throw Error('订单哈希无效');return{signed,id,exchange:payload.domain.verifyingContract,fingerprint:orderFingerprint(signed),maxSpend};},
  postOrder:signed=>bounded(raw.postOrder(signed),requestTimeoutMs,'订单提交结果未知，请核对后再操作'),
  fetchOrder:id=>raw.fetchOrder({orderId:id},{timeout:requestTimeoutMs,retries:0}),
  listTrades:({conditionId,assetId})=>collectPages(raw.listAccountTrades({market:conditionId,assetId},{timeout:requestTimeoutMs,retries:0})),
  cancelOrder:id=>bounded(raw.cancelOrder({orderId:id}),requestTimeoutMs,'撤单结果未知，请核对'),
  async tradeFinancials(order,trades){const hashes=[...new Set(trades.map(t=>t.transactionHash??t.transaction_hash).filter(Boolean))].sort();if(!hashes.length)return null;let shares=0n,notional=0n,fees=0n;const proofs=[],seen=new Set();const topic=viem.keccak256(viem.stringToHex(orderFilledSignature)),transfer=viem.keccak256(viem.stringToHex('Transfer(address,address,uint256)'));
   for(const hash of hashes){const receipt=await rpc('eth_getTransactionReceipt',[hash]);if(receipt?.status!=='0x1'||!Array.isArray(receipt.logs))return null;let found=false,txMoney=0n,txFee=0n,delta=0n;for(const log of receipt.logs){if(lower(log.address)===lower(PUSD)&&lower(log.topics?.[0])===lower(transfer)&&/^0x[0-9a-fA-F]{64}$/.test(log.data??'')){const amount=BigInt(log.data);if(lower('0x'+log.topics?.[2]?.slice(-40))===lower(wallet))delta+=amount;if(lower('0x'+log.topics?.[1]?.slice(-40))===lower(wallet))delta-=amount;}
    if(lower(log.address)!==lower(order.exchange)||lower(log.topics?.[0])!==lower(topic))continue;const maker=lower('0x'+log.topics?.[2]?.slice(-40));if(maker===lower(wallet)&&lower(log.topics?.[1])!==lower(order.id))return null;if(lower(log.topics?.[1])!==lower(order.id))continue;if(maker!==lower(wallet))throw Error('链上成交钱包不一致');const eventId=hash+':'+log.logIndex;if(seen.has(eventId))throw Error('链上成交事件重复');seen.add(eventId);if(!/^0x[0-9a-fA-F]{448}$/.test(log.data??''))throw Error('链上成交事件格式未支持');const words=log.data.slice(2).match(/.{64}/g).map(x=>BigInt('0x'+x));if(words[0]!==BigInt(order.side==='BUY'?0:1)||String(words[1])!==String(order.assetId))throw Error('链上成交资产不一致');const qty=order.side==='BUY'?words[3]:words[2],money=order.side==='BUY'?words[2]:words[3];shares+=qty;notional+=money;fees+=words[4];txMoney+=money;txFee+=words[4];proofs.push({transactionHash:hash,blockNumber:receipt.blockNumber,logIndex:log.logIndex});found=true;}if(!found||delta!==(order.side==='BUY'?-(txMoney+txFee):txMoney-txFee))return null;}
   return{sharesMicros:String(shares),notionalMicros:String(notional),feeMicros:String(fees),proofs,source:'onchain-OrderFilled'};
  },
  async redeem({conditionId,onSubmitted=()=>{}}){if(!/^0x[0-9a-fA-F]{64}$/.test(conditionId??''))throw Error('盘口标识无效');allowRelayer=true;relayerSubmitted=false;try{const handle=await raw.redeemPositions({conditionId});onSubmitted({transactionId:handle.transactionId??null,transactionHash:handle.transactionHash??null});return await handle.wait();}finally{allowRelayer=false;}},
  async redemptionCredit(input){let transactionHash=typeof input==='string'?input:input?.transactionHash;if(!transactionHash&&input?.transactionId){const response=await fetchFn('https://relayer-v2.polymarket.com/transaction?id='+encodeURIComponent(input.transactionId),{redirect:'error',signal:AbortSignal.timeout(requestTimeoutMs)});if(!response.ok)return null;const rows=await response.json();if(!Array.isArray(rows)||rows.length!==1||rows[0].state!=='STATE_CONFIRMED')return null;transactionHash=rows[0].transactionHash;}if(!/^0x[0-9a-fA-F]{64}$/.test(transactionHash??''))return null;const receipt=await rpc('eth_getTransactionReceipt',[transactionHash]);if(receipt?.status!=='0x1'||!Array.isArray(receipt.logs))return null;const transfer=viem.keccak256(viem.stringToHex('Transfer(address,address,uint256)'));let credit=0n;for(const log of receipt.logs){if(lower(log.address)!==lower(PUSD)||lower(log.topics?.[0])!==lower(transfer)||!/^0x[0-9a-fA-F]{64}$/.test(log.data??''))continue;const amount=BigInt(log.data);if(lower('0x'+log.topics[2]?.slice(-40))===lower(wallet))credit+=amount;if(lower('0x'+log.topics[1]?.slice(-40))===lower(wallet))credit-=amount;}
   let burned=null;if(input?.assetId&&input?.sharesMicros){const contracts=new Set([sdk.production?.contracts?.conditionalTokens,sdk.production?.contracts?.positionManager].filter(Boolean).map(lower));const single=viem.keccak256(viem.stringToHex('TransferSingle(address,address,address,uint256,uint256)')),batch=viem.keccak256(viem.stringToHex('TransferBatch(address,address,address,uint256[],uint256[])'));burned=0n;for(const log of receipt.logs){if(!contracts.has(lower(log.address))||lower('0x'+log.topics?.[2]?.slice(-40))!==lower(wallet)||!/^0x0{64}$/i.test(log.topics?.[3]??''))continue;if(lower(log.topics?.[0])===lower(single)&&/^0x[0-9a-fA-F]{128}$/.test(log.data??'')){const asset=BigInt('0x'+log.data.slice(2,66)),amount=BigInt('0x'+log.data.slice(66));if(asset===BigInt(input.assetId))burned+=amount;}else if(lower(log.topics?.[0])===lower(batch)){const abi=viem.parseAbi(['event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)']);const decoded=viem.decodeEventLog({abi,data:log.data,topics:log.topics}).args;for(let i=0;i<decoded.ids.length;i++)if(decoded.ids[i]===BigInt(input.assetId))burned+=decoded.values[i];}}if(burned!==BigInt(input.sharesMicros))return null;}
   return{creditMicros:String(credit),...(burned!==null?{burnedSharesMicros:String(burned)}:{}),transactionHash,blockNumber:receipt.blockNumber,source:'onchain-pUSD-Transfer-and-position-burn'};},
  close(){lifecycle.abort();raw.close?.();signer.cancelPending?.();}
 };return client;
}
