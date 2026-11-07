import { round } from '../paper-broker.mjs';

const epsilon = 1e-8;
const finiteNonnegative = value => Number.isFinite(value) && value >= 0;
const entries = value => value instanceof Map ? [...value.entries()] : Object.entries(value ?? {});
const values = value => Array.isArray(value) ? value : value instanceof Map ? [...value.values()] : Object.values(value ?? {});
const outcomes = ['Up', 'Down'];

// Account cash also contains funding and other positions' flows. A position's
// financial result can therefore use only its own cumulative fill reports.
// Null means the evidence is incomplete or inconsistent; it is not zero PnL.
export function managedCashflows(trade) {
  if (!trade || typeof trade.tokenId !== 'string' || !trade.tokenId) return null;
  const reports = new Map();
  for (const report of values(trade.orderReports)) {
    if (!report || typeof report.id !== 'string' || !report.id || report.tokenId !== trade.tokenId ||
        !['buy', 'sell'].includes(report.side) ||
        !['filled', 'notional', 'fees'].every(key => finiteNonnegative(report[key])) ||
        report.notional > report.filled + epsilon ||
        (report.filled === 0 && (report.notional !== 0 || report.fees !== 0)) ||
        (report.filled > 0 && report.notional <= 0)) return null;
    const prior = reports.get(report.id);
    if (prior && (prior.side !== report.side ||
        ['filled', 'notional', 'fees'].some(key => report[key] < prior[key] - epsilon))) return null;
    reports.set(report.id, report);
  }
  const unique = [...reports.values()];
  const total = (side, field) => round(unique.filter(report => report.side === side).reduce((sum, report) => sum + report[field], 0));
  const bought = total('buy', 'filled'), sold = total('sell', 'filled');
  if (!(bought > 0) || sold > bought + epsilon) return null;
  const buyNotional = total('buy', 'notional'), sellNotional = total('sell', 'notional');
  const buyFees = total('buy', 'fees'), sellFees = total('sell', 'fees');
  const buyCost = round(buyNotional + buyFees), sellNet = round(sellNotional - sellFees);
  if (![bought, sold, buyNotional, sellNotional, buyFees, sellFees, buyCost, sellNet].every(Number.isFinite)) return null;
  let settlementSize = 0, settlementPayout = 0;
  if (trade.settlement !== undefined && trade.settlement !== null) {
    const settlement = trade.settlement;
    if (!finiteNonnegative(settlement.size) || !finiteNonnegative(settlement.payout) ||
        settlement.size > bought - sold + epsilon || settlement.payout > settlement.size + epsilon ||
        (settlement.size === 0 && settlement.payout !== 0)) return null;
    settlementSize = settlement.size; settlementPayout = settlement.payout;
  }
  const remaining = round(Math.max(0, bought - sold - settlementSize));
  return { bought, sold, buyNotional, sellNotional, buyFees, sellFees, fees: round(buyFees + sellFees),
    buyCost, sellNet, settlementSize, settlementPayout, remaining,
    net: round(sellNet + settlementPayout - buyCost), costPerShare: buyCost / bought,
    orderReports: unique.map(report => structuredClone(report)) };
}

// The label must come from the verified settlement service. These checks also
// bind that service's label to the complete identity of this owned position.
export function validManagedSettlement(trade, label, now) {
  const market = trade?.market;
  const financialOnly = label?.version === 'paper-official-payout-v1' && label?.scope === 'paper-financial-only';
  if (!market || !label || !Number.isFinite(now) ||
      !/^btc-updown-5m-\d+$/.test(market.slug ?? '') ||
      Number(market.slug.split('-').at(-1)) * 1000 !== market.start ||
      !Number.isFinite(market.start) || market.end !== market.start + 300_000 ||
      trade.slug !== market.slug || label.slug !== market.slug ||
      typeof market.conditionId !== 'string' || !market.conditionId || label.conditionId !== market.conditionId ||
      label.start !== market.start || label.end !== market.end ||
      !outcomes.includes(trade.outcome) || !outcomes.includes(label.winner) ||
      market.tokens?.Up === market.tokens?.Down ||
      outcomes.some(outcome => typeof market.tokens?.[outcome] !== 'string' || !market.tokens[outcome] ||
        label.tokens?.[outcome] !== market.tokens[outcome] || label.payouts?.[outcome] !== Number(label.winner === outcome)) ||
      trade.tokenId !== market.tokens[trade.outcome] ||
      !Number.isFinite(label.observedAt) || label.observedAt < market.end || label.observedAt > now || now < market.end) return false;
  // Explicit financial-only labels certify final payout through the separate
  // official payout verifier. They never authorize missing-metadata research
  // labels, and do not infer a financial payout from BTC prices.
  if (!financialOnly && (!Number.isFinite(label.opening) || label.opening <= 0 ||
      !Number.isFinite(label.final) || label.final <= 0 || Math.abs(label.final - label.opening) < 1e-7 ||
      (label.final >= label.opening ? 'Up' : 'Down') !== label.winner)) return false;
  // An optional, already observed opening is an additional consistency check.
  // No opening is reconstructed from subsequent prices or from the winner.
  const opening = trade.entryOpening ?? trade.opening ?? market.opening ?? market.priceToBeat;
  if (opening === undefined || opening === null) return true;
  if (!Number.isFinite(opening) || opening <= 0) return false;
  if (financialOnly && (label.opening === undefined || label.opening === null)) return true;
  return Number.isFinite(label.opening) && label.opening > 0 && Math.abs(label.opening - opening) <= 0.00001;
}

// Parking changes management ownership, never financial inventory. All owned
// tokens still consume exposure; any unknown ownership continues to block entry.
export function managedInventory({trade = null, activeTrades = [], pendingSettlements = [], holdings = {}, inventoryCost = {}, now}) {
  const pending = values(pendingSettlements), claims = new Map(), costs = new Map(entries(inventoryCost));
  const add = (position, kind) => {
    if (!position || typeof position.tokenId !== 'string' || !position.tokenId) return;
    const prior = claims.get(position.tokenId) ?? [];
    prior.push({trade: position, kind}); claims.set(position.tokenId, prior);
  };
  add(trade, 'active'); for (const position of values(activeTrades)) add(position, 'active');
  for (const position of pending) add(position, 'pending');
  const positions = [], activeTokens = [], pendingTokens = [], unmanagedTokens = [], conflictingTokens = [];
  let totalCost = 0, activeCost = 0, pendingCost = 0, unmanagedCost = 0, unknownCost = false;
  for (const [tokenId, size] of entries(holdings)) {
    if (size === 0) continue;
    const ownership = claims.get(tokenId) ?? [], owner = ownership.length === 1 ? ownership[0] : null;
    const validSize = Number.isFinite(size) && size > 0;
    const market = owner?.trade.market ?? null;
    const matching = owner && owner.trade.id && owner.trade.slug === market?.slug &&
      outcomes.includes(owner.trade.outcome) && market?.tokens?.[owner.trade.outcome] === tokenId &&
      /^btc-updown-5m-\d+$/.test(market.slug??'') && Number(market.slug.split('-').at(-1))*1000===market.start &&
      Number.isFinite(market.start) && market.end===market.start+300000 &&
      typeof market.conditionId==='string' && market.conditionId.length>0 &&
      outcomes.every(o=>typeof market.tokens?.[o]==='string'&&market.tokens[o]) && market.tokens.Up!==market.tokens.Down && Number.isFinite(now);
    const expired = matching ? now >= market.end : null;
    const flow = matching ? managedCashflows(owner.trade) : null;
    const sizeMatches = Boolean(flow && validSize && Math.abs(flow.remaining - size) <= epsilon);
    const recordedCost = costs.get(tokenId), costKnown = finiteNonnegative(recordedCost);
    const expectedCost = flow && validSize ? round(flow.costPerShare * size) : null;
    const costMatches = Boolean(costKnown && Number.isFinite(expectedCost) &&
      Math.abs(recordedCost - expectedCost) <= 1e-7 * Math.max(1, expectedCost));
    const kind = validSize && matching && sizeMatches && (costMatches || !costKnown) &&
      (owner.kind === 'active' || expired) ? owner.kind : 'unmanaged';
    // Unknown cost uses the maximum possible payout as a conservative risk
    // bound, never as NAV or as an invented acquisition cash flow.
    const cost = costKnown ? recordedCost : validSize ? size : null;
    if (!costKnown) unknownCost = true;
    if (cost !== null) totalCost += cost;
    if (ownership.length > 1) conflictingTokens.push(tokenId);
    if (kind === 'active') {activeTokens.push(tokenId); activeCost += cost ?? 0;}
    else if (kind === 'pending') {pendingTokens.push(tokenId); pendingCost += cost ?? 0;}
    else {unmanagedTokens.push(tokenId); unmanagedCost += cost ?? 0;}
    positions.push({tokenId, size, cost: cost === null ? null : round(cost), costKnown, kind,
      phase: kind === 'pending' ? 'awaiting-resolution' : kind === 'active' ? expired ? 'active-expired' : 'tradable-holding' : 'unmanaged-holding',
      expired, tradeId: owner?.trade.id ?? null, origin: owner?.trade.origin ?? 'automatic', market,
      sizeMatches, costMatches, ownershipClaims: ownership.length});
  }
  return {positions, activeTokens, pendingTokens, unmanagedTokens, conflictingTokens,
    count: positions.length, activeCount: activeTokens.length, pendingCount: pendingTokens.length, unmanagedCount: unmanagedTokens.length,
    totalCost: round(totalCost), activeCost: round(activeCost), pendingCost: round(pendingCost), unmanagedCost: round(unmanagedCost),
    unknownCost, costKnown: !unknownCost,
    entryBlocked: Boolean(trade) || activeTokens.length > 0 || unmanagedTokens.length > 0 || unknownCost};
}
