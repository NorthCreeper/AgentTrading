const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (value, digits = 0) => Number.isFinite(value) ? value.toLocaleString('en-US', {minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
const count = value => Number.isInteger(value) && value >= 0 ? number(value) : '—';
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1 ? `${number(value * 100, 2)}%` : '—';
const money = value => Number.isFinite(value) ? `${value < 0 ? '−' : ''}$${number(Math.abs(value), 4)}` : '—';
const time = value => Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ?
  new Date(value).toLocaleString('zh-CN', {timeZone:'Asia/Hong_Kong',hour12:false}) : '—';
const benchmarkNames = {market:'原始盘口',fixed:'固定模型',adaptive:'在线校准'};

export function renderAdaptiveResearch(study, get = id => document.getElementById(id)) {
  const setText = (id, value) => {const node = get(id); if(node) node.textContent = value;};
  const setHtml = (id, value) => {const node = get(id); if(node) node.innerHTML = value;};
  setText('adaptive-status', study?.error ? `在线学习验证采集异常：${study.error}。研究未接管买卖，主自动模拟继续。` :
    study?.startedAt ? `自 ${time(study.startedAt)} 起记录新预测；参数逐轮核实后学习，研究未接管买卖。` :
    '等待创建后的新预测；参数逐轮核实后学习，研究未接管买卖。');
  for(const [id,field] of [['forecasts','forecasts'],['labeled','labeled'],['updates','updates'],['dates','dates']])
    setText(`adaptive-${id}`, count(study?.[field] ?? 0));

  const benchmarks = study?.benchmarks;
  const rows = benchmarks && typeof benchmarks === 'object' ? Object.keys(benchmarkNames).map(key => {
    const b = benchmarks[key] ?? {};
    const brier = Number.isFinite(b.brier) && b.brier >= 0 && b.brier <= 1 ? number(b.brier, 5) : '—';
    const known = Number.isInteger(b.known) && b.known > 0;
    const net = known ? money(b.quotedNet) : '尚未核实';
    return `<tr><td>${benchmarkNames[key]}</td><td>${brier}</td><td>${count(b.selected)} 条<small>已核实 ${count(b.known)} · 待核实 ${count(b.unknown)}</small></td><td>${net}<small>预测净值 ${money(b.predictedNet)}</small></td></tr>`;
  }).join('') : '<tr><td colspan="4">等待本版本的新预测与报价，尚无核实比较。</td></tr>';
  setHtml('adaptive-benchmarks', rows + '<tr><td colspan="4"><small>按当时预测选择的报价反事实，未提交订单；报价净值不是账户盈利，未核实部分保留未知。</small></td></tr>');

  const latest = study?.latest;
  const p = {market:latest?.marketProbability,fixed:latest?.fixedPUp,adaptive:latest?.pUp};
  const revision = latest?.updatesAtForecast;
  setText('adaptive-latest', latest ? `${time(latest.at)} · ${latest.market?.slug ?? latest.slug ?? '—'} · 权重版本 ${count(revision)}\n` +
    `Up：原始盘口 ${probability(p.market)} · 固定模型 ${probability(p.fixed)} · 在线校准 ${probability(p.adaptive)}\n` +
    (latest.label ? `结算已核实 · ${latest.label.winner ?? '—'} · ${time(latest.label.observedAt ?? latest.label.knownAt)}` :
      '结算待核实，尚不计入已核实报价净值。') : '尚无本版本的新预测。');

  const params = study?.params;
  const offset = Array.isArray(params) ? params[0] : params?.b0;
  const shape = Array.isArray(params) ? params[1] : params?.b1;
  setHtml('adaptive-parameters', `<details><summary>学习参数与更新时间</summary><p>偏移 ${number(offset, 5)} · 形状 ${number(shape, 5)}</p>` +
    `<p>最近学习：${time(study?.lastUpdateAt)}<br>标签已知至：${time(study?.throughLabelKnownAt)}</p>` +
    `<p>固定算法范围内小幅更新，向盘口基准收缩；不自动寻找最佳价格阈值。版本：${esc(study?.version ?? '尚未创建')}</p></details>`);
}
