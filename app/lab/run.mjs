import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeMarket, normalizeBook, normalizeTwap, roundSlug } from './market.mjs';
import { runScenario } from './scenario.mjs';
import { PaperDriver } from './driver.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0] ?? 'demo';
const option = key => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
if (!['demo', 'observe', 'replay'].includes(command)) throw new Error('Use demo, observe or replay; no live trading command exists.');
const allowed = command === 'observe' ? ['--seconds', '--paper'] : command === 'replay' ? ['--input'] : [];
for (let i = 1; i < args.length; i++) {
  if (!allowed.includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  if (args[i] !== '--paper') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value: ${args[i]}`);
    i++;
  }
}
const seconds = Number(option('--seconds') ?? 360);
if (!Number.isFinite(seconds) || seconds < 5 || seconds > 86400) throw new Error('Seconds must be between 5 and 86400');
const output = join(base, 'sessions', `${new Date().toISOString().replace(/[:.]/g, '-')}-${command}`);
mkdirSync(output, { recursive: true });
const eventsPath = join(output, 'events.jsonl');
const counts = {};
const markets = new Set();
const journal = event => {
  counts[event.type] = (counts[event.type] ?? 0) + 1;
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
};
const driver = new PaperDriver(journal);
let stopped = false;
let lastTwap = null;
let socket = null, reconnect = null, ping = null, watchdog = null;
let socketConnected = false;
let lastMessageAt = 0;
let finishing = false;
let lastFrameAt = null;
let summary = {};

function connectTwap() {
  if (stopped || finishing) return;
  const ws = new WebSocket('wss://ws-live-data.polymarket.com');
  socket = ws;
  socketConnected = false;
  let opened = false;
  watchdog = setTimeout(() => ws.close(), 15_000);
  ws.addEventListener('open', () => {
    opened = true; socketConnected = true; lastMessageAt = Date.now();
    clearTimeout(watchdog);
    journal({ type: 'twap_connected', now: Date.now() });
    ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_twap_sixty',
      type: 'update', filters: JSON.stringify({ symbol: 'btc/usd' }) }] }));
    ping = setInterval(() => {
      if (Date.now() - lastMessageAt > 15_000) { ws.close(); return; }
      if (ws.readyState === WebSocket.OPEN) ws.send('PING');
    }, 5000);
  });
  ws.addEventListener('message', event => {
    lastMessageAt = Date.now();
    if (typeof event.data !== 'string' || !event.data.trim() || event.data.trim() === 'PONG') return;
    try {
      const raw = JSON.parse(event.data);
      journal({ type: 'twap_raw', now: Date.now(), raw });
      const value = normalizeTwap(raw, Date.now());
      if (value && (!lastTwap || value.timestamp >= lastTwap.timestamp)) lastTwap = value;
    } catch (error) { journal({ type: 'twap_error', now: Date.now(), error: error.message }); }
  });
  ws.addEventListener('error', () => {
    journal({ type: 'twap_connection_error', now: Date.now() });
    ws.close();
  });
  ws.addEventListener('close', () => {
    socketConnected = false; lastTwap = null;
    clearInterval(ping); clearTimeout(watchdog);
    journal({ type: 'twap_gap', now: Date.now(), opened });
    if (!stopped && !finishing) reconnect = setTimeout(connectTwap, 2000);
  });
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`${response.status} ${new URL(url).pathname}`);
  return response.json();
}

process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
console.log(`模式：${command}；真实交易关闭。结果目录：${output}`);
try {
  if (command === 'demo') {
    summary = await runScenario(journal);
  } else if (command === 'replay') {
    const input = option('--input');
    if (!input) throw new Error('replay requires --input events.jsonl');
    for (const line of readFileSync(resolve(input), 'utf8').split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === 'frame') {
        markets.add(event.market.slug); journal(event);
        await driver.frame(event); lastFrameAt = event.now;
      } else if (event.type === 'gap') {
        journal(event); await driver.stop(event.now); lastFrameAt = event.now;
      }
    }
    if (lastFrameAt === null) throw new Error('No recorded frames to replay');
    await driver.stop(lastFrameAt);
    summary = driver.engine.snapshot();
  } else {
    connectTwap();
    const deadline = Date.now() + seconds * 1000;
    let cached = null, refreshedAt = 0, lastPrinted = 0;
    while (!stopped && Date.now() < deadline) {
      const loopAt = Date.now();
      try {
        if (!cached || cached.market.slug !== roundSlug(loopAt) || loopAt - refreshedAt > 10_000) {
          const gamma = await get(`https://gamma-api.polymarket.com/markets/slug/${roundSlug(loopAt)}`);
          const clob = await get(`https://clob.polymarket.com/clob-markets/${gamma.conditionId}`);
          const market = normalizeMarket(gamma, clob, Date.now());
          cached = { market, gamma, clob }; refreshedAt = Date.now();
          markets.add(market.slug); journal({ type: 'market', now: refreshedAt, ...cached });
        }
        const market = cached.market;
        const books = await Promise.all(Object.values(market.tokens).map(async tokenId => {
          const raw = await get(`https://clob.polymarket.com/book?token_id=${tokenId}`);
          const receivedAt = Date.now(); journal({ type: 'book_raw', now: receivedAt, raw });
          return normalizeBook(raw, market, tokenId, receivedAt);
        }));
        const now = Date.now();
        if (roundSlug(now) !== market.slug) throw new Error('Round changed while fetching books');
        const frame = { type: 'frame', now, market, books, twap: socketConnected ? lastTwap : null };
        journal(frame); lastFrameAt = now;
        if (args.includes('--paper')) await driver.frame(frame);
        if (now - lastPrinted > 15_000) {
          console.log(`${market.slug} | 剩余 ${Math.ceil((market.end - now) / 1000)} 秒 | TWAP ${frame.twap ? '收到' : '等待'} | 模拟订单 ${driver.broker.orders.size}`);
          lastPrinted = now;
        }
      } catch (error) {
        cached = null;
        journal({ type: 'gap', now: Date.now(), error: error.message });
        await driver.stop(Date.now());
        console.log(`数据暂停：${error.message}`);
      }
      await sleep(Math.max(0, 1000 - (Date.now() - loopAt)));
    }
    await driver.stop(Date.now());
    summary = driver.engine.snapshot();
  }
} catch (error) {
  journal({ type: 'fatal', now: Date.now(), error: error.message });
  summary = { ...driver.engine.snapshot(), error: error.message };
  process.exitCode = 1;
} finally {
  finishing = true;
  clearTimeout(reconnect); clearInterval(ping); clearTimeout(watchdog);
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  // Let the close event finish before sealing the report counts.
  await sleep(100);
  summary = { ...summary, mode: command, realTrading: false, paperOnLiveData: args.includes('--paper'),
    counts, markets: [...markets], orderCount: command === 'demo' ? summary.orders.length : driver.broker.orders.size,
    limitations: ['Execution exercise only; no forecast or profitability claim.',
      'Live REST observation assumes zero maker fills; synthetic fixtures model FIFO trade fills.',
      'Unclosed inventory remains visible; no estimated settlement or redemption.',
      'No authenticated adapter or automatic restart recovery; each run is a new paper session.'] };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  const report = `# BTC 5 分钟工作流验证\n\n` +
    `模式：${command}。真实交易：关闭。\n\n` +
    `- 识别轮次：${markets.size}\n- 行情帧：${counts.frame ?? 0}\n- 模拟订单：${summary.orderCount}\n` +
    `- 数据缺口：${counts.gap ?? 0}\n- 暂停原因：${summary.halted ?? summary.error ?? '无'}\n` +
    `- 未平仓份额：${JSON.stringify(summary.holdings ?? {})}\n- 累计模拟现金变动：${summary.cash ?? 0}\n` +
    `- 累计模拟费用：${summary.fees ?? 0}\n\n` +
    `现金变动在仍有持仓时不等于盈亏。合成演示中的结果只用于校验执行和记账，不能用来评价策略收益。\n\n` +
    `真实行情采用每秒 REST 盘口快照及 Chainlink 60 秒 TWAP。观察模式只读；加 --paper 才运行本地模拟。` +
    `真实行情中的挂单保守地不计成交，超时撤单后才按可见深度模拟吃单。到期残余持仓不自动判定输赢。\n`;
  writeFileSync(join(output, '报告.md'), report);
  console.log(`完成：${join(output, '报告.md')}`);
}
