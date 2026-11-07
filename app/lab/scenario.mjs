import { PaperBroker } from './paper-broker.mjs';
import { Lifecycle } from './lifecycle.mjs';

export const fixtureMarket = {
  slug: 'btc-updown-5m-1788786000', conditionId: 'fixture-condition',
  tokens: { Up: '101', Down: '102' }, start: 1788786000000, end: 1788786300000,
  tick: 0.01, minSize: 5, negRisk: false, fee: { rate: 0.07, exponent: 1 },
};
export function bookAt(now, { bids = [[0.48, 3]], asks = [[0.50, 100]] } = {}) {
  return { tokenId: '101', bids, asks, timestamp: now, receivedAt: now };
}
export const intentAt = (overrides = {}) => ({ id: 'entry-1', tokenId: '101', side: 'buy', size: 10,
  makerPrice: 0.48, limit: 0.51, mode: 'maker_then_taker', makerMs: 10_000, ...overrides });

export async function runScenario(journal = () => {}) {
  const broker = new PaperBroker();
  const engine = new Lifecycle(broker, { journal });
  const t = fixtureMarket.start + 20_000;
  broker.setBook(bookAt(t));
  await engine.start(intentAt(), fixtureMarket, t);
  // Three shares ahead of us; the next two shares fill our maker order.
  broker.trade({ tokenId: '101', price: 0.48, size: 5, side: 'sell', timestamp: t + 1000 });
  await engine.tick(t + 1000);
  broker.setBook(bookAt(t + 10_000));
  await engine.tick(t + 10_000); // cancel, confirm, FAK buy remaining eight shares
  broker.setBook(bookAt(t + 20_000, { bids: [[0.54, 100]], asks: [[0.56, 3]] }));
  await engine.start(intentAt({ id: 'exit-1', side: 'sell', makerPrice: 0.56, limit: 0.53 }),
    fixtureMarket, t + 20_000);
  broker.trade({ tokenId: '101', price: 0.56, size: 5, side: 'buy', timestamp: t + 21_000 });
  await engine.tick(t + 21_000);
  broker.setBook(bookAt(t + 30_000, { bids: [[0.54, 100]], asks: [[0.56, 3]] }));
  await engine.tick(t + 30_000);
  return { label: 'Synthetic execution fixture; not a profitability backtest', ...engine.snapshot(),
    orders: [...broker.orders.values()] };
}
