const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (value, digits = 0) => Number.isFinite(value) ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const money = value => Number.isFinite(value) ? `${value < 0 ? '−' : ''}$${number(Math.abs(value), 4)}` : '—';
const time = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false }) : '—';
const duration = value => Number.isFinite(value) ? `${number(value / 1000, 1)} 秒` : '—';
const policyNames = { immediate: '立即卖出', delay30: '观察 30 秒后卖出', settlement: '持有至核实结算' };
const originNames = { automatic: '自动入场', 'manual-one-tap': '手动 One-Tap' };
const reasonNames = { 'first-observed': '首次观察剩余库存', periodic: '固定观察时点', 'exit-signal': '当前退出信号' };
const statusNames = {
  pending: '等待执行观察', filled: '报价足额可卖', partial: '报价部分可卖',
  'hold-to-settlement': '持有至核实结算', 'expired-hold-to-settlement': '到期，余量待核实结算',
  'no-bid-at-decision': '判断时无买盘', 'no-bid-at-execution': '执行观察时无买盘',
  'protection-unfilled': '保护价内无可卖深度', 'missing-decision': '缺少判断时点报价', 'missing-quote': '缺少执行时点报价',
};

export function renderContinuationResearch(study, get = id => document.getElementById(id)) {
  const setText = (id, value) => { const node = get(id); if (node) node.textContent = value; };
  const setHtml = (id, value) => { const node = get(id); if (node) node.innerHTML = value; };
  setText('continuation-status', study?.error ? `研究采集异常，主账户继续运行：${study.error}` : study?.startedAt ?
    `自 ${time(study.startedAt)} 起记录新持仓；${number(study.rounds)} 个盘口，${number(study.finalized)} 个采样已完成核实。历史交易不回填。` :
    '等待新持仓的有效盘口报价；此研究不修改买卖规则。');
  for (const [id, field] of [['samples', 'samples'], ['trades', 'trades'], ['pending', 'pending'], ['misses', 'slotMisses']])
    setText(`continuation-${id}`, number(study?.[field] ?? 0));
  const origins = study?.origins ?? {};
  setText('continuation-origins', `采样来源：自动入场 ${number(origins.automatic ?? 0)}，手动 One-Tap ${number(origins['manual-one-tap'] ?? 0)}。研究开始观察前未覆盖 ${number(study?.preObservationSlots ?? 0)} 个时点，单独计数；同一笔仓位可以有多个采样。`);
  const pairs = study?.pairs ?? [];
  setHtml('continuation-pairs', pairs.length ? pairs.map(pair => `<tr><td>${esc(policyNames[pair.policy] ?? pair.policy)} − 立即卖出</td><td>${number(pair.complete)}</td><td>${number(pair.unknown)}</td><td>${pair.complete > 0 ? money(pair.meanPerShareDifference) + ' / 份' : '—'}</td></tr>`).join('') :
    '<tr><td colspan="4">等待各组未来价值均可核实后比较</td></tr>');
  const latest = study?.latest;
  setText('continuation-latest', latest ? `${time(latest.at)} · ${latest.slug ?? latest.market?.slug ?? '—'} · ${latest.outcome} / 剩余 ${number(latest.size, 4)} 份 · ${originNames[latest.origin] ?? latest.origin ?? '—'}` :
    '尚无本版本的新持仓采样。');
  setText('continuation-reasons', latest ? `采样依据：${(latest.reasons ?? []).map(reason => reasonNames[reason] ?? reason).join('、') || '—'}。仓位编号：${latest.tradeId ?? '—'}。` : '');
  setText('continuation-decision', latest ? `当时持有判断：${latest.decision?.reason ?? latest.decision?.status ?? '未记录判断'}。` : '');
  setHtml('continuation-arms', latest ? (latest.arms ?? []).map(arm => {
    const execution = arm.execution;
    const remaining = arm.remainingBeforeSettlement ?? execution?.remaining ?? null;
    return `<tr><td>${esc(policyNames[arm.name] ?? arm.name)}</td><td>${esc(statusNames[arm.status] ?? arm.status ?? '—')}<small>${arm.complete ? '未来净价值已核实' : arm.terminalValue == null ? '未来净价值未知' : '等待核实'}</small></td><td>${number(execution?.filled, 4)}<small>报价费用 ${money(execution?.fees)}</small></td><td>${number(remaining, 4)}</td><td>${arm.complete ? money(arm.terminalValue) : '—'}<small>核实时刻 ${time(arm.knownAt)}</small></td><td>${duration(arm.tradingHoldingMs)}</td><td>${duration(arm.settlementWaitMs)}</td></tr>`;
  }).join('') : '<tr><td colspan="7">等待剩余库存采样</td></tr>');
}
