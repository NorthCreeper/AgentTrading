import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyResolution } from './settlement.mjs';
import { settlementProtocol as cfg, settlementFeatures, fitProbability } from './settlement-model.mjs';
import { evaluateSettlementRows, settlementPasses } from './settlement-evaluation.mjs';
const root = fileURLToPath(new URL('./', import.meta.url)), reports = join(root, 'reports'), runtime = join(root, 'runtime');
const output = (name, value) => writeFileSync(join(reports, name), JSON.stringify(value, null, 2));
if (existsSync(join(reports, 'settlement-forward-research.json'))) throw Error('Completed forward-data study is frozen.');
let input;
if (existsSync(join(reports, 'settlement-forward-input.json'))) input = JSON.parse(readFileSync(join(reports, 'settlement-forward-input.json'), 'utf8'));
else {
  const text = readFileSync(join(runtime, 'settlement-samples.jsonl'), 'utf8');
  const rows = text.trim().split('\n').filter(Boolean).map(JSON.parse), unique = new Map();
  for (const row of rows) if (!unique.has(row.slug)) unique.set(row.slug, row);
  const samples = [...unique.values()].sort((a, b) => a.observedAt - b.observedAt);
  const n = samples.length, trainEnd = Math.floor(n * .6), validationEnd = Math.floor(n * .8);
  const virtualFitAt = (samples[trainEnd]?.observedAt ?? Date.now()) - 1;
  const cohorts = samples.map((s, i) => ({ ...s, part: i < trainEnd ? 'train' : i < validationEnd ? 'validation' : 'diagnostic' }));
  input = { createdAt: new Date().toISOString(), hash: createHash('sha256').update(text).digest('hex'), config: cfg,
    duplicateRows: rows.length - unique.size, virtualFitAt,
    protocol: 'Only newly collected opening-correct samples. Fixed prior model/thresholds; 60/20/20 chronological whole rounds, no parameter search. Train only on labels actually received before first validation observation. Missing labels remain excluded in their original cohort. Segments start independent $10/$2 ledgers. Cash is released at recorded verified-result receipt time.', cohorts };
  output('settlement-forward-input.json', input);
}
const parts = { train: [], validation: [], diagnostic: [] }, excluded = [];
for (const s of input.cohorts) {
  const path = join(runtime, 'outcomes', s.slug + '.json');
  if (!existsSync(path)) { excluded.push({ slug: s.slug, part: s.part, reason: 'Result not available at study cutoff' }); continue; }
  const e = JSON.parse(readFileSync(path, 'utf8')), label = verifyResolution(s.frame.market, e.gamma, e.clob, e.observedAt);
  const f = settlementFeatures(s.frame, s.prices, s.observedAt);
  if (!label || !f || Math.abs(f.opening - label.opening) > .00001) { excluded.push({ slug: s.slug, part: s.part, reason: 'Opening or features fail verification' }); continue; }
  if (label.observedAt > Date.parse(input.createdAt)) { excluded.push({ slug: s.slug, part: s.part, reason: 'Result arrived after study cutoff' }); continue; }
  if (s.part === 'train' && label.observedAt > input.virtualFitAt) { excluded.push({ slug: s.slug, part: s.part, reason: 'Training label not yet received at virtual fit time' }); continue; }
  if (s.x.some((x, i) => Math.abs(x - f.x[i]) > 1e-9)) throw Error('Live/research feature mismatch');
  parts[s.part].push({ ...s, ...f, label, y: Number(label.winner === 'Up') });
}
const model = fitProbability(parts.train);
const artifact = { id: `settlement-forward-v1-${input.hash.slice(0, 8)}`, createdAt: new Date().toISOString(),
  inputHash: input.hash, protocol: cfg, model, fee: parts.train[0]?.frame.market.fee ?? null,
  trainingRounds: parts.train.length, virtualFitAt: input.virtualFitAt, prospectiveAfter: Date.now() };
const validation = evaluateSettlementRows(parts.validation, artifact), diagnostic = evaluateSettlementRows(parts.diagnostic, artifact);
const historicalPassed = Boolean(model && settlementPasses(validation) && settlementPasses(diagnostic));
artifact.promotion = { eligible: false, historicalPassed, reason: !model ? '有效训练样本或两种结果不足；继续采集' : historicalPassed ?
  '新采集数据检验通过，仍待模型上线后的前瞻验证；仅独立影子记账' : '新采集数据的收益或校准检验未通过；仅独立影子记账' };
const report = { createdAt: artifact.createdAt, modelId: artifact.id, protocol: input.protocol, config: cfg, frozenSamples: input.cohorts.length,
  parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length])), usableRounds: Object.values(parts).reduce((s, rows) => s + rows.length, 0),
  excluded, validation, diagnostic, promotion: artifact.promotion,
  limitations: ['Data was collected prospectively, but this model is fitted and scored afterward; it is not an online prospective trading result.',
    'Fewer than ten settled trades or poor probability coverage/calibration fails the gate even if net is positive.',
    'Probability haircut is an engineering margin, not a confidence bound. No real fills, redemption transport or gas are modeled.',
    'Each evaluation segment has a separate risk ledger; segment profit must not be read as a continuous account return.'] };
output('settlement-forward-model.json', artifact); output('settlement-forward-research.json', report);
console.log(JSON.stringify({ samples: report.frozenSamples, parts: report.parts, excluded: excluded.length, modelReady: Boolean(model),
  validation: { net: validation.net, trades: validation.settled, candidates: validation.independentCandidateCount, brier: validation.brier, marketBrier: validation.marketBrier },
  diagnostic: { net: diagnostic.net, trades: diagnostic.settled, candidates: diagnostic.independentCandidateCount, brier: diagnostic.brier, marketBrier: diagnostic.marketBrier }, promotion: artifact.promotion }));
