export const WINDOW_MS = 600_000;
export const GAP_MS = 5000;

export function trimHistory(rows, now, key = 'time') {
  return rows.filter(row => Number.isFinite(row[key]) && row[key] >= now - WINDOW_MS && row[key] <= now)
    .sort((a, b) => a[key] - b[key]).slice(-2400);
}

export function chartWindow(state, selection = 'round') {
  const lastObserved = Math.max(state.frame?.now ?? 0, state.priceHistory?.at(-1)?.time ?? 0);
  const end = state.running ? state.now : (lastObserved || state.now);
  const market = state.frame?.market;
  return selection === 'round' && market ? { start: market.start, end: market.end, observedUntil: end, slug: market.slug } :
    { start: end - WINDOW_MS, end, observedUntil: end, slug: null };
}

export function chartRows(rows, window) {
  return rows.filter(row => row.time >= window.start && row.time <= window.end && row.time <= window.observedUntil &&
    (!window.slug || row.slug === window.slug)).sort((a, b) => a.time - b.time);
}

export function segments(rows, key, { splitRounds = true } = {}) {
  const result = []; let current = [], previous;
  for (const row of rows) {
    if (!Number.isFinite(row[key])) { if (current.length) result.push(current); current = []; previous = null; continue; }
    if (previous && (row.time - previous.time > GAP_MS || (splitRounds && row.slug !== previous.slug) || row.time <= previous.time)) {
      result.push(current); current = [];
    }
    current.push(row); previous = row;
  }
  if (current.length) result.push(current);
  return result;
}

export function axisTimes(window, count = 5) {
  return Array.from({ length: count }, (_, i) => window.start + (window.end - window.start) * i / (count - 1));
}

export function e18ToPrice(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const decimal = value.padStart(19,'0');
  const price = Number(decimal.slice(0,-18) + '.' + decimal.slice(-18));
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function openingReference(prices, market) {
  if (!market) return null;
  // Never substitute the first observation after reconnecting for the round's opening price.
  const exact = prices.find(row => row.time === market.start);
  return exact ? { valueE18: exact.valueE18, time: exact.time, source: 'Chainlink 开盘时刻采样' } : null;
}

// Display-only interpolation. The recorded observations and trading inputs stay untouched.
export function canAnimate(previous, next, keys, splitRounds = true) {
  const a=previous.at(-1), b=next.at(-1);
  if (!a || !b || b.time<a.time || b.time-a.time>GAP_MS) return false;
  if (splitRounds && a.slug!==b.slug) return false;
  let last=a;
  for (const row of next.filter(r=>r.time>=a.time)) {
    if (row.time-last.time>GAP_MS || (splitRounds && row.slug!==last.slug) ||
        keys.some(key=>!Number.isFinite(row[key]))) return false;
    last=row;
  }
  return keys.every(key=>Number.isFinite(a[key])&&Number.isFinite(b[key]));
}

export function revealRows(previous, next, progress, keys, splitRounds = true) {
  if (progress>=1 || !canAnimate(previous,next,keys,splitRounds)) return next;
  const a=previous.at(-1), b=next.at(-1), p=Math.max(0,progress);
  if (b.time===a.time) return next;
  const cutoff=a.time+(b.time-a.time)*p;
  const tail=[a,...next.filter(r=>r.time>a.time)];
  const left=tail.findLast(r=>r.time<=cutoff), right=tail.find(r=>r.time>cutoff);
  const result=next.filter(r=>r.time<=a.time);
  if (result.at(-1)?.time!==a.time) result.push(a);
  result.push(...tail.slice(1).filter(r=>r.time<=cutoff));
  if (right && cutoff>left.time) {
    const fraction=(cutoff-left.time)/(right.time-left.time), point={...right,time:cutoff};
    for (const key of keys) point[key]=left[key]+(right[key]-left[key])*fraction;
    result.push(point);
  }
  return result;
}

export function stableRange(previous, low, high) {
  if (!previous) return {low,high};
  if (low<previous.low || high>previous.high) return {low:Math.min(low,previous.low),high:Math.max(high,previous.high)};
  return high-low<(previous.high-previous.low)*.55 ? {low,high} : previous;
}
