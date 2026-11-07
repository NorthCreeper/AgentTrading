import { depthQuote, freshBook } from './strategy.mjs';
import { e18ToPrice } from './chart-model.mjs';
import { amountQuote, amountExecutionVersion } from '../amount-order.mjs';

export const settlementProtocol = Object.freeze({ version: 'settlement-probability-v1', size: 5,
  entryAgeMs: 120_000, entryWindowMs: 5000, staleMs: 3000, maxSpread: .04,
  minEdge: .03, buffer: .01, probabilityHaircut: .03, ridge: 20, maxLogitCorrection: .75,
  minTrainingRounds: 30, minValidationRounds: 15, minDiagnosticRounds: 15, minTrades: 10 });
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = x => 1 / (1 + Math.exp(-clamp(x, -30, 30)));
const logit = p => Math.log(p / (1 - p));

export function settlementFeatures(frame, prices, now = frame.now) {
  const age = now - frame.market.start, cfg = settlementProtocol;
  if (age < cfg.entryAgeMs || age > cfg.entryAgeMs + cfg.entryWindowMs || frame.now > now || now - frame.now > cfg.staleMs || frame.market.minSize > cfg.size)
    return null;
  const available = prices.filter(p => p.time <= now && Number.isFinite(p.receivedAt) && p.receivedAt <= now);
  const opening = available.find(p => p.time === frame.market.start);
  if (!opening) return null;
  const ps = available.filter(p => p.time >= now - 60_000).sort((a, b) => a.time - b.time);
  if (ps.length < 20 || ps[0].time > now - 55_000 || now - ps.at(-1).time > 5000 ||
      now - ps.at(-1).receivedAt > 5000 || ps.some((p, i) => i && (p.time <= ps[i - 1].time || p.time - ps[i - 1].time > 5000))) return null;
  const values = ps.map(p => e18ToPrice(p.valueE18)), base = e18ToPrice(opening.valueE18);
  if (!base || values.some(v => !v)) return null;
  const books = ['Up', 'Down'].map(o => frame.books.find(b => b.tokenId === frame.market.tokens[o]));
  if (books.some(b => !freshBook(b, now, cfg.staleMs) || !b.bids.length || !b.asks.length ||
      b.asks[0][0] - b.bids[0][0] > cfg.maxSpread || b.asks[0][0] <= b.bids[0][0])) return null;
  const mid = books.map(b => (b.bids[0][0] + b.asks[0][0]) / 2);
  const marketProbability = clamp(mid[0] / (mid[0] + mid[1]), .01, .99);
  const last = values.at(-1), p30 = ps.findLastIndex(p => p.time <= now - 30_000);
  if (p30 < 0) return null;
  const variance = values.slice(1).reduce((s, v, i) => s + (Math.log(v / values[i]) * 10000) ** 2 / ((ps[i + 1].time - ps[i].time) / 1000), 0) / (values.length - 1);
  // TWAP variance is a feature, not a Brownian-motion claim about true settlement probability.
  const distance = Math.log(last / base) * 10000, trend = Math.log(last / values[p30]) * 10000;
  const volatility = Math.sqrt(variance), remaining = (frame.market.end - now) / 1000;
  const x = [clamp(distance / Math.max(1, volatility * Math.sqrt(remaining)), -10, 10), trend, volatility];
  return { x, marketProbability, opening: base, observedAt: now, books };
}

// Fixed, small correction to the market's probability. One training observation per round.
export function fitProbability(samples) {
  if (samples.length < settlementProtocol.minTrainingRounds || new Set(samples.map(s => s.slug)).size !== samples.length ||
      !samples.some(s => s.y === 0) || !samples.some(s => s.y === 1)) return null;
  const n = 3, mean = Array(n).fill(0), scale = Array(n).fill(0), weights = Array(n + 1).fill(0);
  for (const s of samples) for (let j = 0; j < n; j++) mean[j] += s.x[j] / samples.length;
  for (const s of samples) for (let j = 0; j < n; j++) scale[j] += (s.x[j] - mean[j]) ** 2 / samples.length;
  for (let j = 0; j < n; j++) scale[j] = Math.sqrt(scale[j]) || 1;
  const rows = samples.map(s => ({ z: [1, ...s.x.map((v, j) => (v - mean[j]) / scale[j])], y: s.y, offset: logit(s.marketProbability) }));
  for (let step = 0; step < 1200; step++) {
    const gradient = weights.map(w => settlementProtocol.ridge * w / rows.length);
    for (const r of rows) {
      const error = sigmoid(r.offset + r.z.reduce((s, z, j) => s + z * weights[j], 0)) - r.y;
      for (let j = 0; j <= n; j++) gradient[j] += error * r.z[j] / rows.length;
    }
    for (let j = 0; j <= n; j++) weights[j] -= .05 * gradient[j];
  }
  return { mean, scale, weights };
}
export function probability(model, features) {
  if (!model || model.mean?.length !== 3 || model.scale?.length !== 3 || model.weights?.length !== 4 ||
      ![...model.mean, ...model.scale, ...model.weights, ...features.x, features.marketProbability].every(Number.isFinite) ||
      model.scale.some(v => v <= 0) || features.x.length !== 3 || features.marketProbability <= 0 || features.marketProbability >= 1) return null;
  const z = features.x.map((v, j) => (v - model.mean[j]) / model.scale[j]);
  if (z.some(v => Math.abs(v) > 6)) return null;
  const correction = clamp(model.weights[0] + z.reduce((s, v, j) => s + v * model.weights[j + 1], 0),
    -settlementProtocol.maxLogitCorrection, settlementProtocol.maxLogitCorrection);
  return sigmoid(logit(features.marketProbability) + correction);
}
export function settlementDecision(frame, prices, artifact, now = frame.now, { amountUsd } = {}) {
  const result = { version: settlementProtocol.version, time: now, modelId: artifact?.id ?? null,
    pUp: null, marketProbability: null, candidate: null, reason: '等待本轮第 120 秒及准确开盘采样' };
  const age = now - frame.market.start;
  if (age > settlementProtocol.entryAgeMs + settlementProtocol.entryWindowMs) {
    result.reason = '本轮固定观察窗口已结束；等待下一轮，不追单'; return result;
  }
  const f = settlementFeatures(frame, prices, now);
  if (!f) {
    if (age >= settlementProtocol.entryAgeMs) result.reason = '观察窗口内数据不足：核对准确开盘、连续 TWAP、盘口新鲜度及价差';
    return result;
  }
  result.marketProbability = f.marketProbability;
  if (!artifact?.model) { result.reason = '完整标注轮次不足，暂不输出模型胜率'; return result; }
  if (frame.market.fee.rate !== artifact.fee?.rate || frame.market.fee.exponent !== artifact.fee?.exponent) {
    result.reason = '费用规则不在训练适用范围'; return result;
  }
  const p = probability(artifact.model, f); result.pUp = p;
  if (p === null) { result.reason = '特征超出训练范围或模型无效'; return result; }
  const candidates = ['Up', 'Down'].map((outcome, i) => {
    const q = amountUsd === undefined ? depthQuote(f.books[i], 'buy', settlementProtocol.size, frame.market) : amountQuote(f.books[i], frame.market, amountUsd);
    if(amountUsd !== undefined && !q.allowed) return null;
    if (!q?.complete) return null;
    const chance = i ? 1 - p : p;
    const size=amountUsd === undefined ? settlementProtocol.size : q.filled;
    return { executionVersion:amountUsd===undefined?null:amountExecutionVersion, outcome, tokenId: frame.market.tokens[outcome], probability: chance, size, amountUsd,
      cost: q.notional, fees: q.fees, limit: q.limit ?? q.worst,
      edge: chance - (q.notional + q.fees) / size - settlementProtocol.buffer - settlementProtocol.probabilityHaircut };
  }).filter(c => c && Number.isFinite(c.edge) && c.edge >= settlementProtocol.minEdge);
  result.candidate = candidates.sort((a, b) => b.edge - a.edge)[0] ?? null;
  result.reason = result.candidate ? '仅结算影子候选：未向交易账户提交订单' : '扣费并扣除误差余量后，没有足够优势';
  return result;
}
