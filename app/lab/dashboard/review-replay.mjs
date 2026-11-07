import { createReadStream, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardController } from './controller.mjs';
import { PaperDriver } from '../driver.mjs';

const root=dirname(fileURLToPath(import.meta.url)),reports=join(root,'reports');mkdirSync(reports,{recursive:true});
const files=readdirSync(join(root,'runtime')).filter(name=>name.endsWith('-frames.jsonl')).map(name=>join(root,'runtime',name));
const framesByTime=new Map();let invalidRows=0;
for(const file of files) {
  const lines=createInterface({input:createReadStream(file),crlfDelay:Infinity});
  for await(const line of lines) {
    try {
      const frame=JSON.parse(line);
      if(frame.type!=='frame' || !Array.isArray(frame.books) || !Number.isFinite(frame.now)) throw Error('Invalid frame');
      framesByTime.set(frame.market.slug+':'+frame.now,frame);
    } catch {invalidRows++;}
  }
}
const frames=[...framesByTime.values()].sort((a,b)=>a.now-b.now);
const rounds=[...new Set(frames.map(f=>f.market.slug))];
const split=Math.max(1,Math.floor(rounds.length*.7)),holdout=new Set(rounds.slice(split));
class ReplayController extends DashboardController {
  record() {} // Use the production decision/lifecycle paths without touching live records.
  save() {}
}
async function evaluate(part) {
  if(!part.length) return {frames:0,rounds:0};
  let now=part[0].now;
  const c=new ReplayController({directory:reports,clock:()=>now,feedFactory:()=>({start(){},stop(){}})});
  const baseline=new PaperDriver();
  await c.command('strategyConfig',{execution:'paper'});await c.command('start',{mode:'auto'});
  const reasons={},candidateRounds=new Set();let validCandidates=0;
  for(const frame of part) {
    now=frame.now;await c.enqueue(()=>c.acceptFrame(frame));await baseline.frame(frame);
    const d=c.strategyDecision;reasons[d.reason]=(reasons[d.reason]??0)+1;
    if(d.selected){validCandidates++;candidateRounds.add(frame.market.slug);}
  }
  await c.command('stop');await baseline.stop(now);
  const summarize=driver=>{
    const orders=[...driver.broker.orders.values()],a=driver.engine.snapshot();
    return {orders:orders.length,filledBuyOrders:orders.filter(o=>o.side==='buy'&&o.filled>0).length,
      filledSellOrders:orders.filter(o=>o.side==='sell'&&o.filled>0).length,
      cash:a.cash,fees:a.fees,remainingPositions:a.holdings,flat:Object.keys(a.holdings).length===0,
      netWhenFlat:Object.keys(a.holdings).length===0?a.cash:null,halted:a.halted};
  };
  return {frames:part.length,rounds:new Set(part.map(f=>f.market.slug)).size,validCandidates,
    candidateRounds:candidateRounds.size,reasons,strategy:summarize(c),fixedUpBaseline:summarize(baseline)};
}
const gapCount=frames.filter((f,i)=>i>0 && f.now-frames[i-1].now>5000).length;
const report={checkedAt:new Date().toISOString(),version:'reference-reversion-v1',sourceFiles:files.length,
  totalFrames:frames.length,totalRounds:rounds.length,gapsOver5Seconds:gapCount,invalidRows,
  method:'固定参数；按完整轮次时间顺序前 70% / 后 30% 切分；无随机打散、无训练或参数搜索；段间重置账户。',
  assumptions:['Maker 不计成交；吃单按当时可见深度及盘口费用计算。','未模拟真实延迟、队列和市场冲击；不合并、不结算到期仓位。','剩余持仓保留；非空仓时不宣称净盈亏。','数据存在间断；连续性检查会跳过不足 30 秒的信号。'],
  development:await evaluate(frames.filter(f=>!holdout.has(f.market.slug))),
  holdout:await evaluate(frames.filter(f=>holdout.has(f.market.slug))),
  promotion:{enabled:false,reason:'仅完成工程对照；样本及成交真实性不足以确认正期望。继续影子观察，不自动提升为实盘或已验证策略。'}};
writeFileSync(join(reports,'strategy-comparison.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
