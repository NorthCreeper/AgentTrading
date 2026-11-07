import {connectInjectedWallet,discoverWalletProvidersAsync,watchInjectedWallet} from '/wallet-client.mjs';
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false}):'—';
const money=v=>v==null?'—':Number.isFinite(Number(v))?Number(v).toLocaleString('en-US',{minimumFractionDigits:4,maximumFractionDigits:6})+' pUSD':'—';
const statusNames={'planned':'计划已保存','signing':'等待签名','signed':'已签名未提交','submitting':'提交中','unknown':'提交结果待核对','accepted':'订单已受理','matched':'已撮合，待链上确认','confirmed':'链上成交与费用已核实','partial':'部分成交','fee-pending':'费用待核验','rejected':'已拒绝','cancelled':'余量已撤销','unfilled':'未成交','failed':'链上失败','aborted-before-submit':'提交前已取消','cancel-unknown':'撤单结果待核对','redeeming':'兑付中','redemption-unknown':'兑付待核验'};
export function createLivePanel({getToken,toast,onExecutionChange=()=>{}}){
 let data=null,busy=false,polling=false,disposed=false,provider=null,signerAddress=null,unwatch=null,pendingSignature=null,signBusy=false,lastPreflight=null;
 let epoch=0,controlToken=getToken(),sequence=0,activeAction=null,activePoll=null,activeSignature=null,browserSigning=false,readRevision=0;
 let executionKey='',executionReadFailed=false;
 const requests=new Set();
 function invalidateView({dropData=false}={}){epoch++;for(const c of requests)c.abort();requests.clear();activeAction=null;activePoll=null;activeSignature=null;busy=false;polling=false;signBusy=false;pendingSignature=null;lastPreflight=null;if(dropData)data=null;}
 function session(){const token=getToken();if(token!==controlToken){controlToken=token;invalidateView({dropData:true});browserSigning=false;unwatch?.();unwatch=null;}return epoch;}
 const current=op=>!disposed&&op.epoch===session();
 const operation=()=>({epoch:session(),id:++sequence});
 async function fetchJson(url,options,timeoutMs,op){const abort=new AbortController();requests.add(abort);let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('请求等待超时，请先核对账本；不要重复提交订单'));},timeoutMs);});
  try{const response=await Promise.race([fetch(url,{...options,signal:abort.signal}),timeout]);const result=await Promise.race([response.json(),timeout]);return current(op)?{response,result}:null;}
  catch(error){if(!current(op))return null;throw error;}finally{clearTimeout(timer);requests.delete(abort);}
 }
 async function request(action,input={},timeoutMs=18000){const op=operation();readRevision++;
  try{const value=await fetchJson('/api/live',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Token':controlToken??''},body:JSON.stringify({action,input})},timeoutMs,op);if(!value)return null;const {response,result}=value;
   if(result.state){readRevision++;data=result;executionReadFailed=false;}
   if(['configure','saveCredentials','unlock','connect','connectBrowser','lock'].includes(action))lastPreflight=null;
   if(!response.ok)throw Error(result.error??'真实账户操作未完成');if(action==='preflight')lastPreflight=result.result?.preflight;render();return result;}
  catch(error){if(!current(op))return null;throw Error(error.name==='AbortError'?'请求等待超时，请先核对账本；不要重复提交订单':error.message);}
 }
 async function act(action,input,options={}){session();if(busy||disposed)return;const op={...operation(),action};activeAction=op;busy=true;render();try{const result=await request(action,input,options.timeoutMs);if(result&&current(op)&&options.success)toast(options.success);return result;}catch(error){if(current(op))toast(error.message,true);}finally{if(activeAction===op){activeAction=null;busy=false;render();}}}
 function clearBrowser(){browserSigning=false;provider=null;signerAddress=null;unwatch?.();unwatch=null;}
 function watchBrowser(){unwatch?.();unwatch=null;if(disposed||!browserSigning||!provider)return;const watched=provider;
  unwatch=watchInjectedWallet(watched,change=>{if(disposed||provider!==watched)return;if(change.kind==='disconnected'||change.kind==='chain'&&!change.polygon||change.kind==='invalid-chain'||change.signerAddress&&change.signerAddress!==signerAddress){clearBrowser();invalidateView();void request('lock').catch(error=>toast(error.message,true));}render();});
 }
 async function verifyRestoredBrowser(){if(!browserSigning||!provider)return;const op=operation(),watched=provider,expected=signerAddress;let timer;try{const values=await Promise.race([Promise.all([watched.request({method:'eth_accounts'}),watched.request({method:'eth_chainId'})]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('钱包状态读取超时')),3000);})]);if(!current(op)||provider!==watched||!browserSigning)return;if(values[0]?.[0]?.toLowerCase()!==expected||Number(BigInt(values[1]))!==137)throw Error('钱包账户或网络已改变');}
  catch(error){if(current(op)&&provider===watched&&browserSigning){clearBrowser();invalidateView();void request('lock').catch(cause=>toast(cause.message,true));toast('钱包状态已改变或不可读，请重新连接浏览器钱包',true);render();}}finally{clearTimeout(timer);}}
 function renderExecution(){
  const execution=data?.execution,s=data?.state;
  const transition=activeAction?.action==='switchPaper'?'paper':activeAction?.action==='enable'?'live':execution?.transition;
  const mode=transition?'switching':execution?.mode;
  const badge=$('execution-account-status'),note=$('execution-account-note');
  badge.classList.toggle('live-armed',mode==='live'&&s?.armed===true);
  $('execution-use-live').disabled=!controlToken||!mode||executionReadFailed||busy||mode==='live'||mode==='switching';
  // Returning to paper remains available while live activation or signing is pending.
  $('execution-use-paper').disabled=!controlToken||!mode||transition==='paper'||mode==='paper'&&execution.paperPaused!==true;
  if(executionReadFailed){
   badge.textContent='执行账户状态待核对';
   note.textContent='等待后台状态刷新。';
  }else if(mode==='switching'){
   badge.textContent=transition==='paper'?'正在切换到模拟账户':'正在核验真实资金';
   note.textContent='等待后台确认切换结果。';
  }else if(mode==='live'){
   badge.textContent='真实资金 · 自动执行';
   note.textContent='模拟新开仓已暂停。';
  }else if(mode==='paper'){
   badge.textContent=`模拟账户 · ${execution.paperMode==='manual'?'手动':'自动'}${execution.paperPaused?' · 暂停开仓':''}`;
   note.textContent='模拟余额与真实钱包分别核算。';
  }else{
   badge.textContent=mode==='idle'?'未启用开仓':'等待执行账户状态';
   note.textContent=execution?.paperResumeAvailable?'可以恢复先前的模拟账户。':'查看钱包余额请使用右上角入口。';
  }
  if(s?.requiresReconciliation)note.textContent+=' 真实订单或兑付待核对，请查看真实账本。';
  const key=`${mode??''}:${transition??''}`;
  if(key!==executionKey){executionKey=key;onExecutionChange(mode?{...execution,mode,transition}:null);}
 }
 function render(){renderExecution();const s=data?.state;if(!s){$('live-status').textContent='等待真实账户状态';$('global-live-status').textContent='真实账户状态待核对';$('live-sign-box').hidden=true;for(const id of ['live-config-open','live-vault-open','live-unlock-open','live-browser-connect','live-preflight','live-reconcile','live-enable-open','live-disable','live-lock','live-sign-confirm','live-sign-reject'])$(id).disabled=true;return;}const enabled=s.armed===true,connected=s.connected===true;
  $('live-status').textContent=enabled?'真实自动交易已启用':s.halt?'真实交易已锁定':'真实交易已关闭';$('live-status').classList.toggle('live-armed',enabled);
  $('global-live-status').textContent=enabled?'真实自动交易开启':'真实交易已关闭';$('global-live-status').classList.toggle('live-armed',enabled);
  $('live-account').textContent=s.config?.wallet??'尚未设置真实交易账户';$('live-cash').textContent=money(s.account?.cash);
  $('live-account-note').textContent=connected?`已认证 · ${s.identity?.signer??'签名钱包'} · 更新 ${time(s.account?.observedAt)}`:'账户与模拟资金分开；只读钱包连接不会解锁真实交易。';
  $('live-vault-status').textContent=s.vault?.exists?(s.vault.locked?'已有加密凭据 · 已锁定':'已有加密凭据 · 本次进程已解锁'):'尚无加密签名凭据';
  $('live-position-count').textContent=String(s.positions?.length??0);$('live-pending-count').textContent=String((s.orders??[]).filter(o=>!['confirmed','cancelled','unfilled','rejected','failed','aborted-before-submit'].includes(o.status)).length);
  $('live-reason').textContent=s.halt??s.accountError??data.runner?.error??lastPreflight?.error??(!s.config?.wallet?'先设置已有账户，选择签名方式，再核对真实账户。':connected&&lastPreflight?.ready?'连接、余额、授权与账本核验通过，等待当前入场信号。':data.runner?.lastDecision?.reason??'等待真实账户核验');
  $('live-reconcile-at').textContent=s.lastReconciledAt?`最近账本核对：${time(s.lastReconciledAt)} · ${s.requiresReconciliation?'尚有未决事项，禁止新开仓':'本地未决事项已核对'}`:'尚未进行真实账本核对；真实交易保持关闭。';
  for(const id of ['live-config-open','live-vault-open','live-unlock-open','live-browser-connect'])$(id).disabled=busy||enabled;
  for(const id of ['live-preflight','live-reconcile'])$(id).disabled=busy||!connected;
  $('live-enable-open').disabled=busy||!connected||enabled||!!s.halt||s.requiresReconciliation||data.execution?.mode==='switching'||executionReadFailed;
  $('live-disable').disabled=!enabled;$('live-lock').disabled=busy||!connected;
  $('live-real-orders').innerHTML=(s.orders??[]).slice(-40).reverse().map(o=>{
   const f=o.financial,settled=o.redemption?.verified,net=settled&&f?(Number(o.redemption.creditMicros)-Number(f.notionalMicros)-Number(f.feeMicros))/1e6:null;
   const round=Number(o.slug?.split('-').at(-1))*1000;
   return`<tr><td>${esc(o.slug)}<small>${Number.isFinite(round)?esc(time(round)+' → '+time(round+300000)):''}</small></td><td>${esc(o.outcome)} / ${esc(o.side)}</td><td>${esc(time(o.createdAt))}<small>源盘口 ${esc(time(o.sourceBookAt))}</small></td><td>${esc(statusNames[o.status]??o.status)}<small>${esc(o.id??o.localId)}</small></td><td>${f?esc(Number(f.sharesMicros)/1e6):'待核实'}</td><td>${f?money(Number(f.notionalMicros)/1e6):'—'}<small>费用 ${f?money(Number(f.feeMicros)/1e6):'未知'}</small></td><td>${net===null?'待核实兑付':money(net)}<small>${settled?'实际链上兑付已核实':'持仓与现金分别记录'}</small></td><td>${['accepted','unknown','matched','cancel-unknown'].includes(o.status)&&o.id?`<button data-live-cancel="${esc(o.id)}">核对并撤余单</button>`:''}</td></tr>`;
  }).join('')||'<tr><td colspan="8">此独立实例还没有真实成交。模拟交易不会写入这里。</td></tr>';
  $('live-sign-box').hidden=!pendingSignature;$('live-sign-summary').textContent=pendingSignature?`钱包 ${pendingSignature.signer} · ${pendingSignature.kind==='typedData'?(pendingSignature.payload?.primaryType??'结构化签名'):'消息签名'} · 到期 ${time(pendingSignature.expiresAt)}`:'';
  $('live-sign-details').textContent=pendingSignature?JSON.stringify(pendingSignature.payload,null,2):'';
  $('live-sign-confirm').disabled=signBusy||!provider||!pendingSignature;$('live-sign-reject').disabled=signBusy||!pendingSignature;
 }
 async function refresh(){session();if(disposed||polling)return;const op=operation(),revision=readRevision;activePoll=op;polling=true;try{const value=await fetchJson('/api/live',{cache:'no-store'},8000,op);if(!value)return;if(!value.response.ok)throw Error();const next=value.result;let signature=null;if(controlToken){const signing=await fetchJson('/api/live/sign-request',{headers:{'X-Control-Token':controlToken},cache:'no-store'},8000,op);if(!signing)return;if(signing.response.ok)signature=signing.result.request;}if(current(op)&&revision===readRevision){data=next;executionReadFailed=false;pendingSignature=signature;render();}}catch{if(current(op)&&revision===readRevision){executionReadFailed=true;renderExecution();$('live-reason').textContent='真实账户状态暂不可读，等待后台恢复后核对。';}}finally{if(activePoll===op){activePoll=null;polling=false;}}}
 $('live-config-open').onclick=()=>{$('live-wallet-address').value=data?.state?.config?.wallet??'';$('live-wallet-type').value=data?.state?.config?.walletType??'deposit';$('live-auto-manage').checked=data?.state?.config?.autoManage===true;$('live-config-dialog').showModal();};
 $('live-config-form').onsubmit=async event=>{event.preventDefault();const result=await act('configure',{wallet:$('live-wallet-address').value.trim(),walletType:$('live-wallet-type').value,autoManage:$('live-auto-manage').checked},{success:'真实账户设置已保存，交易保持关闭'});if(result)$('live-config-dialog').close();};
 $('live-vault-open').onclick=()=>{$('live-vault-form').reset();$('live-vault-dialog').showModal();};
 $('live-vault-form').onsubmit=async event=>{event.preventDefault();const input={privateKey:$('live-private-key').value.trim(),password:$('live-vault-password').value};const relayerKey=$('live-relayer-key').value.trim(),relayerAddress=$('live-relayer-address').value.trim();if(relayerKey)input.relayerApiKey={key:relayerKey,address:relayerAddress};$('live-vault-form').reset();const result=await act('saveCredentials',input,{success:'签名凭据已加密保存，交易仍关闭'});input.privateKey='';input.password='';if(result)$('live-vault-dialog').close();};
 $('live-vault-dialog').addEventListener('close',()=>$('live-vault-form').reset());
 $('live-unlock-open').onclick=()=>{$('live-unlock-form').reset();$('live-unlock-dialog').showModal();};
 $('live-unlock-form').onsubmit=async event=>{event.preventDefault();const password=$('live-unlock-password').value;$('live-unlock-form').reset();clearBrowser();const unlocked=await act('unlock',{password});if(unlocked){$('live-unlock-dialog').close();await act('connect',{}, {success:'真实账户已连接，自动交易保持关闭'});}};
 $('live-unlock-dialog').addEventListener('close',()=>$('live-unlock-form').reset());
 $('live-browser-connect').onclick=async()=>{session();if(busy||disposed)return;const op=operation();activeAction=op;busy=true;render();try{const providers=await discoverWalletProvidersAsync(window);if(!current(op))return;const connected=await connectInjectedWallet(window,providers[0]?.provider??null);if(!current(op))return;if(!connected.polygon)throw Error('请先将签名钱包切换到 Polygon 网络');provider=connected.provider;signerAddress=connected.signerAddress;browserSigning=true;watchBrowser();
   const result=await request('connectBrowser',{signerAddress},120000);if(result&&current(op))toast('浏览器签名钱包已连接；自动交易保持关闭');}catch(error){if(current(op))toast(error.message,true);}finally{if(activeAction===op){activeAction=null;busy=false;render();}}};
 $('live-preflight').onclick=()=>act('preflight');$('live-reconcile').onclick=()=>act('reconcile',{}, {success:'真实成交与账户已核对'});
 $('live-disable').onclick=async()=>{invalidateView();render();try{const result=await request('disable');if(result)toast('已停止新的真实入场，保留成交与持仓记录');}catch(error){toast(error.message,true);}};
 $('live-lock').onclick=async()=>{invalidateView();render();const result=await act('lock',{}, {success:'真实签名连接已锁定'});if(result)clearBrowser();};
 function openRealConfirmation(){
  session();
  const s=data?.state;
  if(!s||disposed||busy||executionReadFailed||!controlToken||s.armed||data.execution?.mode==='switching')return;
  if(!s.config?.wallet){$('live-config-open').onclick();return;}
  if(!s.connected||s.halt||s.requiresReconciliation){
   $('live-trading').scrollIntoView?.({block:'start'});
   toast(s.halt??(s.requiresReconciliation?'请先核对真实订单与兑付。':'请先解锁凭据或连接浏览器签名钱包。'),true);
   return;
  }
  $('live-enable-form').reset();
  $('live-enable-wallet').textContent=s.config.wallet;
  $('live-enable-dialog').showModal();
 }
 $('live-enable-open').onclick=openRealConfirmation;
 $('execution-use-live').onclick=openRealConfirmation;
 $('execution-use-paper').onclick=async()=>{
  session();
  if(disposed||!controlToken||!data?.execution||$('execution-use-paper').disabled)return;
  const input=data.execution.paperMode?{}:{mode:$('mode').value==='manual'?'manual':'auto'};
  invalidateView();
  if($('live-enable-dialog').open)$('live-enable-dialog').close();
  const result=await act('switchPaper',input,{timeoutMs:45000});
  if(result?.execution?.mode==='paper')toast(result.execution.paperPaused?'已切回模拟账户，模拟开仓仍暂停。':'已切回模拟账户。');
 };
 $('live-enable-form').onsubmit=async event=>{
  event.preventDefault();session();
  const expectedWallet=$('live-enable-wallet').textContent,s=data?.state;
  if(busy||disposed||!controlToken||!s?.connected||s.config?.wallet!==expectedWallet||s.halt||s.requiresReconciliation||executionReadFailed){
   $('live-enable-dialog').close();toast('真实账户状态已变化，请重新核对后确认。',true);return;
  }
  const input={expectedWallet,walletSuffix:$('live-wallet-suffix').value.trim().toLowerCase(),understood:$('live-understood').checked};
  if(input.understood!==true||input.walletSuffix!==expectedWallet.slice(-6).toLowerCase()){
   toast('请核对账户地址并确认使用真实资金。',true);return;
  }
  // Let the user reach the paper switch while account checks are in flight.
  $('live-enable-dialog').close();
  await act('enable',input,{timeoutMs:45000,success:'已切换到真实资金，模拟新开仓已暂停。'});
 };
 $('live-real-orders').onclick=event=>{const id=event.target?.dataset?.liveCancel;if(id)void act('cancel',{orderId:id},{success:'撤单已请求，结果以核对账本为准'});};
 $('live-sign-confirm').onclick=async()=>{session();if(signBusy||!pendingSignature||!provider||disposed)return;const op=operation(),signerProvider=provider;activeSignature=op;signBusy=true;render();const requestData=pendingSignature;try{const accounts=await signerProvider.request({method:'eth_accounts'});if(!current(op)||provider!==signerProvider)return;if(accounts?.[0]?.toLowerCase()!==requestData.signer.toLowerCase())throw Error('钱包账户已改变，请重新连接');let signature;
   if(requestData.kind==='typedData')signature=await signerProvider.request({method:'eth_signTypedData_v4',params:[requestData.signer,JSON.stringify(requestData.payload)]});
   else{const message=typeof requestData.payload==='string'?requestData.payload:requestData.payload?.raw;if(typeof message!=='string')throw Error('此钱包消息格式尚未支持，请使用加密凭据方式');const hex=message.startsWith('0x')?message:'0x'+[...new TextEncoder().encode(message)].map(b=>b.toString(16).padStart(2,'0')).join('');signature=await signerProvider.request({method:'personal_sign',params:[hex,requestData.signer]});}
   if(!current(op)||provider!==signerProvider)return;const result=await request('signAnswer',{id:requestData.id,signature,signerAddress:requestData.signer});if(result&&current(op)&&pendingSignature?.id===requestData.id)pendingSignature=null;
  }catch(error){if(current(op)){try{await request('signAnswer',{id:requestData.id,rejected:true});}catch{}toast(error.message,true);}}finally{if(activeSignature===op){activeSignature=null;signBusy=false;render();}}};
 $('live-sign-reject').onclick=async()=>{session();if(!pendingSignature)return;const op=operation(),requestData=pendingSignature;try{const result=await request('signAnswer',{id:requestData.id,rejected:true});if(result&&current(op)&&pendingSignature?.id===requestData.id){pendingSignature=null;render();}}catch(error){if(current(op))toast(error.message,true);}};
 let timer=setInterval(()=>void refresh(),1500);window.addEventListener('pagehide',()=>{disposed=true;clearInterval(timer);timer=null;unwatch?.();unwatch=null;invalidateView();});window.addEventListener('pageshow',event=>{if(event.persisted&&disposed){disposed=false;session();watchBrowser();void verifyRestoredBrowser();if(timer===null)timer=setInterval(()=>void refresh(),1500);void refresh();}});render();void refresh();
 return{refresh};
}
