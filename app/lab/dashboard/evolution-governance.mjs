import { createHash } from 'node:crypto';

const freeze = value => { for (const x of Object.values(value)) if (x && typeof x === 'object') freeze(x); return Object.freeze(value); };
export const evolutionProtocol = freeze({
  version: 'strategy-evolution-governance-v1',
  scope: 'paper-experiment-selection',
  policies: ['market', 'consensus'],
  executionDelayMs: [0, 1000],
  initialCapital: 100,
  batchDays: 7,
  confirmationBatches: 2,
  minimumObservedRoundsPerDay: 230,
  minimumDistinctEligibleRounds: 300,
  minimumCompletedTradesPerAccount: 100,
  minimumPositiveDays: 5,
  maximumPositiveDayConcentration: .5,
  extraTicksPerBuyAndSellShare: 1,
  primaryFailedCandidateRetry: false,
  fixedCutoffAssessment: true,
  realTrading: false,
  profitabilityProven: false,
  thresholdsRole: 'Engineering coverage and economic robustness screens; not a confidence interval or sequential proof.',
});
const dayMs = 86400000, offset = 28800000, epsilon = 1e-7;
const finite = Number.isFinite;
const round = value => Math.round(value * 1e8) / 1e8;
const sum = values => round(values.reduce((s, x) => s + x, 0));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const day = time => new Date(time + offset).toISOString().slice(0, 10);
const list = value => Array.isArray(value) ? value : Object.values(value ?? {});
const canonicalRound = (slug, expectedDay) => {
  if (!/^btc-updown-5m-\d+$/.test(slug ?? '')) return false;
  const time = Number(slug.split('-').at(-1)) * 1000;
  return Number.isSafeInteger(time) && time % 300000 === 0 && day(time) === expectedDay;
};
const nonnegative = value => finite(value) && value >= 0;
const equality = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= epsilon;
function batchDates(batch) {
  if (!finite(batch?.start) || !finite(batch?.end) || (batch.start + offset) % dayMs !== 0 ||
      batch.end - batch.start !== evolutionProtocol.batchDays * dayMs) return [];
  return Array.from({ length: evolutionProtocol.batchDays }, (_, i) => day(batch.start + i * dayMs));
}
function payoutValid(t, settlement, now) {
  const m = t.market, l = settlement?.label;
  const financial = l?.version === 'paper-official-payout-v1' && l?.scope === 'paper-financial-only';
  const source = financial ? 'Gamma resolved + CLOB canonical payout; paper financial only; onchain redemption unconfirmed' :
    'Gamma resolved + CLOB winner + eventMetadata cross-check';
  const numericResearch = l && finite(l.opening) && l.opening > 0 && finite(l.final) && l.final > 0 &&
    Math.abs(l.final - l.opening) >= epsilon && (l.final >= l.opening ? 'Up' : 'Down') === l.winner;
  return Boolean(m && l && (financial || numericResearch) && l.source === source &&
    settlement.verificationSource === l.source && settlement.verificationVersion === l.version &&
    (l.rules === undefined || l.rules === m.rules) &&
    (l.resolutionSource === undefined || l.resolutionSource === m.resolutionSource) &&
    settlement.id && nonnegative(settlement.size) && nonnegative(settlement.payout) &&
    ['Up', 'Down'].includes(settlement.winner) && settlement.winner === l.winner &&
    l.slug === t.slug && l.conditionId === m.conditionId && l.start === m.start && l.end === m.end &&
    l.tokens?.Up === m.tokens.Up && l.tokens?.Down === m.tokens.Down &&
    l.payouts?.Up === Number(l.winner === 'Up') && l.payouts?.Down === Number(l.winner === 'Down') &&
    equality(settlement.payout, settlement.size * l.payouts[t.outcome]) &&
    finite(l.observedAt) && l.observedAt >= m.end && l.observedAt <= now &&
    settlement.observedAt === l.observedAt && finite(settlement.creditedAt) &&
    settlement.creditedAt >= l.observedAt && settlement.creditedAt <= now);
}
function ownFlow(t, { now, cutoff = now } = {}) {
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.slug !== 'string' ||
      !['Up', 'Down'].includes(t.outcome) || !t.market || t.slug !== t.market.slug ||
      !t.market.conditionId || t.market.tokens?.Up === t.market.tokens?.Down ||
      !['Up', 'Down'].every(o => typeof t.market.tokens?.[o] === 'string' && t.market.tokens[o]) ||
      t.tokenId !== t.market.tokens[t.outcome] || !finite(t.market.start) ||
      t.market.end !== t.market.start + 300000 || !finite(t.market.tick) || t.market.tick <= 0 ||
      !finite(t.openedAt) || t.openedAt < t.market.start || t.openedAt >= t.market.end ||
      t.openedAt > now || !canonicalRound(t.slug, day(t.market.start))) throw Error('Invalid owned trade identity');
  const reports = new Map();
  for (const r of list(t.orderReports)) {
    if (!r || !r.id || r.tokenId !== t.tokenId || !['buy', 'sell'].includes(r.side) ||
        !['filled', 'notional', 'fees'].every(k => nonnegative(r[k])) ||
        r.notional > r.filled + epsilon || (!r.filled && (r.notional || r.fees)) ||
        (r.filled > 0 && r.notional <= 0) || !finite(r.createdAt) || r.createdAt < t.market.start ||
        r.createdAt >= t.market.end || r.createdAt > now)
      throw Error('Invalid cumulative fill evidence');
    const prior = reports.get(r.id);
    if (prior && (prior.side !== r.side || ['filled', 'notional', 'fees'].some(k => r[k] < prior[k] - epsilon)))
      throw Error('Nonmonotonic cumulative fill evidence');
    reports.set(r.id, r);
  }
  const actualReports = [...reports.values()], atCutoff = actualReports.filter(r => r.createdAt <= cutoff);
  const aggregate = rows => {
    const buys = rows.filter(r => r.side === 'buy'), sells = rows.filter(r => r.side === 'sell');
    return { bought: sum(buys.map(r => r.filled)), sold: sum(sells.map(r => r.filled)),
      buyCost: sum(buys.map(r => r.notional + r.fees)), sellNet: sum(sells.map(r => r.notional - r.fees)),
      fees: sum(rows.map(r => r.fees)) };
  };
  const actual = aggregate(actualReports);
  if (!(actual.bought > 0) || actual.sold > actual.bought + epsilon ||
      !equality(actual.buyCost, t.cost) || !equality(actual.fees, t.fees) ||
      !equality(actual.bought, t.size)) throw Error('Owned trade cost, size or fee mismatch');
  const s = t.settlement;
  if (s && (!payoutValid(t, s, now) || s.size > actual.bought - actual.sold + epsilon))
    throw Error('Invalid or conflicting verified payout evidence');
  const actualRemaining = round(actual.bought - actual.sold - (s?.size ?? 0));
  if (!equality(actualRemaining, t.remaining) || actualRemaining < -epsilon)
    throw Error('Owned remaining inventory mismatch');
  const actualNet = round(actual.sellNet + (s?.payout ?? 0) - actual.buyCost);
  if (t.closedAt !== undefined && (!finite(t.closedAt) || t.closedAt < t.openedAt || t.closedAt > now ||
      actualRemaining !== 0 || !equality(actualNet, t.net))) throw Error('Closed trade mismatch');
  const observed = aggregate(atCutoff), payoutKnown = s && s.observedAt <= cutoff && s.creditedAt <= cutoff;
  const remaining = round(Math.max(0, observed.bought - observed.sold - (payoutKnown ? s.size : 0)));
  const net = round(observed.sellNet + (payoutKnown ? s.payout : 0) - observed.buyCost);
  return { id: t.id, slug: t.slug, openedDay: day(t.openedAt), actualNet, actualFees: actual.fees,
    lowerNet: net, upperNet: round(net + remaining), remaining, known: remaining === 0,
    completed: remaining === 0 && finite(t.closedAt) && t.closedAt <= cutoff,
    extraTickCost: round((observed.bought + observed.sold) * t.market.tick),
    actualRemaining, settlementId: s?.id ?? null };
}
function auditAccount(a, batch, now) {
  if (!a || a.initialCapital !== evolutionProtocol.initialCapital || !nonnegative(a.cash) ||
      !nonnegative(a.fees) || !finite(a.realized) || !Number.isInteger(a.completed) || a.completed < 0)
    throw Error('Invalid account aggregates');
  const closed = a.closedTrades;
  if (!Array.isArray(closed) || !Array.isArray(a.pendingSettlements)) throw Error('Incomplete owned inventory ledger');
  const owned = [...closed, ...a.pendingSettlements, ...(a.position ? [a.position] : [])];
  const ids = new Set(), settlementIds = new Set(), reportOwners = new Map(), flows = [];
  for (const t of owned) {
    if (ids.has(t.id)) throw Error('Duplicate owned trade'); ids.add(t.id);
    if (t.openedAt < batch.start || t.openedAt >= batch.end || t.openedDay && t.openedDay !== day(t.openedAt))
      throw Error('Owned trade is outside this registered cohort');
    for (const r of list(t.orderReports)) {
      if (reportOwners.has(r?.id) && reportOwners.get(r.id) !== t.id) throw Error('Order report claimed by multiple positions');
      reportOwners.set(r?.id, t.id);
    }
    const f = ownFlow(t, { now, cutoff: batch.labelCutoff });
    if (f.settlementId) { if (settlementIds.has(f.settlementId)) throw Error('Duplicate payout intent'); settlementIds.add(f.settlementId); }
    flows.push(f);
  }
  const computedCash = round(a.initialCapital + sum(flows.map(f => f.actualNet)));
  const computedFees = sum(flows.map(f => f.actualFees));
  const closedFlows = flows.slice(0, closed.length);
  if (!equality(computedCash, a.cash) || !equality(computedFees, a.fees) ||
      !equality(sum(closedFlows.map(f => f.actualNet)), a.realized) || closed.length !== a.completed)
    throw Error('Cash, fees, completed or realized do not reconcile');
  if (closedFlows.some(f => f.actualRemaining !== 0)) throw Error('Closed inventory remains unresolved');
  if (a.pendingBuy) throw Error('Unreconciled pending buy at fixed assessment');
  const lower = round(a.initialCapital + sum(flows.map(f => f.lowerNet)));
  const upper = round(a.initialCapital + sum(flows.map(f => f.upperNet)));
  return { id: a.id, policy: a.policy, executionDelayMs: a.executionDelayMs, initialCapital: a.initialCapital,
    cash: a.cash, fees: computedFees, realized: a.realized, lower, upper,
    completedAtCutoff: flows.filter(f => f.completed).length,
    unresolved: flows.filter(f => !f.known).length, extraTickCost: sum(flows.map(f => f.extraTickCost)),
    daily: Object.fromEntries(batchDates(batch).map(d => {
      const rows = flows.filter(f => f.openedDay === d);
      return [d, { lowerNet: sum(rows.map(f => f.lowerNet)), upperNet: sum(rows.map(f => f.upperNet)),
        completed: rows.filter(f => f.completed).length, extraTickCost: sum(rows.map(f => f.extraTickCost)) }];
    })) };
}
export function evaluateEvolutionBatch({ batch, accounts, daily, now, registryHash, integrity } = {}) {
  const b = { ...batch, batchId: batch?.batchId ?? batch?.id };
  const evidenceHash = hash({ batch: b, accounts, daily, registryHash, integrity: integrity ?? null });
  const result = { id: (b.batchId ?? 'invalid') + ':' + evidenceHash, batchId: b.batchId ?? null,
    registryHash, evidenceHash, batch: b, pass: false, ready: finite(now) && finite(b.labelCutoff) && now >= b.labelCutoff,
    evaluatedAt: now, status: 'collecting', scope: evolutionProtocol.scope, gates: [], reasons: [],
    metrics: { accounts: [], groups: [] }, profitabilityProven: false };
  const gate = (name, passed, reason, details = null) => {
    result.gates.push({ name, passed: Boolean(passed), reason, details });
    if (!passed) result.reasons.push(reason);
  };
  const dates = batchDates(b);
  const validBatch = Boolean(typeof b.batchId === 'string' && b.batchId &&
    Number.isInteger(b.index) && b.index >= 0 && dates.length === evolutionProtocol.batchDays &&
    finite(b.labelCutoff) && b.labelCutoff >= b.end && finite(b.registeredAt) && b.registeredAt < b.start &&
    finite(now) && now >= b.registeredAt);
  gate('registered-fixed-batch', validBatch, '批次必须在起点前登记完整七日期及固定标签截止');
  gate('registry-binding', typeof registryHash === 'string' && registryHash.length > 0 &&
    b.registryHash === registryHash, '协议或来源登记不一致，不能晋升');
  const clean = integrity !== false && integrity?.passed !== false && integrity?.ok !== false &&
    !(integrity?.errors?.length) && !(integrity?.registryHash && integrity.registryHash !== registryHash);
  gate('integrity-input', clean, '外部完整性审计未通过');
  const eligible = new Set(), perDay = [];
  for (const d of dates) {
    const row = daily?.[d], observed = row?.observedRounds, selected = row?.eligibleRounds;
    const validObserved = Array.isArray(observed) ? new Set(observed.filter(slug => canonicalRound(slug, d))) : new Set();
    const validEligible = Array.isArray(selected) ? new Set(selected.filter(slug => canonicalRound(slug, d))) : new Set();
    for (const slug of validEligible) eligible.add(slug);
    const valid = validObserved.size >= evolutionProtocol.minimumObservedRoundsPerDay &&
      Array.isArray(observed) && observed.every(slug => canonicalRound(slug, d)) &&
      Array.isArray(selected) && selected.every(slug => canonicalRound(slug, d)) &&
      [...validEligible].every(slug => validObserved.has(slug));
    perDay.push({ day: d, observed: validObserved.size, eligible: validEligible.size, valid });
  }
  gate('date-and-round-coverage', dates.length === evolutionProtocol.batchDays &&
    perDay.every(d => d.valid) && eligible.size >= evolutionProtocol.minimumDistinctEligibleRounds,
    '日期或不同合法盘口覆盖不足', { dates: perDay, eligibleRounds: eligible.size });
  const roster = list(accounts), expected = evolutionProtocol.executionDelayMs.flatMap(delay =>
    evolutionProtocol.policies.map(policy => policy + ':' + delay));
  const keys = roster.map(a => a?.policy + ':' + a?.executionDelayMs);
  gate('same-execution-roster', roster.length === expected.length &&
    expected.every(k => keys.filter(x => x === k).length === 1),
    '需要两种时延各含相同本金的冠军和挑战者');
  if (validBatch) for (const a of roster) {
    try {
      const audited = auditAccount(a, b, now); result.metrics.accounts.push(audited);
      gate('account-integrity:' + (a?.id ?? keys[result.metrics.accounts.length - 1]), true, '账户自有现金流与费用已复算');
    } catch (e) { gate('account-integrity:' + (a?.id ?? 'unknown'), false, e.message); }
  }
  for (const delay of evolutionProtocol.executionDelayMs) {
    const baseline = result.metrics.accounts.find(a => a.policy === 'market' && a.executionDelayMs === delay);
    const candidate = result.metrics.accounts.find(a => a.policy === 'consensus' && a.executionDelayMs === delay);
    if (!baseline || !candidate) { gate('economics:' + delay, false, '该时延组缺少可核对账户'); continue; }
    const differences = dates.map(d => ({ day: d, delta: round(candidate.daily[d].lowerNet - baseline.daily[d].upperNet) }));
    const total = sum(differences.map(x => x.delta)), positives = differences.filter(x => x.delta > epsilon);
    const positiveTotal = sum(positives.map(x => x.delta)), largest = Math.max(0, ...positives.map(x => x.delta));
    const concentration = positiveTotal > 0 ? largest / positiveTotal : null;
    const absolute = round(candidate.lower - candidate.initialCapital), relative = round(candidate.lower - baseline.upper);
    const stressAbsolute = round(absolute - candidate.extraTickCost);
    const stressRelative = round(relative - candidate.extraTickCost + baseline.extraTickCost);
    // Also pass the stricter candidate-only adverse execution comparison.
    const asymmetricStressRelative = round(relative - candidate.extraTickCost);
    result.metrics.groups.push({ executionDelayMs: delay, baselineId: baseline.id, candidateId: candidate.id,
      absoluteWorstNet: absolute, relativeWorstNet: relative, stressAbsolute, stressRelative,
      asymmetricStressRelative, positiveDays: positives.length, positiveDayConcentration: concentration,
      leaveOneDayOutMinimum: Math.min(...differences.map(x => round(total - x.delta))), daily: differences });
    gate('completed-coverage:' + delay, baseline.completedAtCutoff >= evolutionProtocol.minimumCompletedTradesPerAccount &&
      candidate.completedAtCutoff >= evolutionProtocol.minimumCompletedTradesPerAccount,
      '双方完整仓位样本不足', { baseline: baseline.completedAtCutoff, candidate: candidate.completedAtCutoff });
    gate('absolute-and-relative-value:' + delay, absolute > epsilon && relative > epsilon,
      '候选最坏库存范围下尚未获得正绝对及相对账户增量', { absolute, relative });
    gate('date-robustness:' + delay, positives.length >= evolutionProtocol.minimumPositiveDays &&
      differences.every(x => total - x.delta > epsilon) &&
      concentration !== null && concentration <= evolutionProtocol.maximumPositiveDayConcentration + 1e-12,
      '日期正增量不足、删单日后转负或盈利过度集中', { positives: positives.length, concentration });
    gate('extra-tick-cost-stress:' + delay, stressAbsolute > epsilon && stressRelative > epsilon &&
      asymmetricStressRelative > epsilon, '额外每腿一tick的不利执行成本后绝对或相对增量不足',
      { stressAbsolute, stressRelative, asymmetricStressRelative });
  }
  result.pass = result.ready && result.gates.length > 0 && result.gates.every(g => g.passed);
  result.status = !result.ready ? 'collecting' : result.pass ? 'passed' : 'not-qualified';
  return result;
}
export function newEvolutionGovernance({ createdAt, registryHash } = {}) {
  if (!finite(createdAt) || typeof registryHash !== 'string' || !registryHash) throw Error('Invalid governance origin');
  return { version: evolutionProtocol.version, createdAt, registryHash, effectivePolicy: 'market', phase: 'primary',
    generation: 0, adoptionId: null, confirmationOf: null, processedResults: {}, processedBatches: {},
    history: [], lastDecision: null, scope: evolutionProtocol.scope, realTrading: false, profitabilityProven: false };
}
export function planEvolutionDecision(state, evaluation, { now } = {}) {
  if (state?.version !== evolutionProtocol.version || !finite(now)) throw Error('Invalid governance state or decision clock');
  if (!evaluation?.ready || !evaluation.id || !evaluation.batchId || !finite(evaluation.evaluatedAt) ||
      evaluation.evaluatedAt > now || state.processedResults[evaluation.id] || state.processedBatches[evaluation.batchId])
    return state;
  const mismatch = evaluation.registryHash !== state.registryHash || evaluation.batch?.registryHash !== state.registryHash;
  const index = evaluation.batch?.index;
  const phaseMatches = state.phase === 'primary' && index === 0 ||
    state.phase === 'confirmation' && index === 1 || state.phase === 'adopted' && index >= 2;
  if (!mismatch && !phaseMatches) return state;
  if (mismatch && state.effectivePolicy !== 'consensus') return state;
  const next = structuredClone(state), previousPhase = state.phase, previousPolicy = state.effectivePolicy;
  let action, reason;
  if (mismatch) {
    next.phase = 'rolled-back'; next.effectivePolicy = 'market'; next.generation++;
    action = 'rollback-source-mismatch'; reason = '登记或来源不一致，仅后续新仓回到市场退出';
  } else if (!evaluation.pass) {
    next.phase = state.phase === 'adopted' ? 'rolled-back' : 'rejected';
    if (state.phase === 'adopted') { next.effectivePolicy = 'market'; next.generation++; }
    action = state.phase === 'adopted' ? 'rollback-monitor' : 'reject-fixed-candidate';
    reason = '固定批次未通过工程与费用后账户门槛；不重筛同候选';
  } else if (state.phase === 'primary') {
    next.phase = 'confirmation'; next.confirmationOf = evaluation.id;
    action = 'begin-confirmation'; reason = '首固定批次通过，等待第二未来七日确认';
  } else if (state.phase === 'confirmation') {
    const first = state.history.find(h => h.evaluationId === state.confirmationOf);
    if (!first || first.batchEnd !== evaluation.batch.start) {
      next.phase = 'rejected'; action = 'reject-noncontiguous-confirmation'; reason = '确认批次须紧接已通过的首批次';
    } else {
      next.phase = 'adopted'; next.effectivePolicy = 'consensus'; next.generation++;
      next.adoptionId = 'paper-adoption:' + state.registryHash + ':' + evaluation.id;
      action = 'adopt-for-new-positions'; reason = '两批未来日期通过，仅后续新仓采用共同确认退出';
    }
  } else {
    action = 'retain-after-monitor'; reason = '固定后续监测批次通过，保持纸面版本';
  }
  const decision = { id: 'decision:' + evaluation.id, evaluationId: evaluation.id, batchId: evaluation.batchId,
    batchIndex: index, batchStart: evaluation.batch?.start, batchEnd: evaluation.batch?.end,
    at: now, action, reason, pass: evaluation.pass, previousPhase, phase: next.phase,
    previousPolicy, effectivePolicy: next.effectivePolicy, generation: next.generation,
    affectsExistingPositions: false, realTrading: false, scope: evolutionProtocol.scope };
  next.processedResults[evaluation.id] = true; next.processedBatches[evaluation.batchId] = evaluation.id;
  next.history.push(decision); next.lastDecision = decision;
  return next;
}
