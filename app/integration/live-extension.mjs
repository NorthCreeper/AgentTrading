import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createLiveTrading} from '../live/live-trading.mjs';
import {createSignerBridge} from './signer-bridge.mjs';
import {evaluateRay,rayProtocol} from '../lab/dashboard/ray-strategy.mjs';
import {RayEntryTrigger} from '../lab/dashboard/ray-entry-trigger.mjs';
import {writeJsonAtomic} from '../lab/dashboard/atomic-json.mjs';
import {acquireRuntimeLease} from '../lab/dashboard/runtime-lease.mjs';
import {verifyPayoutResolution} from '../lab/dashboard/payout-resolution.mjs';
import {verifyResolution} from '../lab/dashboard/settlement.mjs';
import {ControlError} from '../lab/dashboard/controller.mjs';
const assetRoot=path.dirname(fileURLToPath(import.meta.url));
const supported=new Set(['configure','saveCredentials','unlock','connect','connectBrowser','lock','preflight','enable','disable','switchPaper','reconcile','cancel','redeem','submitCurrent','signAnswer']);
const paperModes=new Set(['manual','auto']);
const walletActions=new Set(['walletConnect','walletDisconnect','walletRefresh']);
const connectionActions=new Set(['configure','saveCredentials','unlock','connect','connectBrowser']);
const transitionActions=new Set(['disable','switchPaper','lock','reconcile','cancel','signAnswer']);
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const safeError=error=>/private|secret|password|passphrase|credential|signature|0x[0-9a-fA-F]{50,}/i.test(String(error?.message))?'真实账户操作未完成，请核对连接或账本':String(error?.message??'操作未完成').slice(0,180);
export async function createLiveExtension({context,controller,clock=Date.now,runtimeClock,engineFactory=createLiveTrading}={}){
 const directory=context.paths.liveData;
 let engine,lease=null,closed=false,closePromise=null,connectionEpoch=0,connecting=null,ticking=false,lastReconcile=0,runnerError=null,lastDecision=null,lastRedeemTry=0;
 let transition=null,previousPaper=null;
 const bridge=createSignerBridge({canRequest:()=>!closed&&!transition&&(Boolean(connecting)||canRunLive())});
 fs.mkdirSync(directory,{recursive:true});const cursorFile=path.join(directory,'live-signal-cursor.json');let cursor;
 try{cursor=new RayEntryTrigger(fs.existsSync(cursorFile)?readJson(cursorFile):null);}catch{cursor=new RayEntryTrigger({version:'corrupt'});}
 function marketProvider(input={}){const frame=controller.frame;if(!frame?.market||input.slug&&frame.market.slug!==input.slug)return null;return{...structuredClone(frame.market),books:structuredClone(frame.books),frameNow:frame.now};}
 function paperIntent(){return{running:controller.running===true,mode:controller.mode,paused:controller.paused===true};}
 function blocksPaperEntry(){
  const paper=paperIntent();
  return (!paper.running||!paperModes.has(paper.mode)||paper.paused)&&controller.engine?.active?.intent?.side!=='buy';
 }
 function clockReady(){const source=runtimeClock??controller.runtimeClock;return !source||source.status().ready===true;}
 function canRunLive(snapshot=engine.snapshot()){return !closed&&!transition&&controller.running&&clockReady()&&blocksPaperEntry()&&snapshot.armed;}
 function executionStatus(snapshot=engine.snapshot()){
  const paper=paperIntent(),activePaper=paper.running&&paperModes.has(paper.mode)&&!paper.paused;
  const paperMode=activePaper?paper.mode:previousPaper?.mode??(paperModes.has(paper.mode)?paper.mode:null);
  let mode='idle';
  if(transition)mode='switching';
  else if(snapshot.armed)mode='live';
  else if(paper.running&&paperModes.has(paper.mode)&&(!paper.paused||!previousPaper))mode='paper';
  return{mode,transition:transition?.target??null,paperMode,paperPaused:paper.paused,paperResumeAvailable:previousPaper!==null};
 }
 function isCurrent(operation){return !closed&&transition===operation&&!operation.cancelled;}
 function assertCurrent(operation){if(!isCurrent(operation))throw Error('账户切换已取消');}
 function beginTransition(target){
  const operation={target,cancelled:false,paperBefore:null};
  transition=operation;
  return operation;
 }
 function disableLive(){
  try{return engine.disable();}
  finally{bridge.cancelPending();}
 }
 function interruptTransition(){if(transition)transition.cancelled=true;}
 async function restorePaperAfterFailure(operation,paper){
  assertCurrent(operation);
  if(!paper.running&&controller.running){await controller.command('stop');return;}
  if(paper.running&&controller.running&&paperModes.has(paper.mode)&&controller.mode===paper.mode&&controller.paused!==paper.paused){
   await controller.command(paper.paused?'pause':'resume');
  }
 }
 async function enableLive(input){
  const snapshot=engine.snapshot(),wallet=snapshot.config?.wallet;
  if(!wallet||input.walletSuffix!==wallet.slice(-6)||input.understood!==true)throw Error('请核对账户地址并确认真实交易权限');
  if(typeof input.expectedWallet!=='string')throw Error('请刷新控制台并重新确认完整真实账户地址');
  if(input.expectedWallet.toLowerCase()!==wallet.toLowerCase())throw Error('确认期间真实账户已改变，请重新核对地址');
  if(snapshot.armed)return snapshot;
  if(connecting||!snapshot.connected)throw Error('请先解锁并连接真实账户');
  if(snapshot.halt||snapshot.requiresReconciliation)throw Error('请先核对真实账户异常和未决订单');
  if(cursor.restoreError)throw Error('真实行情事件缓存损坏，请核对恢复记录');
  if(controller.strategyConfig?.model!=='ray-twap-band')throw Error('请先选择当前 Ray 主策略，其他模型未接入真实执行');
  if(!clockReady())throw Error('可信时钟尚未就绪');
  const operation=beginTransition('live');
  let changedPaper=false;
  try{
   // Previously accepted simulation commands must finish before taking the pause baseline.
   await controller.chain;
   assertCurrent(operation);
   const paper=operation.paperBefore=paperIntent();
   if(!paper.running){
    changedPaper=true;
    const paperExposure=controller.engine?.holdings?.size||controller.engine?.active;
    const input=paperExposure?{mode:paperModes.has(paper.mode)?paper.mode:'manual',paused:true}:{mode:'observe'};
    await controller.command('start',input);
   }else if(!blocksPaperEntry()){
    changedPaper=true;
    await controller.command('pause');
   }
   const current=()=>isCurrent(operation)&&controller.running&&blocksPaperEntry()&&clockReady();
   if(!current())throw Error('模拟暂停或可信时钟尚未核对，真实交易保持关闭');
   const result=await engine.enable({confirmation:'ENABLE_REAL_TRADING',isCurrent:current});
   if(!current()||!engine.snapshot().armed)throw Error('真实启用请求已取消');
   if(paperModes.has(paper.mode)&&(!previousPaper||!paper.paused))previousPaper=paper;
   return result;
  }catch(error){
   if(isCurrent(operation)){
    // Revoke any authorization even if the engine failed while recording enable.
    try{disableLive();}catch(revokeError){runnerError=safeError(revokeError);}
    if(changedPaper){
     try{await restorePaperAfterFailure(operation,operation.paperBefore);}
     catch(restoreError){throw Error(`${safeError(error)}；模拟恢复失败：${safeError(restoreError)}`);}
    }
   }
   throw error;
  }finally{if(transition===operation)transition=null;}
 }
 async function switchPaper(input){
  if(input.mode!==undefined&&!paperModes.has(input.mode))throw Error('请选择手动模拟或自动模拟');
  if(transition?.target==='paper'&&!transition.cancelled)throw Error('正在切换模拟账户');
  const pendingPaper=transition?.paperBefore;
  const before=paperModes.has(pendingPaper?.mode)?pendingPaper:previousPaper;
  const mode=input.mode??before?.mode??controller.mode;
  if(!paperModes.has(mode))throw Error('请选择手动模拟或自动模拟');
  interruptTransition();
  const operation=beginTransition('paper');
  try{
   disableLive();
   await controller.chain;
   assertCurrent(operation);
   if(controller.running&&controller.mode!==mode){
    await controller.command('stop');
    assertCurrent(operation);
   }
   if(!controller.running)await controller.command('start',{mode});
   else if(controller.paused)await controller.command('resume');
   assertCurrent(operation);
   previousPaper=null;
   return engine.snapshot();
  }finally{if(transition===operation)transition=null;}
 }
 function decision(){
  const now=clock(),snapshot=engine?.snapshot(),cash=Number(snapshot?.account?.cash),frame=controller.frame;
  if(closed||!controller.running||controller.runtimeClock&&!controller.runtimeClock.status().ready)return{selected:null,reason:'等待工作流行情与可信时钟'};
  if(controller.strategyConfig?.model!=='ray-twap-band')return{selected:null,reason:'真实执行目前仅支持当前 Ray 主策略'};
  if(!snapshot?.connected||!Number.isFinite(cash))return{selected:null,reason:'等待真实账户余额核验'};
  const result=evaluateRay({frame:frame?{...frame,twap:controller.referencePrice()}:null,config:{...controller.config,size:controller.config.size??100},now,equity:cash,roundUsedShares:0});
  if(snapshot.orders?.some(o=>o.slug===frame?.market?.slug&&o.status!=='failed'&&(Number(o.matchedSize)>0||BigInt(o.financial?.sharesMicros??'0')>0n))){result.selected=null;result.reason='本盘口已观察到真实买入成交，等待核对，不重复开仓';}
  return result;
 }
 async function signalProvider({market,outcome,side}){if(side!=='BUY')return{eligible:false,reason:'当前真实主策略仅自动入场并持有到结算'};const result=decision(),selected=result.selected;return selected&&market.slug===controller.frame?.market?.slug&&selected.outcome===outcome?{...selected,pct:.025}:{eligible:false,reason:result.reason??'主策略未准入'};}
 async function resolutionProvider({slug,conditionId}){
  if(!/^btc-updown-5m-\d+$/.test(slug??''))return null;
  for(const kind of ['financial-outcomes','outcomes']){const file=path.join(controller.directory,kind,slug+'.json');if(!fs.existsSync(file))continue;
   try{const e=readJson(file),label=kind==='financial-outcomes'?verifyPayoutResolution(e.market,e.gamma,e.clob,e.observedAt):verifyResolution(e.market,e.gamma,e.clob,e.observedAt);
    if(label&&label.conditionId===conditionId&&label.observedAt<=clock())return{...label,verified:true,resolved:true,scope:'Verified official outcome only; real credit still requires transaction receipt'};}catch{}
  }return null;
 }
 engine=engineFactory({directory,clock,marketProvider,signalProvider,resolutionProvider});
 async function releaseWallet(){interruptTransition();connectionEpoch++;connecting=null;bridge.close();engine.lock();const old=lease;lease=null;await old?.release();}
 async function connect(input){
  if(closed||connecting)throw Error('真实账户连接正在处理中或已关闭');const wallet=engine.snapshot().config?.wallet;if(!wallet)throw Error('请先设置账户地址');
  const operation={epoch:++connectionEpoch};connecting=operation;
  try{
   if(!lease){const acquired=await acquireRuntimeLease(path.join(os.tmpdir(),'btc5m-real-wallet-single-writer',wallet.toLowerCase()),{kind:'real-wallet'});if(operation.epoch!==connectionEpoch||closed){await acquired.release();throw Error('真实账户连接已取消');}lease=acquired;}
   const result=await engine.connect(input);if(operation.epoch!==connectionEpoch||closed)throw Error('真实账户连接已取消');return result;
  }catch(error){if(operation.epoch===connectionEpoch){engine.lock();const old=lease;lease=null;await old?.release();}throw error;}
  finally{if(connecting===operation)connecting=null;}
 }
 async function submitCurrent(){if(!canRunLive())throw Error('真实交易保持关闭或正在切换账户');const selected=decision().selected;if(!selected)throw Error(decision().reason??'主策略未准入');const frame=controller.frame,plan=cursor.plan({frame,reference:controller.referencePrice(),candidate:selected,now:clock(),triggerSource:'real-source-event'});
  if(!plan?.allowed)throw Error(plan?.reason??'等待新的有效源盘口');cursor.remember(plan);writeJsonAtomic(cursorFile,cursor.saved());return engine.submit({slug:frame.market.slug,outcome:selected.outcome,side:'BUY',pct:.025,requestId:randomUUID()});
 }
 const state=()=>{const snapshot=engine.snapshot();return{state:snapshot,execution:executionStatus(snapshot),runner:{error:runnerError,lastDecision:lastDecision?{reason:lastDecision.reason,reasonCode:lastDecision.reasonCode,outcome:lastDecision.selected?.outcome??null}:null,sourceTrigger:cursor.summary(),protocolVersion:rayProtocol.version},portableIdentity:context.identity};};
 async function tick(){if(closed||ticking||engine.snapshot().busy)return;ticking=true;try{
  const current=engine.snapshot();if(current.connected&&clock()-lastReconcile>5000&&current.orders?.length){lastReconcile=clock();await engine.reconcile();}
  const after=engine.snapshot();lastDecision=decision();if(canRunLive(after)&&lastDecision.selected){try{await submitCurrent();runnerError=null;}catch(error){runnerError=safeError(error);}}
  if(canRunLive()&&after.config?.autoManage&&clock()-lastRedeemTry>15000){lastRedeemTry=clock();for(const position of after.positions??[]){const label=await resolutionProvider(position);if(label?.verified&&canRunLive()){await engine.redeem({slug:position.slug});break;}}}
 }catch(error){runnerError=safeError(error);}finally{ticking=false;}}
 const unsubscribe=controller.subscribe(()=>{void tick();},{snapshot:false}),timer=setInterval(()=>{void tick();},1000);timer.unref();
 async function router({req,res,url,json,authorizeControl,readJsonBody}){
  const staticAssets={'/live-panel.mjs':['live-panel.mjs','text/javascript; charset=utf-8'],'/live-style.css':['live-style.css','text/css; charset=utf-8']};
  if(req.method==='GET'&&staticAssets[url.pathname]){const [file,type]=staticAssets[url.pathname];res.writeHead(200,{'Content-Type':type});res.end(fs.readFileSync(path.join(assetRoot,file)));return true;}
  if(!url.pathname.startsWith('/api/live'))return false;
  if(req.method==='GET'&&url.pathname==='/api/live'){json(res,200,state());return true;}
  if(req.method==='GET'&&url.pathname==='/api/live/export'){json(res,200,{...state(),scope:'Real ledger only; secrets and signing payloads excluded'});return true;}
  if(req.method==='GET'&&url.pathname==='/api/live/sign-request'){if(authorizeControl())json(res,200,{request:bridge.pending()});return true;}
  if(req.method!=='POST'||url.pathname!=='/api/live'){json(res,404,{error:'真实账户接口不存在'});return true;}
  if(!authorizeControl())return true;
  try{const {action,input={}}=await readJsonBody();if(!supported.has(action))throw Error('不支持此真实账户操作');let result;
   if(transition&&!transitionActions.has(action))throw Error('正在切换交易账户，请等待或停止交易');
   if(engine.snapshot().armed&&connectionActions.has(action))throw Error('请先停止真实交易，再修改钱包连接');
   if(action==='configure'){await releaseWallet();result=await engine.configure(input);}
   else if(action==='lock'){await releaseWallet();result=engine.snapshot();}
   else if(action==='connect')result=await connect();
   else if(action==='connectBrowser'){if(connecting)throw Error('真实账户连接正在处理中');const signer=bridge.connect(input.signerAddress);result=await connect({signer});}
   else if(action==='signAnswer'){await bridge.answer(input);result={answered:true};}
   else if(action==='enable')result=await enableLive(input);
   else if(action==='switchPaper')result=await switchPaper(input);
   else if(action==='submitCurrent')result=await submitCurrent();
   else if(action==='preflight')result=await engine.preflight();
   else if(action==='disable'){interruptTransition();result=disableLive();}
   else if(action==='redeem'){if(!canRunLive())throw Error('真实交易保持关闭或正在切换账户');result=await engine.redeem(input);}
   else result=await engine[action](input);
   json(res,200,{...state(),result});
  }catch(error){json(res,409,{error:safeError(error),...state()});}
  return true;
 }
 const summary=()=>{const s=engine.snapshot();return{enabled:s.armed===true,connected:s.connected===true,locked:s.locked===true,busy:s.busy===true,halt:s.halt??null,requiresReconciliation:s.requiresReconciliation===true,execution:executionStatus(s)};};
 function beforeControl({action,input}){
  if(action==='stop'||action==='pause'){
   const wasArmed=engine.snapshot().armed;
   interruptTransition();
   if(transition||wasArmed){try{disableLive();}catch(error){runnerError=safeError(error);}}
   // When live used the observe feed, there is no simulation admission to pause.
   if(action==='pause'&&wasArmed&&controller.running&&controller.mode==='observe')return{handled:true};
   return;
  }
  // The simulation controller verifies sell size against its existing holdings.
  const managingPaper=action==='cancel'||(action==='order'&&input?.side==='sell');
  if(!walletActions.has(action)&&!managingPaper&&(transition||engine.snapshot().armed))throw new ControlError('请先切回模拟账户，再执行模拟账户操作');
 }
 return{router,engine,state,summary,beforeControl,close(){if(closePromise)return closePromise;closed=true;connectionEpoch++;connecting=null;clearInterval(timer);unsubscribe();bridge.close();closePromise=(async()=>{await engine.close();const old=lease;lease=null;await old?.release();})();return closePromise;}};
}
