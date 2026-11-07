import { createReadStream, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { verifyResolution, SettlementLedger } from './settlement.mjs';
import { settlementProtocol as cfg, settlementFeatures, fitProbability, probability, settlementDecision } from './settlement-model.mjs';
import { round } from '../paper-broker.mjs';

const root = fileURLToPath(new URL('./', import.meta.url)), runtime = join(root, 'runtime'), reports = join(root, 'reports');
const archive = join(runtime, 'outcomes'); mkdirSync(archive, { recursive: true });
const output = (name, data) => writeFileSync(join(reports, name), JSON.stringify(data, null, 2));
if (existsSync(join(reports, 'settlement-research.json'))) throw Error('Completed settlement study is frozen. Use new prospective data and a new protocol.');
let input;
if (existsSync(join(reports, 'settlement-input.json'))) input = JSON.parse(readFileSync(join(reports, 'settlement-input.json'), 'utf8'));
else {
  const cutoff = Date.now(), groups = new Map(), prices = new Map(), hash = createHash('sha256');
  for (const file of readdirSync(runtime).filter(f => /-(frames|prices)\.jsonl$/.test(f)).sort()) {
    const path = join(runtime, file), size = statSync(path).size;
    if (!size) continue;
    for await (const line of createInterface({ input: createReadStream(path, { end: size - 1 }), crlfDelay: Infinity })) {
      let row; try { row = JSON.parse(line); } catch { throw Error(`Incomplete input record: ${file}; retry from a complete snapshot`); }
      hash.update(file + ':' + line + '\n');
      if (file.endsWith('-prices.jsonl')) {
        const prior = prices.get(row.time);
        if (prior && prior.valueE18 !== row.valueE18) throw Error('Conflicting price observation');
        if (!prior || row.receivedAt < prior.receivedAt) prices.set(row.time, row);
      } else if (row.market?.end <= cutoff) {
        if (!groups.has(row.market.slug)) groups.set(row.market.slug, { market: row.market, frames: [] });
        const g = groups.get(row.market.slug);
        if (row.market.conditionId !== g.market.conditionId || row.market.rules !== g.market.rules) throw Error('Market rules changed within round');
        const age = row.now - row.market.start;
        if (age >= cfg.entryAgeMs && age <= cfg.entryAgeMs + cfg.entryWindowMs) g.frames.push(row);
      }
    }
  }
  const allPrices = [...prices.values()].sort((a, b) => a.time - b.time);
  const rounds = [...groups.values()].sort((a, b) => a.market.start - b.market.start);
  const trainEnd = Math.floor(rounds.length * .6), validationEnd = Math.floor(rounds.length * .8);
  input = { createdAt: new Date(cutoff).toISOString(), cutoff, hash: hash.digest('hex'), config: cfg,
    protocol: 'Fixed entry at 120–125 seconds, one observation per round, chronological whole-round 60/20/20 split BEFORE fetching labels. No grid search. Official historical priceToBeat is quality control only; only the exact opening RTDS value received before entry enters features.',
    rounds: rounds.map((g, i) => {
      const localPrices = allPrices.filter(p => p.time >= g.market.start && p.time <= g.market.start + cfg.entryAgeMs + cfg.entryWindowMs);
      const frame = g.frames.sort((a, b) => a.now - b.now).find(f => settlementFeatures(f, localPrices));
      return { market: g.market, part: i < trainEnd ? 'train' : i < validationEnd ? 'validation' : 'diagnostic',
        frame: frame ?? null, prices: frame ? localPrices.filter(p => p.time <= frame.now && p.receivedAt <= frame.now) : [],
        missing: frame ? null : 'No eligible 120s frame, exact opening, fresh book or continuous TWAP' };
    }) };
  output('settlement-input.json', input);
  console.log(JSON.stringify({ frozenRounds: input.rounds.length, usableBeforeLabels: input.rounds.filter(r => r.frame).length }));
}

// Public read-only requests, at most two rounds concurrently; persist evidence for audit/restart.
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw Error(`HTTP ${response.status}`); return response.json();
}
const labels = new Map(), failures = [];
for (let i = 0; i < input.rounds.length; i += 2) {
  const results = await Promise.allSettled(input.rounds.slice(i, i + 2).map(async r => {
    const path = join(archive, r.market.slug + '.json');
    let evidence;
    if (existsSync(path)) evidence = JSON.parse(readFileSync(path, 'utf8'));
    else {
      const [gamma, clob] = await Promise.all([get(`https://gamma-api.polymarket.com/markets/slug/${r.market.slug}`), get(`https://clob.polymarket.com/markets/${r.market.conditionId}`)]);
      evidence = { market: r.market, gamma, clob, observedAt: Date.now() };
    }
    const label = verifyResolution(r.market, evidence.gamma, evidence.clob, evidence.observedAt);
    if (!label) throw Error('Still unresolved');
    writeFileSync(path, JSON.stringify(evidence)); labels.set(r.market.slug, label);
  }));
  results.forEach((r, j) => { if (r.status === 'rejected') failures.push({ slug: input.rounds[i + j].market.slug, reason: r.reason.message }); });
  if (i % 20 === 0) console.log(JSON.stringify({ checked: Math.min(i + 2, input.rounds.length), verified: labels.size, failures: failures.length }));
}

const samples = [], excluded = [];
for (const r of input.rounds) {
  const label = labels.get(r.market.slug), f = r.frame && settlementFeatures(r.frame, r.prices);
  if (!label || !f) { excluded.push({ slug: r.market.slug, reason: !label ? 'No verified final label' : r.missing }); continue; }
  if (Math.abs(f.opening - label.opening) > .00001) { excluded.push({ slug: r.market.slug, reason: 'Local exact opening differs from official priceToBeat', local: f.opening, official: label.opening }); continue; }
  samples.push({ slug: r.market.slug, part: r.part, x: f.x, marketProbability: f.marketProbability,
    y: Number(label.winner === 'Up'), frame: r.frame, prices: r.prices, label });
}
const parts = Object.fromEntries(['train', 'validation', 'diagnostic'].map(k => [k, samples.filter(s => s.part === k)]));
const model = fitProbability(parts.train), fee = parts.train[0]?.frame.market.fee ?? null;
const artifact = { id: `${cfg.version}-${input.hash.slice(0, 8)}`, createdAt: new Date().toISOString(),
  inputHash: input.hash, protocol: cfg, model, fee, prospectiveAfter: Date.now(), promotion: { eligible: false } };
function evaluate(rows) {
  const predictions = rows.map(s => ({ ...s, p: model ? probability(model, s) : null })).filter(s => s.p !== null);
  const score = key => predictions.length ? predictions.reduce((v, s) => v + (s[key] - s.y) ** 2, 0) / predictions.length : null;
  const ledger = new SettlementLedger(), decisions = [], delayed = [], independent = [];
  function release(now) {
    for (const d of delayed) if (d.availableAt <= now) ledger.settle({ ...d.label, observedAt: d.availableAt }, now);
  }
  for (const s of rows) {
    release(s.frame.now);
    const d = settlementDecision(s.frame, s.prices, artifact);
    if (!d.candidate) continue;
    independent.push(round(d.candidate.size * Number(d.candidate.outcome === s.label.winner) - d.candidate.cost - d.candidate.fees));
    if (ledger.enter(d.candidate, s.frame.market, s.frame.now, artifact.id)) {
      // Historical release is an explicit scenario, not an observed real-time redemption.
      const availableAt = Math.max(s.label.end + 600_000, s.label.closedAt ?? 0);
      delayed.push({ label: s.label, availableAt });
      decisions.push({ slug: s.slug, outcome: d.candidate.outcome, edge: d.candidate.edge, probability: d.candidate.probability });
    }
  }
  release(Math.max(0, ...delayed.map(d => d.availableAt)));
  const trades = ledger.state.settlements, nets = trades.map(t => t.net), mean = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : null;
  const se = nets.length > 1 ? Math.sqrt(nets.reduce((s, n) => s + (n - mean) ** 2, 0) / (nets.length - 1) / nets.length) : null;
  return { rounds: rows.length, predictions: predictions.length, brier: score('p'), marketBrier: score('marketProbability'),
    ...ledger.summary(), mean, lowerMeanHeuristic: se === null ? null : mean - 1.96 * se,
    stressNet: round(ledger.summary().net - trades.length * cfg.size * .01),
    independentCandidateCount: independent.length, independentCandidateNet: round(independent.reduce((a, b) => a + b, 0)), decisions, trades };
}
const validation = evaluate(parts.validation), diagnostic = evaluate(parts.diagnostic);
const passes = (r, minRounds) => r.rounds >= minRounds && r.settled >= cfg.minTrades && r.net > 0 &&
  r.stressNet > 0 && r.lowerMeanHeuristic > 0 && r.brier !== null && r.brier < r.marketBrier;
const historicalPassed = Boolean(model && passes(validation, cfg.minValidationRounds) && passes(diagnostic, cfg.minDiagnosticRounds));
artifact.promotion = { eligible: false, historicalPassed, reason: !model ? '训练段完整标注轮次不足 30，或缺少两种结果；继续采集' :
  historicalPassed ? '历史检查通过，仍须新的前瞻样本；未开放自动交易' : '历史收益、样本数或概率校准未通过；只做影子研究' };
const report = { createdAt: new Date().toISOString(), modelId: artifact.id, protocol: input.protocol, config: cfg,
  frozenRounds: input.rounds.length, officialLabels: labels.size, usableRounds: samples.length,
  parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length])), failures, excluded,
  validation, diagnostic, promotion: artifact.promotion,
  limitations: ['Historical labels were fetched after trading: they are targets/QC only, never features.',
    'One fixed model; no claim of calibrated probability until it beats market Brier score on new data.',
    'Historical cash release assumes max(end+10min, published closedTime), not actual finality or redemption latency.',
    'Independent candidate totals ignore shared capital and are diagnostics only; ledger respects one pending position, $10 risk and $2 realized loss limit.',
    'No on-chain redemption or gas/relayer costs modeled; one-tick stress and buffers do not guarantee coverage.',
    'Historical segments overlap previously inspected markets; a fresh prospective period is required.'] };
output('settlement-model.json', artifact); output('settlement-research.json', report);
console.log(JSON.stringify({ rounds: report.frozenRounds, labels: labels.size, usable: samples.length, parts: report.parts,
  modelFitted: Boolean(model), validation: { net: validation.net, trades: validation.settled, brier: validation.brier, marketBrier: validation.marketBrier },
  diagnostic: { net: diagnostic.net, trades: diagnostic.settled, brier: diagnostic.brier, marketBrier: diagnostic.marketBrier }, promotion: artifact.promotion }));
