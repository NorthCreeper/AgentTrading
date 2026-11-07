const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number = (value, digits = 0) => Number.isFinite(value) ?
  value.toLocaleString('en-US', {minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
const money = value => Number.isFinite(value) ? `${value < 0 ? '−' : ''}$${number(Math.abs(value), 4)}` : '—';
const count = value => Number.isInteger(value) && value >= 0 ? number(value) : '—';
const time = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ?
  new Date(value).toLocaleString('zh-CN', {timeZone:'Asia/Hong_Kong',hour12:false}) : '—';
const duration = value => Number.isFinite(value) && value >= 0 ? `${number(value / 60000, 2)} 分钟` : '—';
const sourceNames = {automatic:'自动策略','manual-one-tap':'手动一键买入','manual-other':'手动订单'};
const nonnegativeMoney = value => Number.isFinite(value) && value >= 0 ? money(value) : '—';

function unknownCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value instanceof Map) return value.size;
  if (Number.isInteger(value) && value >= 0) return value;
  if (value === true) return 1;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

export function renderSettlementQueue(summary, get = id => document.getElementById(id)) {
  const setText = (id, value) => {const node=get(id);if(node)node.textContent=value;};
  const setHtml = (id, value) => {const node=get(id);if(node)node.innerHTML=value;};
  const positions = Array.isArray(summary?.positions) ? summary.positions.filter(position => position && typeof position === 'object') : [];
  let status;
  if (!summary) status='等待账户结算队列数据；未核实仓位不计完成交易或收益。';
  else if (summary.error) status=`结算队列信息待核对：${summary.error}。未核实资金不会提前变为现金。`;
  else {
    status = summary.count === 0 && positions.length === 0 ? '当前没有待结算仓位；新入场继续核对策略条件、可核实净值与可用现金。' :
      '到期仓位单独等待官方支付核实；若仓位净值暂不可核实，暂停新买入。';
    status += ' 待结算成本继续单列记录，未核实资金不会提前变为现金。';
    if (summary.activePosition) status += ' 当前另有活跃仓位，继续管理其退出；处理完成后再考虑新开仓。';
    const unknown = unknownCount(summary.unknownHoldings);
    if (unknown) status += ` 另有 ${count(unknown)} 项持仓归属待核对，暂不能据此允许新开仓。`;
    if (positions.length && Number.isFinite(summary.maximumPayout) && summary.maximumPayout >= 0)
      status += ` 队列最高可能支付 ${money(summary.maximumPayout)}，尚未核实，不计已实现收益。`;
  }
  setText('settlement-queue-status',status);
  setText('settlement-queue-count',count(summary?.count));
  setText('settlement-queue-cost',nonnegativeMoney(summary?.cost));
  setText('settlement-queue-cash',money(summary?.cash));
  setText('settlement-queue-wait',duration(summary?.longestWaitMs));
  setHtml('settlement-queue-body',positions.length ? positions.map(position => {
    const origin = sourceNames[position.origin ?? 'automatic'] ?? position.origin;
    return `<tr><td>${esc(position.outcome ?? '—')} · ${esc(position.slug ?? '—')}<small>${esc(origin ?? '来源待核对')}</small></td>` +
      `<td>${Number.isFinite(position.size) && position.size >= 0 ? number(position.size,4) : '—'} 份<small>剩余持仓成本 ${nonnegativeMoney(position.cost)}</small></td>` +
      `<td>${time(position.market?.end)}<small>到期后等待 ${duration(position.waitMs)}</small></td>` +
      '<td>等待官方支付核实<small>尚未清仓，不计本笔收益</small><small>结算前不作为可用现金</small>' +
      (position.lastCheckedAt?`<small>最近查询 ${time(position.lastCheckedAt)}</small>`:'<small>等待查询</small>') +
      (position.lastResult?`<small>Gamma ${position.lastResult.gammaResolved?'已确认':'待确认'} · CLOB ${position.lastResult.clobClosed?'已关闭':'未关闭'}</small>`:'') +
      (position.lastError?`<small>查询待重试：${esc(position.lastError)}</small>`:'')+'</td></tr>';
  }).join('') : `<tr><td colspan="4">${summary ? '当前没有待结算仓位。' : '等待结算队列数据。'}</td></tr>`);
}
