import { createReadStream, readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardController, defaults } from './controller.mjs';
import { strategyDefaults } from './strategy.mjs';
import { round } from '../paper-broker.mjs';

const root=dirname(fileURLToPath(import.meta.url)), reports=join(root,'reports');
mkdirSync(reports,{recursive:true});
const completedPath=join(reports,'parameter-research.json');
const completed=existsSync(completedPath)?JSON.parse(readFileSync(completedPath,'utf8')):null;
if(completed && !process.argv.includes('--reproduce'))
  throw Error('This study is frozen. Use --reproduce for its original data only; new optimization needs a new protocol and unseen period.');
const previous=JSON.parse(readFileSync(join(reports,'strategy-comparison.json'),'utf8'));
const cutoff=Date.parse(previous.checkedAt), byTime=new Map(), digest=createHash('sha256');
let invalidRows=0;
for(const name of readdirSync(join(root,'runtime')).filter(n=>n.endsWith('-frames.jsonl')).sort()) {
  for await(const line of createInterface({input:createReadStream(join(root,'runtime',name)),crlfDelay:Infinity})) {
    try { const f=JSON.parse(line);if(f.type!=='frame'||!Array.isArray(f.books)||!Number.isFinite(f.now)||!f.market?.slug)throw Error();
      const key=f.market.slug+':'+f.now;
      if(byTime.has(key)&&JSON.stringify(byTime.get(key))!==JSON.stringify(f)) throw Error('conflicting frame');
      byTime.set(key,f);
    } catch {invalidRows++;}
  }
}
if(invalidRows) throw Error('Invalid/conflicting input rows: '+invalidRows);
const allFrames=[...byTime.values()].sort((a,b)=>a.now-b.now);
const frames=completed?allFrames.slice(0,completed.protocol.totalFrames):allFrames;
if(!frames.length) throw Error('No frames');
for(const f of frames) digest.update(JSON.stringify(f)+'\n');
const inputSha256=digest.digest('hex');
if(completed && inputSha256!==completed.protocol.inputSha256) throw Error('Original study input has changed; reproduction blocked');
const lastTime=frames.at(-1).now;
const newRounds=[...new Set(frames.filter(f=>f.market.start>=cutoff&&f.market.end<=lastTime).map(f=>f.market.slug))];
if(newRounds.length<8) throw Error('Need at least eight new ended rounds for validation and final test');
const split=Math.floor(newRounds.length/2),validationIds=new Set(newRounds.slice(0,split)),testIds=new Set(newRounds.slice(split));
const development=frames.filter(f=>f.market.end<=cutoff),validation=frames.filter(f=>validationIds.has(f.market.slug)),test=frames.filter(f=>testIds.has(f.market.slug));
const candidates=[];
for(const edge of [.01,.02]) for(const holdMs of [10_000,15_000]) for(const makerMs of [5000,10_000])
  candidates.push({id:`edge${Math.round(edge*100)}-hold${holdMs/1000}-maker${makerMs/1000}`,config:{...defaults,holdMs,makerMs},strategy:{...strategyDefaults,execution:'paper',minNetEdge:edge}});
const baselineId='edge1-hold15-maker10';
const segmentInfo=part=>({frames:part.length,rounds:new Set(part.map(f=>f.market.slug)).size,first:part[0]?.now,last:part.at(-1)?.now});
const protocol={version:'bounded-grid-v1',createdAt:new Date().toISOString(),inputSha256,
  cutoffFromPreviousReview:previous.checkedAt,totalFrames:frames.length,totalRounds:new Set(frames.map(f=>f.market.slug)).size,
  development:segmentInfo(development),validation:segmentInfo(validation),test:segmentInfo(test),
  excludedFrames:frames.length-development.length-validation.length-test.length,candidates,
  selection:'Only development and validation: require >=3 and >=2 completed trades, flat, no halt; maximize the worse segment score (net - 0.25 * realized drawdown) / completed trades. Tie: nearer original profile. If none qualify keep original. Final test never selects or retunes.',
  assumptions:['Production strategy and lifecycle; independent account per segment; max loss and exposure unchanged.',
    'Maker fills are zero without trade events; takers use visible depth and market fee parameters.',
    'No queue/latency/settlement model; timestamps may have gaps; remaining inventory is not treated as closed.',
    'Prior reviewed data is development only. After this run the final segment is no longer unseen.']};
writeFileSync(join(reports,'parameter-protocol.json'),JSON.stringify(protocol,null,2));

class Offline extends DashboardController {record(){} save(){}}
async function evaluate(part,profile) {
  let now=part[0].now,base=0,baseFees=0,inTrade=false,peak=0,drawdown=0;
  const c=new Offline({directory:reports,clock:()=>now,feedFactory:()=>({start(){},stop(){}})});
  await c.command('config',profile.config);await c.command('strategyConfig',profile.strategy);await c.command('start',{mode:'auto'});
  const trades=[];
  for(const frame of part) {
    now=frame.now;
    if(!inTrade){base=c.engine.cash;baseFees=c.engine.fees;}
    await c.enqueue(()=>c.acceptFrame(frame));
    if(c.engine.holdings.size)inTrade=true;
    if(inTrade&&!c.engine.holdings.size&&!c.engine.active){
      trades.push({time:now,slug:frame.market.slug,net:round(c.engine.cash-base),fees:round(c.engine.fees-baseFees)});
      peak=Math.max(peak,c.engine.cash);drawdown=Math.max(drawdown,peak-c.engine.cash);inTrade=false;
    }
  }
  await c.command('stop');
  const a=c.engine.snapshot(),flat=!Object.keys(a.holdings).length,orders=[...c.broker.orders.values()];
  const net=flat?a.cash:null;
  return {...segmentInfo(part),net,fees:a.fees,closedTrades:trades.length,winningTrades:trades.filter(t=>t.net>0).length,
    realizedDrawdown:round(drawdown),score:flat&&trades.length?round((net-.25*drawdown)/trades.length):null,
    orders:orders.length,makerOrders:orders.filter(o=>o.postOnly).length,remainingPositions:a.holdings,halted:a.halted,trades};
}
const results=[];
for(const p of candidates){const result={id:p.id,development:await evaluate(development,p),validation:await evaluate(validation,p)};results.push(result);
  console.log(JSON.stringify({profile:p.id,development:result.development.net,validation:result.validation.net,trades:[result.development.closedTrades,result.validation.closedTrades]}));}
const eligible=results.filter(r=>r.development.closedTrades>=3&&r.validation.closedTrades>=2&&
  [r.development,r.validation].every(s=>s.net!==null&&!s.halted));
const distance=id=>{const p=candidates.find(p=>p.id===id);return Number(p.strategy.minNetEdge!==.01)+Number(p.config.holdMs!==15000)+Number(p.config.makerMs!==10000);};
eligible.sort((a,b)=>Math.min(b.development.score,b.validation.score)-Math.min(a.development.score,a.validation.score)||distance(a.id)-distance(b.id)||a.id.localeCompare(b.id));
const selectedId=eligible[0]?.id??baselineId,selected=candidates.find(p=>p.id===selectedId);
// Freeze the choice on disk BEFORE opening the final segment to the evaluator.
writeFileSync(join(reports,'parameter-selection.json'),JSON.stringify({selectedId,selected,reason:eligible.length?'best guarded development/validation score':'insufficient completed trades; retain original',testUsedForSelection:false},null,2));
const finalTest=await evaluate(test,selected),baselineTest=selectedId===baselineId?finalTest:await evaluate(test,candidates.find(p=>p.id===baselineId));
const report={protocol,results,selectedId,selected,selectionQualified:eligible.length>0,finalTest,baselineTest,
  profitableEvidence:false,executionDecision:'User-authorized experimental paper trading only; no claim of positive expectancy and no automatic live promotion.',
  checkedAt:new Date().toISOString()};
writeFileSync(join(reports,'parameter-research.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({selectedId,finalTest:finalTest.net,baselineTest:baselineTest.net,finalTrades:finalTest.closedTrades,report:join(reports,'parameter-research.json')},null,2));
