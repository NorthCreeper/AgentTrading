import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Compare only deterministic execution events and account state, not transport diagnostics.
const [sourceArg, replayArg] = process.argv.slice(2);
if (!sourceArg || !replayArg) throw new Error('Usage: node verify-replay.mjs source-session replay-session');
const source = resolve(sourceArg), replay = resolve(replayArg);
const events = folder => readFileSync(join(folder, 'events.jsonl'), 'utf8').trim().split(/\r?\n/)
  .map(line => JSON.parse(line)).filter(e => ['submit', 'cancel', 'report', 'complete', 'halt'].includes(e.type));
const summary = folder => JSON.parse(readFileSync(join(folder, 'summary.json'), 'utf8'));
const original = summary(source), reproduced = summary(replay);
assert.equal(original.realTrading, false);
assert.equal(original.paperOnLiveData, true, 'Source must contain a paper run on recorded market data');
assert.equal(reproduced.mode, 'replay');
assert.ok(original.counts.frame > 0);
assert.ok(original.orderCount > 0, 'Do not pass an empty execution replay');
assert.equal(reproduced.counts.frame, original.counts.frame, 'Frame count differs');
const originalEvents = events(source), replayEvents = events(replay);
assert.deepEqual(replayEvents, originalEvents, 'Execution event sequence differs');
for (const key of ['active', 'halted', 'holdings', 'cash', 'fees', 'markets', 'orderCount'])
  assert.deepEqual(reproduced[key], original[key], `Account field differs: ${key}`);
const result = { passed: true, source, replay, executionEventsCompared: originalEvents.length,
  framesCompared: original.counts.frame, orderCount: original.orderCount,
  finalHoldings: original.holdings, finalCash: original.cash, fees: original.fees };
writeFileSync(join(replay, 'replay-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
