import { connectInjectedWallet, discoverWalletProvidersAsync, watchInjectedWallet } from './wallet-client.mjs';
import {walletEntryView,loadWalletProfile,saveWalletProfile,createWalletReadback} from './wallet-entry.mjs';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const number = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString('en-US', {minimumFractionDigits:digits, maximumFractionDigits:digits}) : '—';
const money = n => Number.isFinite(n) ? `${n < 0 ? '−' : ''}$${number(Math.abs(n), 4)}` : '—';
const percent = n => Number.isFinite(n) ? `${number(n * 100)}%` : '—';
const date = n => n == null ? '—' : new Date(n).toLocaleString('zh-CN', {timeZone:'Asia/Hong_Kong', hour12:false});
const shorten = address => address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '未连接';
const statuses = {disconnected:'未连接', loading:'查询中', ready:'已连接 · 只读', stale:'上次余额 · 已过期', error:'查询失败'};

export function createPortfolioPanel({ command, toast }) {
  let state, locked = true, view = 'paper', wallet = null, busy = false, fundingRequest = null;
  let signer = null, unwatch = null, providers = [], restoreAttempted=false,backendPid=null;
  let walletEpoch=0,activeWalletOperation=null,pageActive=true,timer=null,restoreSuppressed=false,restoreNeedsRead=false;
  const storage=(()=>{try{return window.localStorage;}catch{return null;}})();
  const reader=createWalletReadback({onUpdate:value=>{wallet=value;restoreNeedsRead=false;render();void restoreRemembered();},onError:error=>{
    if(wallet?.address)wallet={...wallet,status:wallet.balance==null?'error':'stale',error:error.message};render();}});
  const operationCurrent=operation=>pageActive&&operation.epoch===walletEpoch&&activeWalletOperation===operation;
  const beginWalletOperation=()=>{const operation={epoch:walletEpoch};activeWalletOperation=operation;busy=true;render();return operation;};
  function finishWalletOperation(operation,retryRestore=true){
    if(activeWalletOperation!==operation)return;
    activeWalletOperation=null;busy=false;render();if(retryRestore)void restoreRemembered();
  }
  function invalidateWalletOperations(){
    walletEpoch++;restoreNeedsRead=false;activeWalletOperation?.controller?.abort();
    if(activeWalletOperation){activeWalletOperation=null;busy=false;}
    reader.invalidate();
  }
  function watchSigner(){
    unwatch?.();unwatch=null;if(!pageActive||!signer?.provider)return;
    const provider=signer.provider;
    unwatch=watchInjectedWallet(provider,change=>{
      if(!pageActive||signer?.provider!==provider)return;
      if(change.kind==='disconnected'){signer=null;unwatch?.();unwatch=null;}
      else signer={...signer,...change};render();
    });
  }
  async function restoreRemembered(){
    if(!pageActive||restoreSuppressed||restoreAttempted||restoreNeedsRead||locked||busy||!state||wallet===null)return;restoreAttempted=true;
    const remembered=loadWalletProfile(storage);if(!remembered||wallet?.address)return;
    reader.invalidate();const operation=beginWalletOperation();
    try{const result=await command('walletConnect',{address:remembered,addressKind:'account'});
      if(operationCurrent(operation)){if(result?.wallet)reader.accept(result.wallet);else{restoreAttempted=false;restoreNeedsRead=true;}}}
    catch(error){if(operationCurrent(operation)){restoreAttempted=false;restoreNeedsRead=true;toast(error.message,true);}}
    finally{finishWalletOperation(operation,false);}
  }
  function render() {
    const paper = state?.portfolio, real = view === 'wallet';
    for (const button of document.querySelectorAll('[data-portfolio-view]')) {
      const active = button.dataset.portfolioView === view;
      button.setAttribute('aria-pressed', String(active)); button.classList.toggle('selected', active);
    }
    $('paper-funds-open').hidden = real; $('wallet-open').hidden = !real;
    $('portfolio-scope').textContent = real ? '真实钱包 · 只读余额' : '当前模拟会话';
    $('portfolio-balance-label').textContent = real ? 'pUSD 现金余额' : '模拟现金余额';
    const cash = real ? wallet?.balanceNumber : paper?.balance.cash;
    $('portfolio-balance').textContent = real && wallet?.balance != null ?
      (cash != null ? `${number(cash, 4)} pUSD` : `${wallet.balance} pUSD`) : money(cash);
    $('portfolio-balance').classList.toggle('negative', Number.isFinite(cash) && cash < 0);
    $('portfolio-balance-note').textContent = real ?
      `${statuses[wallet?.status] ?? '未连接'} · 指定地址 · 不含持仓` :
      `累计添加 ${money(paper?.balance.deposits)} · ${paper?.balance.funded ? '已记录资金流' : '历史零本金模拟'}`;
    $('portfolio-roi').textContent = real ? '—' : percent(paper?.return.roi);
    $('portfolio-roi').classList.toggle('negative', !real && paper?.return.roi < 0);
    $('portfolio-roi').classList.toggle('up', !real && paper?.return.roi > 0);
    $('portfolio-roi-note').textContent = real ? '待接入真实持仓净值与资金流' :
      paper?.return.baselineAt ? `本期净值变化 ${money(paper.return.netChange)} · 已剔除追加资金` : '添加资金并建立正净值基准后计算';
    const stats = paper?.winRate.all;
    $('portfolio-win-rate').textContent = real ? '—' : percent(stats?.rate);
    $('portfolio-win-note').textContent = real ? '待接入真实成交记录' :
      `${stats?.wins ?? 0} 盈 / ${stats?.losses ?? 0} 亏 / ${stats?.breakeven ?? 0} 平 · ${stats?.completed ?? 0} 笔完整交易`;
    $('portfolio-paper-details').hidden = real;
    $('portfolio-wallet-details').hidden = !real;
    $('portfolio-nav').textContent = money(paper?.nav.value);
    $('portfolio-nav-note').textContent = paper?.nav.known ? '现金 + 全部持仓扣费可卖价值 / 已核实结算' :
      `${paper?.nav.reason ?? '等待账户数据'}${paper?.nav ? ` · 净值范围 ${money(paper.nav.lower)} 至 ${money(paper.nav.upper)}` : ''}`;
    $('portfolio-return-note').textContent = paper?.return.reason ?? '等待账户数据';
    $('portfolio-basis').textContent = paper?.return.baselineAt ?
      `基准 ${date(paper.return.baselineAt)} · 基准净值 ${money(paper.return.baselineNav)} · 计入本金 ${money(paper.return.contributedCapital)}` : '尚未建立本期收益基准；历史交易与盈亏保留。';
    $('portfolio-closed-net').textContent = money(stats?.net);
    const rows = [['all','全部'], ['automatic','自动入场'], ['manualOneTap','手动 One-Tap'], ['manualOther','其他手动']];
    $('portfolio-win-rows').innerHTML = rows.map(([key,label]) => {
      const s = paper?.winRate[key];
      return `<tr><td>${label}</td><td>${s?.completed ?? 0}</td><td>${s?.wins ?? 0} / ${s?.losses ?? 0} / ${s?.breakeven ?? 0}</td><td>${percent(s?.rate)}</td><td>${money(s?.net)}</td><td>${money(s?.fees)}</td></tr>`;
    }).join('');
    $('portfolio-stats-note').textContent = paper?.winRate.scope ?? '统计完整入场至清仓的扣费净盈亏。';
    $('wallet-summary').textContent = wallet?.address ?
      `${shorten(wallet.address)} · Polygon · ${wallet.addressKind === 'account' ? 'Polymarket 账户地址' : '签名地址'} · ${statuses[wallet.status]}` : '连接或填写 Polymarket 账户钱包地址，查看真实现金余额。';
    $('wallet-observed').textContent = wallet?.observedAt ?
      `链上区块 ${wallet.blockNumber} · 更新于 ${date(wallet.observedAt)} · 每 10 秒查询` : '未获得有效余额时显示“—”；真实零余额才显示 0。';
    $('wallet-error').textContent = wallet?.error ?? ''; $('wallet-error').hidden = !wallet?.error;
    $('wallet-address-current').textContent = wallet?.address ?? '尚未连接';
    $('wallet-connection-status').textContent = statuses[wallet?.status] ?? '未连接';
    $('wallet-signer').textContent = signer ? `签名钱包 ${signer.signerAddress} · ${signer.polygon ? 'Polygon' : `当前网络 ${signer.chainId}，余额仍从 Polygon 读取`}` :
      '可使用浏览器钱包读取公开地址，或直接填写账户地址。';
    const entry=walletEntryView(wallet);
    $('wallet-entry-status').textContent=entry.status;$('wallet-entry-address').textContent=entry.address;
    $('wallet-entry-balance').textContent=entry.balance;$('wallet-entry-balance-note').textContent=entry.balanceNote;
    $('wallet-entry-observed').textContent=entry.observed;$('wallet-entry-error').textContent=entry.error??'';$('wallet-entry-error').hidden=!entry.error;
    $('wallet-top-open').textContent=entry.connected?`钱包余额 · ${entry.short}`:'查看钱包余额';
    $('wallet-entry-connect').textContent=entry.connected?'更换 / 设置地址':'接入我的钱包';
    for (const id of ['paper-funds-open','paper-funds-submit','wallet-open','wallet-submit','wallet-provider-connect','wallet-refresh','wallet-disconnect','wallet-top-open','wallet-entry-connect','wallet-entry-refresh','wallet-entry-disconnect'])
      $(id).disabled = locked || busy || (['wallet-refresh','wallet-disconnect','wallet-entry-refresh','wallet-entry-disconnect'].includes(id) && !wallet?.address);
  }
  const refreshWallet=()=>pageActive?reader.refresh():Promise.resolve(null);
  document.querySelectorAll('[data-portfolio-view]').forEach(button => button.onclick = () => {
    view = button.dataset.portfolioView; render(); if (view === 'wallet') void refreshWallet();
  });
  $('paper-funds-open').onclick = () => { fundingRequest = null; $('paper-funds-form').reset(); $('paper-funds-dialog').showModal(); $('paper-funds-amount').focus(); };
  $('paper-funds-form').onsubmit = async event => {
    event.preventDefault(); if (busy || locked) return;
    const amount = Number($('paper-funds-amount').value);
    if (!fundingRequest || fundingRequest.amount !== amount) fundingRequest = {requestId:crypto.randomUUID(), amount};
    busy = true; render();
    try {
      const result = await command('addPaperFunds', fundingRequest);
      if (result) { fundingRequest = null; $('paper-funds-dialog').close(); }
    } finally { busy = false; render(); }
  };
  const openWallet=async()=>{
    if(locked||busy)return;
    $('wallet-address').value=wallet?.address??loadWalletProfile(storage)??'';
    $('wallet-remember').checked=!!loadWalletProfile(storage);
    $('wallet-provider').innerHTML='<option value="">正在查找浏览器钱包…</option>';
    $('wallet-dialog').showModal();const operation=beginWalletOperation();operation.controller=new AbortController();
    try{const found=await discoverWalletProvidersAsync(window,{signal:operation.controller.signal});
      if(operationCurrent(operation)){providers=found;$('wallet-provider').innerHTML = providers.length ?
        providers.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('') : '<option value="">未发现扩展 · 可填写地址</option>';}}
    catch{if(operationCurrent(operation)){providers=[];$('wallet-provider').innerHTML='<option value="">未发现扩展 · 可填写地址</option>';}}
    finally{finishWalletOperation(operation);}
  };
  for(const id of ['wallet-open','wallet-top-open','wallet-entry-connect'])$(id).onclick=openWallet;
  $('wallet-provider-connect').onclick = async () => {
    if (busy || locked) return;
    const operation=beginWalletOperation();
    try {
      const connectedSigner=await connectInjectedWallet(window, providers[Number($('wallet-provider').value)]?.provider ?? null);
      if(!operationCurrent(operation))return;signer=connectedSigner;watchSigner();
      toast('已读取签名钱包公开地址；请确认 Polymarket 账户钱包地址');
    } catch (error) { if(operationCurrent(operation))toast(error.message, true); }
    finally { finishWalletOperation(operation); }
  };
  $('wallet-form').onsubmit = async event => {
    event.preventDefault(); if (busy || locked) return;
    const input={address:$('wallet-address').value.trim(),addressKind:'account',signerAddress:signer?.signerAddress??null};
    const remember=$('wallet-remember').checked;restoreSuppressed=false;restoreAttempted=true;
    reader.invalidate();const operation=beginWalletOperation();
    try {
      const result = await command('walletConnect',input);
      if (operationCurrent(operation)&&result?.wallet) {reader.accept(result.wallet);restoreAttempted=true;
        if(!saveWalletProfile(storage,result.wallet.address,remember))toast('当前浏览器无法保存地址，本次接入仍有效',true);
        $('wallet-dialog').close();void refreshWallet();}
    } finally { finishWalletOperation(operation); }
  };
  const refreshNow=async()=>{
    if(busy||locked)return;reader.invalidate();const operation=beginWalletOperation();
    try{
    const result = await command('walletRefresh');
    if(operationCurrent(operation)&&result?.wallet)reader.accept(result.wallet);
    }finally{finishWalletOperation(operation);}
  };
  const disconnectWallet=async()=>{
    if(busy||locked)return;restoreSuppressed=true;restoreAttempted=true;
    if(!saveWalletProfile(storage,null,false))toast('当前浏览器无法清除记住的地址，请检查浏览器存储设置',true);
    signer=null;unwatch?.();unwatch=null;$('wallet-address').value='';$('wallet-remember').checked=false;
    reader.invalidate();const operation=beginWalletOperation();
    try{
    const result = await command('walletDisconnect');
    if(operationCurrent(operation)&&result?.wallet)reader.accept(result.wallet);
    }finally{finishWalletOperation(operation);}
  };
  for(const id of ['wallet-refresh','wallet-entry-refresh'])$(id).onclick=refreshNow;
  for(const id of ['wallet-disconnect','wallet-entry-disconnect'])$(id).onclick=disconnectWallet;
  const startWalletTimer=()=>{if(timer===null)timer=setInterval(()=>{void refreshWallet();},10000);};
  startWalletTimer();
  window.addEventListener('pagehide',()=>{
    pageActive=false;clearInterval(timer);timer=null;unwatch?.();unwatch=null;
    restoreAttempted=false;invalidateWalletOperations();
  });
  window.addEventListener('pageshow',event=>{
    if(!event.persisted||pageActive)return;pageActive=true;startWalletTimer();watchSigner();void refreshWallet();render();void restoreRemembered();
  });
  void refreshWallet();
  return {update(next,options={}){state=next;locked=Boolean(options.locked);
    const pid=next?.serviceRuntime?.pid;if(pid&&backendPid&&pid!==backendPid){restoreAttempted=false;wallet=null;invalidateWalletOperations();void refreshWallet();}backendPid=pid??backendPid;
    render();void restoreRemembered();}};
}
