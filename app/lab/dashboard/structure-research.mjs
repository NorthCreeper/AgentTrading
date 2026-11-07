import {createReadStream,readdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DashboardController,defaults} from './controller.mjs';
import {strategyDefaults,depthQuote,freshBook} from './strategy.mjs';
import {edgeFeatures,fitRidge,evaluateExecutionEdge} from './execution-edge.mjs';
import {round} from '../paper-broker.mjs';

const root=fileURLToPath(new URL('./',import.meta.url)),out=join(root,'reports');
if(existsSync(join(out,'structure-research.json')))throw Error('Completed study is frozen; use a new protocol for further optimization.');
const prior=JSON.parse(readFileSync(join(out,'parameter-research.json'),'utf8'));
const seenEnd=prior.protocol.test.last,trainEnd=prior.protocol.development.last;
const map=new Map(),hash=createHash('sha256');
for(const file of readdirSync(join(root,'runtime')).filter(f=>f.endsWith('-frames.jsonl')).sort())
  for await(const line of createInterface({input:createReadStream(join(root,'runtime',file)),crlfDelay:Infinity})) {
    const f=JSON.parse(line);if(f.type!=='frame'||!Number.isFinite(f.now)||!f.market?.slug)throw Error('Invalid frame');
    const key=f.market.slug+':'+f.now;if(map.has(key)&&JSON.stringify(map.get(key))!==JSON.stringify(f))throw Error('Conflicting frame');map.set(key,f);
  }
const frames=[...map.values()].sort((a,b)=>a.now-b.now);
frames.forEach(f=>hash.update(JSON.stringify(f)+'\n'));
const last=frames.at(-1).now,groups=new Map();
for(const f of frames){if(!groups.has(f.market.slug))groups.set(f.market.slug,[]);groups.get(f.market.slug).push(f);}
const parts={train:[],validation:[],diagnostic:[]};
for(const group of groups.values()) {
  const first=group[0],end=group.at(-1).now;if(first.market.end>last)continue;
  const key=end<=trainEnd?'train':first.market.start>trainEnd&&end<=seenEnd?'validation':first.market.start>seenEnd?'diagnostic':null;
  if(key)parts[key].push(...group);
}
const specs=[10_000,30_000].flatMap(horizonMs=>[.01,.02].map(threshold=>({horizonMs,threshold})));
const describe=part=>({frames:part.length,rounds:new Set(part.map(f=>f.market.slug)).size,first:part[0]?.now,last:part.at(-1)?.now});
const protocol={createdAt:new Date().toISOString(),inputSha256:hash.digest('hex'),totalFrames:frames.length,
  parts:Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,describe(v)])),specs,
  training:'Shared Up/Down ridge regression, lambda 10, standardized on training only; labels are future full-size sell proceeds minus current buy cost, both fees included. Samples every five seconds. Same-round continuous future paths only; no settlement guesses.',
  selection:'Validation only: minimum 3 completed trades; maximize net minus 0.25 realized drawdown. Diagnostic segment is not used for selection. Compare with no-trade zero.',
  promotion:'Both validation and diagnostic require >=10 completed trades, positive net, positive net after one extra tick per side, and positive mean-net minus 1.96 standard errors. This is an experimental screen, not statistical proof.',
  caveat:'Diagnostic forward data was collected after prior parameter study, but aggregate old-strategy outcomes have already been inspected. It is NOT a pristine unseen confirmation. A fresh prospective period remains required.'};
writeFileSync(join(out,'structure-protocol.json'),JSON.stringify(protocol,null,2));

function samples(part,horizonMs) {
  const result=[];let history=[],prices=[],lastSample=-Infinity;
  for(let i=0;i<part.length;i++) {
    const f=part[i],now=f.now;
    history.push({time:now,slug:f.market.slug,...Object.fromEntries(['Up','Down'].map(o=>{const b=f.books.find(b=>b.tokenId===f.market.tokens[o]);return [o.toLowerCase(),b?.bids[0]&&b?.asks[0]?(b.bids[0][0]+b.asks[0][0])/2:null];}))});
    history=history.filter(h=>h.time>=now-30_000);
    if(f.twap&&!prices.some(p=>p.time===f.twap.timestamp))prices.push({time:f.twap.timestamp,receivedAt:f.twap.receivedAt,valueE18:f.twap.valueE18});
    prices=prices.filter(p=>p.time>=now-30_000&&p.time<=now).sort((a,b)=>a.time-b.time);
    if(now-lastSample<5000)continue;lastSample=now;
    let j=i+1;while(j<part.length&&part[j].now<now+horizonMs)j++;
    const future=part[j];
    if(!future||future.market.slug!==f.market.slug||future.now>now+horizonMs+3000)continue;
    if(part.slice(i+1,j+1).some((row,k)=>row.now-part[i+k].now>5000))continue;
    for(const outcome of ['Up','Down']) {
      const feature=edgeFeatures({frame:f,history,prices,config:defaults,now},outcome);if(!feature)continue;
      const b=future.books.find(b=>b.tokenId===feature.tokenId);if(!freshBook(b,future.now,defaults.staleMs))continue;
      const exit=depthQuote(b,'sell',defaults.size,future.market);if(!exit?.complete)continue;
      result.push({x:feature.x,y:(exit.notional-exit.fees-feature.buy.notional-feature.buy.fees)/defaults.size,slug:f.market.slug,time:now,labelTime:future.now});
    }
  }
  return result;
}
function summary(trades,account) {
  const net=account.holdings&&Object.keys(account.holdings).length?null:account.cash;
  const n=trades.length,mean=n?trades.reduce((s,t)=>s+t.net,0)/n:0;
  const se=n>1?Math.sqrt(trades.reduce((s,t)=>s+(t.net-mean)**2,0)/(n-1)/n):null;
  let peak=0,value=0,dd=0;for(const t of trades){value+=t.net;peak=Math.max(peak,value);dd=Math.max(dd,peak-value);}
  return {net,fees:account.fees,completedTrades:n,wins:trades.filter(t=>t.net>0).length,meanNet:mean,
    lowerMeanHeuristic:se===null?null:mean-1.96*se,stressNet:net===null?null:net-trades.reduce((s,t)=>s+t.tick*defaults.size*2,0),
    realizedDrawdown:dd,remaining:account.holdings,halted:account.halted,trades};
}
class Offline extends DashboardController {
  closed=[];record(suffix,row){if(suffix==='-trades')this.closed.push({...row,tick:this.frame.market.tick});}save(){}
  evaluate(now=this.clock(),size=this.config.size) {return evaluateExecutionEdge({frame:this.frame,history:this.history,prices:this.priceHistory,config:{...this.config,size},strategy:this.strategyConfig,now},this.edgeArtifact,{research:true});}
}
async function replay(part,artifact) {
  let now=part[0].now;const c=new Offline({directory:out,clock:()=>now,feedFactory:()=>({start(){},stop(){}})});c.edgeArtifact=artifact;
  await c.command('config',{holdMs:artifact.horizonMs});await c.command('strategyConfig',{execution:'paper',model:'execution-edge'});await c.command('start',{mode:'auto'});
  for(const f of part){now=f.now;await c.enqueue(()=>c.acceptFrame(f));}
  await c.command('stop');return summary(c.closed,c.engine.snapshot());
}
const artifacts=[],results=[];
for(const spec of specs) {
  const train=samples(parts.train,spec.horizonMs),model=fitRidge(train);
  const artifact={id:`execution-edge-v2-${spec.horizonMs/1000}s-${Math.round(spec.threshold*100)}c-${protocol.inputSha256.slice(0,8)}`,
    ...spec,model,size:5,fee:{rate:.07,exponent:1},safetyMargin:.01,trainedThrough:trainEnd,trainingSamples:train.length,promotion:{eligible:false}};
  const validation=await replay(parts.validation,artifact);artifacts.push(artifact);results.push({id:artifact.id,trainingSamples:train.length,validation});
  console.log(JSON.stringify({id:artifact.id,trainingSamples:train.length,validationNet:validation.net,trades:validation.completedTrades}));
}
const eligible=results.filter(r=>r.validation.completedTrades>=3&&r.validation.net!==null&&!r.validation.halted)
  .sort((a,b)=>(b.validation.net-.25*b.validation.realizedDrawdown)-(a.validation.net-.25*a.validation.realizedDrawdown));
const chosen=eligible[0]??results[0],artifact=artifacts.find(a=>a.id===chosen.id);
writeFileSync(join(out,'structure-selection.json'),JSON.stringify({selectedId:artifact.id,selectedBeforeDiagnostic:true,validation:chosen.validation},null,2));
const diagnostic=await replay(parts.diagnostic,artifact);
const passes=s=>s.completedTrades>=10&&s.net>0&&s.stressNet>0&&s.lowerMeanHeuristic>0&&!s.halted;
artifact.promotion={eligible:passes(chosen.validation)&&passes(diagnostic),reason:'必须同时通过两段净收益、样本数、误差余量与额外滑点检查；未通过时自动开仓被阻止',validation:chosen.validation,diagnostic};
// Scan complete-set purchases at actual asks, with fees, synchronized books and a cash buffer.
let pairFrames=0,pairRounds=new Set(),bestPairEdge=-Infinity;
for(const f of frames){const bs=['Up','Down'].map(o=>f.books.find(b=>b.tokenId===f.market.tokens[o]));
  if(bs.some(b=>!freshBook(b,f.now,3000))||Math.abs(bs[0].receivedAt-bs[1].receivedAt)>500||Math.abs(bs[0].timestamp-bs[1].timestamp)>1000)continue;
  const q=bs.map(b=>depthQuote(b,'buy',5,f.market));if(q.some(q=>!q?.complete))continue;
  const edge=1-q.reduce((s,q)=>s+(q.notional+q.fees)/5,0)-.01;bestPairEdge=Math.max(bestPairEdge,edge);
  if(edge>0){pairFrames++;pairRounds.add(f.market.slug);}
}
const oldTrades=readdirSync(join(root,'runtime')).filter(n=>n.endsWith('-trades.jsonl')).flatMap(n=>readFileSync(join(root,'runtime',n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
const live={trades:oldTrades.length,net:round(oldTrades.reduce((s,t)=>s+t.net,0)),fees:round(oldTrades.reduce((s,t)=>s+t.fees,0))};live.gross=round(live.net+live.fees);
const report={protocol,oldLiveExperiment:live,candidates:results,selectedId:artifact.id,diagnostic,
  pairScan:{positiveFrames:pairFrames,positiveRounds:pairRounds.size,bestBufferedEdgePerPair:bestPairEdge,executable:false,reason:'Snapshots are non-atomic; current workflow has no complete-set merge or dual-leg lifecycle. These are observations, not realized arbitrage profits.'},
  noTradeBenchmark:0,promotion:artifact.promotion,conclusion:artifact.promotion.eligible?'Limited experimental paper candidate; no proof of maximum or future positive expectancy':'No candidate passed. Prefer no automatic directional trades while gathering new evidence.'};
writeFileSync(join(out,'execution-edge-model.json'),JSON.stringify(artifact,null,2));writeFileSync(join(out,'structure-research.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({selectedId:artifact.id,diagnosticNet:diagnostic.net,diagnosticTrades:diagnostic.completedTrades,promotion:artifact.promotion.eligible,pairScan:report.pairScan,oldLiveExperiment:live},null,2));
