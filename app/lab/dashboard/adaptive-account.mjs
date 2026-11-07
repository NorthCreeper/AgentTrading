import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomic } from './atomic-json.mjs';
import { PaperBroker, round } from '../paper-broker.mjs';
import { amountQuote } from '../amount-order.mjs';
import { researchBook } from './p2-book.mjs';
import { depthQuote } from './strategy.mjs';
import { predictAdaptive, adaptiveProtocol } from './adaptive-calibration.mjs';
import { quoteEvidenceRevision } from './settlement-value-research.mjs';

// This registration was fixed before collection. Changes require a separate study.
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export const adaptiveAccountProtocol = deepFreeze({ ...JSON.parse(readFileSync(
  new URL('../research/p3-adaptive-account-20261001/pre-registration.json', import.meta.url), 'utf8')),
  pausePendingBeforeExecution: true });
const P = adaptiveAccountProtocol, finite = Number.isFinite;
const probability = p => finite(p) && p > 0 && p < 1;
const digest = text => createHash('sha256').update(text).digest('hex');
const day = at => new Date(at + 28800000).toISOString().slice(0, 10);
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-7;
const clone = structuredClone;

export function adaptiveAccountImplementation() {
  const files = ['./adaptive-account.mjs', '../paper-broker.mjs', '../amount-order.mjs',
    './p2-book.mjs', './strategy.mjs', './atomic-json.mjs', './adaptive-calibration.mjs', './settlement-value-research.mjs'];
  const implementationCodeHashes = Object.fromEntries(files.map(file => [file,
    digest(readFileSync(new URL(file, import.meta.url)))]));
  return { protocolHash: digest(JSON.stringify(P)), implementationCodeHashes,
    implementationHash: digest(JSON.stringify(implementationCodeHashes)) };
}

function validMarket(m) {
  return Boolean(m && typeof m.slug === 'string' && m.slug && typeof m.conditionId === 'string' && m.conditionId &&
    finite(m.start) && finite(m.end) && m.end - m.start === 300000 &&
    ['Up', 'Down'].every(o => typeof m.tokens?.[o] === 'string' && m.tokens[o]) && m.tokens.Up !== m.tokens.Down &&
    finite(m.tick) && m.tick > 0 && m.tick < 1 && finite(m.fee?.rate) && m.fee.rate >= 0 &&
    finite(m.fee?.exponent) && m.fee.exponent >= 0);
}
function binding(s) {
  return { learnerInstanceId: s.provenance?.learnerInstanceId, protocolHash: s.provenance?.protocolHash,
    implementationHash: s.provenance?.implementationHash, sourceModelId: s.sourceModelId };
}
function validateBinding(b) {
  return Boolean(typeof b.learnerInstanceId === 'string' && b.learnerInstanceId &&
    typeof b.sourceModelId === 'string' && b.sourceModelId &&
    b.protocolHash === P.sourceImplementation.protocolHash &&
    b.implementationHash === P.sourceImplementation.implementationHash);
}
function frameBooks(f, market, now) {
  if (!validMarket(market) || !f || !isDeepStrictEqual(f.market, market) || !finite(f.now) ||
      f.now > now || now - f.now > P.sourceFreshMs || !Array.isArray(f.books) || f.books.length !== 2) return null;
  const books = ['Up', 'Down'].map(o => f.books.find(b => b.tokenId === market.tokens[o]));
  if (!books.every((b, i) => b && finite(b.timestamp) && finite(b.receivedAt) &&
      b.timestamp <= b.receivedAt && b.receivedAt <= f.now &&
      researchBook(b, market, ['Up', 'Down'][i], now).bookObserved)) return null;
  return books;
}
function sourceReady(s, now, createdAt) {
  const m = s?.market, f = s?.quoteEvidence?.frame;
  if (!s || !finite(s.at) || s.at < createdAt || s.at > now || now - s.at > P.sourceFreshMs ||
      !validMarket(m) || s.at < m.start + P.anchorMs || s.at > m.start + P.anchorMs + P.forecastWindowMs ||
      typeof s.id !== 'string' || !s.id || s.version !== adaptiveProtocol.version ||
      !probability(s.pUp) || !probability(s.marketProbability) || !probability(s.fixedPUp) ||
      !finite(s.opening) || s.opening <= 0 || s.evidenceRevision !== quoteEvidenceRevision ||
      !Number.isInteger(s.updatesAtForecast) || s.updatesAtForecast < 0 ||
      s.updateId !== `${adaptiveProtocol.version}:update:${s.updatesAtForecast}` ||
      s.throughLabelKnownAt !== null && (!finite(s.throughLabelKnownAt) || s.throughLabelKnownAt > s.at) ||
      !finite(s.ingestedAt) || s.ingestedAt < s.at || s.ingestedAt > now ||
      !f || !isDeepStrictEqual(f.market, m) || !finite(f.now) || f.now > s.at || s.at - f.now > P.sourceFreshMs ||
      s.quoteEvidence.now !== s.at || !Array.isArray(f.books) || f.books.length !== 2 ||
      !Array.isArray(s.sourceBookTimes) || s.sourceBookTimes.length !== 2) return null;
  let predicted; try { predicted = predictAdaptive(s.marketProbability, s.params); } catch { return null; }
  if (predicted.q !== s.pUp || predicted.z !== s.z) return null;
  const books = frameBooks(f, m, s.at);
  if (!books) return null;
  for (const [i, outcome] of ['Up', 'Down'].entries()) {
    const b = books[i], times = s.sourceBookTimes.filter(t => t.tokenId === m.tokens[outcome]);
    if (!b || times.length !== 1 || b.timestamp !== times[0].sourceAt || b.receivedAt !== times[0].receivedAt ||
        !researchBook(b, m, outcome, s.at).ready || b.receivedAt > f.now) return null;
  }
  if (!close((books[0].bids[0][0] + books[0].asks[0][0]) / 2, s.marketProbability)) return null;
  return { frame: f, books };
}
function verifiedLabel(l, record, now) {
  const m = record.market;
  return Boolean(l && l.slug === m.slug && l.conditionId === m.conditionId && l.start === m.start && l.end === m.end &&
    ['Up', 'Down'].every(o => l.tokens?.[o] === m.tokens[o]) && finite(l.observedAt) &&
    l.observedAt >= m.end && l.observedAt <= now && finite(l.opening) && close(l.opening, record.opening) &&
    ['Up', 'Down'].includes(l.winner) && [0, 1].includes(l.payouts?.Up) && [0, 1].includes(l.payouts?.Down) &&
    l.payouts.Up + l.payouts.Down === 1 && l.payouts.Up === Number(l.winner === 'Up'));
}
function normalizedLabel(l) {
  return { slug: l.slug, conditionId: l.conditionId, tokens: clone(l.tokens), start: l.start, end: l.end,
    opening: l.opening, winner: l.winner, payouts: clone(l.payouts), observedAt: l.observedAt };
}
function duration(p, now) {
  const until = Math.max(p.enteredAt, now);
  return { occupiedMs: until - p.enteredAt,
    tradableMs: Math.max(0, Math.min(until, p.market.end) - p.enteredAt),
    waitMs: Math.max(0, until - Math.max(p.enteredAt, p.market.end)) };
}
function initialAccount(model, initialCapital) {
  return { id: `${model}-${initialCapital}`, model, initialCapital, cash: initialCapital, realizedPnl: 0,
    spent: 0, received: 0, closedCost: 0, fees: 0, completed: 0, wins: 0,
    occupiedMs: 0, tradableMs: 0, waitMs: 0, pendingOrderMs: 0, unfilled: 0, partial: 0,
    attempts: 0, dispositions: {}, position: null, pendingOrder: null };
}
function validateState(s, implementation) {
  if (s?.version !== P.version || !finite(s.createdAt) || !finite(s.lastAt) || s.lastAt < s.createdAt ||
      !Array.isArray(s.accounts) || !s.processed || Array.isArray(s.processed) || !Array.isArray(s.pending))
    throw Error('Invalid adaptive account state; preserve original evidence');
  if (!isDeepStrictEqual(s.protocol, P) || s.protocolHash !== implementation.protocolHash ||
      s.implementationHash !== implementation.implementationHash ||
      !isDeepStrictEqual(s.implementationCodeHashes, implementation.implementationCodeHashes) ||
      typeof s.instanceId !== 'string' || !s.instanceId || s.sourceBinding !== null && !validateBinding(s.sourceBinding))
    throw Error('Adaptive account version or source binding changed; isolate original evidence');
  const ids = P.models.flatMap(model => P.initialCapitals.map(capital => `${model}-${capital}`));
  if (s.accounts.length !== ids.length || !ids.every(id => s.accounts.filter(a => a.id === id).length === 1))
    throw Error('Invalid six-account identity');
  for (const a of s.accounts) {
    if (a.id !== `${a.model}-${a.initialCapital}` || !P.models.includes(a.model) || !P.initialCapitals.includes(a.initialCapital) ||
        !['cash', 'spent', 'received', 'closedCost', 'fees', 'occupiedMs', 'tradableMs', 'waitMs', 'pendingOrderMs']
          .every(k => finite(a[k]) && a[k] >= -1e-8) || !finite(a.realizedPnl) ||
        !['completed', 'wins', 'unfilled', 'partial', 'attempts'].every(k => Number.isInteger(a[k]) && a[k] >= 0) ||
        a.wins > a.completed || a.position && a.pendingOrder ||
        !close(a.cash, a.initialCapital - a.spent + a.received) ||
        !close(a.realizedPnl, a.received - a.closedCost) ||
        !close(a.spent, a.closedCost + (a.position?.cost ?? 0)) ||
        !close(a.occupiedMs, a.tradableMs + a.waitMs)) throw Error('Invalid adaptive account financial checkpoint');
    for (const p of [a.position, a.pendingOrder].filter(Boolean)) {
      const r = s.processed[p.slug];
      const up = r && { market: r.forecast.marketProbability, fixed: r.forecast.fixedPUp, adaptive: r.forecast.pUp }[a.model];
      if (!r || !validMarket(p.market) || !isDeepStrictEqual(p.market, r.market) ||
          p.opening !== r.opening || p.sourceId !== r.sourceId || !isDeepStrictEqual(p.sourceBinding, s.sourceBinding) ||
          !['Up', 'Down'].includes(p.outcome) || !probability(p.chance) || !finite(p.limit) ||
          p.chance !== (p.outcome === 'Up' ? up : 1 - up) ||
          !isDeepStrictEqual(p.forecast, r.forecast) || r.dispositions[a.id] !== (a.position ? p.disposition : 'pending'))
        throw Error('Invalid adaptive position or pending forecast binding');
    }
    if (a.position && (!(a.position.size > 0) || !finite(a.position.enteredAt) || a.position.enteredAt > s.lastAt ||
        !close(a.position.cost, a.position.notional + a.position.fees))) throw Error('Invalid held financial identity');
    if (a.pendingOrder && (a.pendingOrder.dueAt !== a.pendingOrder.requestedAt + P.latencyMs ||
        a.pendingOrder.deadlineAt !== a.pendingOrder.dueAt + P.executionWindowMs)) throw Error('Invalid pending execution window');
    const records = Object.values(s.processed), closed = records.flatMap(r => r.settlements?.[a.id] ? [r.settlements[a.id]] : []);
    if (a.completed !== closed.length || a.wins !== closed.filter(c => c.pnl > 0).length ||
        a.attempts !== records.filter(r => r.attempted?.includes(a.id)).length)
      throw Error('Account event counts differ from round checkpoint');
    const sum = key => round(closed.reduce((total, c) => total + c[key], 0));
    if (!close(a.closedCost, sum('cost')) || !close(a.received, sum('payout')) ||
        !close(a.fees, sum('fees') + (a.position?.fees ?? 0)) ||
        !['occupiedMs', 'tradableMs', 'waitMs'].every(key => close(a[key], sum(key))))
      throw Error('Financial aggregates differ from verified settlements');
    const counts = {};
    for (const r of records) { const status = r.dispositions[a.id]; if (status && status !== 'pending') counts[status] = (counts[status] ?? 0) + 1; }
    if (!isDeepStrictEqual(a.dispositions, counts)) throw Error('Account dispositions differ from independent rounds');
  }
  for (const [slug, r] of Object.entries(s.processed)) {
    if (slug !== r.market?.slug || !validMarket(r.market) || !finite(r.at) || r.at < s.createdAt ||
        !isDeepStrictEqual(r.sourceBinding, s.sourceBinding) || !finite(r.opening) ||
        !ids.every(id => typeof r.dispositions[id] === 'string') ||
        r.label && !verifiedLabel(r.label, r, s.lastAt)) throw Error('Invalid processed-round identity');
    const forecast = r.forecast;
    let predicted; try { predicted = predictAdaptive(forecast.marketProbability, forecast.params); } catch { throw Error('Invalid frozen probability parameters'); }
    if (predicted.q !== forecast.pUp || predicted.z !== forecast.z || !probability(forecast.fixedPUp) ||
        !Number.isInteger(forecast.updatesAtForecast) || forecast.updatesAtForecast < 0 ||
        forecast.updateId !== `${adaptiveProtocol.version}:update:${forecast.updatesAtForecast}` ||
        forecast.sourceModelId !== s.sourceBinding.sourceModelId ||
        forecast.throughLabelKnownAt !== null && (!finite(forecast.throughLabelKnownAt) || forecast.throughLabelKnownAt > r.at))
      throw Error('Invalid frozen forecast version or knowledge time');
    for (const c of Object.values(r.settlements)) {
      if (!r.label || !['Up', 'Down'].includes(c.outcome) || !(c.size > 0) ||
          !close(c.cost, c.notional + c.fees) || !close(c.payout, c.size * r.label.payouts[c.outcome]) ||
          !close(c.pnl, c.payout - c.cost) || !finite(c.enteredAt) || c.enteredAt < r.receivedAt ||
          !finite(c.closedAt) || c.closedAt < r.label.observedAt || c.closedAt > s.lastAt ||
          !isDeepStrictEqual({ occupiedMs: c.occupiedMs, tradableMs: c.tradableMs, waitMs: c.waitMs },
            duration({ enteredAt: c.enteredAt, market: r.market }, c.closedAt)))
        throw Error('Invalid settled financial or time identity');
    }
  }
}

export class AdaptiveAccountStudy {
  constructor(directory, { createdAt = Date.now() } = {}) {
    if (!finite(createdAt) || createdAt < 0) throw Error('Invalid adaptive account activation time');
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, 'p3-adaptive-account.json');
    this.journal = join(directory, 'p3-adaptive-account.jsonl');
    this.error = null; this.lastFrame = null;
    const implementation = adaptiveAccountImplementation(), restored = existsSync(this.path);
    this.state = restored ? JSON.parse(readFileSync(this.path, 'utf8')) : {
      version: P.version, protocol: clone(P), ...implementation, instanceId: randomUUID(),
      createdAt, startedAt: null, lastAt: createdAt, sourceBinding: null, processed: {}, pending: [],
      accounts: P.models.flatMap(model => P.initialCapitals.map(capital => initialAccount(model, capital))),
    };
    validateState(this.state, implementation);
    this.lastNow = this.state.lastAt;
    this.written = new Set(existsSync(this.journal) ? readFileSync(this.journal, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line).id) : []);
    if (!restored) writeJsonAtomic(this.path, this.state);
    this.flush();
  }
  flush() {
    for (const event of this.state.pending) if (!this.written.has(event.id)) {
      appendFileSync(this.journal, JSON.stringify(event) + '\n'); this.written.add(event.id);
    }
    this.state.pending = [];
  }
  observe({ now, frame = null, sourceSamples = {}, allowEntry = true, sessionId = null, experimentId = null } = {}, labels = new Map()) {
    if (this.error) return;
    if (!finite(now) || now < this.state.createdAt || now < this.lastNow) throw Error('Invalid or regressed adaptive account clock');
    this.lastNow = now;
    if (frameBooks(frame, frame?.market, now)) this.lastFrame = clone(frame);
    let next = null;
    const events = [], mutable = () => next ??= clone(this.state);
    const event = (id, kind, details) => events.push({ id, kind, at: now, ...details });
    // Resolutions do not depend on an active quote frame or on current entry permission.
    for (const r of Object.values(this.state.processed)) {
      const l = labels.get(r.market.slug);
      if (!verifiedLabel(l, r, now)) continue;
      if (r.label && (l.winner !== r.label.winner || !isDeepStrictEqual(l.payouts, r.label.payouts)))
        throw Error('Official adaptive account settlement contradicted existing evidence');
      const holders = (next ?? this.state).accounts.filter(a => a.position?.slug === r.market.slug);
      if (!holders.length) continue;
      const n = mutable(), saved = n.processed[r.market.slug];
      saved.label ??= normalizedLabel(l); saved.settlements ??= {};
      for (const old of holders) {
        const a = n.accounts.find(x => x.id === old.id), p = a.position;
        const payout = round(p.size * l.payouts[p.outcome]), pnl = round(payout - p.cost), times = duration(p, now);
        a.cash = round(a.cash + payout); a.received = round(a.received + payout);
        a.closedCost = round(a.closedCost + p.cost); a.realizedPnl = round(a.realizedPnl + pnl);
        a.completed++; if (pnl > 0) a.wins++;
        for (const k of ['occupiedMs', 'tradableMs', 'waitMs']) a[k] += times[k];
        saved.settlements[a.id] = { payout, pnl, cost: p.cost, notional: p.notional, fees: p.fees,
          size: p.size, outcome: p.outcome, enteredAt: p.enteredAt, closedAt: now, ...times };
        event(`${P.version}:${r.market.slug}:${a.id}:settled`, 'settled', { accountId: a.id,
          position: clone(p), label: clone(saved.label), payout, pnl, cashAfter: a.cash, ...times });
        a.position = null;
      }
    }
    const finish = (account, status, details = {}) => {
      const n = mutable(), a = n.accounts.find(x => x.id === account.id), p = a.pendingOrder;
      n.processed[p.slug].dispositions[a.id] = status;
      a.dispositions[status] = (a.dispositions[status] ?? 0) + 1;
      a.pendingOrderMs += Math.max(0, now - p.requestedAt);
      if (!['filled', 'partial-filled'].includes(status)) a.unfilled++;
      if (status === 'partial-filled') a.partial++;
      event(`${P.version}:${p.slug}:${a.id}:execution`, 'execution', { accountId: a.id, pendingOrder: clone(p),
        status, ...details, cashAfter: a.cash });
      a.pendingOrder = null;
    };
    for (const old of (next ?? this.state).accounts) {
      const p = old.pendingOrder;
      if (!p) continue;
      if (!allowEntry) { finish(old, 'execution-disabled'); continue; }
      if (now < p.dueAt) continue;
      if (now > p.deadlineAt) { finish(old, 'execution-expired'); continue; }
      const books = frameBooks(frame, p.market, now);
      if (!books || frame.now < p.dueAt || frame.now <= p.sourceFrameAt) continue;
      const book = books[p.outcome === 'Up' ? 0 : 1];
      if (book.timestamp <= p.sourceAt || book.receivedAt < p.sourceReceivedAt) continue;
      if (!book.asks.length) { finish(old, 'no-liquidity', { bookEvidence: clone(frame) }); continue; }
      const broker = new PaperBroker(); broker.setBook(book);
      const size = Math.floor(P.amountUsd / book.asks[0][0] * 1e8) / 1e8;
      const fill = broker.submit({ tokenId: book.tokenId, side: 'buy', price: p.limit,
        size, amountUsd: P.amountUsd, orderType: 'FAK', postOnly: false }, p.market, now);
      const cost = round(fill.notional + fill.fees), expectedProfit = round(fill.filled * p.chance - cost);
      if (fill.filled <= 0) { finish(old, 'no-liquidity', { fill, bookEvidence: clone(frame) }); continue; }
      if (cost > old.cash + 1e-8) { finish(old, 'budget-failed', { fill, expectedProfit, bookEvidence: clone(frame) }); continue; }
      if (expectedProfit <= 0) { finish(old, 'value-expired', { fill, expectedProfit, bookEvidence: clone(frame) }); continue; }
      const a = mutable().accounts.find(x => x.id === old.id), status = fill.notional >= P.amountUsd - 1e-7 ? 'filled' : 'partial-filled';
      a.cash = round(a.cash - cost); a.spent = round(a.spent + cost); a.fees = round(a.fees + fill.fees);
      a.position = { slug: p.slug, market: clone(p.market), opening: p.opening, sourceId: p.sourceId,
        sourceBinding: clone(p.sourceBinding), forecast: clone(p.forecast), outcome: p.outcome,
        chance: p.chance, limit: p.limit, size: fill.filled, notional: fill.notional, fees: fill.fees, cost,
        enteredAt: now, expectedProfit, disposition: status };
      finish(a, status, { fill, expectedProfit, bookEvidence: clone(frame) });
    }
    const candidates = Object.values(sourceSamples).filter(s => s && !(next ?? this.state).processed[s.market?.slug] &&
      finite(s.at) && s.at >= this.state.createdAt && s.at <= now && now - s.at <= P.sourceFreshMs)
      .sort((a, b) => a.at - b.at || lexical(a.id ?? '', b.id ?? ''));
    for (const s of candidates) {
      const valid = sourceReady(s, now, this.state.createdAt);
      if (!valid) continue;
      const b = binding(s);
      if (!validateBinding(b) || !isDeepStrictEqual(s.provenance?.implementationCodeHashes, P.sourceImplementation.implementationCodeHashes) ||
          (next ?? this.state).sourceBinding && !isDeepStrictEqual((next ?? this.state).sourceBinding, b))
        throw Error('Adaptive account source learner, model or implementation changed; isolate evidence');
      const n = mutable(); n.sourceBinding ??= b; n.startedAt ??= now;
      const forecast = { pUp: s.pUp, marketProbability: s.marketProbability, fixedPUp: s.fixedPUp,
        params: clone(s.params), z: s.z, updateId: s.updateId, updatesAtForecast: s.updatesAtForecast,
        throughLabelKnownAt: s.throughLabelKnownAt, sourceModelId: s.sourceModelId };
      const record = { sourceId: s.id, at: s.at, receivedAt: now, day: day(s.at), market: clone(s.market),
        opening: s.opening, sourceBinding: clone(b), forecast, dispositions: {}, attempted: [], settlements: {}, label: null,
        sessionId, experimentId };
      n.processed[s.market.slug] = record;
      // Raw evidence is stored once in the append-only journal, not cloned on every frame.
      event(`${P.version}:${s.market.slug}:source`, 'source', { source: clone(s), sessionId, experimentId });
      const quotesByModel = Object.fromEntries(P.models.map(model => {
        const up = { market: s.marketProbability, fixed: s.fixedPUp, adaptive: s.pUp }[model];
        const quotes = ['Up', 'Down'].map((outcome, i) => {
          let q; try { q = amountQuote(valid.books[i], s.market, P.amountUsd, P.slippageCents); } catch { return null; }
          const chance = outcome === 'Up' ? up : 1 - up;
          return q.complete ? { ...q, outcome, chance, expectedProfit: round(q.filled * chance - q.total) } : null;
        }).filter(q => q && q.expectedProfit > 0).sort((a, b) => b.expectedProfit - a.expectedProfit || lexical(a.outcome, b.outcome));
        return [model, quotes[0] ?? null];
      }));
      for (const a of n.accounts) {
        const q = quotesByModel[a.model];
        let status = !q ? 'skipped-no-value' : !allowEntry ? 'skipped-disabled' :
          a.position || a.pendingOrder ? 'skipped-busy' : a.cash < P.minimumAvailableCashAtDecision ? 'skipped-cash' :
            q.total > a.cash + 1e-8 ? 'skipped-budget' : 'pending';
        record.dispositions[a.id] = status;
        if (status === 'pending') {
          const book = valid.books[q.outcome === 'Up' ? 0 : 1];
          a.attempts++; record.attempted.push(a.id);
          a.pendingOrder = { slug: s.market.slug, market: clone(s.market), opening: s.opening,
            sourceId: s.id, sourceBinding: clone(b), forecast: clone(forecast), outcome: q.outcome,
            chance: q.chance, limit: q.limit, originalQuote: clone(q), requestedAt: now,
            dueAt: now + P.latencyMs, deadlineAt: now + P.latencyMs + P.executionWindowMs,
            sourceAt: book.timestamp, sourceReceivedAt: book.receivedAt, sourceFrameAt: valid.frame.now };
        } else a.dispositions[status] = (a.dispositions[status] ?? 0) + 1;
        event(`${P.version}:${s.market.slug}:${a.id}:decision`, 'decision', { accountId: a.id, status,
          quote: clone(q), probability: forecast, sourceBinding: clone(b), cashAtDecision: a.cash });
      }
    }
    if (!events.length) return;
    next.lastAt = now; next.pending.push(...events);
    validateState(next, adaptiveAccountImplementation());
    writeJsonAtomic(this.path, next); this.state = next; this.flush();
  }
  summary(now = this.lastNow) {
    const asOf = finite(now) && now >= this.state.lastAt ? now : this.state.lastAt;
    const accounts = this.state.accounts.map(a => {
      let nav = { known: true, value: a.cash, lower: a.cash, upper: a.cash, asOf };
      let current = { occupiedMs: 0, tradableMs: 0, waitMs: 0 };
      if (a.position) {
        const p = a.position, f = this.lastFrame; current = duration(p, asOf);
        nav = { known: false, value: null, lower: a.cash, upper: round(a.cash + p.size), asOf };
        const books = frameBooks(f, p.market, asOf);
        if (asOf < p.market.end && books) {
          const book = books[p.outcome === 'Up' ? 0 : 1];
          if (researchBook(book, p.market, p.outcome, asOf).bidReady) {
            const sale = depthQuote(book, 'sell', p.size, p.market, round(Math.max(p.market.tick, book.bids[0][0] - .02)));
            if (sale?.complete) { const value = round(a.cash + sale.notional - sale.fees); nav = { known: true, value, lower: value, upper: value, asOf }; }
          }
        }
      }
      return { ...a, occupiedMs: a.occupiedMs + current.occupiedMs,
        tradableMs: a.tradableMs + current.tradableMs, waitMs: a.waitMs + current.waitMs,
        pendingOrderMs: a.pendingOrderMs + (a.pendingOrder ? Math.max(0, asOf - a.pendingOrder.requestedAt) : 0),
        roiRealized: a.realizedPnl / a.initialCapital, nav,
        roiNav: { known: nav.known, value: nav.known ? (nav.value - a.initialCapital) / a.initialCapital : null,
          lower: (nav.lower - a.initialCapital) / a.initialCapital, upper: (nav.upper - a.initialCapital) / a.initialCapital },
        position: a.position ? { slug: a.position.slug, outcome: a.position.outcome, size: a.position.size,
          cost: a.position.cost, notional: a.position.notional, fees: a.position.fees,
          enteredAt: a.position.enteredAt, end: a.position.market.end } : null,
        pendingOrder: a.pendingOrder ? { slug: a.pendingOrder.slug, outcome: a.pendingOrder.outcome,
          limit: a.pendingOrder.limit, chance: a.pendingOrder.chance, requestedAt: a.pendingOrder.requestedAt,
          dueAt: a.pendingOrder.dueAt, deadlineAt: a.pendingOrder.deadlineAt } : null };
    });
    const records = Object.values(this.state.processed);
    return clone({ version: P.version, protocol: P, protocolHash: this.state.protocolHash,
      implementationHash: this.state.implementationHash, implementationCodeHashes: this.state.implementationCodeHashes,
      instanceId: this.state.instanceId, sourceBinding: this.state.sourceBinding,
      createdAt: this.state.createdAt, startedAt: this.state.startedAt, lastAt: this.state.lastAt, lastNow: asOf,
      forecasts: records.length, rounds: records.length, dates: new Set(records.map(r => r.day)).size,
      accounts, error: this.error, errors: this.error ? [this.error] : [],
      autoSimulationEnabled: true, accountIsolated: true, changesMainRules: false, realTrading: false,
      promotion: { status: 'collecting', eligible: false },
      scope: 'Six isolated finite-capital paper accounts; fixed one-dollar decisions and delayed protected fills.',
      limitations: ['Paper depth is received liquidity, not guaranteed real execution or queue competition.',
        'Settlement network cost is not modeled; unresolved inventory is reported as unknown or a range.',
        'Main trading rules, funding and positions are not changed by this study.'] });
  }
}
