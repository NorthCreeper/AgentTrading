// Independent arithmetic audit of a frozen naturally running observer. No trading imports.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const here=dirname(fileURLToPath(import.meta.url)),lab=resolve(here,'../..'),sha=b=>createHash('sha256').update(b).digest('hex'),
 read=p=>JSON.parse(readFileSync(p,'utf8')),round=n=>Math.round(n*1e8)/1e8,close=(a,b)=>Math.abs(a-b)<=2e-8;
function prefix(path,count){const bytes=readFileSync(path);let end=0;for(let i=0;i<count;i++){
  const next=bytes.indexOf(10,end);assert.ok(next>=0,'Frozen complete input prefix exists');end=next+1;}return bytes.subarray(0,end);}
function chain(bytes,count,lastHash){const rows=bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);let prev=null;
 assert.equal(rows.length,count);for(let i=0;i<rows.length;i++){
  const r=rows[i];assert.equal(r.sequence,i+1);assert.equal(r.prev,prev);
  assert.equal(r.hash,sha(JSON.stringify({sequence:r.sequence,prev:r.prev,payload:r.payload})));prev=r.hash;
 }assert.equal(prev,lastHash);return rows;}
function fillMath(report,book,fee){let filled=0,notional=0,fees=0;
 const levels=report.side==='buy'?book.asks:book.bids;
 for(const [price,available]of levels){if(report.side==='buy'?price>report.price:price<report.price)break;
  if(filled>=report.size)break;const budget=report.side==='buy'&&report.amountUsd!==undefined?
   Math.floor(Math.max(0,report.amountUsd-notional)/price*1e8)/1e8:Infinity,
   quantity=Math.min(available,round(report.size-filled),budget);
  if(quantity<=0)break;filled=round(filled+quantity);notional=round(notional+quantity*price);
  fees=round(fees+round(quantity*fee.rate*(price*(1-price))**fee.exponent));
 }return {filled,notional,fees};}
export function auditNaturalObserver({directory=join(here,'prospective-observer'),out=join(here,'natural-observer-audit-'+Date.now())}={}){
 directory=resolve(directory);out=resolve(out);assert.ok(!existsSync(out),'New audit directory required');mkdirSync(out);
 // Read the atomic checkpoint first; all append-only prefixes already exist at its exact cursors.
 const checkpointBytes=readFileSync(join(directory,'checkpoint.json')),checkpoint=JSON.parse(checkpointBytes),
 registrationBytes=readFileSync(join(directory,'observer-registration.json')),registration=JSON.parse(registrationBytes),
 state=checkpoint.payload.state,machine=checkpoint.payload.machine,
 inputBytes=prefix(join(directory,'inputs.jsonl'),state.inputSequence),journalBytes=prefix(join(directory,'journal.jsonl'),state.journalSequence);
 for(const [name,bytes]of [['checkpoint.json',checkpointBytes],['observer-registration.json',registrationBytes],['inputs.jsonl',inputBytes],['journal.jsonl',journalBytes]])
 writeFileSync(join(out,name),bytes,{flag:'wx'});
 assert.equal(checkpoint.hash,sha(JSON.stringify(checkpoint.payload)));assert.equal(checkpoint.payload.bindingHash,sha(JSON.stringify(registration.binding)));
 const inputs=chain(inputBytes,state.inputSequence,state.inputHash),journal=chain(journalBytes,state.journalSequence,state.journalHash),
 events=[...journal.map(r=>r.payload),...state.pendingOutbox],ids=new Set();
 for(const e of events){assert.ok(!ids.has(e.id),'Each journal event has a unique identity');ids.add(e.id);}
 const sourceChecks=Object.fromEntries(Object.entries(registration.binding.sources).map(([name,hash])=>{
  const actual=sha(readFileSync(join(lab,name)));assert.equal(actual,hash,'Registered source '+name);return [name,actual];})),
 historicalPath=join(here,'full-history-1790887800000'),historicalRegistration=read(join(historicalPath,'registration.json'));
 for(const [name,hash]of Object.entries(historicalRegistration.sources))assert.equal(sourceChecks[name],hash);
 assert.equal(sha(readFileSync(join(historicalPath,'report.json'))),registration.binding.reportHash);
 assert.equal(sha(readFileSync(join(historicalPath,'registration.json'))),registration.binding.historicalRegistrationHash);
 assert.equal(sha(readFileSync(join(historicalPath,'certificate.json'))),registration.binding.historicalCertificateHash);
 assert.equal(registration.binding.protocol.independentCash,true);assert.equal(registration.binding.protocol.mainControls,false);
 assert.equal(registration.binding.protocol.bootstrap,false);assert.deepEqual(registration.binding.protocol.methods,['GET']);
 assert.ok(machine.prospective);assert.ok(machine.seedKnownAt<=registration.createdAt);assert.equal(machine.arms.length,38);
 let lastKnowledge=registration.createdAt,rawOfficial=0,producerRecords=0;const inputBySequence=new Map();
 for(const row of inputs){inputBySequence.set(row.sequence,row);const p=row.payload;assert.ok(p.observedAt>=lastKnowledge,'Monotonic observer knowledge');lastKnowledge=p.observedAt;
  if(p.kind==='state'){producerRecords++;assert.equal(p.state.realTrading,false);assert.ok(p.state.now<=p.observedAt);
   assert.equal(p.state.account,undefined,'No main cash, fees or account state is copied');assert.equal(p.state.portfolio,undefined);}
  if(p.kind==='official'){rawOfficial++;assert.ok(p.raw.observedAt<=p.observedAt,'Raw evidence is available only after its original observation');}
 }
 assert.ok(machine.evidenceAt<=lastKnowledge);for(const e of state.labelsAccepted){assert.ok(e.at>=e.sourceObservedAt);assert.ok(e.at<=lastKnowledge);}
 const ledgers=new Map(machine.arms.map(arm=>[arm.account.id,{id:arm.account.id,candidate:arm.candidate.id,scenario:arm.scenario.id,
  cash:100,fees:0,realized:0,completed:0,wins:0,trades:new Map(),reports:new Map(),sources:new Map(),opened:0,attempts:0,payouts:0}])),
 reportIds=new Set(),settlementIds=new Set(),kinds={};let depthChecks=0,clockChecks=0;
 for(const e of events){kinds[e.kind]=(kinds[e.kind]??0)+1;const input=inputBySequence.get(e.inputSequence);
  assert.ok(input,'Every journal event has an original input');assert.equal(e.inputHash,input.hash);assert.ok(e.at<=input.payload.observedAt,'No event trades on future knowledge');
  if(!e.candidate)continue;const ledger=ledgers.get([e.scope,e.scenario,e.candidate].join(':'));assert.ok(ledger);
  if(e.kind==='entry-attempt'||e.kind==='sale-attempt'){
   const r=e.report;assert.ok(!reportIds.has(r.id),'Order reports cannot be consumed twice');reportIds.add(r.id);ledger.reports.set(r.id,r);ledger.attempts++;
   assert.equal(r.createdAt,e.at);assert.ok(e.sourceAt<=e.receivedAt&&e.receivedAt<=e.frameAt&&e.frameAt<=e.at);clockChecks++;
   const previous=ledger.sources.get(r.tokenId)??-Infinity;assert.ok(e.sourceAt>previous,'Each account consumes a strictly new source');ledger.sources.set(r.tokenId,e.sourceAt);
   const frame=input.payload.state?.frame;assert.ok(frame&&frame.now===e.frameAt);const book=frame.books.find(b=>b.tokenId===r.tokenId);assert.ok(book);
   assert.equal(book.timestamp,e.sourceAt);assert.equal(book.receivedAt,e.receivedAt);
   const fee={...frame.market.fee,rate:frame.market.fee.rate*(e.scenario==='stress'?1.25:1)},math=fillMath(r,book,fee);
   for(const field of ['filled','notional','fees'])assert.ok(close(math[field],r[field]),'Independent displayed-depth arithmetic '+field);depthChecks++;
   ledger.cash=round(ledger.cash+(r.side==='buy'?-r.notional-r.fees:r.notional-r.fees));ledger.fees=round(ledger.fees+r.fees);
   if(e.kind==='sale-attempt'){const t=ledger.trades.get(e.tradeId);assert.ok(t);t.remaining=round(t.remaining-r.filled);t.saleNet=round(t.saleNet+r.notional-r.fees);}
  }
  if(e.kind==='opened'){
   const id=e.tradeId??e.entityId??e.id;assert.ok(!ledger.trades.has(id));const buys=Object.values(e.orderReports).filter(r=>r.side==='buy');
   assert.ok(buys.length);let size=0,cost=0;for(const r of buys){assert.ok(ledger.reports.has(r.id));size=round(size+r.filled);cost=round(cost+r.notional+r.fees);}
   assert.ok(close(size,e.remaining)&&close(cost,e.cost));ledger.trades.set(id,{id,slug:e.slug,market:e.market,outcome:e.outcome,size,
    remaining:size,cost,saleNet:0,payout:0,closed:false,queued:false});ledger.opened++;
   assert.ok(e.entryDecision.knownAt<=e.openedAt&&e.entryDecision.forecastMadeAt<=e.openedAt);
  }
  if(e.kind==='queued'){const t=ledger.trades.get(e.tradeId);assert.ok(t);assert.ok(close(t.remaining,e.remaining));assert.ok(e.at>=t.market.end);t.queued=true;}
  if(e.kind==='settled'){
   const t=ledger.trades.get(e.tradeId);assert.ok(t&&!t.closed);assert.ok(close(t.remaining,e.size));const labels=state.labelsAccepted.filter(l=>l.label.slug===e.slug&&l.at<=e.at);
   assert.ok(labels.length,'Settlement requires evidence actually known before credit');assert.ok(labels.some(l=>l.label.winner===e.winner));
   const payout=round(e.size*(t.outcome===e.winner?1:0));assert.ok(close(payout,e.payout));assert.ok(!settlementIds.has(ledger.id+':'+e.tradeId));settlementIds.add(ledger.id+':'+e.tradeId);
   t.remaining=0;t.payout=round(t.payout+payout);ledger.cash=round(ledger.cash+payout);ledger.payouts++;
  }
  if(e.kind==='closed'){
   const id=e.tradeId??e.entityId??e.id,t=ledger.trades.get(id);assert.ok(t&&!t.closed);assert.ok(close(t.remaining,0));
   const net=round(t.saleNet+t.payout-t.cost);assert.ok(close(net,e.net));t.closed=true;ledger.realized=round(ledger.realized+net);ledger.completed++;ledger.wins+=Number(net>0);
  }
 }
 const accounts=[];for(const arm of machine.arms){const a=arm.account,l=ledgers.get(a.id),owned=[a.position,...a.pendingSettlements].filter(Boolean),
  remaining=[...l.trades.values()].filter(t=>!t.closed),closed=[...l.trades.values()].filter(t=>t.closed);
  for(const field of ['cash','fees','realized'])assert.ok(close(l[field],a[field]),'Independent account arithmetic '+a.id+' '+field);
  assert.equal(l.completed,a.completed);assert.equal(l.wins,a.wins);assert.equal(remaining.length,owned.length);assert.equal(closed.length,a.closedTrades.length);
  for(const t of owned){const expected=l.trades.get(t.id);assert.ok(expected&&!expected.closed);assert.ok(close(t.remaining,expected.remaining));assert.ok(close(t.cost,expected.cost));
   assert.equal(Boolean(t.parkedAt),expected.queued);}
  for(const [token,source]of l.sources)assert.equal(a.lastConsumedSources[token],source);
  assert.equal(a.initialCapital,100);accounts.push({id:a.id,cash:l.cash,fees:l.fees,realized:l.realized,completed:l.completed,wins:l.wins,
   opened:l.opened,attempts:l.attempts,payouts:l.payouts,active:Number(Boolean(a.position)),pending:a.pendingSettlements.length,
   remaining:remaining.map(t=>({id:t.id,slug:t.slug,shares:t.remaining,cost:t.cost,queued:t.queued}))});
 }
 const forecasts=machine.forecasts?.entries??[];for(const [slug,f]of forecasts){assert.ok(f.at<=lastKnowledge);if(f.updated)assert.ok(f.knownAt>=f.at&&f.knownAt<=lastKnowledge);}
 const result={version:'independent-natural-observer-audit-v1',pass:true,auditedAt:Date.now(),directory,out,createdAt:registration.createdAt,
  cutoff:state.lastPollAt,inputSequence:state.inputSequence,journalSequence:state.journalSequence,pendingOutbox:state.pendingOutbox.length,
  naturalFrames:state.frames,naturalProducerRecords:producerRecords,rounds:Object.keys(state.knownMarkets).length,rawOfficial,
  strictLabels:state.labelsAccepted.filter(e=>e.scope==='strict').length,financialLabels:state.labelsAccepted.filter(e=>e.scope==='financial').length,
  eventKinds:kinds,accounts:accounts.length,independentlyCheckedOrderReports:depthChecks,executionClockChecks:clockChecks,
  historicalSourceCount:Object.keys(historicalRegistration.sources).length,allRegisteredSourcesUnchanged:true,
  mainCashCopied:false,mainOrderControls:false,accountDetails:accounts,
  sums:{cash:accounts.reduce((s,a)=>round(s+a.cash),0),fees:accounts.reduce((s,a)=>round(s+a.fees),0),realized:accounts.reduce((s,a)=>round(s+a.realized),0),
   active:accounts.reduce((s,a)=>s+a.active,0),pending:accounts.reduce((s,a)=>s+a.pending,0),completed:accounts.reduce((s,a)=>s+a.completed,0)},
  snapshotHashes:{checkpoint:sha(checkpointBytes),registration:sha(registrationBytes),inputs:sha(inputBytes),journal:sha(journalBytes)},
  interpretation:'Natural prospective samples and independent cash/fee/inventory/payment arithmetic; not a profitability claim. No live fills or wallet funds used.'};
 writeFileSync(join(out,'independent-audit.json'),JSON.stringify(result,null,2),{flag:'wx'});
 writeFileSync(join(out,'自然运行独立核算.md'),`# 自然候选运行独立核算\n\n审计通过。原实例 ${result.createdAt}，冻结 ${result.naturalFrames} 个自然有效新帧、${result.inputSequence} 条原始输入与 ${result.journalSequence} 条事件。全部 38 个账户逐事件独立核算现金、费用、库存与支付。\n\n自然开仓 ${kinds.opened??0} 次，完成 ${kinds.closed??0} 次，延迟 FAK 实际尝试 ${depthChecks} 次。当前可交易持仓 ${result.sums.active} 个，待核验结算 ${result.sums.pending} 个；未知支付保留库存，未提前变成现金。\n\n原始官方证据 ${rawOfficial} 份，已接受严格标签 ${result.strictLabels} 个、财务标签 ${result.financialLabels} 个。交易与支付的证据知晓时间、重复报告及源消费均通过检查；全部 24 个历史登记源及 25 个观察登记源哈希不变。\n\n每组初始 $100 来自独立模拟登记；输入未复制主现金，观察器仅 GET，未使用钱包或主交易控制接口。此审计确认自然运行和会计一致性，不构成盈利证明。\n`,{flag:'wx'});
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const r=auditNaturalObserver({directory:process.argv[2],out:process.argv[3]});console.log(JSON.stringify({...r,accountDetails:undefined}));
}
