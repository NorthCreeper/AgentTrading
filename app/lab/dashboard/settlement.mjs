import { round } from '../paper-broker.mjs';

export const resolutionSource = 'https://data.chain.link/streams/btc-usd-twap-60s-streams';
const array = value => Array.isArray(value) ? value : JSON.parse(value);

// Final labels require agreement of identity, final status and both official APIs.
// A closed market or a last price of 1 alone is not evidence of resolution.
export function verifyResolution(market, gamma, clob, observedAt) {
  if (!/^btc-updown-5m-\d+$/.test(market.slug) || market.end !== market.start + 300_000 ||
      Number(market.slug.split('-').at(-1)) * 1000 !== market.start ||
      gamma.slug !== market.slug || gamma.conditionId !== market.conditionId ||
      clob.condition_id !== market.conditionId || clob.market_slug !== market.slug ||
      Date.parse(gamma.endDate) !== market.end || gamma.resolutionSource !== resolutionSource ||
      gamma.description !== market.rules || !Number.isFinite(observedAt) || observedAt < market.end)
    throw Error('结算身份、时间或规则不一致');
  if (gamma.closed !== true || gamma.umaResolutionStatus !== 'resolved' || clob.closed !== true)
    return null;
  const outcomes = array(gamma.outcomes), ids = array(gamma.clobTokenIds), prices = array(gamma.outcomePrices);
  if (outcomes.length !== 2 || ids.length !== 2 || prices.length !== 2 || clob.tokens?.length !== 2 || clob.is_50_50_outcome === true)
    throw Error('不支持的结算支付结构');
  for (const outcome of ['Up', 'Down']) {
    const i = outcomes.indexOf(outcome), t = clob.tokens.find(t => t.outcome === outcome);
    if (i < 0 || ids[i] !== market.tokens[outcome] || t?.token_id !== market.tokens[outcome] ||
        typeof t.winner !== 'boolean' || Number(prices[i]) !== Number(t.winner) || Number(t.price) !== Number(t.winner))
      throw Error('官方结算结果或 token 映射冲突');
  }
  const winners = clob.tokens.filter(t => t.winner);
  if (winners.length !== 1) throw Error('缺少唯一官方赢家');
  const event = gamma.events?.find(e => e.slug === market.slug);
  const opening = event?.eventMetadata?.priceToBeat, final = event?.eventMetadata?.finalPrice;
  if (![opening, final].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0))
    throw Error('缺少官方开盘或最终价格');
  // Metadata numbers have display precision: ambiguous near-ties cannot be certified here.
  if (Math.abs(final - opening) < 1e-7 || (final >= opening ? 'Up' : 'Down') !== winners[0].outcome)
    throw Error('官方价格与赢家不一致，或精度不足以核对相等价格');
  return { version: 1, slug: market.slug, conditionId: market.conditionId, tokens: market.tokens,
    start: market.start, end: market.end, winner: winners[0].outcome,
    payouts: { Up: Number(winners[0].outcome === 'Up'), Down: Number(winners[0].outcome === 'Down') },
    opening, final, observedAt, closedAt: Date.parse(gamma.closedTime ?? event?.closedTime) || null,
    source: 'Gamma resolved + CLOB winner + eventMetadata cross-check' };
}

// Separate hypothetical ledger. Never credits the user's trading account or sends orders.
export class SettlementLedger {
  constructor(saved) {
    this.state = saved ?? { version: 1, budget: 10, maxLoss: 2, cash: 0, fees: 0, entries: [], settlements: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.entries) || !Array.isArray(this.state.settlements) ||
        !Number.isFinite(this.state.cash) || !Number.isFinite(this.state.fees)) throw Error('Invalid settlement ledger');
  }
  enter(candidate, market, now, modelId) {
    if (!candidate || !Number.isFinite(now) || now < market.start || now >= market.end ||
        !['Up', 'Down'].includes(candidate.outcome) || candidate.tokenId !== market.tokens[candidate.outcome] ||
        ![candidate.size, candidate.cost, candidate.fees].every(Number.isFinite) || candidate.size <= 0 ||
        candidate.cost <= 0 || candidate.fees < 0 || candidate.cost + candidate.fees > this.state.budget ||
        this.state.entries.some(e => e.slug === market.slug) || this.state.entries.some(e => !e.settled) ||
        this.state.cash <= -this.state.maxLoss) return false;
    this.state.cash = round(this.state.cash - candidate.cost - candidate.fees);
    this.state.fees = round(this.state.fees + candidate.fees);
    this.state.entries.push({ slug: market.slug, conditionId: market.conditionId, tokens: market.tokens,
      end: market.end, outcome: candidate.outcome, tokenId: candidate.tokenId, size: candidate.size,
      cost: candidate.cost, fees: candidate.fees, enteredAt: now, modelId, probability: candidate.probability,
      amountUsd: candidate.amountUsd ?? null, executionVersion:candidate.executionVersion??null, settled: false });
    return true;
  }
  settle(label, now) {
    if (!label || !Number.isFinite(now) || !Number.isFinite(label.end) || !Number.isFinite(label.observedAt) || now < label.end || now < label.observedAt ||
        !['Up', 'Down'].includes(label.winner) || label.payouts?.Up !== Number(label.winner === 'Up') ||
        label.payouts?.Down !== Number(label.winner === 'Down')) return null;
    const e = this.state.entries.find(e => e.slug === label.slug && !e.settled);
    if (!e || e.conditionId !== label.conditionId || e.end !== label.end ||
        ['Up', 'Down'].some(o => e.tokens[o] !== label.tokens[o])) return null;
    const payout = round(e.size * label.payouts[e.outcome]);
    const result = { slug: e.slug, outcome: e.outcome, winner: label.winner, enteredAt: e.enteredAt,
      settledAt: now, payout, cost: e.cost, fees: e.fees, net: round(payout - e.cost - e.fees), modelId: e.modelId, amountUsd: e.amountUsd ?? null, executionVersion:e.executionVersion??null };
    e.settled = true; this.state.cash = round(this.state.cash + payout); this.state.settlements.push(result);
    return result;
  }
  summary() {
    const pending = this.state.entries.filter(e => !e.settled);
    return { entries: this.state.entries.length, settled: this.state.settlements.length, pending: pending.length,
      cash: this.state.cash, net: round(this.state.settlements.reduce((s, e) => s + e.net, 0)), fees: this.state.fees,
      capitalAtRisk: round(pending.reduce((s, e) => s + e.cost + e.fees, 0)), last: this.state.settlements.at(-1) ?? null };
  }
}
