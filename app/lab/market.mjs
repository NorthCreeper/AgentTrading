// Public data only. Never infer a round's outcome from a spot exchange price.
export const roundStart = now => Math.floor(now / 300_000) * 300;
export const roundSlug = now => `btc-updown-5m-${roundStart(now)}`;
const array = value => Array.isArray(value) ? value : JSON.parse(value);
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export function normalizeMarket(gamma, clob, now) {
  const start = roundStart(now) * 1000;
  if (gamma.slug !== roundSlug(now)) throw new Error('Wrong BTC five-minute round');
  if (!gamma.active || gamma.closed || gamma.acceptingOrders !== true || clob.ao !== true)
    throw new Error('Market is not accepting orders');
  if (Date.parse(gamma.endDate) !== start + 300_000) throw new Error('Round expiry mismatch');
  if (!gamma.conditionId || clob.c !== gamma.conditionId) throw new Error('Condition ID mismatch');
  const outcomes = array(gamma.outcomes);
  const ids = array(gamma.clobTokenIds);
  if (outcomes.length !== 2 || ids.length !== 2 || new Set(ids).size !== 2)
    throw new Error('Expected two distinct outcome tokens');
  const tokens = {};
  for (const outcome of ['Up', 'Down']) {
    const index = outcomes.indexOf(outcome);
    const token = ids[index];
    if (typeof token !== 'string' || !/^\d+$/.test(token) ||
        !clob.t?.some(t => t.o === outcome && t.t === token))
      throw new Error('Gamma/CLOB outcome mapping mismatch');
    tokens[outcome] = token;
  }
  if (!positive(clob.mts) || Number(clob.mts) >= 1 || !positive(clob.mos))
    throw new Error('Missing tick size or minimum order size');
  if (!clob.fd || !Number.isFinite(clob.fd.r) || clob.fd.r < 0 ||
      !Number.isFinite(clob.fd.e) || clob.fd.e <= 0 || clob.fd.to !== true)
    throw new Error('Unknown fee model: do not assume zero fees');
  if (typeof gamma.negRisk !== 'boolean') throw new Error('Missing negative-risk flag');
  const source = new URL(gamma.resolutionSource);
  if (source.hostname !== 'data.chain.link' || source.pathname !== '/streams/btc-usd-twap-60s-streams')
    throw new Error('Unrecognized resolution feed; review market rules');
  return {
    slug: gamma.slug, conditionId: gamma.conditionId, tokens, start, end: start + 300_000,
    tick: Number(clob.mts), minSize: Number(clob.mos), negRisk: gamma.negRisk,
    fee: { rate: clob.fd.r, exponent: clob.fd.e },
    resolutionSource: gamma.resolutionSource, rules: gamma.description,
  };
}

export function normalizeBook(raw, market, tokenId, receivedAt) {
  if (raw.asset_id !== tokenId || raw.market !== market.conditionId)
    throw new Error('Order book identity mismatch');
  const levels = (rows, descending) => {
    if (!Array.isArray(rows)) throw new Error('Missing order book levels');
    return rows.map(({ price, size }) => {
      const p = Number(price), q = Number(size);
      if (!Number.isFinite(p) || p <= 0 || p >= 1 || !positive(q))
        throw new Error('Invalid book level');
      return [p, q];
    }).sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]);
  };
  const bids = levels(raw.bids, true), asks = levels(raw.asks, false);
  if (bids.length && asks.length && bids[0][0] >= asks[0][0]) throw new Error('Crossed book');
  const timestamp = Number(raw.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > receivedAt + 2000) throw new Error('Invalid book time');
  if (Number(raw.tick_size) !== market.tick || Number(raw.min_order_size) !== market.minSize)
    throw new Error('Market parameters changed; refresh metadata');
  return { tokenId, bids, asks, timestamp, receivedAt };
}

// The two current /book responses are authoritative for the active tick.
// Metadata may lag a live tick-size change; never mix identities or parameters.
export function normalizeBookPair(raws, market, receivedAt, { allowStale = false } = {}) {
  const ids=Object.values(market.tokens);
  if(raws.length!==2 || new Set(raws.map(r=>r.asset_id)).size!==2 ||
    raws.some(r=>!ids.includes(r.asset_id)||r.market!==market.conditionId))
    throw Error('Order book identity mismatch');
  const tick=Number(raws[0].tick_size), minSize=Number(raws[0].min_order_size);
  if(![.1,.01,.005,.0025,.001,.0001].includes(tick) || !Number.isFinite(minSize) || minSize<=0 ||
    raws.some(r=>Number(r.tick_size)!==tick||Number(r.min_order_size)!==minSize))
    throw Error('Outcome book parameters disagree; retry a synchronized pair');
  const effective={...market,tick,minSize};
  const books=raws.map(r=>normalizeBook(r,effective,r.asset_id,receivedAt));
  // Display may retain a validated old snapshot. Never refresh its source time:
  // execution and research still apply their own freshness checks.
  if(!allowStale && books.some(b=>receivedAt-b.timestamp>3000))throw Error('Order book parameters are stale');
  return {market:effective,books};
}

export function normalizeTwap(message, receivedAt) {
  const p = message.payload;
  if (message.topic !== 'crypto_prices_twap_sixty' || p?.symbol !== 'btc/usd') return null;
  // The live service can send a subscription history envelope. Wait for an actual update.
  if (message.type && message.type !== 'update') return null;
  if (p.window_s !== 60 || typeof p.full_accuracy_value !== 'string' ||
      !/^\d+$/.test(p.full_accuracy_value)) throw new Error('Invalid TWAP precision/window');
  const timestamp = Number(p.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > receivedAt + 2000) throw new Error('Invalid TWAP time');
  // Preserve the exact E18 value; do not round through a JS floating-point number.
  return { valueE18: p.full_accuracy_value, timestamp, receivedAt, windowSeconds: 60 };
}
