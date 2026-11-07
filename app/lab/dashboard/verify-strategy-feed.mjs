// Isolated public-feed smoke check: no dashboard account load, orders or state writes.
import { DashboardController } from './controller.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
class ShadowCheck extends DashboardController {
  frameCount=0; decisionCount=0;
  record(suffix) { if(suffix==='-frames') this.frameCount++; if(suffix==='-decisions') this.decisionCount++; }
  save() {}
}
const c=new ShadowCheck({directory:fileURLToPath(new URL('./reports/',import.meta.url))});
await c.command('start',{mode:'auto'});
await new Promise(resolve=>setTimeout(resolve,38_000));
await c.chain;
const snapshot=c.snapshot();
await c.command('stop');
const result={checkedAt:new Date().toISOString(),isolated:true,execution:snapshot.strategy.config.execution,
  frames:c.frameCount,decisions:c.decisionCount,prices:c.priceHistory.length,orders:c.broker.orders.size,
  priceFresh:snapshot.referenceFresh,reason:snapshot.strategy.decision?.reason??null,
  candidateCount:snapshot.strategy.decision?.candidates.length??0,halted:snapshot.account.halted,sources:snapshot.sources};
result.pass=result.frames>=2&&result.decisions===result.frames&&result.prices>=2&&result.priceFresh&&result.orders===0&&!result.halted;
writeFileSync(fileURLToPath(new URL('./reports/strategy-live-verification.json',import.meta.url)),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
if(!result.pass) process.exitCode=1;
