import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { verifyResolution } from './settlement.mjs';
import { round } from '../paper-broker.mjs';
const root=fileURLToPath(new URL('./',import.meta.url)), runtime=join(root,'runtime');
const path=join(root,'reports','settlement-counterfactual.json');
if(existsSync(path)) throw Error('Counterfactual report is frozen');
const state=JSON.parse(readFileSync(join(runtime,'state.json'),'utf8'));
const trades=readdirSync(runtime).filter(f=>f.endsWith('-trades.jsonl')).flatMap(f=>readFileSync(join(runtime,f),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
  .filter(t=>t.experimentId==='4b319f2f-c974-4336-bc5e-31c5bd3a0009');
const rows=trades.map(t=>{
  const buys=state.orders.filter(o=>o.tokenId===t.entryDecision.tokenId&&o.side==='buy'&&o.filled>0&&o.createdAt>=t.openedAt-1000&&o.createdAt<=t.closedAt);
  if(buys.length!==1) throw Error('Ambiguous historical buy fill');
  const b=buys[0],e=JSON.parse(readFileSync(join(runtime,'outcomes',t.slug+'.json'),'utf8'));
  const label=verifyResolution(e.market,e.gamma,e.clob,e.observedAt);
  if(!label) throw Error('Missing verified result');
  return {slug:t.slug,outcome:t.outcome,winner:label.winner,size:b.filled,entryCost:b.notional,entryFee:b.fees,
    actualNet:t.net,holdToSettlementNet:round(b.filled*label.payouts[t.outcome]-b.notional-b.fees)};
});
const report={createdAt:new Date().toISOString(),experimentId:'4b319f2f-c974-4336-bc5e-31c5bd3a0009',count:rows.length,
  actualNet:round(rows.reduce((s,r)=>s+r.actualNet,0)),holdToSettlementNet:round(rows.reduce((s,r)=>s+r.holdToSettlementNet,0)),rows,
  limitation:'Post-hoc counterfactual for every completed trade in one existing six-trade experiment. Keeps observed entry fills but replaces exits; not a strategy backtest. Ignores changed future entries, capital lock, loss-limit path and redemption costs. Cannot establish positive expectancy.'};
writeFileSync(path,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
