import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomic } from './atomic-json.mjs';
import { adaptiveProtocol, predictAdaptive, updateAdaptive } from './adaptive-calibration.mjs';
import { valueEconomics } from './settlement-value.mjs';
import { researchBook } from './p2-book.mjs';
import { quoteEvidenceRevision } from './settlement-value-research.mjs';
import { round } from '../paper-broker.mjs';

const finite = Number.isFinite;
const probability = p => finite(p) && p > 0 && p < 1;
const day = at => new Date(at + 28800000).toISOString().slice(0, 10);
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const updateId = n => `${adaptiveProtocol.version}:update:${n}`;

const digest = value => createHash('sha256').update(value).digest('hex');
export function adaptiveImplementation() {
  const implementationCodeHashes = Object.fromEntries(['adaptive-calibration.mjs', 'adaptive-research.mjs']
    .map(name => [name, digest(readFileSync(new URL('./' + name, import.meta.url)))]));
  return { protocolHash: digest(JSON.stringify(adaptiveProtocol)), implementationCodeHashes,
    implementationHash: digest(JSON.stringify(implementationCodeHashes)) };
}

function provenance(state) {
  return { learnerInstanceId: state.learnerInstanceId, protocolHash: state.protocolHash,
    implementationHash: state.implementationHash, implementationCodeHashes: structuredClone(state.implementationCodeHashes) };
}

function validSource(s, now, createdAt, lastUpdateAt) {
  const m = s?.market, e = s?.quoteEvidence, f = e?.frame;
  if (!s || !finite(s.at) || s.at < createdAt || s.at > now || now - s.at > adaptiveProtocol.staleMs ||
      s.at < (lastUpdateAt ?? 0) || typeof s.id !== 'string' || !s.id ||
      typeof s.modelId !== 'string' || !s.modelId || !probability(s.marketProbability) || !probability(s.pUp) ||
      !finite(s.opening) || s.opening <= 0 || s.evidenceRevision !== quoteEvidenceRevision ||
      !m || !finite(m.start) || !finite(m.end) || m.end - m.start !== 300000 ||
      s.at < m.start + adaptiveProtocol.anchorMs || s.at > m.start + adaptiveProtocol.anchorMs + adaptiveProtocol.windowMs ||
      typeof m.slug !== 'string' || !m.slug || typeof m.conditionId !== 'string' || !m.conditionId ||
      !['Up', 'Down'].every(o => typeof m.tokens?.[o] === 'string' && m.tokens[o]) || m.tokens.Up === m.tokens.Down ||
      !finite(m.tick) || m.tick <= 0 || m.tick >= 1 || !finite(m.fee?.rate) || m.fee.rate < 0 ||
      !finite(m.fee?.exponent) || m.fee.exponent < 0 || !e || e.now !== s.at ||
      !Number.isInteger(e.amountUsd) || e.amountUsd < 1 || e.amountUsd > 1000 ||
      !f || !isDeepStrictEqual(f.market, m) || !finite(f.now) || f.now > s.at || s.at - f.now > adaptiveProtocol.staleMs ||
      !Array.isArray(f.books) || f.books.length !== 2 ||
      !Array.isArray(s.sourceBookTimes) || s.sourceBookTimes.length !== 2) return null;
  const books = ['Up', 'Down'].map(o => f.books.find(b => b.tokenId === m.tokens[o]));
  for (const [i, outcome] of ['Up', 'Down'].entries()) {
    const b = books[i], times = s.sourceBookTimes.filter(t => t.tokenId === m.tokens[outcome]);
    if (!b || times.length !== 1 || b.timestamp !== times[0].sourceAt || b.receivedAt !== times[0].receivedAt ||
        !finite(b.timestamp) || !finite(b.receivedAt) || b.timestamp > b.receivedAt || b.receivedAt > f.now ||
        s.at - b.timestamp > adaptiveProtocol.staleMs || s.at - b.receivedAt > adaptiveProtocol.staleMs ||
        !researchBook(b, m, outcome, s.at).ready) return null;
  }
  const rawMid = (books[0].bids[0][0] + books[0].asks[0][0]) / 2;
  if (Math.abs(rawMid - s.marketProbability) > 1e-12) return null;
  return { books, frame: f, amountUsd: e.amountUsd };
}

function labelIdentity(l, s, now) {
  const m = s.market;
  return Boolean(l && l.slug === m.slug && l.conditionId === m.conditionId && l.start === m.start && l.end === m.end &&
    ['Up', 'Down'].every(o => l.tokens?.[o] === m.tokens[o]) && finite(l.observedAt) &&
    l.observedAt >= m.end && l.observedAt <= now && s.at < l.observedAt && finite(l.opening) &&
    ['Up', 'Down'].includes(l.winner) && [0, 1].includes(l.payouts?.Up) && [0, 1].includes(l.payouts?.Down) &&
    l.payouts.Up + l.payouts.Down === 1 && l.payouts.Up === Number(l.winner === 'Up'));
}

function quotes(frame, books, pUp, amountUsd) {
  const economics = valueEconomics(frame, { books }, pUp, amountUsd, {});
  const entries = economics.quotedEntries;
  const selected = entries.filter(q => finite(q.expectedSettlementProfit) && q.expectedSettlementProfit > 0)
    .sort((a, b) => b.expectedSettlementProfit - a.expectedSettlementProfit || lexical(a.outcome, b.outcome))[0] ?? null;
  return { quotedEntries: entries, selected, quoteOnly: true, actualExecutionVerified: false,
    executionLatencyModeled: false, capitalOccupancyModeled: false, settlementCostsModeled: false };
}

function validateState(state, implementation) {
  if (state?.version !== adaptiveProtocol.version || !finite(state.createdAt) || state.createdAt < 0 ||
      !Number.isInteger(state.updates) || state.updates < 0 || !state.samples || Array.isArray(state.samples) ||
      !Array.isArray(state.pending)) throw Error('Unsupported or invalid adaptive study state; preserve original research');
  if (!isDeepStrictEqual(state.protocol, adaptiveProtocol) || state.protocolHash !== implementation.protocolHash ||
      state.implementationHash !== implementation.implementationHash ||
      !isDeepStrictEqual(state.implementationCodeHashes, implementation.implementationCodeHashes) ||
      typeof state.learnerInstanceId !== 'string' || !state.learnerInstanceId)
    throw Error('Adaptive protocol or implementation differs; isolate and preserve original research');
  predictAdaptive(.5, state.params);
  if (state.updates === 0 && (state.lastUpdateAt !== null || state.throughLabelKnownAt !== null ||
      !isDeepStrictEqual(state.params, adaptiveProtocol.initialParams))) throw Error('Invalid initial learner checkpoint');
  for (const [slug, s] of Object.entries(state.samples)) {
    const p = predictAdaptive(s.marketProbability, s.params);
    if (slug !== s.market?.slug || !finite(s.at) || s.at < state.createdAt || !probability(s.pUp) ||
        !probability(s.marketProbability) || !probability(s.fixedPUp) || !Number.isInteger(s.updatesAtForecast) ||
        s.updatesAtForecast < 0 || s.updatesAtForecast > state.updates || s.updateId !== updateId(s.updatesAtForecast) ||
        p.q !== s.pUp || p.z !== s.z || s.sourceModelId !== state.sourceModelId ||
        !isDeepStrictEqual(s.provenance, provenance(state)) ||
        s.throughLabelKnownAt !== null && (!finite(s.throughLabelKnownAt) || s.throughLabelKnownAt > s.at))
      throw Error('Invalid immutable adaptive forecast');
    if (s.label && (!labelIdentity(s.label, s, state.lastUpdateAt) ||
        s.label.y !== s.label.payouts.Up || Math.abs(s.label.opening - s.opening) > .00001))
      throw Error('Invalid adaptive label identity or known-time checkpoint');
  }
  const labeled = Object.values(state.samples).filter(s => s.label);
  if (labeled.length !== state.updates) throw Error('Adaptive label count differs from update checkpoint');
  if (state.updates && (!finite(state.lastUpdateAt) || state.lastUpdateAt < state.createdAt ||
      state.throughLabelKnownAt !== Math.max(...labeled.map(s => s.label.observedAt)) ||
      state.throughLabelKnownAt > state.lastUpdateAt)) throw Error('Invalid adaptive update time checkpoint');
}

export class AdaptiveResearch {
  constructor(directory, { createdAt = Date.now() } = {}) {
    if (!finite(createdAt) || createdAt < 0) throw Error('Invalid adaptive study creation time');
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, 'p3-adaptive.json');
    this.journal = join(directory, 'p3-adaptive.jsonl');
    this.error = null;
    const restored = existsSync(this.path);
    const implementation = adaptiveImplementation();
    this.state = restored ? JSON.parse(readFileSync(this.path, 'utf8')) : {
      version: adaptiveProtocol.version, createdAt, startedAt: null, params: [...adaptiveProtocol.initialParams],
      updates: 0, lastUpdateAt: null, throughLabelKnownAt: null, samples: {}, pending: [],
      protocol: structuredClone(adaptiveProtocol), ...implementation, learnerInstanceId: randomUUID(), sourceModelId: null,
    };
    validateState(this.state, implementation);
    this.written = new Set(existsSync(this.journal) ? readFileSync(this.journal, 'utf8').split('\n').filter(Boolean)
      .map(s => JSON.parse(s).id) : []);
    if (!restored) writeJsonAtomic(this.path, this.state);
    this.flush();
  }

  flush() {
    for (const event of this.state.pending) if (!this.written.has(event.id)) {
      appendFileSync(this.journal, JSON.stringify(event) + '\n');
      this.written.add(event.id);
    }
    this.state.pending = [];
  }

  observe({ now, sourceSamples = {}, sessionId = null, experimentId = null } = {}, labels = new Map()) {
    if (this.error) return;
    if (!finite(now) || now < this.state.createdAt || now < (this.state.lastUpdateAt ?? 0))
      throw Error('Invalid or regressed adaptive observation time');
    const next = structuredClone(this.state), events = [];
    // Forecast first, then update from available verified outcomes. A source that
    // was already observed before this study started is never retrospectively scored.
    const sources = Object.values(sourceSamples).sort((a, b) => (a?.at ?? 0) - (b?.at ?? 0) || lexical(a?.id ?? '', b?.id ?? ''));
    for (const source of sources) {
      if (next.samples[source?.market?.slug]) continue;
      const valid = validSource(source, now, next.createdAt, next.lastUpdateAt);
      if (!valid) continue;
      if (next.sourceModelId !== null && source.modelId !== next.sourceModelId)
        throw Error('Fixed comparison model changed; isolate and preserve original adaptive study');
      next.sourceModelId ??= source.modelId;
      const p = predictAdaptive(source.marketProbability, next.params), m = source.market;
      const sample = {
        id: `${adaptiveProtocol.version}:${m.slug}:forecast`, version: adaptiveProtocol.version,
        at: source.at, ingestedAt: now, day: day(source.at), market: structuredClone(m), opening: source.opening,
        pUp: p.q, marketProbability: source.marketProbability, fixedPUp: source.pUp, z: p.z,
        params: [...next.params], updateId: updateId(next.updates), updatesAtForecast: next.updates,
        throughLabelKnownAt: next.throughLabelKnownAt, sourceSampleId: source.id, sourceModelId: source.modelId,
        sessionId, experimentId, evidenceRevision: source.evidenceRevision,
        provenance: provenance(next),
        sourceBookTimes: structuredClone(source.sourceBookTimes), quoteEvidence: structuredClone(source.quoteEvidence),
        quotes: {
          market: quotes(valid.frame, valid.books, source.marketProbability, valid.amountUsd),
          fixed: quotes(valid.frame, valid.books, source.pUp, valid.amountUsd),
          adaptive: quotes(valid.frame, valid.books, p.q, valid.amountUsd),
        },
        label: null, diagnosticOnly: true, actualExecutionVerified: false,
      };
      next.samples[m.slug] = sample;
      next.startedAt ??= source.at;
      events.push({ id: sample.id, kind: 'forecast', at: now, sample: structuredClone(sample) });
    }
    const eligible = [];
    for (const sample of Object.values(next.samples)) {
      const l = labels.get(sample.market.slug);
      if (!labelIdentity(l, sample, now)) continue;
      if (sample.label) {
        if (l.winner !== sample.label.winner || l.payouts.Up !== sample.label.y ||
            Math.abs(l.opening - sample.label.opening) > .00001)
          throw Error('Verified adaptive outcome contradicted an existing label');
        continue;
      }
      if (Math.abs(l.opening - sample.opening) <= .00001) eligible.push({ sample, label: l });
    }
    eligible.sort((a, b) => a.label.observedAt - b.label.observedAt || lexical(a.sample.market.slug, b.sample.market.slug));
    for (const { sample, label: l } of eligible) {
      const before = [...next.params], y = l.payouts.Up;
      const after = updateAdaptive(before, { q: sample.pUp, z: sample.z, y });
      sample.label = {
        slug: l.slug, conditionId: l.conditionId, start: l.start, end: l.end, tokens: structuredClone(l.tokens),
        winner: l.winner, y, payouts: structuredClone(l.payouts), opening: l.opening, observedAt: l.observedAt,
      };
      next.params = after;
      next.updates++;
      next.lastUpdateAt = now;
      next.throughLabelKnownAt = Math.max(next.throughLabelKnownAt ?? 0, l.observedAt);
      events.push({ id: sample.id + ':label', kind: 'resolved', at: now, sampleId: sample.id,
        forecastAt: sample.at, label: structuredClone(sample.label) });
      events.push({ id: updateId(next.updates), kind: 'model-update', at: now, update: next.updates,
        provenance: provenance(next),
        sampleId: sample.id, sourceSampleId: sample.sourceSampleId, knownAt: l.observedAt,
        q: sample.pUp, z: sample.z, y, residual: y - sample.pUp,
        beforeParams: before, afterParams: [...after], throughLabelKnownAt: next.throughLabelKnownAt });
    }
    if (!events.length) return;
    next.pending.push(...events);
    writeJsonAtomic(this.path, next);
    this.state = next;
    this.flush();
  }

  summary() {
    const samples = Object.values(this.state.samples), labeled = samples.filter(s => s.label);
    const benchmarks = Object.fromEntries(['market', 'fixed', 'adaptive'].map(name => {
      const probabilityKey = { market: 'marketProbability', fixed: 'fixedPUp', adaptive: 'pUp' }[name];
      const selected = samples.filter(s => s.quotes[name].selected), known = selected.filter(s => s.label);
      const sum = xs => round(xs.reduce((a, x) => a + x, 0));
      return [name, {
        brier: labeled.length ? labeled.reduce((s, x) => s + (x[probabilityKey] - x.label.y) ** 2, 0) / labeled.length : null,
        selected: selected.length, known: known.length, unknown: selected.length - known.length,
        quotedNet: known.length ? sum(known.map(s => {
          const q = s.quotes[name].selected;
          return q.size * (q.outcome === 'Up' ? s.label.y : 1 - s.label.y) - q.quotedCost;
        })) : null,
        predictedNet: sum(selected.map(s => s.quotes[name].selected.expectedSettlementProfit)),
        knownPredictedNet: known.length ? sum(known.map(s => s.quotes[name].selected.expectedSettlementProfit)) : null,
        quotedWins: known.filter(s => {
          const q = s.quotes[name].selected;
          return q.size * (q.outcome === 'Up' ? s.label.y : 1 - s.label.y) - q.quotedCost > 0;
        }).length,
        quoteOnly: true, actualExecutionVerified: false,
      }];
    }));
    return structuredClone({
      version: adaptiveProtocol.version, protocol: adaptiveProtocol,
      ...provenance(this.state), sourceModelId: this.state.sourceModelId,
      createdAt: this.state.createdAt, startedAt: this.state.startedAt, params: this.state.params,
      updates: this.state.updates, lastUpdateAt: this.state.lastUpdateAt, throughLabelKnownAt: this.state.throughLabelKnownAt,
      forecasts: samples.length, labeled: labeled.length, pending: samples.length - labeled.length,
      dates: new Set(samples.map(s => s.day)).size, labeledDates: new Set(labeled.map(s => s.day)).size,
      benchmarks, latest: samples.at(-1) ?? null, error: this.error,
      realTrading: false, diagnosticOnly: true, changesTradingRules: false, autoTradingEnabled: false,
      promotion: { status: 'collecting', eligible: false }, accountReturn: null,
      scope: 'Causal probability and quote-only economic diagnostics; no simulated fills, account profit, or permission to trade.',
      limitations: ['No execution delay, finite capital path, settlement costs or independent uncertainty interval.',
        'One forecast per distinct market round; adjacent rounds are not assumed statistically independent.',
        'Predictions remain fixed after labels and model updates; no regret or profitability guarantee is claimed.',
        'Higher win rate or improved Brier alone does not establish after-cost trading profit.'],
    });
  }
}
