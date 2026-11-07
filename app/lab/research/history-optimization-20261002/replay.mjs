import {readFileSync,writeFileSync,mkdirSync,existsSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalFrameEvents,prefixLines,hashPrefix,mergePaymentLabels} from './history-catalog.mjs';
import {candidates,evidenceOnly,suiteProtocol,candidateDecision,candidateExit} from './suite.mjs';
import {newEvolutionPortfolio,stepEvolutionPortfolio,validateEvolutionPortfolio,evolutionDailySummary,evolutionBook} from './portfolio.mjs';
import {BidHistory} from '../../dashboard/bid-exit.mjs';
import {freshBook,depthQuote} from '../../dashboard/strategy.mjs';
import {fitProbability} from '../../dashboard/settlement-model.mjs';
import {valueFeatures,valueProtocol} from '../../dashboard/settlement-value.mjs';
import {predictAdaptive,updateAdaptive} from '../../dashboard/adaptive-calibration.mjs';
import {quoteEqualSharePair,makerReplayCapability} from './execution-policies.mjs';
import {round} from '../../paper-broker.mjs';

const day=at=>new Date(at+28800000).toISOString().slice(0,10),startDay=d=>Date.parse(d+'T00:00:00+08:00');
const digest=b=>createHash('sha256').update(b).digest('hex');
export function chronologicalSplit(rounds){
 const dates=[...new Set(rounds.filter(r=>r.canonicalSession).map(r=>day(r.start)))].sort();
 if(dates.length<5)throw Error('Insufficient observed calendar dates');
 const n=Math.floor(dates.length*.6),v=Math.max(1,Math.floor(dates.length*.2));
 return {dates,train:dates.slice(0,n),validation:dates.slice(n,n+v),test:dates.slice(n+v),
  validationAt:startDay(dates[n]),testAt:startDay(dates[n+v]),partialBoundaryDates:[dates[0],dates.at(-1)]};
}
export class ReplayMachine{
 constructor({rounds,labels,cutoff,split=chronologicalSplit(rounds),prospective=false,seed=null,candidateIds=null}){
  if(seed&&(!prospective||!Number.isFinite(seed.knownAt)||seed.knownAt>cutoff||
   seed.adaptiveThrough!==null&&(!Number.isFinite(seed.adaptiveThrough)||seed.adaptiveThrough>seed.knownAt)||
   seed.fixed&&(!Number.isFinite(seed.fixed.artifact?.fittedAt)||seed.fixed.artifact.fittedAt>seed.knownAt||seed.fixed.asOf>seed.knownAt)))throw Error('Future or retrospective seed rejected');
  this.seedKnownAt=seed?.knownAt??null;this.evidenceAt=seed?.knownAt??null;
  this.cutoff=cutoff;this.split=split;this.prospective=prospective;this.lastAt=null;this.frames=0;
  this.history=[];this.bidHistory=new BidHistory();this.forecasts=new Map();this.trainingRows=[];
  this.params=seed?.params??[0,0];this.adaptiveThrough=seed?.adaptiveThrough??null;this.updates=0;
  this.fixed=seed?.fixed??null;this.fixedAttempted=Boolean(seed);this.labels=labels.filter(l=>l.scope==='strict').sort((a,b)=>a.at-b.at||a.label.slug.localeCompare(b.label.slug));this.li=0;
  this.payments=mergePaymentLabels(labels);this.fi=0;
  this.financial=new Map(this.payments.map(l=>[l.label.slug,l.label]));
  this.rounds=new Map(rounds.map(r=>[r.slug,r]));this.counts={};this.pair={frames:0,opportunities:0,slugs:new Set(),largestEdge:null};
  const scopes=prospective?['prospective']:suiteProtocol.scopes;
  this.arms=scopes.flatMap(scope=>suiteProtocol.scenarios.flatMap(scenario=>candidates.filter(c=>!candidateIds||candidateIds.includes(c.id)).map(candidate=>({scope,scenario,candidate,
   account:newEvolutionPortfolio(candidate.exit,scenario.delayMs,{id:[scope,scenario.id,candidate.id].join(':'),
    protectionTicks:candidate.protectionTicks??null,retry:candidate.retry??false,reentry:candidate.reentry??false}),
   exit:candidateExit(candidate),markedPeak:100,maxMarkedDrawdown:0,markedFrames:0,unknownMarkedFrames:0}))));
 }
 processLabels(now){
  while(this.li<this.labels.length&&this.labels[this.li].at<=now){
   const e=this.labels[this.li++],f=this.forecasts.get(e.label.slug);
   if(!f||f.updated||e.at<f.at||Math.abs(e.label.opening-f.opening)>.00001)continue;
   const old=[...this.params];this.params=updateAdaptive(this.params,{q:f.q,z:f.z,y:e.label.payouts.Up});
   this.adaptiveThrough=e.at;this.updates++;f.updated=true;f.y=e.label.payouts.Up;f.knownAt=e.at;
   f.update={before:old,after:[...this.params],at:e.at};
  }
 }
 context(now){
  if(!this.fixedAttempted&&now>=this.split.validationAt){
   this.fixedAttempted=true;
   const boundary=this.split.validationAt-60000;
   const xs=[...this.forecasts.values()].filter(f=>this.split.train.includes(f.day)&&f.updated&&f.knownAt<boundary)
    .map(f=>({slug:f.slug,x:f.x,marketProbability:f.marketProbability,y:f.y,knownAt:f.knownAt}));
   const model=xs.length>=valueProtocol.minimumRounds&&new Set(xs.map(x=>day(this.forecasts.get(x.slug).at))).size>=valueProtocol.minimumTrainingDates?fitProbability(xs):null;
   this.trainingRows=xs;
   if(model)this.fixed={artifact:{version:valueProtocol.version,id:'chronological-fixed-'+digest(JSON.stringify(xs)).slice(0,16),
    fittedAt:now,model,trainingRounds:xs.length},asOf:now,trainingBoundaryAt:boundary,
    throughLabelKnownAt:Math.max(...xs.map(x=>x.knownAt))};
  }
  return {fixed:this.fixed?{...this.fixed,asOf:now}:null,
   adaptive:{params:[...this.params],asOf:now,throughLabelKnownAt:this.adaptiveThrough,id:'causal-delayed-calibration'}};
 }
 activeScope(scope,now){return this.prospective||scope==='continuous-full-history'||scope==='validation-new-independent-100'&&now>=this.split.validationAt&&now<this.split.testAt||scope==='test-new-independent-100'&&now>=this.split.testAt;}
 mark(arm,input){
  const a=arm.account,owned=[a.position,...a.pendingSettlements].filter(Boolean);let nav=a.cash,known=true;
  for(const t of owned){const b=evolutionBook(input.frame,t.market,t.outcome,input.now);
   const currentMarket=input.frame?.market;
   const q=b&&freshBook(b,input.now,3000)&&b.bids.length?depthQuote(b,'sell',t.remaining,currentMarket,Math.max(currentMarket.tick,b.bids[0][0]-.02)):null;
   if(!q?.complete){known=false;break;}nav+=q.notional-q.fees;
  }
  if(known){arm.markedFrames++;arm.markedPeak=Math.max(arm.markedPeak,nav);arm.maxMarkedDrawdown=Math.max(arm.maxMarkedDrawdown,arm.markedPeak-nav);}
  else arm.unknownMarkedFrames++;
 }
 step(frame,prices,now=frame.now){
  if(this.seedKnownAt!==null&&now<this.seedKnownAt)throw Error('Seed cannot backfill earlier observations');
  if(this.lastAt!==null&&now<=this.lastAt)return [];
  const paymentEvents=this.advancePayments(now);
  this.lastAt=now;this.evidenceAt=now;this.frames++;this.processLabels(now);const causalContext=this.context(now);
  const h={time:frame.now,slug:frame.market.slug};
  for(const o of ['Up','Down']){const b=frame.books.find(b=>b.tokenId===frame.market.tokens[o]),valid=Boolean(freshBook(b,now,3000)&&b.bids.length&&b.asks.length&&b.timestamp<=b.receivedAt&&b.receivedAt<=frame.now);h[o.toLowerCase()]=valid?(b.bids[0][0]+b.asks[0][0])/2:null;h[o.toLowerCase()+'BookValid']=valid;}
  this.history.push(h);this.history=this.history.filter(r=>r.slug===frame.market.slug&&r.time>=now-35000);this.bidHistory.add(frame,now);
  if(!this.forecasts.has(frame.market.slug)){
   const f=valueFeatures(frame,prices,now);
   if(f){const p=predictAdaptive(f.marketProbability,this.params);this.forecasts.set(frame.market.slug,
    {slug:frame.market.slug,at:now,day:day(now),opening:f.opening,x:f.x,marketProbability:f.marketProbability,q:p.q,z:p.z,params:[...this.params],updated:false});}
  }
  const allEvents=paymentEvents;
  for(const scenario of suiteProtocol.scenarios){
   const sf=scenario.feeMultiplier===1?frame:{...frame,market:{...frame.market,fee:{...frame.market.fee,rate:frame.market.fee.rate*scenario.feeMultiplier}}};
   const bh=scenario.feeMultiplier===1?this.bidHistory.rows:this.bidHistory.rows.map(r=>({...r,fee:{...r.fee,rate:r.fee.rate*scenario.feeMultiplier}}));
   const input={frame:sf,now,prices,history:this.history,bidHistory:bh,causalContext,
    config:{buyUnits:1,staleMs:3000,maxExposure:10},strategy:{execution:'paper',model:'forward-momentum',exitPolicy:'market',maxSpread:.04,minNetEdge:.005,costBuffer:.005,stopLossUsd:0}};
   const cache=new Map();
   for(const arm of this.arms.filter(a=>a.scenario.id===scenario.id)){
    if(!this.activeScope(arm.scope,now)){
     if(arm.account.lastAt!==null&&now>arm.account.lastAt)for(const e of stepEvolutionPortfolio(arm.account,{frame:null,now,eventOnly:true},this.financial,null,false,arm.exit))allEvents.push({scope:arm.scope,scenario:scenario.id,candidate:arm.candidate.id,...e});
     continue;
    }
    const decision=candidateDecision(arm.candidate,input,cache);
    if(arm.scope==='continuous-full-history'||this.prospective){const count=this.counts[scenario.id+':'+arm.candidate.id]??={frames:0,eligible:0,skips:{},eligibleRounds:new Set()};count.frames++;
     if(decision.selected){count.eligible++;count.eligibleRounds.add(frame.market.slug);}else{const reason=decision.reason??'unknown';count.skips[reason]=(count.skips[reason]??0)+1;}}
    const events=stepEvolutionPortfolio(arm.account,{...input,afterEventAtSameTime:true},this.financial,decision.selected,true,arm.exit);
    for(const e of events)allEvents.push({scope:arm.scope,scenario:scenario.id,candidate:arm.candidate.id,...e});
    this.mark(arm,input);
   }
  }
  this.pair.frames++;const paired=quoteEqualSharePair({frame,now,cash:100,inventoryCost:0});
  if(paired.allowed){this.pair.opportunities++;this.pair.slugs.add(frame.market.slug);this.pair.largestEdge=Math.max(this.pair.largestEdge??0,paired.edgePerShare);allEvents.push({kind:'paired-book-opportunity',at:now,slug:frame.market.slug,plan:paired,actualExecutionVerified:false});}
  return allEvents;
 }
 advancePayments(now){
  const events=[];
  while(this.fi<this.payments.length&&this.payments[this.fi].at<=now){
   const e=this.payments[this.fi++];this.processLabels(e.at);
   for(const arm of this.arms){const a=arm.account;
    if(a.lastAt===null||e.at<=a.lastAt||![a.position,...a.pendingSettlements].some(t=>t?.slug===e.label.slug))continue;
    for(const event of stepEvolutionPortfolio(a,{frame:null,now:e.at,eventOnly:true},this.financial,null,true,arm.exit))events.push({scope:arm.scope,scenario:arm.scenario.id,candidate:arm.candidate.id,...event});
   }
  }
  return events;
 }
 finish(now){
  this.evidenceAt=Math.max(this.evidenceAt??0,now);
  const events=this.advancePayments(now);this.processLabels(now);
  for(const arm of this.arms){if(arm.account.lastAt===null||arm.account.lastAt>=now)continue;
   for(const e of stepEvolutionPortfolio(arm.account,{frame:null,now,eventOnly:true},this.financial,null,false,arm.exit))events.push({scope:arm.scope,scenario:arm.scenario.id,candidate:arm.candidate.id,...e});
   validateEvolutionPortfolio(arm.account);
  }
  return events;
 }
 summary(){
  const accounts=this.arms.map(arm=>{
   const a=arm.account,owned=[a.position,...a.pendingSettlements].filter(Boolean),maxPayout=owned.reduce((s,t)=>s+t.remaining,0);
   const ts=a.closedTrades,first=ts.length?Math.min(...ts.map(t=>t.openedAt)):null;
   const holdingMs=ts.reduce((s,t)=>s+t.timing.tradableMs,0),waitMs=[...ts,...owned].reduce((s,t)=>s+t.timing.waitMs,0);
   const dates=evolutionDailySummary(a),netByEntryDay=Object.fromEntries(Object.entries(dates).map(([d,v])=>[d,v.net]));
   return {scope:arm.scope,scenario:arm.scenario.id,id:arm.candidate.id,label:arm.candidate.label,phase:arm.candidate.phase,
    cash:a.cash,net:a.realized,fees:a.fees,completed:a.completed,wins:a.wins,winRate:a.completed?a.wins/a.completed:null,
    roiRange:{lower:round((a.cash-100)/100),upper:round((a.cash+maxPayout-100)/100)},
    accountNetRange:{lower:round(a.cash-100),upper:round(a.cash+maxPayout-100)},unresolved:owned.length,
    maxRealizedDrawdown:a.maxRealizedDrawdown,maxMarkedDrawdownKnownFrames:arm.maxMarkedDrawdown,
    markedFrames:arm.markedFrames,unknownMarkedFrames:arm.unknownMarkedFrames,
    averageTradableHoldSeconds:a.completed?holdingMs/a.completed/1000:null,totalSettlementWaitHours:waitMs/3600000,
    netByEntryDay,dates,counts:a.counts,attemptedRounds:a.attemptedRounds.length,
    cashExhausted:a.cash<1.05,firstEntryAt:first,lastAt:a.lastAt,
    secondEntries:ts.length-new Set(ts.map(t=>t.slug)).size};
  });
  return {version:suiteProtocol.version,cutoff:this.cutoff,frames:this.frames,split:this.split,accounts,
   forecasts:this.forecasts.size,updates:this.updates,fixedTraining:this.trainingRows.length,
   causalSeed:{params:this.params,adaptiveThrough:this.adaptiveThrough,fixed:this.fixed,knownAt:this.evidenceAt},
   counts:Object.fromEntries(Object.entries(this.counts).map(([id,c])=>[id,{...c,eligibleRounds:c.eligibleRounds.size}])),
   pair:{...this.pair,slugs:this.pair.slugs.size,status:'opportunity-only-not-account-profit'},maker:makerReplayCapability()};
 }
}

function quantile(xs,p){return xs[Math.min(xs.length-1,Math.floor(xs.length*p))]??null;}
export function promotionScreen(report){
 const gates=suiteProtocol.historicalPromotion,eligible=[],checks=[];
 const find=(scope,scenario,id)=>report.accounts.find(a=>a.scope===scope&&a.scenario===scenario&&a.id===id);
 const validDates=scope=>(scope==='validation-new-independent-100'?report.split.validation:report.split.test).filter(d=>!report.split.partialBoundaryDates.includes(d));
 for(const c of candidates.filter(c=>c.id!=='baseline')){
  const reasons=[],parts={};
  for(const scope of ['validation-new-independent-100','test-new-independent-100']){
   const dates=validDates(scope),a=find(scope,'base',c.id),b=find(scope,'base','baseline'),stress=find(scope,'stress',c.id),controlStress=find(scope,'stress','baseline');
   const net=dates.reduce((s,d)=>s+(a.netByEntryDay[d]??0),0),control=dates.reduce((s,d)=>s+(b.netByEntryDay[d]??0),0);
   const ss=dates.reduce((s,d)=>s+(stress.netByEntryDay[d]??0),0),sb=dates.reduce((s,d)=>s+(controlStress.netByEntryDay[d]??0),0);
   const completed=dates.reduce((s,d)=>s+(a.dates[d]?.completed??0),0);
   const diffs=dates.map(d=>(a.netByEntryDay[d]??0)-(b.netByEntryDay[d]??0)),draws=[];let seed=0x6317c7;
   const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
   if(dates.length>=3)for(let i=0;i<10000;i++){let v=0;for(let k=0;k<dates.length;k++)v+=diffs[Math.floor(rand()*dates.length)];draws.push(v/dates.length);}
   draws.sort((x,y)=>x-y);const alpha=gates.familywiseAlpha/(candidates.length-1),lower=quantile(draws,alpha);
   const positives=dates.map(d=>Math.max(0,a.netByEntryDay[d]??0)),positiveTotal=positives.reduce((x,y)=>x+y,0),maxShare=positiveTotal?Math.max(...positives)/positiveTotal:null;
   parts[scope]={dates,completed,net,control,increment:net-control,stressNet:ss,stressIncrement:ss-sb,dateBlockLower:lower,maxPositiveDateShare:maxShare,unresolved:a.unresolved};
   if(dates.length<3)reasons.push(scope+':insufficient-dates');
   if(completed<(scope.startsWith('validation')?gates.minimumCompletedValidation:gates.minimumCompletedTest))reasons.push(scope+':insufficient-completed-trades');
   if(!(net>0))reasons.push(scope+':absolute-after-cost-net-not-positive');
   if(!(net-control>0))reasons.push(scope+':no-increment');
   if(!(ss>0&&ss-sb>0))reasons.push(scope+':delay-fee-stress-not-positive');
   if(!(lower>0))reasons.push(scope+':date-block-multiple-candidate-bound-not-positive');
   const unknown=arms=>arms.reduce((n,account)=>n+dates.reduce((s,d)=>s+(account.dates[d]?.unresolved??0),0),0);
   if(unknown([a,stress,b,controlStress]))reasons.push(scope+':unresolved-inventory-or-control');
   if(!(maxShare!==null&&maxShare<=.5))reasons.push(scope+':profit-concentration');
  }
  const pass=reasons.length===0;if(pass)eligible.push(c.id);checks.push({id:c.id,pass,status:pass?'historical-paper-eligible':'prospective-candidate',reasons,parts});
 }
 return {eligible,checks,baselineEligible:false,realTrading:false,multipleCandidateCorrection:'one-sided date-block bootstrap alpha=.05/18; descriptive retrospective screen'};
}
export async function loadPriceRows(file,cutoff){
 const rows=[];for await(const raw of prefixLines(file.path,file.bytes)){if(!raw.terminated||!raw.line)continue;let p;try{p=JSON.parse(raw.line);}catch{continue;}
  if(Number.isFinite(p.time)&&Number.isFinite(p.receivedAt)&&p.time<=p.receivedAt&&p.receivedAt<=cutoff)rows.push(p);}
 return rows.sort((a,b)=>a.receivedAt-b.receivedAt||a.time-b.time);
}
export class PriceCursor{
 constructor(rows,at){this.rows=rows;this.pi=0;this.map=new Map();while(this.pi<rows.length&&rows[this.pi].receivedAt<at-330000)this.pi++;}
 at(now){while(this.pi<this.rows.length&&this.rows[this.pi].receivedAt<=now){const p=this.rows[this.pi++];if(p.time<=now)this.map.set(p.time,p);}
  for(const time of this.map.keys())if(time<now-330000)this.map.delete(time);return [...this.map.values()].sort((a,b)=>a.time-b.time);}
}
export async function runReplay(catalogPath,output,{candidateIds=null}={}){
 const catalog=JSON.parse(readFileSync(catalogPath)),manifest=catalog.manifest??catalog,
  rounds=catalog.rounds??JSON.parse(readFileSync(join(catalog.directory,'rounds.json'))),labels=catalog.labels??JSON.parse(readFileSync(join(catalog.directory,'labels.json')));
 if(existsSync(output))throw Error('New immutable replay directory required');mkdirSync(output,{recursive:true});
 const split=chronologicalSplit(rounds),sources=sourceRegistration();
 for(const [p]of Object.entries(sources)){const target=join(output,'source',p);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(fileURLToPath(new URL('../../',import.meta.url)),p)));}
 writeFileSync(join(output,'pre-registration.json'),JSON.stringify({declaredAt:Date.now(),catalogPath,cutoff:manifest.cutoff,sources,protocol:suiteProtocol,candidates,evidenceOnly,split,candidateIds,partitionMeaning:'Independent policy accounts; all partitions use identical whole history, forecasts and cash, no chronological reset.'},null,2));
 for(const f of manifest.files){if(await hashPrefix(f.frozen??f.path,f.bytes)!==f.sha256)throw Error('Frozen prefix differs: '+f.path);}
 const machine=new ReplayMachine({rounds,labels,cutoff:manifest.cutoff,split,candidateIds}),priceFiles=new Map(manifest.files.filter(f=>f.kind==='price').map(f=>[f.sessionId,f])),priceCache=new Map();
 let activeSession=null,cursor=null,lastProgress=Date.now(),slug=null,roundCount=0;
 const emit=events=>{if(events.length)appendFileSync(join(output,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');};
 for await(const event of canonicalFrameEvents(manifest,rounds)){
  if(event.sessionId!==activeSession){activeSession=event.sessionId;const file=priceFiles.get(activeSession);if(!file)throw Error('Missing causal price source '+activeSession);
   if(!priceCache.has(activeSession)){priceCache.set(activeSession,await loadPriceRows(file,manifest.cutoff));if(priceCache.size>2)priceCache.delete(priceCache.keys().next().value);}
   cursor=new PriceCursor(priceCache.get(activeSession),event.at);
  }
  if(slug!==event.frame.market.slug){slug=event.frame.market.slug;roundCount++;}
  emit(machine.step(event.frame,cursor.at(event.at)));
  if(Date.now()-lastProgress>10000){lastProgress=Date.now();const p={rounds:roundCount,frames:machine.frames,lastAt:event.at,at:Date.now()};writeFileSync(join(output,'progress.json'),JSON.stringify(p));console.log(JSON.stringify(p));}
 }
 emit(machine.finish(manifest.cutoff));const report=machine.summary();if(!candidateIds)report.promotion=promotionScreen(report);
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));
 writeFileSync(join(output,'forecasts.json'),JSON.stringify([...machine.forecasts.values()],null,2));
 writeFileSync(join(output,'training.json'),JSON.stringify(machine.trainingRows,null,2));
 for(const arm of machine.arms)writeFileSync(join(output,arm.account.id.replaceAll(':','__')+'.json'),JSON.stringify(arm.account));
 writeFileSync(join(output,'completion.json'),JSON.stringify({completedAt:Date.now(),sources,reportSha256:digest(readFileSync(join(output,'report.json'))),eventSha256:digest(readFileSync(join(output,'events.jsonl'))),catalogPath,rounds:roundCount,frames:machine.frames},null,2));
 return report;
}
export function sourceRegistration(roots=['replay.mjs','suite.mjs','portfolio.mjs','entry-policies.mjs','execution-policies.mjs','history-catalog.mjs']){
 const here=dirname(fileURLToPath(import.meta.url)),lab=resolve(here,'../..'),files=new Map();
 const visit=path=>{path=resolve(path);if(files.has(path))return;const b=readFileSync(path),s=b.toString('utf8');files.set(path,digest(b));
  for(const m of s.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)){const p=resolve(dirname(path),m[1]);if(p.endsWith('.mjs'))visit(p);}
 };
 roots.forEach(p=>visit(resolve(here,p)));return Object.fromEntries([...files].sort(([a],[b])=>a.localeCompare(b)).map(([p,h])=>[relative(lab,p).replaceAll('\\','/'),h]));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const report=await runReplay(resolve(process.argv[2]),resolve(process.argv[3]),{candidateIds:process.argv[4]?.split(',')??null});console.log(JSON.stringify({frames:report.frames,forecasts:report.forecasts,updates:report.updates,eligible:report.promotion?.eligible}));
}
