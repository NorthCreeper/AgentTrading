import { Lifecycle } from './lifecycle.mjs';
import { PaperBroker, round } from './paper-broker.mjs';

// Execution exercise only: one small Up buy/sell cycle per round, no forecasting claim.
// Live observation intentionally assumes NO maker fills (REST snapshots cannot reveal queue fills).
export class PaperDriver {
  broker = new PaperBroker();
  attempted = new Set();
  enteredAt = null;
  exitSequence = 0;
  constructor(journal) { this.engine = new Lifecycle(this.broker, { journal }); }
  async frame(frame) {
    const { now, market, books, twap } = frame;
    for (const book of books) this.broker.setBook(book);
    const referenceFresh = twap && now >= twap.timestamp && now - twap.timestamp <= 5000 &&
      now >= twap.receivedAt && now - twap.receivedAt <= 5000;
    await this.engine.tick(now, { stop: !referenceFresh });
    if (this.engine.active || this.engine.halted) return;
    const held = this.engine.holdings.get(market.tokens.Up) ?? 0;
    const book = books.find(b => b.tokenId === market.tokens.Up);
    if (!book?.bids.length || !book?.asks.length) return;
    if (held > 0 && this.enteredAt === null) this.enteredAt = now;
    if (held >= market.minSize && (now - this.enteredAt >= 15_000 || now >= market.end - 35_000)) {
      // Exit can proceed on a fresh book even if the reference feed is unavailable.
      await this.engine.start({ id: `exit-${market.slug}-${++this.exitSequence}`, tokenId: market.tokens.Up,
        side: 'sell', size: held, makerPrice: book.asks[0][0],
        limit: round(Math.max(market.tick, book.bids[0][0] - market.tick)),
        mode: now < market.end - 35_000 && referenceFresh ? 'maker_then_taker' : 'taker', makerMs: 2000 }, market, now);
      return;
    }
    if (this.attempted.has(market.slug) || this.engine.holdings.size > 0 || !referenceFresh ||
        now >= market.end - 90_000) return;
    const accepted = await this.engine.start({ id: `entry-${market.slug}`, tokenId: market.tokens.Up,
      side: 'buy', size: market.minSize, makerPrice: book.bids[0][0],
      limit: round(Math.min(1 - market.tick, book.asks[0][0] + market.tick)),
      mode: 'maker_then_taker', makerMs: 10_000 }, market, now);
    if (accepted) { this.attempted.add(market.slug); this.enteredAt = null; }
  }
  async stop(now) { await this.engine.tick(now, { stop: true }); }
}
