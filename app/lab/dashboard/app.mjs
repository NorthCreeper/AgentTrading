import {createLivePanel} from '/live-panel.mjs';
import {createConsoleConnection} from './console-connection.mjs';
import { renderCharts } from './charts.mjs';
import { amountQuote } from './amount-order.mjs';
import {oneTapQuote} from './one-tap-order.mjs';
import { buyPresetsKey, loadBuyPresets, validateBuyPresets } from './buy-presets.mjs';
import { bookStatus } from './book-status.mjs';
import { createPortfolioPanel } from './portfolio-panel.mjs';
import {isWalletCommand,requestWalletCommand} from './wallet-entry.mjs';
import { renderContinuationResearch } from './continuation-panel.mjs';
import { renderAdaptiveResearch } from './adaptive-panel.mjs';
import { renderAdaptiveAccounts } from './adaptive-account-panel.mjs';
import { renderSettlementQueue } from './settlement-queue-panel.mjs';
import { renderEvolution } from './evolution-panel.mjs';
import { renderRayEntry,renderRayRuntimeCheck } from './ray-entry-panel.mjs';
import {renderRayConsole} from './ray-console-panel.mjs';
import {createArchivePanel} from './archive-panel.mjs';
import {marketWindowFor,formatMarketWindow,formatRecordedTime} from './market-time.mjs';
import {renderRecoveryBaseline} from './recovery-baseline-panel.mjs';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n, digits = 2) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = n => n == null ? '—' : `${n < 0 ? '−' : ''}$${num(Math.abs(n), 4)}`;
const time = ms => new Date(ms).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false });
function marketWindowCell(record) {
  const window=marketWindowFor(record);
  return `<td class="market-window-cell ${window.status==='conflict'?'negative':''}"><span>${esc(formatMarketWindow(window))}</span><small>${esc(window.slug??'盘口标识未记录')}</small></td>`;
}
function renderValueResearch(v) {
  $('value-status').textContent=v?.error?`研究记录异常，自动模拟继续：${v.error}`:
    v?.currentDecision?.reason??'等待本轮第120秒；此模型仅用于研究';
  $('value-forecasts').textContent=String(v?.forecasts??0);
  $('value-labeled').textContent=String(v?.labeled??0);
  $('value-model-brier').textContent=num(v?.brier,5);
  $('value-market-brier').textContent=num(v?.marketBrier,5);
  const h=v?.historical;
  $('value-historical').innerHTML=h?['validation','test'].map(key=>{
    const s=h[key],name=key==='validation'?'验证集':'测试集';
    return s?`<tr><td>${name}</td><td>${s.rounds} / ${s.hkDates} 天</td><td>${num(s.modelBrier,5)}</td><td>${num(s.marketBrier,5)}</td><td class="${s.improvement<0?'negative':'up'}">${num(s.improvement,5)}</td></tr>`:'';
  }).join(''):'<tr><td colspan="5">历史校准报告尚未就绪</td></tr>';
  const s=v?.latest;
  $('value-latest').textContent=s?`最近采样：${time(s.at)} · ${s.market.slug} · Up研究估计 ${num(s.pUp*100,1)}%，盘口中间价 ${num(s.marketProbability*100,1)}¢ · ${s.label?'核实结果 '+s.label.winner:'结果待核实'}。`:'尚无本版本前瞻预测，历史数据不会回填。';
  $('value-quotes').innerHTML=s?(s.economics?.quotedEntries??[]).map(q=>`<tr><td>${esc(q.outcome)} / ${money(q.amountUsd)}</td><td>${q.reason?'—':num(q.probabilityEstimate*100,1)+'%'}</td><td>${num(q.costPerShare*100,2)}¢</td><td>${q.reason?esc(q.reason):money(q.expectedSettlementProfit)}</td></tr>`).join(''):'<tr><td colspan="4">等待有效采样报价</td></tr>';
  $('value-owned').innerHTML=(s?.economics?.ownedPositions??[]).map(p=>`<tr><td>${esc(p.outcome)} / ${num(p.size,4)}份</td><td>${money(p.expectedSettlementValue)}</td><td>${money(p.sellNowNet)}</td><td>${money(p.continuationMinusImmediate)}</td></tr>`).join('')||'<tr><td colspan="4">采样时无当前盘口持仓</td></tr>';
}
const texts = { running: '运行中', paused: '暂停开仓', stopped: '已停止', halted: '异常暂停',
  filled: '全部成交', cancelled: '已取消', rejected: '被拒绝', open: '挂单中',
  connected: '已连接', connecting: '连接中', disconnected: '已断开', error: '连接异常', stale:'源报价未更新' };
const stages = { maker: '正在等待挂单成交', taker: '正在执行限价吃单', holding: '持仓管理中',
  waiting: '等待信号或手动操作', observing: '只读观察中', stopped: '已停止，保留会话记录', halted: '异常暂停，请核对日志' };
let connectionInfo={transport:'connecting',reachable:false};
let state, token, pending = false, connected = false, selectedTab = 'orders', toastTimer, initial = true;
let accountExecution = null;
const paperEntryBlocked=()=>accountExecution?.mode==='live'||accountExecution?.mode==='switching';
const portfolioPanel = createPortfolioPanel({command, toast});
const archivePanel=createArchivePanel($);
const livePanel=createLivePanel({getToken:()=>token,toast,onExecutionChange:execution=>{accountExecution=execution;renderButtons();}});
let ledgerPanel={open(){},close(){}};
void import('./ledger-panel.mjs').then(({createLedgerPanel})=>{
  ledgerPanel=createLedgerPanel($);
  if(location.hash==='#ledger')ledgerPanel.open();
}).catch(()=>{ $('ledger-load-status').textContent='账本模块正在更新，请稍后刷新页面。'; });
const isError = e => e.type === 'halt' || e.type === 'rejected' || e.state === 'error';

function toast(message, error = false) {
  $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500);
}
async function command(action, input = {}) {
  if (pending || !connected) return;
  pending = true; renderButtons();
  try {
    const walletOnly=isWalletCommand(action),requestPid=state?.serviceRuntime?.pid;
    let data;
    if(walletOnly)data=await requestWalletCommand({action,input,token});
    else{
      const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Control-Token': token }, body: JSON.stringify({ action, input }) });
      data = await response.json();
      if (!response.ok) throw new Error(data.error);
    }
    if(walletOnly&&requestPid&&state?.serviceRuntime?.pid!==requestPid)return;
    if (data.state) { state = data.state; render(); }
    toast({ start: '工作流已启动，正在连接行情', stop: '已停止并核对模拟挂单', pause: '已暂停开仓', resume: '已恢复开仓',
      cancel: '撤单已核对', order: '模拟订单已受理，请查看成交状态', config: '运行参数已保存', strategyConfig:'策略参数已保存', reset: '新的模拟会话已建立',
      addPaperFunds:'模拟资金已记录，收益已剔除资金流', walletConnect:'已连接只读余额查询', walletDisconnect:'已断开余额查询', walletRefresh:'正在刷新钱包余额' }[action] ?? '操作已完成');
    return data;
  } catch (error) { toast(error.message, true); }
  finally { pending = false; renderButtons(); }
}
function currentBook(outcome = $('outcome').value) {
  return state?.frame?.books.find(b => b.tokenId === state.frame.market.tokens[outcome]);
}
function useQuote() {
  const book = currentBook(), m = state?.frame?.market;
  if (!book?.bids.length || !book?.asks.length) return toast('尚无可用盘口', true);
  const buy = $('side').value === 'buy';
  $('maker-price').value = num(buy ? book.bids[0][0] : book.asks[0][0], 3).replaceAll(',', '');
  $('limit-price').value = (buy ? Math.min(1 - m.tick, book.asks[0][0] + m.tick) : Math.max(m.tick, book.bids[0][0] - m.tick)).toFixed(3);
  estimate();
}
function estimate() {
  $('order-size').min = $('order-mode').value.startsWith('maker') ? (state?.frame?.market.minSize ?? 5) : 0.00000001;
  const price = Number($('order-mode').value === 'maker' ? $('maker-price').value : $('limit-price').value);
  const size = Number($('order-size').value);
  $('estimate').textContent = price > 0 && size > 0 ? money(price * size) : '—';
  const units=Number($('buy-units').value);
  $('quick-amount').textContent=Number.isFinite(units)&&units>=1?money(units):'请输入有效美元预算';
  const quotes=['Up','Down'].map(outcome=>{
    try {
      const q=state?.strategy?.config.model==='ray-twap-band'?oneTapQuote(currentBook(outcome),state.frame.market,units):amountQuote(currentBook(outcome),state.frame.market,units);
      return `${outcome}：${q.allowed?`预计 ${num(q.filled,4)} 份合约，费用 ${money(q.fees)}，总支出 ${money(q.total)}，未用预算 ${money(Math.max(0,units-q.total))}`:q.reason}`;
    } catch(error) {return `${outcome}：${error.message}`;}
  });
  $('quick-estimate').textContent=quotes.join('；');
  $('auto-amount-note').textContent=state?.strategy?.config.model==='ray-twap-band'
    ? `每个盘口只开一次仓，自动与手动共用限制；完全未成交可重试，部分成交后不补单。${state.strategy.rayEntrySummary?.roundEntryConsumed?'本盘口已有成交，本轮买入已锁定。':''}净值 2.5%–10% 含费预算；仅根据通过验证的信号强度放大，当前尚未通过验证，采用 2.5%。FAK 未成交余量取消；每轮累计最多 100 份，完整比例请求超出剩余额度时等待。固定总成本上限已取消。本框只影响本次手动买入。`
    : `自动策略与结算影子买入：每次 ${money(state?.config.buyUnits ?? 1)}，可在“运行参数”中修改。本框修改本次手动金额。`;
  renderQuickButtons();
}
function renderQuickButtons() {
  if(!state)return;
  const now=state.now,market=state.frame?.market;
  const singleEntry=state.strategy?.config.model==='ray-twap-band'&&state.strategy?.rayProtocol?.entryPolicy==='one-filled-entry-per-market-v1';
  const entryBlocked=singleEntry&&state.strategy?.rayEntrySummary?.roundEntryConsumed!==false;
  for(const outcome of ['Up','Down']) {
    let allowed=false; const book=currentBook(outcome);
    try {const units=Number($('buy-units').value),ray=state.strategy?.config.model==='ray-twap-band',eq=state.strategy?.rayEntrySummary;
      allowed=(ray?oneTapQuote(book,market,units):amountQuote(book,market,units)).allowed;
      if(ray)allowed=allowed&&eq?.equityKnown&&units>=Math.floor(eq.equity*.025*100+1e-8)/100&&units<=Math.floor(eq.equity*.1*100+1e-8)/100;
    } catch {}
    $(`quick-${outcome.toLowerCase()}`).disabled=entryBlocked||paperEntryBlocked()||pending||!connected||!state.running||state.mode==='observe'||state.paused||Boolean(state.account.halted)||
      Boolean(state.account.active)||Boolean(state.strategy?.managedPosition)||Boolean(state.strategy?.rayOwnedPositions?.length)||Boolean(state.strategy?.settlementQueue?.unknownHoldings)||!state.referenceFresh||!allowed||!market||
      now<market.start+15000||now>=market.end-30000||!book||now-book.receivedAt>state.config.staleMs||now-book.timestamp>state.config.staleMs;
  }
}
function renderButtons() {
  portfolioPanel.update(state, {locked:pending || !connected});
  if (!state) return;
  const locked = pending || !connected;
  $('start').disabled = locked || paperEntryBlocked() || state.running || Boolean(state.account.halted);
  $('recover-storage').hidden = !state.storageRecoveryAvailable;
  $('recover-storage').disabled = locked || !state.storageRecoveryAvailable;
  $('stop').disabled = locked || !state.running;
  $('pause').disabled = locked || paperEntryBlocked() || !state.running || state.mode === 'observe';
  $('pause').textContent = state.paused ? '▶ 恢复模拟开仓' : 'Ⅱ 暂停模拟开仓';
  $('mode').disabled = locked || state.running;
  $('reset').disabled = locked || state.running || Boolean(state.account.active) || state.holdings.length > 0 || Boolean(state.account.halted);
  $('submit-order').disabled = locked || !state.running || state.mode === 'observe' || Boolean(state.account.active) ||
    Boolean(state.account.halted) || !bookStatus(state.frame,state.now,state.config.staleMs).fresh || ($('side').value === 'buy' && (paperEntryBlocked() || state.paused || !state.referenceFresh ||
      state.strategy?.rayProtocol?.entryPolicy==='one-filled-entry-per-market-v1'&&state.strategy?.rayEntrySummary?.roundEntryConsumed!==false));
  $('save-config').disabled = locked || state.running || Boolean(state.account.active) || Boolean(state.strategy?.managedPosition) || Boolean(state.strategy?.rayOwnedPositions?.length) || Boolean(state.strategy?.settlementQueue?.count);
  $('save-strategy').disabled = locked || state.running || Boolean(state.account.active) || Boolean(state.strategy?.managedPosition) || Boolean(state.strategy?.rayOwnedPositions?.length) || Boolean(state.strategy?.settlementQueue?.count);
  document.querySelectorAll('[data-cancel]').forEach(b => b.disabled = locked);
  renderQuickButtons();
}
function renderBook() {
  const book = currentBook(); $('book-outcome').textContent = $('outcome').value;
  $('book-outcome').className = 'outcome-chip ' + ($('outcome').value === 'Up' ? 'up' : 'down');
  if (!book) { $('asks').innerHTML = '<div class="empty small">暂无卖盘</div>'; $('bids').innerHTML = '<div class="empty small">暂无买盘</div>'; $('full-depth').innerHTML = ''; return; }
  const levelHtml = (levels, side) => {
    const max = Math.max(1, ...levels.map(l => l[1]));
    return levels.map(([p, q]) => `<div class="book-row ${side}" style="--depth:${q/max*100}%"><span>${num(p,3)}</span><span>${num(q,2)}</span></div>`).join('');
  };
  $('asks').innerHTML = levelHtml(book.asks.slice(0,5).reverse(), 'ask') || '<div class="empty small">卖盘为空</div>';
  $('bids').innerHTML = levelHtml(book.bids.slice(0,5), 'bid') || '<div class="empty small">买盘为空</div>';
  $('full-depth').innerHTML = '<p>卖盘</p>' + levelHtml(book.asks, 'ask') + '<p>买盘</p>' + levelHtml(book.bids, 'bid');
  $('book-spread').textContent = book.asks[0] && book.bids[0] ? `${num((book.asks[0][0]-book.bids[0][0])*100,2)}¢` : '—';
}
function describe(e) {
  if (e.message) return e.message;
  if(e.type==='submit'&&e.request.maxSpend!==undefined)return `One-Tap FAK · 本金 ${money(e.request.amountUsd)} · 含费最高支出 ${money(e.request.maxSpend)} · 价格上限 ${num(e.request.price,3)}`;
  if(e.type==='report'&&e.report.maxSpend!==undefined)return `${e.report.id} · 成交 ${num(e.report.filled,4)} 份 · 本金 ${money(e.report.notional)} · 费用 ${money(e.report.fees)} · 未用含费预算 ${money(Math.max(0,e.report.maxSpend-e.report.notional-e.report.fees))}`;
  if (e.type === 'submit' && e.request.amountUsd !== undefined) return `单次市价买入 · 预算 ${money(e.request.amountUsd)} · 价格上限 ${num(e.request.price,3)}`;
  if (e.type === 'report' && e.report.amountUsd !== undefined) return `${e.report.id} · 成交 ${money(e.report.notional)} / 预算 ${money(e.report.amountUsd)} · ${num(e.report.filled,4)} 份合约 · 费用 ${money(e.report.fees)}`;
  if (e.type === 'submit') return `提交${e.request.side === 'buy' ? '买入' : '卖出'} · ${e.request.orderType}${e.request.postOnly ? ' / Maker' : ''} · ${e.request.size} 份 @ ${e.request.price}`;
  if (e.type === 'report') return `${e.report.id} · ${texts[e.report.status] ?? e.report.status} · 累计成交 ${e.report.filled} / ${e.report.size}`;
  if (e.type === 'cancel') return `${e.orderId} · 撤单并核对成交`;
  if (e.type === 'complete') return `${e.intentId} · 本次执行结束，成交 ${e.filled} 份`;
  if (e.type === 'connection') return `${{ market: '盘口发现', book: '订单簿', twap: 'Chainlink' }[e.name] ?? e.name} · ${texts[e.state] ?? e.state}`;
  return e.reason ?? e.type;
}
function renderTables() {
  $('orders-count').textContent = state.orders.length; $('holdings-count').textContent = state.holdings.length;
  $('orders-body').innerHTML = state.orders.length ? [...state.orders].reverse().slice(0,200).map(o => `<tr><td><button class="quote-button" data-order="${esc(o.id)}">${esc(o.id)}</button><small>委托 ${esc(formatRecordedTime(o.createdAt))}</small></td>${marketWindowCell(o)}<td><span class="${o.side === 'buy' ? 'up' : 'negative'}">${o.side === 'buy' ? '买入' : '卖出'}</span> ${esc(o.market?.outcome ?? '—')}</td><td>${o.amountUsd!==undefined ? `FAK 本金 ${money(o.amountUsd)}${o.maxSpend!==undefined?` · 含费上限 ${money(o.maxSpend)}`:``}` : o.postOnly ? 'Maker' : esc(o.orderType)}</td><td>${num(o.price,3)}</td><td>${o.amountUsd!==undefined ? `${num(o.filled,4)} 份<small>成交 ${money(o.notional)} · 费用 ${money(o.fees)}</small><small>未用 ${money(Math.max(0,o.maxSpend!==undefined?o.maxSpend-o.notional-o.fees:o.amountUsd-o.notional))}</small>` : `${num(o.filled,2)} / ${num(o.size,2)}`}</td><td><span class="tag ${esc(o.status)}">${texts[o.status] ?? esc(o.status)}</span></td><td>${o.status === 'open' && state.account.active?.orderId === o.id ? `<button data-cancel="${esc(o.id)}">撤单</button>` : '—'}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">还没有模拟订单</td></tr>';
  $('holdings-list').innerHTML = state.holdings.length ? state.holdings.map(h => `<div class="holding"><div><strong>${esc(h.market?.outcome ?? '未知结果')} · ${num(h.size)} 份</strong><small>${esc(h.market?.slug ?? h.tokenId)}</small><small>${h.market?.end <= state.now ? (h.management==='awaiting-resolution' || state.strategy?.managedPosition?.tokenId===h.tokenId ? '待结算库存 · 未核实资金仍锁定' : '该轮已结束，保留份额等待归属核对') : h.valuationFresh ? '按当前买一价估值' : '报价已过期，估值暂停'}</small></div><div class="holding-value">${h.bid === null ? '—' : money(h.bid*h.size)}<small><button data-sell="${esc(h.tokenId)}" ${!state.running || state.mode === 'observe' || !h.valuationFresh ? 'disabled' : ''}>填入卖出</button></small></div></div>`).join('') : '<div class="empty">当前没有模拟持仓</div>';
  $('cash-note').textContent = `模拟现金余额 ${money(state.account.cash)} · 累计添加 ${money(state.portfolio?.balance.deposits ?? 0)} · 累计费用 ${money(state.account.fees)}。余额包含资金流，不能直接当作盈亏。`;
  const filter = $('log-filter').value;
  const logs = state.log.filter(e => filter === 'all' || filter === 'errors' && isError(e) || filter === 'orders' && ['submit','report','cancel','complete','action'].includes(e.type) || filter === 'system' && ['ready','start','stop','pause','resume','round','connection','config','restored','reset','skip'].includes(e.type));
  $('log-list').innerHTML = [...logs].reverse().map(e => `<div class="log-row ${isError(e) ? 'error' : ''}"><time>${time(e.time)}</time><span>${esc(describe(e))}</span><button data-event="${esc(e.id)}" aria-label="查看事件详情">···</button></div>`).join('') || '<div class="empty">暂无此类事件</div>';
}
function render() {
  if (!state) return;
  renderRayConsole(state);
  document.body.classList.toggle('disconnected', !connected);
  $('ui-connection').innerHTML = `<i class="${connected ? 'good' : 'bad'}"></i>${connected ? connectionInfo.transport==='polling'?'后台可达 · 实时连接重连中':state.serviceRuntime?.managed?'独立后台已连接':'控制台已连接' : '正在重新连接后台'}`;
  $('run-status').textContent = texts[state.status]; $('run-status').className = `status ${state.status}`;
  if (initial || state.running) $('mode').value = state.mode;
  if (initial) { $('order-size').value = state.config.size; $('maker-seconds').value = state.config.makerMs/1000; initial = false; }
  $('clock').textContent = `${new Date(state.now).toLocaleDateString('zh-CN', { timeZone: 'Asia/Hong_Kong' })} ${time(state.now)} HKT`;
  $('session-id').textContent = state.sessionId.slice(0,8);
  const frame = state.frame, latestPrice = state.priceHistory?.at(-1);
  const quotes=bookStatus(frame,state.now,state.config.staleMs);
  const twap = state.reference?.price ?? (latestPrice ? { ...latestPrice, timestamp: latestPrice.time } : frame?.twap);
  $('btc-price').textContent = twap ? `$${num(Number(BigInt(twap.valueE18)/10n**16n)/100,2)}` : '—';
  $('twap-age').textContent = twap ? `${state.running ? '' : '上次记录 · '}观察于 ${time(twap.timestamp)} · ${num(Math.max(0,state.now-twap.timestamp)/1000,1)} 秒前${state.reference?.deliveryDelayMs!=null ? ` · 到达延迟 ${num(state.reference.deliveryDelayMs/1000,1)} 秒` : ''}` : '等待参考价格';
  for (const outcome of ['Up','Down']) {
    const book = currentBook(outcome), prefix = outcome.toLowerCase();
    $(`${prefix}-price`).textContent = book?.asks[0] ? `${num(book.asks[0][0]*100,1)}¢` : '—';
    $(`${prefix}-spread`).textContent = book?.bids[0] && book?.asks[0] ? `${state.running && quotes.fresh ? '' : '历史快照 · '}买一 ${num(book.bids[0][0]*100,1)}¢ · 价差 ${num((book.asks[0][0]-book.bids[0][0])*100,1)}¢ · 源报价 ${num(Math.max(0,state.now-book.timestamp)/1000,1)} 秒前` : '等待盘口';
  }
  const nav = state.portfolio?.nav.value ?? (state.portfolio ? null : state.equity);
  $('equity').textContent = money(nav); $('equity').className = nav < 0 ? 'negative' : '';
  $('fees').textContent = `累计费用 ${money(state.account.fees)} · 持仓 ${state.holdings.length} 项`;
  renderRecoveryBaseline(state);
  const alert = (state.storageRecoveryAvailable ? '本地状态文件保存失败，工作流已暂停。可点击“核对并解除存储暂停”；账户核对一致且保存成功后才能重新启动。' : state.account.halted) || (!connected ? '控制台连接中断，操作暂时不可用。后台运行状态以重连后的实际数据为准。' :
    state.runtimeRecovery?.status==='waiting-for-clock'?'后台已启动，等待独立校时通过后恢复原工作流。':state.runtimeRecovery?.status==='blocked'?('后台恢复暂缓：'+state.runtimeRecovery.reason):state.running && !quotes.fresh ? `${quotes.reason}${quotes.sourceAgeMs!==null?`，快照距今 ${num(Math.max(0,quotes.sourceAgeMs)/1000,1)} 秒`:''}。报价仅供查看，等待有效行情后自动恢复交易判断；图表保留缺口。` :
    state.running && !state.referenceFresh ? `${state.reference?.reason??'Chainlink 参考价格未就绪或过期'}。当前禁止新开仓，已有持仓仍可按规则退出。` :
    state.mode === 'auto' ? state.strategy?.config.model==='execution-edge'&&state.strategy.modelValidation?.eligible!==true ? '新模型验证未通过，自动开仓被阻止；行情与预测仍可继续记录。' : state.strategy?.config.execution==='paper' ? (state.strategy?.config.model==='ray-twap-band'?'Ray 模拟：每轮最后 120 秒判断，买入后持有至官方结算；手动 One-Tap 继续按原市场规则退出。历史盈利尚未验证。':state.strategy?.config.exitPolicy==='market'?'市场信息模拟：自动策略与手动 One-Tap 仓位均自动管理退出；不使用固定美元止损。':'实验性模拟策略：仅管理策略自己的仓位，模型预测不保证收益。') : '影子观察：计算并记录 Up / Down 候选，不自动下单。' : '');
  $('alert').hidden = !alert; $('alert').textContent = alert;
  $('alert').dataset.tone = state.account.halted || !connected ? 'error' :
    state.running && !state.referenceFresh || state.strategy?.config.execution==='paper' ? 'warning' : 'info';
  const strategy=state.strategy;
  const settlement=state.settlementResearch;
  if(settlement) {
    $('settlement-labels').textContent=String(settlement.officialLabels);
    $('settlement-samples').textContent=`${settlement.prospectiveSamples} / ${settlement.prospectiveLabeled}`;
    $('settlement-net').textContent=money(settlement.ledger.net);
    $('settlement-risk').textContent=`${money(settlement.ledger.capitalAtRisk)} · ${settlement.ledger.pending} 笔`;
    const train=settlement.historical?.parts?.train ?? 0;
    $('settlement-status').textContent=`${settlement.reason}。历史训练 ${train} 轮；本模型上线后预测 ${settlement.modelSamples ?? 0} 轮，已标注 ${settlement.modelLabeled ?? 0} 轮；影子入场 ${settlement.ledger.entries} 笔，已结算 ${settlement.ledger.settled} 笔。`;
    const d=settlement.decision, resolution=state.sources.resolution;
    $('settlement-decision').textContent=`${d?.reason ?? '等待数据'}${d?.pUp != null ? ` · Up 模型概率 ${num(d.pUp*100,1)}%（未验证）` : ''}${resolution?.state==='error' ? ' · 官方结果查询异常，将重试' : ''}${settlement.openingConflicts ? ` · ${settlement.openingConflicts} 轮开盘基准冲突，禁止纳入检验` : ''}`;
  }
  const modelBlocked=strategy?.config.model==='execution-edge'&&strategy.modelValidation?.eligible!==true;
  const forwardMode=strategy?.config.model==='forward-momentum';
  const rayMode=strategy?.config.model==='ray-twap-band';
  const marketExits=strategy?.config.exitPolicy==='market';
  $('strategy-value-head').textContent=rayMode?'TWAP 偏离 · $':forwardMode?'30 秒涨幅':'参考价 · $';
  $('strategy-maker-head').textContent=rayMode?'本方买价':'挂单余量';
  $('strategy-book-head').textContent=rayMode?'本次份额':'盘口失衡';
  $('strategy-taker-head').textContent=rayMode?'另一方买价':forwardMode?'动量扣成本余量':'吃单余量';
  $('strategy-description').textContent=rayMode?'Ray：每个盘口只开一次仓，零成交可重试，部分成交后不补单；最后 120 秒，TWAP 偏离当轮真实开盘达到日期门槛：原时段基线为早间 $40、午间 $60、夜间 $80；按纽约日期识别周末、休市与事件窗口，仅采用通过日期复核的设置，未通过沿用基线；本方买价 80–85 美分、另一方不高于 20 美分。金额 FAK，价格保护最多 2¢ 且自动单不超过 85¢；含费预算按净值 2.5%–10%，强度校准未通过时采用 2.5%。请求保留市场最低份额，部分成交余量取消；每轮实际累计最多 100 份。固定总成本上限已取消；每笔预算仍须有足够现金，完整比例请求超过份额额度时跳过，持有至官方核验；手动 One-Tap 保留市场退出。动态 TWAP 门槛目前仅作研究。':marketExits?
    '市场信息退出：30 秒盘口跌幅超过当前价差与近期波动尺度，且 10 秒仍下跌，连续确认 5 秒后卖出。取消固定美元止损、固定持有时限与最后一分钟强制退出。BTC 方向仅作持有诊断，不阻止已确认的盘口退出；没有退出信号时可持有至官方结算。手动 One-Tap 买入同样自动管理退出。':forwardMode?
    '前瞻自动模拟：第 30–210 秒寻找 30 秒至少 3 美分的恢复动量；覆盖当前往返费用与缓冲后按金额买入。该余量描述历史动量，不是未来收益预测或胜率。持有满 10 秒后，30 秒动量跌幅达到 3 美分且连续确认 5 秒才因反转退出；信号恢复或记录中断会重新计时。损失线、持有时限及结束前 60 秒退出优先执行，未卖出余量待官方结果模拟结算。':strategy?.config.model==='execution-edge'?
    '预测按当前卖一买入、在设定时间后按可见买盘退出的每份净收益，计入双边费用。显示值再减去成本缓冲和模型误差余量；不是结算胜率。':
    '同轮参考价回归 + TWAP 方向确认。下列为旧模型假设下的每份余量，不是胜率或已验证收益。';
  $('strategy-badge').textContent=strategy?.config.execution==='paper'?'实验模拟':'影子观察';
  const obs=strategy?.observation;
  const p2=strategy?.researchP2,context=p2?.current?p2.latest:null;
  $('p2-status').textContent=p2?.error?`P2 采集异常，主策略继续执行：${p2.error}`:context?
    `已记录 ${p2.counts.frames} 个上下文 · 当前轮剩余 ${num(context.remainingSeconds,0)} 秒 · 本次连接拒绝 ${p2.counts.rejected} 条异常消息、记录 ${p2.counts.sequenceGaps} 次成交序列缺口。`:'等待新的现货与盘口上下文；主策略按原条件运行。';
  $('p2-venues').innerHTML=['coinbase','binance'].map(v=>{const p=context?.venues[v],w=context?.windows[v];return `<tr><td>${v==='coinbase'?'Coinbase · BTC/USD':'Binance · BTC/USDT'}</td><td>${p?.ready?num(p.price,2):'—'}</td><td>${p?.sourceAgeMs==null?'—':num(p.sourceAgeMs/1000,1)+' 秒'}</td>${[10,30,60].map(n=>`<td>${w?.[n]?num(w[n].returnBps,2)+' bp':'—'}</td>`).join('')}</tr>`;}).join('');
  $('p2-gap').textContent=context?.deviations.spotUsdMinusTwapUsd==null?'—':money(context.deviations.spotUsdMinusTwapUsd);
  $('p2-vol').textContent=context?.windows.coinbase[30]==null?'—':num(context.windows.coinbase[30].realizedVolBps,2)+' bp';
  $('p2-basis').textContent=context?.deviations.crossVenueUsdtUsdBps==null?'—':num(context.deviations.crossVenueUsdtUsdBps,2)+' bp';
  $('p2-depth').textContent=context?.binanceDepth.imbalance5==null?'—':num(context.binanceDepth.imbalance5,3);
  const p1=strategy?.researchP1;
  const p3=strategy?.researchP3;
  $('p3-status').textContent=p3?.error?`研究异常，主账户继续运行：${p3.error}`:p3?.startedAt?
    `自 ${new Date(p3.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'})} 起独立模拟；历史回放不计入，尚未证明盈利优势。`:'等待新行情开始独立对照';
  $('p3-accounts').innerHTML=(p3?.accounts??[]).map(a=>`<tr><td>${money(a.initialCapital)} / ${a.policy==='market'?'原中间价退出':'净卖出价值退出'}</td><td>${a.completed}</td><td class="${a.realized<0?'negative':''}">${a.completed?money(a.realized):'—'}</td><td>${money(a.fees)}</td><td>${money(a.cash)}</td><td>${a.position?esc(a.position.outcome)+' · '+esc(state.now>=a.position.marketEnd?'到期，等待核实结算':a.position.decision?.reason??'等待判断'):a.pending?'等待买入执行':a.cash<1?'余额低于单次 $1 预算':'空仓'}</td></tr>`).join('');
  const p3b=strategy?.researchP3b;
  renderValueResearch(strategy?.researchValue);
  renderContinuationResearch(strategy?.researchContinuation);
  renderAdaptiveResearch(strategy?.researchAdaptive);
  renderAdaptiveAccounts(strategy?.researchAdaptiveAccount);
  renderSettlementQueue(strategy?.settlementQueue);
  renderRayEntry(state);
  renderEvolution(strategy?.evolution);
  const holdingLabels={'supported-hold':'盘口支持继续观察',hold:'尚无退出信号','waiting-agreement':'两项退出尚未共同确认','confirming-reversal':'转弱确认中','data-unavailable':'信息不足，暂无法判断','execution-pending':'等待卖出执行','retry-cooldown':'等待下一次执行判断','awaiting-resolution':'到期，等待核实结算'};
  const groupName=a=>`${money(a.initialCapital)} / ${a.policy==='consensus'?'共同确认退出':'原退出基线'}`;
  $('p3b-status').textContent=p3b?.error?`研究异常，主账户继续运行：${p3b.error}`:p3b?.startedAt?
    `自 ${new Date(p3b.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'})} 起独立模拟；历史交易不回填，候选优势待验证。`:'等待新行情启动对照';
  $('p3b-accounts').innerHTML=(p3b?.accounts??[]).map(a=>`<tr><td>${groupName(a)}</td><td>${a.completed}</td><td class="${a.realized<0?'negative':''}">${a.completed?money(a.realized):'—'}<small>费用 ${money(a.fees)}</small></td><td>${money(a.cash)}</td><td>${a.position?esc(a.position.outcome)+' · '+esc(a.policy==='market'&&a.position.category==='supported-hold'?'参考价格支持观察（诊断）':holdingLabels[a.position.category]??'等待判断'):a.pending?'等待买入执行':a.cash<1?'余额低于单次 $1 预算':'空仓'}</td></tr>`).join('');
  $('p3b-holding').innerHTML=(p3b?.accounts??[]).map(a=>{const m=a.observedMs??{},minutes=k=>num(k.reduce((n,key)=>n+(m[key]??0),0)/60000,1)+' 分钟';return `<tr><td>${groupName(a)}</td><td>${minutes(['supported-hold'])}</td><td>${minutes(['hold','waiting-agreement','confirming-reversal','execution-pending','retry-cooldown'])}</td><td>${minutes(['data-unavailable','unobserved-gap'])}</td><td>${minutes(['awaiting-resolution'])}</td></tr>`;}).join('');
  $('p1-status').textContent=p1?.error?`P1 采集异常，主账户继续运行：${p1.error}`:p1?.startedAt?
    `自 ${new Date(p1.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'})} 起独立记录 · 退出后观察完成 ${p1.recoveryCompleted} 笔，待完成 ${p1.pendingRecovery} 笔。历史回放未计入。`:'等待 P1 新行情记录';
  $('p1-accounts').innerHTML=(p1?.accounts??[]).map(a=>`<tr><td>${money(a.initialCapital)} / ${a.policy==='market'?'市场信息退出':'持有到核实结算'}</td><td>${a.completed}</td><td class="${a.realized<0?'negative':''}">${a.completed?money(a.realized):'—'}</td><td>${money(a.fees)}</td><td>${money(a.cash)} / ${a.position?esc(a.position.outcome):'空仓'}</td><td>${num(a.waitMs/60000,1)} 分钟</td></tr>`).join('');
  const holding=strategy?.managedPosition?.holdingDecision;
  $('holding-decision').textContent=holding?`持有判断：${holding.reason}${holding.move30==null?'':` · 30 秒变化 ${num(holding.move30*100,2)}¢`}${holding.netAtVisibleDepth==null?'':` · 当前可卖净收益 ${money(holding.netAtVisibleDepth)}${holding.completeDepth?'':'（仅部分深度）'}`}`:
    strategy?.managedPosition?'持有判断：等待新的有效报价':strategy?.rayOwnedPositions?.length?'持有判断：Ray 活跃仓位持有至已核实官方结算':'持有判断：当前无策略仓位';
  const mp=obs?.marketExitPairs;
  $('market-exit-pair-status').textContent=mp?`同笔入场三组退出对照（含自动与手动） · ${mp.completed} 组完成，${mp.pending} 组待完成。${mp.completed?`原规则 ${money(mp.baselineNet)}；仅取消美元止损 ${money(mp.noDollarNet)}；市场信息退出 ${money(mp.marketNet)}；相对原规则 ${money(mp.delta)}。`:'等待三组均退出或结算。'}`:'等待新版本入场';
  const pair=obs?.pairedExit;
  $('paired-exit-status').textContent=pair?`同笔入场退出对照 · ${pair.completed} 对已完成，${pair.pending} 对待完成。${pair.completed?`旧规则 ${money(pair.oldNet)}；确认 5 秒 ${money(pair.confirmedNet)}；差额 ${money(pair.delta)}。改善 ${pair.improved} 对，变差 ${pair.worse} 对，相同 ${pair.unchanged} 对。`:'等待两组均完成退出后比较。'}`:'等待本版本新的主账户入场';
  $('observation-status').textContent=obs?.error?`对照记录异常，已停止对照采集；主账户执行继续：${obs.error}`:
    obs?.startedAt?`自 ${new Date(obs.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'})} 起记录新数据 · 主账户待完成持续观察 ${obs.pendingMainFollowups} 笔。完成数为 0 时尚无收益结论。`:'等待新的行情与进场信号，历史回放不会计入此处。';
  $('observation-policies').innerHTML=(obs?.policies??[]).map(p=>`<tr><td>${esc(p.label)}</td><td>${p.n}</td><td class="${p.net<0?'negative':''}">${p.n?money(p.net):'—'}</td><td>${p.n?money(p.fees):'—'}</td><td>${p.active}</td></tr>`).join('');
  const pointText=p=>!p?'等待':p.net===null?(p.status==='missing-quote'?'缺测':'深度不足'):money(p.net);
  $('observation-followups').innerHTML=(obs?.mainFollowups??[]).map(e=>`<tr><td>${time(e.openedAt)} · ${esc(e.outcome)}</td>${[30,60,120].map(n=>`<td>${pointText(e.points[n])}</td>`).join('')}<td>${e.settlementNet===undefined?'待官方结算':money(e.settlementNet)}</td></tr>`).join('')||'<tr><td colspan="5">等待本版本新的主账户入场</td></tr>';
  const experiment=strategy?.experiment;
  const recentTrades=experiment?.recentTrades??[];
  $('strategy-trades').innerHTML=recentTrades.length?[...recentTrades].reverse().slice(0,20).map(t=>`<tr><td class="record-time-cell">${esc(formatRecordedTime(t.openedAt))}${t.filledEntries>1?`<small>首批开仓记录 · 共 ${num(t.filledEntries,0)} 个买入批次</small>`:''}</td>${marketWindowCell(t)}<td class="record-time-cell">${esc(formatRecordedTime(t.closedAt))}<small>${t.settlement?'核实结算归账':'平仓归账'}</small></td><td>${esc(t.outcome)} / ${t.parameters?.strategy?.model==='ray-twap-band'?num(t.bought,2)+' 份':money(t.amountUsd)}</td><td>${num(t.entryAverage,4)} / ${t.exitAverage==null?(t.settlement?'结算':'—'):num(t.exitAverage,4)}</td><td>${money(t.fees)} / <span class="${t.net<0?'negative':'up'}">${money(t.net)}</span></td><td>${esc(t.exitReason)}${t.settlement?` · 结算返还 ${money(t.settlement.payout)}`:''}</td></tr>`).join(''):'<tr><td colspan="7" class="empty small">等待本版本完成交易</td></tr>';
  const review=experiment?.latestReview;
  $('experiment-review').textContent=forwardMode?review?`最近 20 笔复盘：净收益 ${money(review.net)}，费用 ${money(review.fees)}，盈利比例 ${num(review.winRate*100,1)}%。参数未自动更改。`:
    `每 20 笔完成交易生成统计复盘 · 已完成 ${experiment?.completedTrades??0} 笔 · 历史盈利门槛不阻止本版本执行。`:
    '按策略版本记录实际模拟成交，手动交易不计入本实验。';
  $('experiment-net').textContent=experiment?money(experiment.net):'—';
  $('experiment-net').className=experiment?.net<0?'negative':'';
  $('experiment-fees').textContent=experiment?money(experiment.fees):'—';
  $('experiment-trades').textContent=experiment?String(experiment.completedTrades):'0';
  $('experiment-position').textContent=strategy?.rayOwnedPositions?.length?`${strategy.rayOwnedPositions.length} 项 Ray 持仓 · 每个盘口只开一次，历史批次保留`:
    strategy?.managedPosition?`${strategy.managedPosition.outcome} · ${state.account.active?'执行中':'持仓中'}`:
    strategy?.settlementQueue?.count?`无活跃仓位 · ${strategy.settlementQueue.count} 笔待结算`:'无策略仓位';
  const lossBlocked=state.config.maxLoss>0&&state.holdings.length===0&&state.account.cash<=-state.config.maxLoss;
  $('experiment-status').textContent=experiment?`实验 ${experiment.id.slice(0,8)} · ${state.running?'运行中':'已停止'} · ${lossBlocked?'已达到会话亏损线，禁止新开仓':state.paused?'已暂停开仓':strategy?.config.execution==='paper'&&state.mode==='auto'?'自动模拟已启用':'自动模拟未运行'}。仅统计本实验完整平仓交易，未平仓盈亏不计入；账户历史继续保留，${state.config.maxLoss>0?'会话亏损限制启用':'累计亏损停开仓已关闭'}。`:'尚未开始自动模拟实验。选择实验性模拟后启动，独立记录策略结果。';
  if(modelBlocked) $('experiment-status').textContent='模型验证未通过，自动开仓被阻止。继续记录真实行情与预测，人工交易仍需手动提交；未平仓仓位继续按已有风控管理。';
  $('strategy-reason').textContent=(state.running?'':'已停止 · ')+(strategy?.decision?.reason??'启动行情后积累连续 30 秒数据');
  $('strategy-candidates').innerHTML=strategy?.decision?.candidates.length?strategy.decision.candidates.map(c=>
    `<tr><td><span class="outcome-chip ${c.outcome==='Up'?'up':'down'}">${esc(c.outcome)}</span></td><td>${rayMode?num(c.deviationUsd,2):forwardMode?(c.move30==null?'—':num(c.move30*100,2)+'¢'):num(c.reference,3)}</td><td class="${c.makerEdge>0?'up':'muted'}">${rayMode?num(c.ask*100,1)+'¢':c.makerEdge==null?'—':num(c.makerEdge*100,2)+'¢'}</td><td class="${c.takerEdge>0?'up':'muted'}">${rayMode?num(c.oppositeAsk*100,1)+'¢':c.takerEdge==null?'—':num(c.takerEdge*100,2)+'¢'}</td><td>${rayMode?num(c.orderSize,2):num(c.obi,2)}</td><td class="strategy-explanation">${esc(c.reason)}</td></tr>`).join(''):'<tr><td colspan="6" class="empty small">尚未满足连续数据条件</td></tr>';
  $('flow-detail').textContent = state.account.active ? `${stages[state.step]} · ${state.account.active.intent.side === 'buy' ? '买入' : '卖出'} · 已成交 ${state.account.active.totalFilled} / ${state.account.active.intent.size}` : stages[state.step];
  const currentStep = state.step === 'observing' ? 'data' : state.step;
  document.querySelectorAll('#flow > div').forEach(el => {
    el.classList.toggle('active', el.dataset.step === currentStep);
    el.classList.toggle('done', state.running && (el.dataset.step === 'market' && frame || el.dataset.step === 'data' && state.referenceFresh));
  });
  if (frame) {
    const m = frame.market;
    $('round-title').textContent = `${time(m.start)} – ${time(m.end)} · 香港时间`;
    const left = Math.max(0, Math.ceil((m.end-state.now)/1000));
    $('countdown').textContent = `${String(Math.floor(left/60)).padStart(2,'0')}:${String(left%60).padStart(2,'0')}`;
    $('round-slug').textContent = m.slug; $('market-link').hidden = false; $('market-link').href = `https://polymarket.com/event/${encodeURIComponent(m.slug)}`;
    for (const id of ['maker-price','limit-price']) {
      $(id).step = m.tick; $(id).min = m.tick; $(id).max = 1 - m.tick;
    }
    $('market-details').innerHTML = Object.entries({ '本轮盘口':m.slug,'开始 / 结束':`${time(m.start)} / ${time(m.end)}`,'限价挂单最小份额':m.minSize,'价格步长':m.tick,'费用系数 / 指数':`${m.fee.rate} / ${m.fee.exponent}`,'负风险市场':m.negRisk?'是':'否','结算价格源':m.resolutionSource,'条件 ID':m.conditionId,'Up token':m.tokens.Up,'Down token':m.tokens.Down,'行情最后接收':time(frame.now) }).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('rules-text').textContent = m.rules ?? '接口未返回规则';
  }
  for (const name of ['market','book','twap']) {
    const source = state.sources[name]; let status = source?.state ?? 'stopped';
    if (state.running && name === 'twap' && source?.state === 'connected' && !state.referenceFresh) status = 'stale';
    if (state.running && name === 'book' && !quotes.fresh && !['error','disconnected'].includes(status)) status = 'stale';
    $(`${name}-health`).textContent = `${status === 'stale' ? (name==='book'?quotes.reason:'数据过期') : texts[status] ?? '未启动'}${status === 'connected' && source?.latency != null ? ` · ${source.latency}ms` : ''}`;
    $(`${name}-dot`).className = status === 'connected' ? 'good' : ['error','disconnected','stale'].includes(status) ? 'bad' : '';
  }
  $('order-help').textContent = state.mode === 'observe' ? '当前为只读观察。停止后切换到手动模拟即可操作。' :
    state.account.active ? '当前有未完成订单，核对结束后可再次操作。' : `限价挂单最小 ${frame?.market.minSize ?? '—'} 份合约；即时吃单卖出可少于此数量。挂单成交需要实际成交记录，触价不等于成交。`;
  renderCharts(state, $('chart-window').value); renderBook(); renderTables(); renderButtons(); estimate();
}

$('start').onclick = () => command('start', { mode: $('mode').value });
$('recover-storage').onclick = () => command('recoverStorage');
$('stop').onclick = () => command('stop');
$('pause').onclick = () => command(state.paused ? 'resume' : 'pause');
$('reset').onclick = () => { if (confirm('新建模拟会话会将本次模拟现金与费用归零，历史日志仍保留。继续？')) command('reset'); };
$('use-quote').onclick = useQuote;
try { const value=Number(localStorage.getItem('btc5m-buy-units')); if(Number.isFinite(value)&&value>0)$('buy-units').value=value; } catch {}
$('buy-units').oninput=()=>{try {localStorage.setItem('btc5m-buy-units',$('buy-units').value);}catch{} estimate();};
let buyPresets;
try { buyPresets=loadBuyPresets(localStorage); } catch { buyPresets=loadBuyPresets(null); }
function renderBuyPresets() {
  document.querySelectorAll('[data-buy-units]').forEach((button,index)=>{
    button.dataset.buyUnits=String(buyPresets[index]);
    button.textContent='$'+buyPresets[index];
    button.onclick=()=>{$('buy-units').value=button.dataset.buyUnits;$('buy-units').oninput();};
    $('buy-preset-'+index).value=buyPresets[index];
  });
}
renderBuyPresets();
document.querySelectorAll('[data-buy-pct]').forEach(button=>{button.onclick=()=>{
  const eq=state?.strategy?.rayEntrySummary;if(!eq?.equityKnown){toast('当前净值待核实',true);return;}
  $('buy-units').value=(Math.floor(eq.equity*Number(button.dataset.buyPct)*100+1e-8)/100).toFixed(2);$('buy-units').oninput();
};});
$('save-buy-presets').onclick=()=>{
  try {
    const values=validateBuyPresets([0,1,2].map(i=>Number($('buy-preset-'+i).value)));
    localStorage.setItem(buyPresetsKey,JSON.stringify(values));
    buyPresets=values;renderBuyPresets();$('preset-editor').open=false;
    toast('三个手动买入金额预设已保存');
  } catch(error) {toast(error.message,true);}
};
$('quick-buy-form').onsubmit=event=>{
  event.preventDefault(); const outcome=event.submitter?.value;
  if(!['Up','Down'].includes(outcome))return;
  command('order',{requestId:crypto.randomUUID(),outcome,side:'buy',mode:'amount',units:Number($('buy-units').value),marketSlug:state.frame?.market.slug});
};
$('outcome').onchange = renderBook; $('side').onchange = renderButtons;
$('order-form').oninput = estimate;
$('order-form').onsubmit = event => {
  event.preventDefault(); command('order', { requestId: crypto.randomUUID(), outcome: $('outcome').value, side: $('side').value,
    mode: $('order-mode').value, size: Number($('order-size').value), makerPrice: Number($('maker-price').value),
    limit: Number($('limit-price').value), makerMs: Number($('maker-seconds').value)*1000 });
};
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
  selectedTab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(b => { b.setAttribute('aria-selected', String(b === button)); b.tabIndex=b===button?0:-1; });
  for (const tab of ['orders','holdings','logs','details']) $(`${tab}-panel`).hidden = tab !== selectedTab;
});
const tabButtons = [...document.querySelectorAll('[data-tab]')];
tabButtons.forEach((button,index) => {
  button.id = 'tab-'+button.dataset.tab;
  button.setAttribute('aria-controls',button.dataset.tab+'-panel');
  button.tabIndex = index===0?0:-1;
  $(button.dataset.tab+'-panel').setAttribute('aria-labelledby',button.id);
  button.onkeydown = event => {
    const next = event.key==='ArrowRight' ? (index+1)%tabButtons.length : event.key==='ArrowLeft' ?
      (index+tabButtons.length-1)%tabButtons.length : event.key==='Home' ? 0 : event.key==='End' ? tabButtons.length-1 : null;
    if(next===null) return;
    event.preventDefault(); tabButtons[next].focus(); tabButtons[next].click();
  };
});
function markNavigation() {
  const hash = location.hash || '#overview';
  if(hash==='#research-archive')archivePanel.open();
  if(hash==='#ledger')ledgerPanel.open();else ledgerPanel.close();
  document.querySelectorAll('nav a[href^="#"]').forEach(link => {
    const active = link.getAttribute('href')===hash;
    link.classList.toggle('nav-active',active);
    if(active) link.setAttribute('aria-current','location'); else link.removeAttribute('aria-current');
  });
}
window.addEventListener('hashchange',markNavigation);
markNavigation();
$('log-filter').onchange = renderTables;
$('chart-window').onchange = () => { if (state) renderCharts(state, $('chart-window').value); };
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.cancel) command('cancel', { orderId: button.dataset.cancel });
  if (button.dataset.order || button.dataset.event) {
    const value = button.dataset.order ? state.orders.find(o => o.id === button.dataset.order) : state.log.find(e => e.id === button.dataset.event);
    $('inspect-content').textContent = JSON.stringify(value, null, 2); $('inspect').showModal();
  }
  if (button.dataset.sell) {
    const holding = state.holdings.find(h => h.tokenId === button.dataset.sell);
    if (!holding || !state.frame || !Object.values(state.frame.market.tokens).includes(holding.tokenId)) return toast('这份持仓属于已结束盘口，不能在当前轮卖出', true);
    $('outcome').value = holding.market.outcome; $('side').value = 'sell'; $('order-size').value = holding.size;
    $('order-mode').value = 'taker'; useQuote(); renderButtons(); $('sell-tools').open=true; $('order-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('卖出参数已填入，请核对限价后提交');
  }
  if (button.dataset.close) $(button.dataset.close).close();
});
$('settings-open').onclick = () => {
  if (!state) return toast('正在连接控制台，请稍候', true);
  for (const [key,value] of Object.entries(state.config)) {
    const field=$('config-form').elements[key];
    if(field&&typeof value==='number')field.value=key.endsWith('Ms')?value/1000:value;
  }
  $('config-form').elements.buyUnits.value=state.config.buyUnits??1;
  $('settings').showModal(); renderButtons();
};
$('config-form').onsubmit = async event => {
  event.preventDefault(); const config = {};
  for (const key of Object.keys(state.config)) {
    const field=$('config-form').elements[key];
    if(field&&typeof state.config[key]==='number')config[key]=Number(field.value)*(key.endsWith('Ms')?1000:1);
  }
  config.buyUnits=Number($('config-form').elements.buyUnits.value);
  if (await command('config', config)) $('settings').close();
};
$('strategy-settings-open').onclick=()=>{
  if(!state?.strategy) return toast('正在加载策略状态',true);
  for(const [key,value] of Object.entries(state.strategy.config)) $('strategy-form').elements[key].value=value;
  $('strategy-settings').showModal();renderButtons();
};
$('strategy-form').onsubmit=async event=>{
  event.preventDefault();const config={};
  for(const key of Object.keys(state.strategy.config)) config[key]=['execution','model','exitPolicy'].includes(key)?$('strategy-form').elements[key].value:Number($('strategy-form').elements[key].value);
  if(await command('strategyConfig',config)) $('strategy-settings').close();
};
const consoleConnection=createConsoleConnection({
  onSnapshot:(snapshot,newToken)=>{state=snapshot;if(newToken!==undefined)token=newToken;connected=true;render();void refreshRayCheck();},
  onStatus:info=>{connectionInfo=info;connected=info.reachable;if(state)render();},
});
let lastRayCheck=0,rayCheckPending=false;
async function refreshRayCheck(){
  if(rayCheckPending||Date.now()-lastRayCheck<30000||state?.strategy?.config?.model!=='ray-twap-band')return;
  rayCheckPending=true;lastRayCheck=Date.now();
  try{const response=await fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('Health unavailable');renderRayRuntimeCheck(await response.json());}
  catch{const node=$('ray-check-note');if(node)node.textContent='当前版本核对暂时无法读取；请查看连接状态，不使用旧通过结果代替。';}
  finally{rayCheckPending=false;}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden){void consoleConnection.refresh();if(location.hash==='#ledger')ledgerPanel.open();}});
window.addEventListener('pagehide',()=>consoleConnection.stop(),{once:true});
window.addEventListener('pageshow',event=>{if(event.persisted)void consoleConnection.start();});
void consoleConnection.start();
