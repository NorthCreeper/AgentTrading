import { resolutionSource } from './settlement.mjs';

const array = value => Array.isArray(value) ? value : JSON.parse(value);
const paymentNumber = value => typeof value === 'number' ? value :
  typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : NaN;
const metadataPrice = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

// A paper financial receipt from two matching official APIs, never an onchain
// redemption confirmation and never a replacement for the strict training label.
// The consumer must additionally require observedAt <= its own current clock.
export function verifyPayoutResolution(market, gamma, clob, observedAt) {
  if (!market || !gamma || !clob || !/^btc-updown-5m-\d+$/.test(market.slug) ||
      ![market.start, market.end, observedAt].every(Number.isFinite) ||
      market.end !== market.start + 300_000 || Number(market.slug.split('-').at(-1)) * 1000 !== market.start ||
      observedAt < market.end || typeof market.conditionId !== 'string' || !market.conditionId ||
      typeof market.rules !== 'string' || !market.rules ||
      ['Up', 'Down'].some(outcome => typeof market.tokens?.[outcome] !== 'string' || !market.tokens[outcome]) ||
      market.tokens.Up === market.tokens.Down ||
      gamma.slug !== market.slug || gamma.conditionId !== market.conditionId ||
      clob.condition_id !== market.conditionId || clob.market_slug !== market.slug ||
      Date.parse(gamma.endDate) !== market.end || market.resolutionSource !== resolutionSource ||
      gamma.resolutionSource !== resolutionSource ||
      gamma.description !== market.rules)
    throw Error('财务结算身份、时间或规则不一致');
  if (gamma.closed !== true || gamma.umaResolutionStatus !== 'resolved' || clob.closed !== true) return null;
  const outcomes = array(gamma.outcomes), ids = array(gamma.clobTokenIds), prices = array(gamma.outcomePrices);
  if (!Array.isArray(outcomes) || !Array.isArray(ids) || !Array.isArray(prices) ||
      outcomes.length !== 2 || ids.length !== 2 || prices.length !== 2 ||
      new Set(outcomes).size !== 2 || new Set(ids).size !== 2 ||
      !['Up', 'Down'].every(outcome => outcomes.includes(outcome)) ||
      !Array.isArray(clob.tokens) || clob.tokens.length !== 2 ||
      new Set(clob.tokens.map(token => token.outcome)).size !== 2 || clob.is_50_50_outcome === true)
    throw Error('不支持的财务结算支付结构');
  for (const outcome of ['Up', 'Down']) {
    const index = outcomes.indexOf(outcome), token = clob.tokens.find(t => t.outcome === outcome);
    if (ids[index] !== market.tokens[outcome] || token?.token_id !== market.tokens[outcome] ||
        typeof token.winner !== 'boolean' || paymentNumber(prices[index]) !== Number(token.winner) ||
        paymentNumber(token.price) !== Number(token.winner))
      throw Error('官方财务支付结果或 token 映射冲突');
  }
  const winners = clob.tokens.filter(token => token.winner);
  if (winners.length !== 1) throw Error('缺少唯一官方财务赢家');
  const winner = winners[0].outcome;
  const event = Array.isArray(gamma.events) ? gamma.events.find(e => e.slug === market.slug) : null;
  const opening = metadataPrice(event?.eventMetadata?.priceToBeat);
  const final = metadataPrice(event?.eventMetadata?.finalPrice);
  let priceCrossCheck = 'missing-price-metadata';
  if (opening !== null && final !== null) {
    if (Math.abs(final - opening) <= 1e-7) priceCrossCheck = 'ambiguous-display-precision';
    else {
      if ((final > opening ? 'Up' : 'Down') !== winner) throw Error('官方价格与财务赢家明确矛盾');
      priceCrossCheck = 'consistent';
    }
  }
  return { version: 'paper-official-payout-v1', scope: 'paper-financial-only',
    slug: market.slug, conditionId: market.conditionId, tokens: { Up: market.tokens.Up, Down: market.tokens.Down },
    start: market.start, end: market.end, winner,
    payouts: { Up: Number(winner === 'Up'), Down: Number(winner === 'Down') },
    opening, final, observedAt, closedAt: Date.parse(gamma.closedTime ?? event?.closedTime) || null,
    priceCrossCheck, source: 'Gamma resolved + CLOB canonical payout; paper financial only; onchain redemption unconfirmed' };
}
