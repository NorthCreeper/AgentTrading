import { mkdirSync, existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyResolution, SettlementLedger } from './settlement.mjs';
import { verifyPayoutResolution } from './payout-resolution.mjs';
import { settlementFeatures, settlementDecision } from './settlement-model.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';

export class SettlementShadow {
  constructor({ directory, artifact = null, seedMarkets = [], historical = null, clock = Date.now }) {
    this.directory = directory; this.archive = join(directory, 'outcomes');
    this.financialArchive = join(directory, 'financial-outcomes'); this.clock = clock;
    this.path = join(directory, 'settlement-shadow.json'); this.artifact = artifact; this.historical = historical;
    mkdirSync(this.archive, { recursive: true });
    mkdirSync(this.financialArchive, { recursive: true });
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) :
      { version: 1, markets: {}, samples: {}, decision: null, ledger: null };
    if (this.state.version !== 1 || !this.state.markets || !this.state.samples) throw Error('Invalid settlement research state');
    this.ledger = new SettlementLedger(this.state.ledger); this.labels = new Map(); this.financialLabels = new Map();
    this.financialConflict = this.state.financialConflict === true;
    for (const m of seedMarkets) this.state.markets[m.slug] ??= m;
    for (const file of readdirSync(this.archive).filter(f => /^btc-updown-5m-\d+\.json$/.test(f))) {
      const e = JSON.parse(readFileSync(join(this.archive, file), 'utf8'));
      const label = verifyResolution(e.market, e.gamma, e.clob, e.observedAt);
      if (label) {
        this.labels.set(label.slug, label); this.state.markets[label.slug] ??= e.market;
        // Old strict archives may omit market.resolutionSource; the unchanged strict
        // verifier has already independently certified gamma's exact source and rules.
        if (label.observedAt <= this.clock()) this.financialLabels.set(label.slug, { ...label, tokens: { ...label.tokens },
          version: 'paper-official-payout-v1', scope: 'paper-financial-only', priceCrossCheck: 'consistent',
          source: 'Archived strict dual-API result; paper financial only; onchain redemption unconfirmed' });
      }
    }
    for (const file of readdirSync(this.financialArchive).filter(f => /^btc-updown-5m-\d+\.json$/.test(f))) {
      const e = JSON.parse(readFileSync(join(this.financialArchive, file), 'utf8'));
      if (!Number.isFinite(e.observedAt) || e.observedAt > this.clock()) throw Error('财务结果归档来自未来时间');
      const label = verifyPayoutResolution(e.market, e.gamma, e.clob, e.observedAt);
      if (!label) throw Error('财务结果归档尚未核实');
      const prior = this.financialLabels.get(label.slug);
      if (prior && prior.winner !== label.winner) this.markFinancialConflict(label);
      if (!prior || label.observedAt < prior.observedAt) this.financialLabels.set(label.slug, label);
      this.state.markets[label.slug] ??= e.market;
    }
  }
  save() {
    this.state.ledger = this.ledger.state;
    writeJsonAtomic(this.path, this.state);
  }
  pending() { return Object.values(this.state.markets).filter(m => !this.labels.has(m.slug)); }
  markFinancialConflict(label) {
    this.financialConflict = true; this.state.financialConflict = true;
    this.state.financialConflictResult = { slug: label.slug, winner: label.winner, observedAt: label.observedAt };
    this.save(); const error = Error('已确认官方财务支付结果发生矛盾');
    error.financialConflict = true; throw error;
  }
  acceptResolution(evidence, now = this.clock()) {
    if (!Number.isFinite(now) || !Number.isFinite(evidence?.observedAt) || evidence.observedAt > now)
      throw Error('财务结算观察时间无效或来自未来');
    // Metadata can be discovered even if that round never produced a usable order book.
    const m = this.state.markets[evidence.market.slug] ?? evidence.market;
    const priorFinancial = this.financialLabels.get(m.slug);
    if (priorFinancial) {
      // A changed canonical payment is a financial conflict even when the latest
      // optional numeric metadata is internally inconsistent. Certify both raw
      // wrappers and all official payment identities before raising that flag.
      const canonicalGamma = { ...evidence.gamma, events: [] };
      const canonical = verifyPayoutResolution(m, canonicalGamma, evidence.clob, evidence.observedAt);
      if (canonical && canonical.winner !== priorFinancial.winner) {
        verifyPayoutResolution(evidence.market, canonicalGamma, evidence.clob, evidence.observedAt);
        this.markFinancialConflict(canonical);
      }
    }
    const financial = verifyPayoutResolution(m, evidence.gamma, evidence.clob, evidence.observedAt);
    if (!financial) return false;
    // Certify the raw evidence's market too: do not archive an inconsistent wrapper.
    verifyPayoutResolution(evidence.market, evidence.gamma, evidence.clob, evidence.observedAt);
    this.state.markets[m.slug] ??= m;
    if (!priorFinancial) {
      writeJsonAtomic(join(this.financialArchive, financial.slug + '.json'), evidence);
      this.financialLabels.set(financial.slug, financial);
    }
    this.save();
    let label;
    try { label = verifyResolution(m, evidence.gamma, evidence.clob, evidence.observedAt); }
    catch (error) {
      if (financial.priceCrossCheck === 'missing-price-metadata' || financial.priceCrossCheck === 'ambiguous-display-precision') return false;
      throw error;
    }
    if (!label) return false;
    const prior = this.labels.get(label.slug);
    if (prior && (prior.winner !== label.winner || prior.opening !== label.opening)) throw Error('Official final result changed');
    const path = join(this.archive, label.slug + '.json');
    if (!prior) writeJsonAtomic(path, evidence);
    this.labels.set(label.slug, prior ?? label);
    this.ledger.settle(prior ?? label, now); this.save(); return true;
  }
  acceptFrame(frame, prices, now, allowShadowEntry, amountUsd, { researchEnabled = true } = {}) {
    const newMarket = !Object.hasOwn(this.state.markets, frame.market.slug);
    this.state.markets[frame.market.slug] ??= frame.market;
    if (!researchEnabled) {
      // Archived research still discovers markets and reconciles already-owned
      // shadow inventory. Do not resample the replaced strategy on every frame.
      let changed = newMarket;
      for (const entry of this.ledger.state.entries) {
        if (!entry.settled && this.ledger.settle(this.labels.get(entry.slug), now)) changed = true;
      }
      if (changed) this.save();
      return;
    }
    // Recover a crash between evidence persistence and ledger persistence exactly once.
    for (const label of this.labels.values()) this.ledger.settle(label, now);
    const f = settlementFeatures(frame, prices, now);
    const d = settlementDecision(frame, prices, this.artifact, now, { amountUsd });
    d.amountUsd = amountUsd ?? null;
    if (f && !this.state.samples[frame.market.slug]) {
      const sample = { slug: frame.market.slug, observedAt: now, opening: f.opening,
        x: f.x, marketProbability: f.marketProbability, modelId: this.artifact?.id ?? null,
        pUp: d.pUp, candidate: d.candidate, amountUsd: amountUsd ?? null };
      this.state.samples[frame.market.slug] = sample;
      appendFileSync(join(this.directory, 'settlement-samples.jsonl'), JSON.stringify({ ...sample, frame,
        prices: prices.filter(p => p.time >= frame.market.start && p.time <= now && p.receivedAt <= now) }) + '\n');
    }
    this.state.decision = d;
    if (allowShadowEntry && now >= (this.artifact?.prospectiveAfter ?? Infinity) && d.candidate)
      this.ledger.enter(d.candidate, frame.market, now, this.artifact.id);
    this.save();
  }
  summary() {
    const samples = Object.values(this.state.samples), labeled = samples.filter(s => {
      const label = this.labels.get(s.slug); return label && Math.abs(label.opening - s.opening) <= .00001;
    });
    const labeledSet = new Set(labeled);
    const modelSamples = samples.filter(s => s.modelId === this.artifact?.id && Number.isFinite(s.pUp));
    const modelLabeled = modelSamples.filter(s => labeledSet.has(s));
    const brier = key => modelLabeled.length ? modelLabeled.reduce((sum, s) =>
      sum + (s[key] - Number(this.labels.get(s.slug).winner === 'Up')) ** 2, 0) / modelLabeled.length : null;
    return { mode: 'settlement-shadow', accountIsolated: true, autoTradingEnabled: false,
      modelId: this.artifact?.id ?? null, modelReady: Boolean(this.artifact?.model),
      reason: this.artifact?.promotion?.reason ?? '等待结算概率研究',
      officialLabels: this.labels.size, pendingLabels: this.pending().length,
      financialVerified: this.financialLabels.size, financialConflict: this.financialConflict,
      prospectiveSamples: samples.length, prospectiveLabeled: labeled.length,
      modelSamples: modelSamples.length, modelLabeled: modelLabeled.length, modelBrier: brier('pUp'), marketBrier: brier('marketProbability'),
      openingConflicts: samples.filter(s => this.labels.has(s.slug) && !labeledSet.has(s)).length,
      historical: this.historical, decision: this.state.decision, ledger: this.ledger.summary() };
  }
}
