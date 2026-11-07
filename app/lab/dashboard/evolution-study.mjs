import {existsSync,readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {writeJsonAtomic} from './atomic-json.mjs';
import {BidHistory} from './bid-exit.mjs';
import {newEvolutionPortfolio,stepEvolutionPortfolio,evolutionCandidate,evolutionFrameReady,evolutionExitFrame,
 evolutionPortfolioSummary,evolutionDailySummary,validateEvolutionPortfolio,evolutionConfig,evolutionStrategy,evolutionDay,
 evolutionPortfolioVersion} from './evolution-portfolio.mjs';

export const evolutionStudyVersion=evolutionPortfolioVersion;
export const evolutionProtocol=Object.freeze({version:evolutionStudyVersion,realTrading:false,initialCapital:100,
 amountUsd:1,activeTradablePositions:1,expiredInventory:'persistent-owned-settlement-queue',maxTradesPerRound:1,
 policies:['market','consensus'],executionDelayMs:[0,1000],sourceFreshMs:3000,executionWindowMs:3000,
 config:evolutionConfig,strategy:evolutionStrategy,payoutScope:'verified-paper-financial-only',
 independentSamples:false,unitOfIndependentObservation:'distinct five-minute market slug',
 forcedDollarOrTimeExit:false,oldResearchMutation:false});
const digest=x=>createHash('sha256').update(x).digest('hex'),clone=structuredClone,finite=Number.isFinite;
export function evolutionImplementation(){
 const files=['./evolution-study.mjs','./evolution-portfolio.mjs','./atomic-json.mjs','../paper-broker.mjs','../amount-order.mjs',
  './forward-strategy.mjs','./market-exit.mjs','./consensus-exit.mjs','./bid-exit.mjs','./strategy.mjs','./p2-book.mjs',
  './reference-price.mjs','./managed-position-accounting.mjs','./settlement.mjs','./chart-model.mjs','./entry-context.mjs'];
 const implementationCodeHashes=Object.fromEntries(files.map(file=>[file,digest(readFileSync(new URL(file,import.meta.url)))]));
 return {protocolHash:digest(JSON.stringify(evolutionProtocol)),implementationCodeHashes,
  implementationHash:digest(JSON.stringify(implementationCodeHashes))};
}
const defaults={batchStart:Date.parse('2026-10-02T00:00:00+08:00'),batchEnd:Date.parse('2026-10-09T00:00:00+08:00'),
 labelCutoff:Date.parse('2026-10-10T00:00:00+08:00')};
function validBatch(b){return typeof b.id==='string'&&b.id&&[b.start,b.end,b.labelCutoff].every(finite)&&
 b.start<b.end&&b.labelCutoff>=b.end&&(b.start+28800000)%86400000===0&&(b.end+28800000)%86400000===0;}
export class EvolutionStudy {
 constructor(directory,{createdAt=Date.now(),registryHash=null,batchId,batchStart,batchEnd,labelCutoff}={}){
  mkdirSync(directory,{recursive:true});this.path=join(directory,'evolution-study.json');this.journal=join(directory,'evolution-study.jsonl');
  this.history=new BidHistory();const implementation=evolutionImplementation();
  if(existsSync(this.path)){
   this.state=JSON.parse(readFileSync(this.path,'utf8'));
   if(this.state.version!==evolutionStudyVersion||!validBatch(this.state.batch)||
    !isDeepStrictEqual(this.state.protocol,evolutionProtocol)||!isDeepStrictEqual(this.state.implementation,implementation))
    throw Error('Evolution protocol or frozen implementation differs; create a new cohort');
   const expected={id:batchId??this.state.batch.id,start:batchStart??this.state.batch.start,end:batchEnd??this.state.batch.end,
    labelCutoff:labelCutoff??this.state.batch.labelCutoff};
   if(!isDeepStrictEqual(expected,this.state.batch)||registryHash!==null&&registryHash!==this.state.registryHash)
    throw Error('Evolution registry or fixed batch identity differs');
  }else{
   const batch={id:batchId??randomUUID(),start:batchStart??defaults.batchStart,end:batchEnd??defaults.batchEnd,
    labelCutoff:labelCutoff??defaults.labelCutoff};
   if(!finite(createdAt)||!validBatch(batch))throw Error('Invalid evolution creation time or batch window');
   this.state={version:evolutionStudyVersion,instanceId:randomUUID(),createdAt,registryHash,batch,protocol:clone(evolutionProtocol),
    implementation,lastAt:null,startedAt:null,closedAt:null,daily:{},pending:[],eventSequence:0,
    accounts:['market','consensus'].flatMap(policy=>[0,1000].map(delay=>newEvolutionPortfolio(policy,delay)))};
  }
  this.validate();this.written=new Map();
  if(existsSync(this.journal))for(const line of readFileSync(this.journal,'utf8').split('\n').filter(Boolean)){
   const row=JSON.parse(line);if(!row.id||this.written.has(row.id)&&this.written.get(row.id)!==JSON.stringify(row))throw Error('Conflicting evolution journal id');
   this.written.set(row.id,JSON.stringify(row));
  }
  this.flush();
  if(!this.state.closedAt)for(const a of this.state.accounts)if(a.position){
   for(const key of ['marketReversal','bidReversal','reversalObservation','holdingDecision','bidDecision','consensusDecision','pendingExit'])delete a.position[key];
  }
  if(!existsSync(this.path))this.save([]);
 }
 validate(){
  const s=this.state;
  if(!finite(s.createdAt)||!Array.isArray(s.pending)||!Number.isInteger(s.eventSequence)||s.eventSequence<0||
   !Array.isArray(s.accounts)||s.accounts.length!==4||new Set(s.accounts.map(a=>a.id)).size!==4||
   s.accounts.some(a=>!['market','consensus'].includes(a.policy)||![0,1000].includes(a.executionDelayMs))||
   new Set(s.accounts.map(a=>`${a.policy}:${a.executionDelayMs}`)).size!==4)throw Error('Invalid evolution cohort checkpoint');
  for(const a of s.accounts)validateEvolutionPortfolio(a);
  for(const [day,d]of Object.entries(s.daily)){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Array.isArray(d.observedRounds)||!Array.isArray(d.eligibleRounds)||
    new Set(d.observedRounds).size!==d.observedRounds.length||new Set(d.eligibleRounds).size!==d.eligibleRounds.length||
    d.eligibleRounds.some(slug=>!d.observedRounds.includes(slug)))throw Error('Invalid evolution coverage checkpoint');
  }
 }
 flush(){
  for(const e of this.state.pending){const text=JSON.stringify(e),prior=this.written.get(e.id);
   if(prior&&prior!==text)throw Error('Conflicting evolution outbox event');
   if(!prior){appendFileSync(this.journal,text+'\n');this.written.set(e.id,text);}}
  this.state.pending=[];
 }
 save(events=[]){
  if(this.state.closedAt){if(events.length)throw Error('Sealed evolution batch is immutable');this.flush();return;}
  this.state.pending.push(...events);this.validate();writeJsonAtomic(this.path,this.state);this.flush();
 }
 observe(input,financialLabels,{allowEntry=true,batchStart,batchEnd,labelCutoff}={}){
  const s=this.state,b=s.batch,now=input?.now;
  if((batchStart!==undefined&&batchStart!==b.start)||(batchEnd!==undefined&&batchEnd!==b.end)||
   (labelCutoff!==undefined&&labelCutoff!==b.labelCutoff))throw Error('Cannot change registered evolution batch');
  if(s.closedAt||!finite(now)||now<s.createdAt||now>b.labelCutoff||s.lastAt!==null&&now<=s.lastAt)return;
  const previous=s.lastAt;s.lastAt=now;s.startedAt??=now;
  const inBatch=now>=b.start&&now<b.end,ready=inBatch&&evolutionFrameReady(input);
  input={...input,config:{...input.config,...evolutionConfig},strategy:{...evolutionStrategy}};
  const exitFrame=evolutionExitFrame(input);if(exitFrame)this.history.add(exitFrame,now);
  input={...input,bidHistory:this.history.rows};
  const candidate=ready?evolutionCandidate(input):null,events=[];
  if(ready){
   const day=evolutionDay(now),d=s.daily[day]??={observedRounds:[],eligibleRounds:[],observedFrom:now,observedThrough:now,unobservedGapMs:0};
   const slug=input.frame.market.slug;
   if(!d.observedRounds.includes(slug)){d.observedRounds.push(slug);events.push({kind:'round-observed',at:now,slug,day});}
   if(candidate&&!d.eligibleRounds.includes(slug)){d.eligibleRounds.push(slug);events.push({kind:'round-eligible',at:now,slug,day});}
   d.observedThrough=now;if(previous!==null&&now-previous>3000)d.unobservedGapMs+=now-previous;
  }
  const labels=new Map([...financialLabels??[]].filter(([,l])=>finite(l?.observedAt)&&l.observedAt<=b.labelCutoff));
  for(const a of s.accounts){
   const es=stepEvolutionPortfolio(a,input,labels,candidate,Boolean(allowEntry&&inBatch));
   if(es.some(e=>['opened','sale-attempt','closed','settled'].includes(e.kind)))a.daily=evolutionDailySummary(a);
   for(const e of es)events.push({...e,tradeId:e.tradeId??e.id??null,accountId:a.id,policy:a.policy,executionDelayMs:a.executionDelayMs});
  }
  this.save(events.map(e=>({...e,id:`${s.instanceId}:${++s.eventSequence}`,version:evolutionStudyVersion,
   batchId:b.id,registryHash:s.registryHash})));
 }
 closeBatch(now){
  if(!finite(now)||now<this.state.batch.labelCutoff)throw Error('Cannot seal before registered label cutoff');
  if(!this.state.closedAt){this.flush();this.state.closedAt=now;this.state.sealedAsOf=this.state.lastAt;
   this.validate();writeJsonAtomic(this.path,this.state);}return this.summary(this.state.batch.labelCutoff);
 }
 summary(now=this.state.lastAt??this.state.createdAt){
  const s=this.state,b=s.batch,asOf=s.closedAt?Math.min(now,b.labelCutoff):now;
  const daily=Object.fromEntries(Object.entries(s.daily).map(([day,d])=>[day,{...clone(d),
   observedRoundCount:d.observedRounds.length,eligibleRoundCount:d.eligibleRounds.length}]));
  const observed=new Set(Object.values(daily).flatMap(d=>d.observedRounds)),eligible=new Set(Object.values(daily).flatMap(d=>d.eligibleRounds));
  const fullDays=[];for(let start=b.start;start<b.end;start+=86400000){const day=evolutionDay(start);
   if(s.createdAt<=start&&asOf>=start+86400000&&daily[day]?.observedRoundCount)fullDays.push(day);}
  return {version:evolutionStudyVersion,realTrading:false,instanceId:s.instanceId,createdAt:s.createdAt,registryHash:s.registryHash,
   batch:clone(b),batchId:b.id,batchStart:b.start,batchEnd:b.end,labelCutoff:b.labelCutoff,protocol:clone(s.protocol),
   implementation:clone(s.implementation),startedAt:s.startedAt,lastAt:s.lastAt,closedAt:s.closedAt,sealedAsOf:s.sealedAsOf??null,
   accountIsolated:true,independentSamples:false,coverage:{daily,fullDays,fullDayCount:fullDays.length,
    observedRounds:[...observed],eligibleRounds:[...eligible],observedRoundCount:observed.size,eligibleRoundCount:eligible.size,
    fullDaysMeaning:'Completed registered HKT calendar days with observations; feed gaps and round counts must be reviewed separately.'},
   daily,accounts:s.accounts.map(a=>evolutionPortfolioSummary(a,asOf)),
   limitations:['Four paths reuse the same market tape and are not four independent statistical samples.',
    'Unavailable official outcomes remain owned inventory with payout bounds; no zero-result substitution.',
    'Paper fills and dual official API payouts do not prove real-market execution or onchain redemption.',
    'Calendar completion alone does not imply complete data coverage or positive expectancy.']};
 }
}
