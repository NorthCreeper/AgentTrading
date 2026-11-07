import { SettlementLedger } from './settlement.mjs';
import { settlementProtocol as cfg, probability, settlementDecision } from './settlement-model.mjs';
import { round } from '../paper-broker.mjs';

export function evaluateSettlementRows(rows, artifact) {
  const predictions = rows.map(s => ({ ...s, p: probability(artifact.model, s) })).filter(s => s.p !== null);
  const score = key => predictions.length ? predictions.reduce((sum, s) => sum + (s[key] - s.y) ** 2, 0) / predictions.length : null;
  const ledger = new SettlementLedger(), pending = [], candidates = [];
  const release = now => { for (const label of pending) ledger.settle(label, now); };
  for (const s of rows) {
    release(s.observedAt);
    const d = settlementDecision(s.frame, s.prices, artifact, s.observedAt);
    if (!d.candidate) continue;
    const independentNet = round(d.candidate.size * s.label.payouts[d.candidate.outcome] - d.candidate.cost - d.candidate.fees);
    const accepted = ledger.enter(d.candidate, s.frame.market, s.observedAt, artifact.id);
    candidates.push({ slug: s.slug, observedAt: s.observedAt, outcome: d.candidate.outcome,
      probability: d.candidate.probability, edge: d.candidate.edge, independentNet, accepted });
    if (accepted) pending.push(s.label);
  }
  release(Math.max(0, ...pending.map(l => l.observedAt)));
  const nets = ledger.state.settlements.map(t => t.net), mean = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : null;
  const se = nets.length > 1 ? Math.sqrt(nets.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (nets.length - 1) / nets.length) : null;
  return { rounds: rows.length, predictions: predictions.length, brier: score('p'), marketBrier: score('marketProbability'),
    ...ledger.summary(), mean, lowerMeanHeuristic: se === null ? null : mean - 1.96 * se,
    stressNet: round(ledger.summary().net - nets.length * cfg.size * .01),
    independentCandidateCount: candidates.length, independentCandidateNet: round(candidates.reduce((s, c) => s + c.independentNet, 0)),
    candidates, trades: ledger.state.settlements };
}
export function settlementPasses(r) {
  return r.rounds >= cfg.minValidationRounds && r.predictions >= .9 * r.rounds && r.settled >= cfg.minTrades &&
    r.net > 0 && r.stressNet > 0 && r.lowerMeanHeuristic > 0 && r.brier !== null && r.brier < r.marketBrier;
}
