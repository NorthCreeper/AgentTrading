// A market's five-minute window is identity evidence, not a rounded fill clock.
export const marketWindowVersion = 'btc5m-market-window-v1';
const timezone = 'Asia/Hong_Kong';
const duration = 300_000;
const isMilliseconds = value => typeof value === 'number' && Number.isSafeInteger(value) &&
  value >= 100_000_000_000 && value <= 8_640_000_000_000_000;
const exists = value => value !== undefined && value !== null;
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);

export function marketWindowFor(record) {
  const input = ownObject(record) ? record : {};
  const direct = input.version === marketWindowVersion;
  const market = ownObject(input.market) ? input.market : {};
  const captured = direct ? input : ownObject(input.marketWindow) ? input.marketWindow : null;
  const issues = [];
  const add = issue => { if (!issues.includes(issue)) issues.push(issue); };
  const slugs = [direct ? null : input.slug, market.slug, captured?.slug].filter(exists);
  const slug = slugs.find(value => typeof value === 'string') ?? null;
  const result = (status, start = null, end = null, source = 'unavailable') => ({
    version: marketWindowVersion, status, slug, start, end, timezone, source, issues: [...issues]
  });
  if (slugs.some(value => typeof value !== 'string' || value !== slug)) add('slug-conflict');
  const match = typeof slug === 'string' ? /^btc-updown-5m-(\d{10})$/.exec(slug) : null;
  const seconds = match ? Number(match[1]) : null;
  const slugStart = seconds === null ? null : seconds * 1000;
  if (slug !== null && (!match || match[0] !== slug || seconds % 300 !== 0 || !isMilliseconds(slugStart))) add('invalid-btc5m-slug');

  if (captured) {
    if (captured.version !== marketWindowVersion) add('annotation-version-invalid');
    if (captured.timezone !== timezone) add('annotation-timezone-invalid');
    if (!['recorded', 'slug-derived', 'unknown', 'conflict'].includes(captured.status)) add('annotation-status-invalid');
    if (captured.status === 'conflict') add('annotation-conflict');
  }
  const evidence = [];
  if (exists(market.start)) evidence.push(['start', market.start, 'market.start']);
  if (exists(market.end)) evidence.push(['end', market.end, 'market.end']);
  if (captured) {
    if (exists(captured.start)) evidence.push(['start', captured.start, 'marketWindow.start']);
    if (exists(captured.end)) evidence.push(['end', captured.end, 'marketWindow.end']);
  }
  for (const [edge, value] of evidence) {
    if (!isMilliseconds(value)) add(`${edge}-not-milliseconds`);
    else if (slugStart !== null && match && value !== slugStart + (edge === 'end' ? duration : 0)) add(`${edge}-slug-conflict`);
  }
  const starts = evidence.filter(([edge, value]) => edge === 'start' && isMilliseconds(value)).map(([, value]) => value);
  const ends = evidence.filter(([edge, value]) => edge === 'end' && isMilliseconds(value)).map(([, value]) => value);
  if (new Set(starts).size > 1) add('start-conflict');
  if (new Set(ends).size > 1) add('end-conflict');
  if (starts.length && ends.length && ends[0] - starts[0] !== duration) add('duration-not-five-minutes');

  const tokens = ownObject(market.tokens) ? market.tokens : null;
  const tokenId = input.tokenId;
  const outcome = input.outcome ?? market.outcome;
  if (tokens && exists(tokenId)) {
    const identities = ['Up', 'Down'].map(side => tokens[side]).filter(exists);
    if (identities.length && !identities.includes(tokenId)) add('token-market-conflict');
    if (['Up', 'Down'].includes(outcome) && exists(tokens[outcome]) && tokens[outcome] !== tokenId) add('token-outcome-conflict');
    if (exists(tokens.Up) && tokens.Up === tokens.Down) add('duplicate-market-token');
  }
  if (exists(input.outcome) && exists(market.outcome) && input.outcome !== market.outcome) add('outcome-conflict');
  if (issues.length) return result('conflict', null, null, 'conflicting-evidence');
  if (slugStart === null) {
    add('market-slug-missing');
    return result('unknown');
  }
  const fullRecordedMarket = isMilliseconds(market.start) && isMilliseconds(market.end);
  const fullRecordedAnnotation = captured?.status === 'recorded' && isMilliseconds(captured.start) && isMilliseconds(captured.end);
  if (fullRecordedMarket) return result('recorded', market.start, market.end, 'market.start/end');
  if (fullRecordedAnnotation) return result('recorded', captured.start, captured.end, 'recorded-market-window');
  return result('slug-derived', slugStart, slugStart + duration,
    evidence.length ? 'btc5m-slug+partial-record' : 'btc5m-slug');
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
function dateParts(ms) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(ms).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
export function formatRecordedTime(ms) {
  return isMilliseconds(ms) ? `${dateParts(ms)}.${String(ms % 1000).padStart(3, '0')} HKT` : '未记录 / 无法核实';
}
export function formatMarketWindow(recordOrWindow) {
  const window = marketWindowFor(recordOrWindow);
  if (window.status === 'conflict') return '盘口时间证据冲突 · 待核实';
  if (window.status === 'unknown') return '盘口时间未记录 · 无法核实';
  return `${dateParts(window.start)} → ${dateParts(window.end)} HKT${window.status === 'slug-derived' ? ' · 由盘口标识推导' : ''}`;
}
