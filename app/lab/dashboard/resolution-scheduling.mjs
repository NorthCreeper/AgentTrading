// Scheduling only: this module cannot certify results, credit money or create labels.
// Keep one in-flight selection in the caller and update checkedAt before the request.
export function selectResolutionCheck({ queue, now, ownedSlugs = new Set(), priorityStreak = 0,
  expiryGraceMs = 0, retryMs = 60_000 } = {}) {
  if (![now, expiryGraceMs, retryMs].every(Number.isFinite) || now < 0 || expiryGraceMs < 0 || retryMs < 0)
    throw new RangeError('Invalid resolution scheduling time');
  if (!Number.isInteger(priorityStreak) || priorityStreak < 0 || priorityStreak > 3)
    throw new RangeError('Invalid resolution priority streak');
  if (!(ownedSlugs instanceof Set) && !Array.isArray(ownedSlugs))
    throw new TypeError('ownedSlugs must be a Set or array');
  const owned = ownedSlugs instanceof Set ? ownedSlugs : new Set(ownedSlugs);
  const rows = queue instanceof Map ? [...queue.values()] : Array.isArray(queue) ? [...queue] : [];
  const eligible = rows.filter(row => {
    const end = row?.market?.end, checkedAt = row?.checkedAt ?? 0;
    return typeof row?.market?.slug === 'string' && row.market.slug.length > 0 &&
      Number.isFinite(end) && Number.isFinite(checkedAt) && checkedAt >= 0 &&
      end + expiryGraceMs <= now && checkedAt <= now &&
      (checkedAt === 0 || checkedAt + retryMs <= now);
  }).sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0) || a.market.end - b.market.end ||
    (a.market.slug < b.market.slug ? -1 : a.market.slug > b.market.slug ? 1 : 0));
  const priority = eligible.filter(row => owned.has(row.market.slug));
  const background = eligible.filter(row => !owned.has(row.market.slug));
  let next = null, reason = 'none', nextStreak = priorityStreak;
  if (background.length && (priorityStreak === 3 || !priority.length)) {
    next = background[0]; reason = priority.length ? 'background-fairness' : 'background-only'; nextStreak = 0;
  } else if (priority.length) {
    next = priority[0]; reason = background.length ? 'owned-priority' : 'owned-only';
    nextStreak = Math.min(3, priorityStreak + 1);
  }
  return { next, priorityStreak: nextStreak, reason, eligible: eligible.length,
    eligibleOwned: priority.length, eligibleBackground: background.length };
}
