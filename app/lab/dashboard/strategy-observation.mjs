import {readFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.mjs';
import {PaperBroker,round} from '../paper-broker.mjs';
import {evaluateForward,forwardExit,forwardProtocol} from './forward-strategy.mjs';
import {freshBook,depthQuote} from './strategy.mjs';
import {marketInformationExit,marketExitRevision} from './market-exit.mjs';

export const observationPolicies=Object.freeze({
 baseline:{label:'旧规则（BTC 尾样 ≤ 3 秒）',strict:true,align:false,cap:1,hold:60,reversal:10},
 fresh_reference:{label:'仅要求参考价新鲜',strict:false,align:false,cap:1,hold:60,reversal:10},
 btc_aligned:{label:'BTC 同方向',strict:false,align:true,cap:1,hold:60,reversal:10},
 capped_85:{label:'信号买价不超过 85¢',strict:false,align:false,cap:.85,hold:60,reversal:10},
 aligned_capped:{label:'同方向且信号买价 ≤ 85¢',strict:false,align:true,cap:.85,hold:60,reversal:10},
 patient_60:{label:'满 30 秒后才检查反转',strict:false,align:false,cap:1,hold:60,reversal:30},
 fixed_60:{label:'持有 60 秒，不因动量反转退出',strict:false,align:false,cap:1,hold:60,reversal:null},
 fixed_120:{label:'持有 120 秒，不因动量反转退出',strict:false,align:false,cap:1,hold:120,reversal:null}
});
const version='prospective-comparison-v1';
const emptyPairs=()=>({completed:0,oldNet:0,confirmedNet:0,delta:0,improved:0,worse:0,unchanged:0,unmatched:{}});
const emptyMarketPairs=()=>({completed:0,baselineNet:0,noDollarNet:0,marketNet:0,delta:0,improved:0,worse:0,unchanged:0,unmatched:{}});
// Independent per-round $1 hypotheses. No orders or cash flow enter the main
// account. All exits retain the $0.50 stop and final-minute exit boundary.
export class StrategyObservation {
 constructor(directory) {
  this.path=join(directory,'strategy-observation.json');this.journal=join(directory,'strategy-observation.jsonl');
  this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{version,startedAt:null,active:[],recent:[],totals:{},attempted:{},mainIds:[]};
  if(this.state.version!==version)throw Error('Unknown strategy observation version');
  this.state.pairedExit??=emptyPairs();
  this.state.marketExitPairs??=emptyMarketPairs();
  this.finishedIds=new Set();this.finishedMainIds=new Set();
  // Finished journal rows are authoritative if interruption occurred before
  // the snapshot save. Reconcile by entry ID to avoid counting a close twice.
  if(existsSync(this.journal)) {
   const done=new Map(),duplicateIds=new Set(),conflictingIds=new Set();let duplicateRows=0;
   for(const line of readFileSync(this.journal,'utf8').split('\n').filter(Boolean)) {
    const e=JSON.parse(line),prior=done.get(e.id);
    // finish() writes terminal rows only. A sold/finished entry must never be
    // overwritten by a later duplicate hypothetical settlement with the same ID.
    if(prior){duplicateRows++;duplicateIds.add(e.id);if(JSON.stringify(prior)!==JSON.stringify(e))conflictingIds.add(e.id);}
    else done.set(e.id,e);
   }
   this.finishedIds=new Set(done.keys());
   this.finishedMainIds=new Set([...done.values()].filter(e=>e.kind==='main-followup').map(e=>e.id.slice(5)));
   this.state.recoveryAudit={version:'observation-terminal-recovery-v2',policy:'first-terminal-id',
    duplicateRows,duplicateIds:duplicateIds.size,conflictingDuplicateIds:conflictingIds.size};
   this.state.active=this.state.active.filter(e=>!done.has(e.id));this.state.totals={};this.state.pairedExit=emptyPairs();this.state.marketExitPairs=emptyMarketPairs();
   for(const e of done.values()) {
    if(e.kind==='paired-exit' && e.status==='closed')this.countPair(e);
    if(e.kind==='paired-market-exit' && e.status==='closed')this.countMarketPair(e);
    if(e.kind==='comparison') {
     if((e.market?.start??0)>=(this.state.attempted[e.variant]?Number(this.state.attempted[e.variant].split('-').at(-1))*1000:0))this.state.attempted[e.variant]=e.slug;
     if(e.status==='closed')this.count(e);
    }
   }
   this.state.recent=[...done.values()].slice(-80);
   const journalMain=[...done.values()].filter(e=>e.kind==='main-followup')
    .sort((a,b)=>(a.openedAt??0)-(b.openedAt??0)||(a.id<b.id?-1:a.id>b.id?1:0)).map(e=>e.id.slice(5));
   const activeIds=this.state.active.map(e=>e.kind==='main-followup'?e.id.slice(5):e.pairId).filter(Boolean);
   const recentIds=new Map();
   for(const id of [...journalMain,...this.state.mainIds,...activeIds]){recentIds.delete(id);recentIds.set(id,true);}
   this.state.mainIds=[...recentIds.keys()].slice(-500);
  }
  this.resetConfirmation();
 }
 resetConfirmation(){for(const e of this.state.active){delete e.reversalObservation;delete e.marketReversal;e.holdingDecision=null;}}
 save(){writeJsonAtomic(this.path,this.state);}
 addMain(trade,held) {
  if(!trade.id || this.state.mainIds.includes(trade.id) || this.finishedMainIds.has(trade.id) ||
   this.state.active.some(e=>e.id==='main:'+trade.id||e.pairId===trade.id)||!Number.isFinite(trade.openedAt)||!held)return;
  this.state.mainIds.push(trade.id);this.state.mainIds=this.state.mainIds.slice(-500);
  this.state.active.push({id:'main:'+trade.id,kind:'main-followup',variant:'main',slug:trade.slug,
   market:structuredClone(trade.market),outcome:trade.outcome,tokenId:trade.tokenId,openedAt:trade.openedAt,
   size:held,cost:trade.costPerShare*held,points:{},entryVersion:trade.entryDecision?.version,
   executionVersion:trade.parameters?.executionVersion,experimentId:trade.experimentId});
  if(trade.parameters?.exitRevision===forwardProtocol.exitRevision) {
   const fees=Object.values(trade.orderReports??{}).filter(o=>o.side==='buy').reduce((s,o)=>s+o.fees,0);
   for(const [variant,confirmationMs] of [['immediate',0],['confirmed',forwardProtocol.reversalConfirmationMs]]) {
    this.state.active.push({id:`paired:${trade.id}:${variant}`,pairId:trade.id,kind:'paired-exit',variant,
     slug:trade.slug,market:structuredClone(trade.market),outcome:trade.outcome,tokenId:trade.tokenId,
     openedAt:trade.openedAt,size:held,remaining:held,cost:trade.costPerShare*held,costPerShare:trade.costPerShare,
     fees,proceeds:0,points:{},status:'holding',experimentId:trade.experimentId,
     parameters:structuredClone(trade.parameters),policy:{reversal:10,confirmationMs},
     comparisonVersion:'same-entry-exit-v1',exitDelayMs:1000});
   }
  }
  if(trade.parameters?.exitRevision===marketExitRevision) {
   const fees=Object.values(trade.orderReports??{}).filter(o=>o.side==='buy').reduce((s,o)=>s+o.fees,0);
   for(const variant of ['baseline','noDollar','market'])this.state.active.push({
    id:`market-paired:${trade.id}:${variant}`,pairId:trade.id,kind:'paired-market-exit',variant,origin:trade.origin??'automatic',
    slug:trade.slug,market:structuredClone(trade.market),outcome:trade.outcome,tokenId:trade.tokenId,openedAt:trade.openedAt,
    size:held,remaining:held,cost:trade.costPerShare*held,costPerShare:trade.costPerShare,fees,proceeds:0,points:{},status:'holding',
    parameters:structuredClone(trade.parameters),policy:{reversal:10,confirmationMs:5000},comparisonVersion:'same-entry-market-exit-v1',exitDelayMs:1000});
  }
  this.save();
 }
 finish(e) {
  if(this.finishedIds.has(e.id)){e.done=true;return;}
  // Durable terminal evidence precedes in-memory totals. Repeated closes with
  // the same entry ID cannot pay or count again, including after restart.
  appendFileSync(this.journal,JSON.stringify({...e,done:true,version})+'\n');
  this.finishedIds.add(e.id);if(e.kind==='main-followup')this.finishedMainIds.add(e.id.slice(5));
  e.done=true;
  if(e.kind==='comparison' && e.status==='closed')this.count(e);
  if(e.kind==='paired-exit' && e.status==='closed')this.countPair(e);
  if(e.kind==='paired-market-exit' && e.status==='closed')this.countMarketPair(e);
  this.state.recent.push(structuredClone(e));this.state.recent=this.state.recent.slice(-80);
 }
 count(e) {
   const t=this.state.totals[e.variant]??={n:0,wins:0,net:0,fees:0,settlements:0};
   t.n++;t.wins+=Number(e.net>0);t.net=round(t.net+e.net);t.fees=round(t.fees+e.fees);
   t.settlements+=Number(e.closeMethod==='verified-settlement');
 }
 countPair(e) {
  const totals=this.state.pairedExit,pair=totals.unmatched[e.pairId]??={};
  pair[e.variant]=e.net;
  if(pair.immediate===undefined || pair.confirmed===undefined)return;
  const delta=round(pair.confirmed-pair.immediate);
  totals.completed++;totals.oldNet=round(totals.oldNet+pair.immediate);totals.confirmedNet=round(totals.confirmedNet+pair.confirmed);
  totals.delta=round(totals.delta+delta);totals.improved+=Number(delta>0);totals.worse+=Number(delta<0);totals.unchanged+=Number(delta===0);
  delete totals.unmatched[e.pairId];
 }
 countMarketPair(e) {
  const t=this.state.marketExitPairs,pair=t.unmatched[e.pairId]??={};pair[e.variant]=e.net;
  if(['baseline','noDollar','market'].some(k=>pair[k]===undefined))return;
  const delta=round(pair.market-pair.baseline);t.completed++;
  for(const k of ['baseline','noDollar','market'])t[k+'Net']=round(t[k+'Net']+pair[k]);
  t.delta=round(t.delta+delta);t.improved+=Number(delta>0);t.worse+=Number(delta<0);t.unchanged+=Number(delta===0);
  delete t.unmatched[e.pairId];
 }
 observe(input,labels,allowEntry) {
  // Freeze comparison thresholds independently of later manual parameter edits.
  input={...input,config:{...input.config,staleMs:3000,buyUnits:1,holdMs:60000},
   strategy:{...input.strategy,minNetEdge:.005,costBuffer:.005,maxSpread:.04,stopLossUsd:.5}};
  const {frame,now,history,config,strategy}=input;if(!frame)return;
  this.state.startedAt??=now;
  let dirty=false;
  for(const e of this.state.active) {
   if(e.done)continue;
   const same=e.slug===frame.market.slug,market=same?frame.market:e.market;
   const book=same?frame.books.find(b=>b.tokenId===e.tokenId):null;
   const fresh=same&&freshBook(book,now,config.staleMs);
   if(!fresh){delete e.reversalObservation;delete e.marketReversal;}
   if(e.status==='pending') {
    if(!allowEntry){e.status='unfilled';e.reason='暂停期间取消待入场对照';this.finish(e);dirty=true;continue;}
    if(now<e.signalAt+1000)continue;
    const tw=frame.twap,ref=tw&&['timestamp','receivedAt'].every(k=>now>=tw[k]&&now-tw[k]<=5000);
    if(!same || now>e.signalAt+4000 || now>=market.end-30000 || !ref) {
     e.status='unfilled';e.reason='延迟窗口内没有可用新鲜报价';this.finish(e);dirty=true;continue;
    }
    if(!fresh)continue;
    const broker=new PaperBroker();broker.setBook(book);
    // Upper share bound is from the current best ask; original protection stays fixed.
    const best=book.asks[0]?.[0];
    const report=best?broker.submit({tokenId:e.tokenId,side:'buy',amountUsd:1,size:Math.floor(1/best*1e8)/1e8,
     price:e.limit,orderType:'FAK',postOnly:false},market,now):null;
    if(!report?.filled){e.status='unfilled';e.reason='原保护价内未成交';this.finish(e);}
    else Object.assign(e,{status:'holding',openedAt:now,size:report.filled,remaining:report.filled,
     cost:report.notional+report.fees,fees:report.fees,proceeds:0,costPerShare:(report.notional+report.fees)/report.filled,points:{}});
    dirty=true;continue;
   }
   // Fixed observations continue after the actual account exits. Missing
   // quotes stay explicitly missing; future points never become entry inputs.
   for(const seconds of [30,60,120]) {
    if(e.points?.[seconds])continue;
    const target=e.openedAt+seconds*1000+1000;
    if(now<target)continue;
    if(fresh && now<=target+3000 && now<market.end) {
     const limit=book.bids.length?Math.max(market.tick,book.bids[0][0]-.02):0;
     const q=depthQuote(book,'sell',e.size,market,limit);
     e.points[seconds]={time:now,status:q?.complete?'quoted':'insufficient-depth',
      net:q?.complete?round(q.notional-q.fees-e.cost):null};
     dirty=true;
    } else if(now>target+3000 || now>=e.market.end) {
     e.points[seconds]={time:now,status:'missing-quote',net:null};dirty=true;
    }
   }
   const label=labels.get(e.slug);
   const verified=label && now>=label.observedAt && now>=e.market.end &&
    label.conditionId===e.market.conditionId && label.start===e.market.start && label.end===e.market.end &&
    label.tokens?.[e.outcome]===e.tokenId && [0,1].includes(label.payouts?.[e.outcome]);
   if(e.kind==='main-followup') {
    if(verified){e.settlementNet=round(e.size*label.payouts[e.outcome]-e.cost);e.settlementObservedAt=label.observedAt;}
    if(verified && Object.keys(e.points).length===3){this.finish(e);dirty=true;}
    continue;
   }
   if(e.status==='holding' && e.remaining>0) {
    if(verified) {
     e.proceeds=round(e.proceeds+e.remaining*label.payouts[e.outcome]);e.remaining=0;
     e.closeMethod='verified-settlement';e.closedAt=now;dirty=true;
    } else if(fresh && now<market.end) {
     if(e.pendingExit && now>=e.pendingExit.at) {
      if(now<=e.pendingExit.at+3000 && book.timestamp>(e.lastSellBook??-1)) {
       const broker=new PaperBroker();broker.setBook(book);
       const o=broker.submit({tokenId:e.tokenId,side:'sell',size:e.remaining,price:e.pendingExit.limit,orderType:'FAK',postOnly:false},market,now);
       e.remaining=round(e.remaining-o.filled);e.proceeds=round(e.proceeds+o.notional-o.fees);e.fees=round(e.fees+o.fees);
       e.lastSellBook=book.timestamp;e.closedAt=now;e.closeMethod='book-sale';
      }
      e.pendingExit=null;e.nextExitAt=now+2000;dirty=true;
     }
     if(e.remaining>0 && !e.pendingExit && now>=(e.nextExitAt??0)) {
      const marketPair=e.kind==='paired-market-exit',paired=e.kind==='paired-exit'||marketPair,policy=paired?e.policy:observationPolicies[e.variant];
      const exit=marketPair && e.variant==='market'?marketInformationExit(e,e.remaining,book,market,now,e.parameters.config,history,input.prices):
       forwardExit(e,e.remaining,book,market,now,
        marketPair?{...e.parameters.config,holdMs:60000}:paired?e.parameters.config:{...config,holdMs:policy.hold*1000},
        marketPair?{...e.parameters.strategy,stopLossUsd:e.variant==='baseline'?.5:0}:paired?e.parameters.strategy:{...strategy,stopLossUsd:.5},history,policy);
      if(paired)dirty=true;
      if(exit){e.pendingExit={at:now+1000,limit:exit.limit};e.exitReason=exit.reason;dirty=true;}
     }
    }
    if(e.remaining===0) {
     e.net=round(e.proceeds-e.cost);e.status='closed';this.finish(e);dirty=true;
    }
   }
  }
  this.state.active=this.state.active.filter(e=>!e.done);
  if(allowEntry && this.state.active.length<512) {
   const decisionCache=new Map();
   for(const [variant,policy] of Object.entries(observationPolicies)) {
    if(this.state.attempted[variant]===frame.market.slug)continue;
    const key=JSON.stringify([policy.strict,policy.align,policy.cap]);
    let d=decisionCache.get(key);
    if(!d){d=evaluateForward({...input,config:{...config,buyUnits:1},researchPolicy:policy});decisionCache.set(key,d);}
    const c=d.selected;if(!c)continue;
    this.state.attempted[variant]=frame.market.slug;
    const e={id:version+':'+variant+':'+frame.market.slug,kind:'comparison',variant,slug:frame.market.slug,
     market:structuredClone(frame.market),tokenId:c.tokenId,outcome:c.outcome,status:'pending',signalAt:now,limit:c.limit,
     entryDecision:structuredClone(c)};
    this.state.active.push(e);dirty=true;
   }
  }
  if(dirty)this.save();
 }
 summary() {
  const {unmatched,...pairedExit}=this.state.pairedExit;
  const {unmatched:marketUnmatched,...marketExitPairs}=this.state.marketExitPairs;
  return {version,startedAt:this.state.startedAt,accountIsolated:true,amountUsd:1,
   recoveryAudit:this.state.recoveryAudit??null,
   marketExitPairs:{...marketExitPairs,version:'same-entry-market-exit-v1',delayMs:1000,
    pending:new Set([...Object.keys(marketUnmatched),...this.state.active.filter(e=>e.kind==='paired-market-exit').map(e=>e.pairId)]).size},
   pairedExit:{...pairedExit,version:'same-entry-exit-v1',delayMs:1000,
    pending:new Set([...Object.keys(unmatched),...this.state.active.filter(e=>e.kind==='paired-exit').map(e=>e.pairId)]).size},
   policies:Object.entries(observationPolicies).map(([key,p])=>({key,label:p.label,...(this.state.totals[key]??{n:0,net:0,fees:0,wins:0}),
    active:this.state.active.filter(e=>e.kind==='comparison'&&e.variant===key).length})),
   mainFollowups:[...this.state.recent,...this.state.active].filter(e=>e.kind==='main-followup').slice(-5),
   pendingMainFollowups:this.state.active.filter(e=>e.kind==='main-followup').length};
 }
}
