const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const finite = Number.isFinite;
const number = (value, digits = 0) => finite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const count = value => Number.isInteger(value) && value >= 0 ? number(value) : '—';
const money = value => finite(value) ? `${value < 0 ? '−' : ''}$${number(Math.abs(value), 4)}` : '—';
const percent = value => finite(value) ? `${value < 0 ? '−' : ''}${number(Math.abs(value) * 100, 2)}%` : '—';
const time = value => finite(value) && finite(new Date(value).getTime()) ?
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false }) : '—';
const duration = value => finite(value) && value >= 0 ? `${number(value / 60000, 2)} 分钟` : '—';
const modelNames = { market: '原始盘口', fixed: '固定模型', adaptive: '在线校准' };
const dispositionNames = {
  'skipped-no-value': '没有正预期报价', 'skipped-disabled': '未开放本次入场', 'skipped-busy': '已有仓位或待单',
  'skipped-cash': '现金不足 $1', 'skipped-budget': '报价含费预算不足',
  filled: '足额成交', 'partial-filled': '部分成交', 'no-liquidity': '保护价内无成交',
  'budget-failed': '执行时现金不足', 'value-expired': '执行时扣费预期已消失',
  'execution-expired': '新报价等待过期', 'execution-disabled': '入场未开放，待单已取消', pending: '等待执行',
};

function accountName(account) {
  const model = modelNames[account?.model] ?? account?.model ?? '未识别模型';
  const capital = finite(account?.initialCapital) && account.initialCapital > 0 ? `$${number(account.initialCapital)}` : '—';
  return `${esc(model)}<small>独立研究本金 ${capital}</small>`;
}

function navCell(account) {
  const nav = account.nav ?? {}, roi = account.roiNav ?? {};
  const traded = Number.isInteger(account.completed) && account.completed > 0 || Boolean(account.position);
  if (nav.known === true && finite(nav.value)) {
    const performance = !traded ? '尚无成交' : roi.known === true && finite(roi.value) ? `净值回报 ${percent(roi.value)}` : '净值回报待核实';
    return `${money(nav.value)}<small>${performance}</small>`;
  }
  const bounds = finite(nav.lower) && finite(nav.upper) && nav.upper >= nav.lower ? `${money(nav.lower)} 至 ${money(nav.upper)}` : '金额范围待核实';
  return `净值待核实<small>${bounds}</small><small>未核实支付不按零计算</small>`;
}

function inventoryRow(account) {
  const position = account.position, pending = account.pendingOrder;
  if (position && typeof position === 'object') {
    const now = account.nav?.asOf;
    const expired = finite(position.end) && finite(now) && now >= position.end;
    return `<tr><td>${accountName(account)}</td><td>${esc(position.outcome ?? '—')} · ${esc(position.slug ?? '—')}<small>入场 ${time(position.enteredAt)}</small></td>` +
      `<td>${number(position.size, 4)} 份<small>含费成本 ${money(position.cost)}</small></td><td>${expired ? '到期，等待核实结算' : '持有至核实结算'}<small>盘口结束 ${time(position.end)}</small></td></tr>`;
  }
  if (pending && typeof pending === 'object') {
    return `<tr><td>${accountName(account)}</td><td>${esc(pending.outcome ?? '—')} · ${esc(pending.slug ?? '—')}<small>请求 ${time(pending.requestedAt)}</small></td>` +
      `<td>尚未成交<small>原保护价 ${finite(pending.limit) && pending.limit > 0 && pending.limit < 1 ? number(pending.limit * 100, 2) + '¢' : '—'}</small></td>` +
      `<td>等待新报价执行<small>执行最早 ${time(pending.dueAt)}<br>报价截止 ${time(pending.deadlineAt)}</small></td></tr>`;
  }
  return `<tr><td>${accountName(account)}</td><td colspan="3">空仓；等待之后的新预测</td></tr>`;
}

export function renderAdaptiveAccounts(study, get = id => document.getElementById(id)) {
  const setText = (id, value) => { const node = get(id); if (node) node.textContent = value; };
  const setHtml = (id, value) => { const node = get(id); if (node) node.innerHTML = value; };
  const accounts = Array.isArray(study?.accounts) ? study.accounts.filter(a => a && typeof a === 'object') : [];
  const status = study?.archived ? '主策略已按用户指定更换为 Ray；旧六组账户已停止新增交易，以下保留历史快照，不代表 Ray 的成绩。原始数据和旧源码绑定校验记录保留。' : study?.error ? `独立账户对照异常：${study.error}。本研究资金单列，主账户买卖规则未修改。` :
    finite(study?.startedAt) ? `自 ${time(study.startedAt)} 起处理新预测；${count(accounts.length)} 组独立模拟账户，每笔 $1，费用另计。该实验持有至核实结算，主账户退出规则未修改。` :
    finite(study?.createdAt) ? `独立模拟账户已创建于 ${time(study.createdAt)}，等待之后的新预测；每笔 $1，费用另计。研究本金不计入主余额。` :
    '等待独立模拟账户创建与新预测；研究本金不计入主余额，主账户买卖规则未修改。';
  setText('adaptive-account-status', status);
  setText('adaptive-account-forecasts', count(study?.forecasts ?? 0));
  setText('adaptive-account-dates', count(study?.dates ?? 0));
  setText('adaptive-account-open', count(accounts.filter(a => a.position).length));
  setText('adaptive-account-pending', count(accounts.filter(a => a.pendingOrder).length));

  setHtml('adaptive-account-accounts', accounts.length ? accounts.map(account => {
    const completed = Number.isInteger(account.completed) && account.completed >= 0 ? account.completed : null;
    const rate = completed > 0 && Number.isInteger(account.wins) && account.wins >= 0 && account.wins <= completed ? percent(account.wins / completed) : '—';
    const pnl = completed > 0 ? money(account.realizedPnl) : '尚无核实平仓';
    const realizedReturn = completed > 0 && finite(account.roiRealized) ? `已实现回报 ${percent(account.roiRealized)}` : '未平仓不计核实损益';
    return `<tr><td>${accountName(account)}</td><td>${money(account.cash)}</td><td>${pnl}<small>累计费用 ${money(account.fees)}</small></td>` +
      `<td>${count(account.completed)} 笔 · 胜率 ${rate}<small>${realizedReturn}</small></td><td>${navCell(account)}</td>` +
      `<td>持仓 ${duration(account.occupiedMs)}<small>其中到期等待 ${duration(account.waitMs)}</small><small>待单 ${duration(account.pendingOrderMs)}</small></td></tr>`;
  }).join('') : '<tr><td colspan="6">等待创建六组独立模拟账户；当前没有研究账户成绩。</td></tr>');

  setHtml('adaptive-account-inventory', accounts.length ? accounts.map(inventoryRow).join('') : '<tr><td colspan="4">尚无本实验的持仓或待单。</td></tr>');
  setHtml('adaptive-account-dispositions', accounts.length ? accounts.map(account => {
    const entries = account.dispositions && typeof account.dispositions === 'object' && !Array.isArray(account.dispositions) ?
      Object.entries(account.dispositions).filter(([, value]) => Number.isInteger(value) && value > 0) : [];
    const reasons = entries.length ? entries.map(([reason, value]) => `${esc(dispositionNames[reason] ?? reason)} ${count(value)} 次`).join(' · ') : '尚无终态机会记录';
    return `<tr><td>${accountName(account)}</td><td>${reasons}<small>当前待单与待核实持仓单列；正预测净值不计作利润。</small></td></tr>`;
  }).join('') : '<tr><td colspan="2">等待之后的新预测与实际执行观察。</td></tr>');
}
