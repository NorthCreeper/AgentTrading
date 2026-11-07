import { evaluateForward, forwardProtocol } from '../../dashboard/forward-strategy.mjs';
import { strategyDefaults, freshBook } from '../../dashboard/strategy.mjs';
import { valueFeatures, valueProtocol } from '../../dashboard/settlement-value.mjs';
import { probability } from '../../dashboard/settlement-model.mjs';
import { predictAdaptive, adaptiveProtocol } from '../../dashboard/adaptive-calibration.mjs';
import { e18ToPrice } from '../../dashboard/chart-model.mjs';
import { amountQuote, amountExecutionVersion } from '../../amount-order.mjs';
import { round } from '../../paper-broker.mjs';

const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const finite = Number.isFinite;
export const entryPolicyProtocol = freeze({ version: 'history-entry-policies-v1', paperOnly: true,
  createdOn: '2026-10-02', defaultAmountUsd: 1, staleMs: 3000, protectionCents: 2,
  priceCap: .85, residualWindowMs: 60000, residualMinimum: .75, residualFloorUsd: 1,
  expectedProfitEpsilon: 1e-8, changesExits: false, changesFrequency: false,
  fittedModelScope: '120-to-125-seconds-only', executionIsFill: false });

// Six pre-fixed entry hypotheses, not a price/time parameter search. The caller
// owns attempts, delayed execution, inventory, exits, funds and known labels.
export const entryPolicyCatalog = freeze([
  { id: 'forward-control', family: 'forward', label: '原动量入场', historyStatus: 'existing-main-explored', parameters: {} },
  { id: 'forward-aligned-capped', family: 'forward', label: '动量同向且不追高', historyStatus: 'filter-components-already-explored',
    parameters: { btcMove30Aligned: true, maximumAverage: .85 } },
  { id: 'forward-twap-residual', family: 'forward', label: '同向动量与标准化TWAP偏离', historyStatus: 'new-hypothesis-old-history-exploratory',
    parameters: { btcMove30Aligned: true, maximumAverage: .85, residualWindowMs: 60000, minimumResidual: .75, scaleFloorUsd: 1 } },
  { id: 'p3-market-value-120', family: 'value', label: '120秒原始盘口概率基准', historyStatus: 'existing-p3-account-model-explored',
    parameters: { anchorMs: 120000, windowMs: 5000, model: 'market', positiveAfterFeesOnly: true } },
  { id: 'p3-fixed-value-120', family: 'value', label: '120秒按先前已知标签拟合', historyStatus: 'existing-p3-model-chronological-refit-required',
    parameters: { anchorMs: 120000, windowMs: 5000, model: 'fixed', positiveAfterFeesOnly: true } },
  { id: 'p3-adaptive-value-120', family: 'value', label: '120秒有界延后更新', historyStatus: 'existing-p3-account-model-chronological-replay-required',
    parameters: { anchorMs: 120000, windowMs: 5000, model: 'adaptive', positiveAfterFeesOnly: true } },
]);

// Inventory policies remain separate factors. These are references, not extra
// entry combinations or implementations of a new exit / forced time limit.
export const existingP3ExitCatalog = freeze([
  { id: 'market-information-v1', scope: 'existing-main', entryIndependent: true,
    source: '../../dashboard/market-exit.mjs', decision: 'fresh-book adaptive reversal with continuous 5s confirmation' },
  { id: 'verified-settlement-only', scope: 'existing-p3-accounts', entryIndependent: true,
    source: '../../dashboard/adaptive-account.mjs', decision: 'hold until independently verified financial payout; count cash wait' },
  { id: 'executable-bid-exit-v1', scope: 'existing-p3-negative-historical-comparison', entryIndependent: true,
    source: '../../dashboard/bid-exit.mjs', decision: 'full-depth net sale value reversal, existing 5s confirmation; prior account superiority not established' },
  { id: 'p3b-common-confirmation', scope: 'existing-registered-comparison', entryIndependent: true,
    implementationVersion: 'market-bid-confirmation-v1', source: '../../dashboard/consensus-exit.mjs',
    decision: 'both original midpoint and executable net bid rules currently confirmed; use registered implementation without posterior re-tuning' },
]);

function validLevels(levels, side) {
  return Array.isArray(levels) && levels.length > 0 && levels.every((l, i) => Array.isArray(l) && l.length >= 2 &&
    finite(l[0]) && l[0] > 0 && l[0] < 1 && finite(l[1]) && l[1] > 0 &&
    (!i || (side === 'buy' ? l[0] > levels[i - 1][0] : l[0] < levels[i - 1][0])));
}
function validFrame(frame, now) {
  const m = frame?.market;
  if (!finite(now) || !frame || !finite(frame.now) || frame.now > now || now - frame.now > entryPolicyProtocol.staleMs ||
      !m || !finite(m.start) || !finite(m.end) || m.end - m.start !== 300000 ||
      typeof m.slug !== 'string' || !m.slug || typeof m.conditionId !== 'string' || !m.conditionId ||
      !['Up', 'Down'].every(o => typeof m.tokens?.[o] === 'string' && m.tokens[o]) || m.tokens.Up === m.tokens.Down ||
      !finite(m.tick) || m.tick <= 0 || m.tick >= 1 || !finite(m.fee?.rate) || m.fee.rate < 0 ||
      !finite(m.fee?.exponent) || m.fee.exponent < 0 || !Array.isArray(frame.books) || frame.books.length !== 2) return false;
  return ['Up', 'Down'].every(o => {
    const matched = frame.books.filter(b => b.tokenId === m.tokens[o]), b = matched[0];
    return matched.length === 1 && freshBook(b, now, entryPolicyProtocol.staleMs) &&
      b.timestamp <= b.receivedAt && b.receivedAt <= frame.now &&
      validLevels(b.bids, 'sell') && validLevels(b.asks, 'buy') && b.bids[0][0] < b.asks[0][0];
  });
}

export function causalTwapResidual(frame, prices, now) {
  const unavailable = reason => ({ ready: false, reason, standardizedResidual: null });
  const available = prices.filter(p => finite(p.time) && p.time <= now && finite(p.receivedAt) &&
    p.receivedAt >= p.time && p.receivedAt <= now);
  const openingRows = available.filter(p => p.time === frame.market.start);
  if (openingRows.length !== 1) return unavailable('exact-opening');
  const rows = available.filter(p => p.time >= now - entryPolicyProtocol.residualWindowMs).sort((a, b) => a.time - b.time);
  if (rows.length < 20 || rows[0].time > now - 55000 || now - rows.at(-1).time > 5000 ||
      now - rows.at(-1).receivedAt > 5000 || rows.some((r, i) => i && (r.time <= rows[i - 1].time || r.time - rows[i - 1].time > 5000)))
    return unavailable('continuous-60s-twap');
  const opening = e18ToPrice(openingRows[0].valueE18), values = rows.map(p => e18ToPrice(p.valueE18));
  if (!(opening > 0) || values.some(v => !(v > 0))) return unavailable('positive-twap');
  const rangeUsd = Math.max(...values) - Math.min(...values), scaleUsd = Math.max(entryPolicyProtocol.residualFloorUsd, rangeUsd);
  const displacementUsd = values.at(-1) - opening;
  // Overlapping 60s TWAP observations are correlated. This range ratio is a
  // descriptive entry filter, not a Brownian probability or a volatility z-test.
  return { ready: true, opening, current: values.at(-1), rangeUsd, scaleUsd, displacementUsd,
    standardizedResidual: displacementUsd / scaleUsd, observedAt: rows.at(-1).receivedAt,
    latestSourceAt: rows.at(-1).time, samples: rows.length, probabilityInterpretation: false };
}

function modelPrediction(model, features, causalContext, now) {
  if (model === 'market') return { pUp: features.marketProbability, knownAt: features.observedAt,
    modelId: 'raw-up-midpoint', signalVersion: valueProtocol.version };
  const c = causalContext?.[model];
  if (!c || !finite(c.asOf) || c.asOf > now || c.throughLabelKnownAt !== null &&
      (!finite(c.throughLabelKnownAt) || c.throughLabelKnownAt > c.asOf))
    return { error: 'noncausal-model-context' };
  if (model === 'fixed') {
    const a = c.artifact;
    if (!a || a.version !== valueProtocol.version || !a.model || typeof a.id !== 'string' || !a.id ||
        !finite(a.fittedAt) || a.fittedAt > c.asOf || !finite(c.trainingBoundaryAt) ||
        c.trainingBoundaryAt > a.fittedAt || !finite(c.throughLabelKnownAt) ||
        c.throughLabelKnownAt >= c.trainingBoundaryAt) return { error: 'noncausal-fixed-fit' };
    const pUp = probability(a.model, features);
    return pUp === null ? { error: 'model-domain' } : { pUp, knownAt: c.asOf, modelId: a.id,
      throughLabelKnownAt: c.throughLabelKnownAt, trainingBoundaryAt: c.trainingBoundaryAt, signalVersion: valueProtocol.version };
  }
  try {
    if (c.throughLabelKnownAt === null && (!Array.isArray(c.params) || c.params.some(p => p !== 0)))
      return { error: 'unproven-adaptive-params' };
    const d = predictAdaptive(features.marketProbability, c.params);
    return { pUp: d.q, knownAt: c.asOf, modelId: c.id ?? adaptiveProtocol.version,
      throughLabelKnownAt: c.throughLabelKnownAt, params: [...d.params], signalVersion: adaptiveProtocol.version };
  } catch { return { error: 'invalid-adaptive-params' }; }
}

/** Pure entry decision. Quoted entries are intents, never simulated fills.
 * fixed: { artifact, asOf, throughLabelKnownAt, trainingBoundaryAt }
 * adaptive: { params, asOf, throughLabelKnownAt, id? }
 * The caller certifies model construction used only labels known before its
 * chronological stage boundary. Metadata cannot certify a backdated model.
 */
export function evaluateEntryPolicy(policyId, { frame, history = [], prices = [], now,
    config = {}, strategy = {}, causalContext = {}, forwardBase = null } = {}) {
  const policy = entryPolicyCatalog.find(p => p.id === policyId);
  if (!policy) throw Error(`Unknown entry policy: ${policyId}`);
  const result = { version: entryPolicyProtocol.version, policyId, time: now, selected: null, candidates: [],
    skipCode: null, reason: '', diagnostics: { featureReady: false, missingFeatures: [], entryFiltersOnly: true },
    quoteOnly: true, actualExecutionVerified: false, paperOnly: true };
  const reject = (code, reason) => ({ ...result, skipCode: code, reason });
  if(policy.family==='value'&&frame?.market&&finite(now)&&
    (now-frame.market.start<valueProtocol.anchorMs||now-frame.market.start>valueProtocol.anchorMs+valueProtocol.windowMs))
    return reject('outside-value-window','结算概率候选只适用于本轮120至125秒');
  if (!validFrame(frame, now)) { result.diagnostics.missingFeatures.push('fresh-valid-dual-book'); return reject('invalid-frame', '当前盘口身份、深度或报价时间无效'); }
  const cfg = { staleMs: entryPolicyProtocol.staleMs, buyUnits: entryPolicyProtocol.defaultAmountUsd, ...config };
  if (cfg.staleMs !== entryPolicyProtocol.staleMs || !Number.isInteger(cfg.buyUnits) || cfg.buyUnits < 1 || cfg.buyUnits > 1000)
    return reject('invalid-execution-config', '回放需使用固定报价新鲜度和有效美元份数');
  const availablePrices = prices.filter(p => finite(p.time) && p.time <= now && finite(p.receivedAt) &&
    p.receivedAt >= p.time && p.receivedAt <= now);
  const availableHistory = history.filter(r => finite(r.time) && r.time <= now &&
    (r.receivedAt === undefined || finite(r.receivedAt) && r.receivedAt <= now));
  if (policy.family === 'forward') {
    const base = forwardBase?structuredClone(forwardBase):evaluateForward({ frame, history: availableHistory, prices: availablePrices, config: cfg,
      strategy: { ...strategyDefaults, execution: 'paper', ...strategy }, now });
    result.candidates = base.candidates;
    result.diagnostics = { ...result.diagnostics, dataQuality: base.dataQuality ?? null, featureReady: Boolean(base.dataQuality?.bookContinuous && base.dataQuality?.btcContinuous) };
    if (!base.dataQuality?.bookContinuous) result.diagnostics.missingFeatures.push('continuous-30s-book');
    if (!base.dataQuality?.btcContinuous) result.diagnostics.missingFeatures.push('continuous-30s-twap');
    if (policyId !== 'forward-control') {
      const residual = policyId === 'forward-twap-residual' ? causalTwapResidual(frame, availablePrices, now) : null;
      if (residual) {
        result.diagnostics.twapResidual = residual;
        if (!residual.ready) { result.diagnostics.featureReady = false; result.diagnostics.missingFeatures.push(residual.reason); }
      }
      for (const c of result.candidates) {
        if (!c.eligible) continue;
        const direction = c.outcome === 'Up' ? 1 : -1;
        if (c.takerPrice > entryPolicyProtocol.priceCap) { c.eligible = false; c.skipCode = 'price-cap'; c.reason = '入场平均保护价超过固定85美分上限'; }
        else if (!finite(c.btcMove30Bps) || c.btcMove30Bps * direction <= 0) { c.eligible = false; c.skipCode = 'direction-mismatch'; c.reason = 'TWAP近30秒方向与盘口动量不同'; }
        else if (residual && (!residual.ready || residual.standardizedResidual * direction < entryPolicyProtocol.residualMinimum)) {
          c.eligible = false; c.skipCode = residual.ready ? 'weak-twap-residual' : 'missing-twap-residual'; c.reason = 'TWAP开盘偏离未通过固定范围标准化条件';
        }
      }
    }
    result.selected = result.candidates.filter(c => c.eligible).sort((a, b) => b.takerEdge - a.takerEdge)[0] ?? null;
    result.reason = result.selected ? '动量入场候选通过费用与数据检查' :
      result.candidates.length ? result.candidates.map(c => `${c.outcome}：${c.reason}`).join('；') : base.reason;
    if (!result.selected) result.skipCode = result.candidates.find(c => c.skipCode)?.skipCode ?? 'no-forward-signal';
    if (result.selected) Object.assign(result.selected, { policyId, modelId: 'forward-momentum',
      signalVersion: forwardProtocol.version, forecastMadeAt: now, knownAt: now, size: result.selected.expectedFilled });
    return result;
  }
  const age = now - frame.market.start;
  if (age < valueProtocol.anchorMs || age > valueProtocol.anchorMs + valueProtocol.windowMs)
    return reject('outside-value-window', '结算概率候选只适用于本轮120至125秒');
  const features = valueFeatures(frame, availablePrices, now);
  if (!features) { result.diagnostics.missingFeatures.push('p3-opening-continuous-twap-and-books'); return reject('missing-value-features', '缺少P3固定观察特征'); }
  result.diagnostics.featureReady = true;
  const prediction = modelPrediction(policy.parameters.model, features, causalContext, now);
  if (prediction.error) { result.diagnostics.missingFeatures.push(prediction.error); return reject(prediction.error, '模型未知、越域或包含未来信息'); }
  if (!finite(prediction.pUp) || prediction.pUp <= 0 || prediction.pUp >= 1) return reject('invalid-probability', '模型未提供有效概率');
  result.diagnostics.forecast = { ...prediction, marketProbability: features.marketProbability, x: [...features.x] };
  for (const outcome of ['Up', 'Down']) {
    const book = frame.books.find(b => b.tokenId === frame.market.tokens[outcome]);
    const chance = outcome === 'Up' ? prediction.pUp : 1 - prediction.pUp;
    const c = { version: forwardProtocol.version, signalVersion: prediction.signalVersion, policyId,
      executionVersion: amountExecutionVersion, tokenId: frame.market.tokens[outcome], outcome, mode: 'taker',
      eligible: false, modelId: prediction.modelId, forecastMadeAt: now, knownAt: prediction.knownAt,
      throughLabelKnownAt: prediction.throughLabelKnownAt ?? null, probability: chance, pUp: prediction.pUp,
      scoreType: 'quoted-expected-settlement-profit-after-entry-fees', quoteOnly: true, actualExecutionVerified: false };
    result.candidates.push(c);
    let q; try { q = amountQuote(book, frame.market, cfg.buyUnits, entryPolicyProtocol.protectionCents); }
    catch { c.reason = '金额报价无效'; c.skipCode = 'invalid-amount-quote'; continue; }
    Object.assign(c, { amountUsd: q.amountUsd, orderSize: q.size, size: q.filled, expectedFilled: q.filled,
      expectedNotional: q.notional, expectedEntryFees: q.fees, makerPrice: q.best, takerPrice: q.average, limit: q.limit });
    if (!q.allowed || !q.complete) { c.reason = '入场保护范围内深度不足'; c.skipCode = 'incomplete-quote'; continue; }
    c.expectedSettlementProfit = round(q.filled * chance - q.notional - q.fees);
    c.takerEdge = round(chance - (q.notional + q.fees) / q.filled);
    c.eligible = c.expectedSettlementProfit > entryPolicyProtocol.expectedProfitEpsilon;
    c.reason = c.eligible ? '原始报价的费用后预期结算价值为正' : '费用后预期结算价值不为正';
    if (!c.eligible) c.skipCode = 'nonpositive-after-fees';
  }
  result.selected = result.candidates.filter(c => c.eligible).sort((a, b) => b.expectedSettlementProfit - a.expectedSettlementProfit)[0] ?? null;
  result.skipCode = result.selected ? null : result.candidates.find(c => c.skipCode)?.skipCode ?? 'no-value-entry';
  result.reason = result.selected ? '固定P3时点费用后价值候选通过检查' : '两个方向均无可执行的费用后正价值';
  return result;
}
