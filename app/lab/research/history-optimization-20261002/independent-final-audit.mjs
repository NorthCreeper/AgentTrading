import { readFileSync, writeFileSync, existsSync, readdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path));
const moneyEqual = (a,b,label) => { if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a-b)>0.00001) throw Error(label+': '+a+' / '+b); };
const check = (condition,label) => {if(!condition) throw Error(label);};
const day = at => new Date(at+28800000).toISOString().slice(0,10);
function cashAudit(a, summary, catalog) {
 check(a.id===[summary.scope,summary.scenario,summary.id].join(':')&&a.initialCapital===100,'Independent account identity/funding');
 check(a.executionDelayMs===(summary.scenario==='base'?1000:2000),'Account scenario delay');
 const trades=[...a.closedTrades,...[a.position,...a.pendingSettlements].filter(Boolean)], ids=new Set(), reportIds=new Set();
 let cash=100, fees=0, realized=0,wins=0, remainingTotal=0,settlements=0,partials=0;
 const daily={},unknown=[];
 for(const t of trades){
  check(!ids.has(t.id),'Duplicate trade '+t.id);ids.add(t.id);
  check(t.openedAt>=t.market.start&&t.openedAt<t.market.end&&t.signalAt<=t.openedAt,'Entry clocks '+t.id);
  check(t.openedAt-t.signalAt>=a.executionDelayMs,'Entry delay '+t.id);
  check(t.lastAt<=catalog.cutoff,'Position future '+t.id);
  if(t.entryDecision?.forecastMadeAt!==undefined)check(t.entryDecision.forecastMadeAt<=t.signalAt,'Future entry forecast '+t.id);
  if(t.entryDecision?.knownAt!==undefined)check(t.entryDecision.knownAt<=t.signalAt,'Future entry knowledge '+t.id);
  let buy=0,sell=0,bought=0,sold=0,ownFees=0;
  for(const r of Object.values(t.orderReports)){
   check(!reportIds.has(r.id),'Duplicate owned report '+r.id);reportIds.add(r.id);
   check(r.orderType==='FAK'&&r.postOnly===false,'Non-FAK report '+r.id);
   check(r.createdAt>=t.market.start&&r.createdAt<t.market.end,'Order outside market '+r.id);
   check(r.tokenId===t.tokenId&&r.filled>=0&&r.notional>=0&&r.fees>=0,'Report ownership/sign '+r.id);
   check(r.filled<=r.size+1e-7,'Overfilled '+r.id);if(r.filled>0&&r.filled<r.size-1e-7)partials++;
   if(r.side==='buy'){check(r.amountUsd===1&&r.notional<=1+1e-7,'One dollar amount '+r.id);check(r.notional<=r.filled*r.price+1e-6,'Buy beyond protected price '+r.id);buy+=r.notional+r.fees;bought+=r.filled;}
   else {check(r.side==='sell','Unknown order side '+r.id);check(r.notional+1e-6>=r.filled*r.price,'Sale below protected price '+r.id);sell+=r.notional-r.fees;sold+=r.filled;}
   ownFees+=r.fees;
   check(r.executionFee.rate>=0&&r.executionTick>0,'Missing actual execution metadata '+r.id);
   check(Math.abs(r.price/r.executionTick-Math.round(r.price/r.executionTick))<1e-5,'Tick incompatible execution '+r.id);
  }
  let payout=0,settled=0;
  if(t.settlement){
   const s=t.settlement;settlements++;payout=s.payout;settled=s.size;
   check(s.creditedAt>=s.observedAt&&s.observedAt>=t.market.end&&s.creditedAt<=catalog.cutoff,'Settlement clock '+t.id);
   check(s.label.observedAt===s.observedAt&&s.label.slug===t.slug&&s.label.conditionId===t.market.conditionId,'Settlement ownership '+t.id);
   check(s.winner===s.label.winner&&s.label.tokens[t.outcome]===t.tokenId,'Settlement direction '+t.id);
   moneyEqual(s.payout,s.size*s.label.payouts[t.outcome],'Settlement amount '+t.id);
   const eligible=catalog.paymentLabels.find(e=>e.label.slug===t.slug);
   check(eligible&&s.creditedAt>=eligible.at,'Settlement before earliest recorded receipt '+t.id);
   check(isDeepStrictEqual(s.label,eligible.label),'Saved settlement is not frozen payment label '+t.id);
  }
  const remainder=bought-sold-settled;
  moneyEqual(remainder,t.remaining,'Inventory '+t.id);moneyEqual(buy,t.cost,'Acquisition cost '+t.id);moneyEqual(ownFees,t.fees,'Own fees '+t.id);
  cash+=sell+payout-buy;fees+=ownFees;remainingTotal+=Math.max(0,remainder);
  const entryDay=day(t.openedAt),d=daily[entryDay]??={opened:0,completed:0,net:0,fees:0,unresolved:0};d.opened++;d.fees+=ownFees;
  if(t.closedAt!==undefined&&t.closedAt!==null){
   check(t.closedAt>=t.openedAt&&t.closedAt<=catalog.cutoff,'Close clock '+t.id);
   moneyEqual(remainder,0,'Nonzero terminal inventory '+t.id);
   const net=sell+payout-buy;moneyEqual(net,t.net,'Own terminal net '+t.id);realized+=net;wins+=Number(net>0);d.completed++;d.net+=net;
  }else{d.unresolved++;check(remainder>0,'Empty owned position '+t.id);unknown.push({slug:t.slug,remaining:remainder,expiry:t.market.end,observedPayment:catalog.paymentLabels.find(e=>e.label.slug===t.slug)?.at??null});}
 }
 moneyEqual(cash,a.cash,'Account cash '+a.id);moneyEqual(fees,a.fees,'Account fees '+a.id);moneyEqual(realized,a.realized,'Account realized '+a.id);
 check(wins===a.wins&&a.completed===a.closedTrades.length,'Completion aggregates '+a.id);
 moneyEqual(summary.cash,cash,'Summary cash '+a.id);moneyEqual(summary.net,realized,'Summary net '+a.id);moneyEqual(summary.fees,fees,'Summary fees '+a.id);
 moneyEqual(summary.accountNetRange.lower,cash-100,'Unknown lower '+a.id);moneyEqual(summary.accountNetRange.upper,cash+remainingTotal-100,'Unknown upper '+a.id);
 check(summary.unresolved===unknown.length,'Unresolved count '+a.id);
 for(const [date,d]of Object.entries(daily)){check(summary.dates[date]?.completed===d.completed,'Daily completion '+a.id);moneyEqual(summary.netByEntryDay[date],d.net,'Daily net '+a.id);check(summary.dates[date].unresolved===d.unresolved,'Daily unresolved '+a.id);}
 return {id:a.id,trades:trades.length,completed:a.completed,cash,fees,realized,wins,remaining:remainingTotal,unresolved:unknown,settlements,partialReports:partials,uniqueOwnedReports:reportIds.size};
}
async function eventAudit(path,cutoff) {
 const rs=createReadStream(path),digest=createHash('sha256');rs.on('data',buffer=>digest.update(buffer));const lines=createInterface({input:rs,crlfDelay:Infinity});
 const usedSources=new Map(),ledgers=new Map();let events=0,attempts=0,settled=0,partial=0,lastAt=-Infinity;
 for await(const line of lines){if(!line)continue;const e=JSON.parse(line);events++;
  check(e.at<=cutoff&&e.at>=lastAt,'Event past cutoff or out of causal order');lastAt=e.at;
  const key=[e.scope,e.scenario,e.candidate].join(':');
  let ledger=null;if(e.scope){ledger=ledgers.get(key);if(!ledger){ledger={cash:100,fees:0,owned:new Map(),closed:0,maxLockedCost:0};ledgers.set(key,ledger);}}
  if(e.kind==='entry-attempt'||e.kind==='sale-attempt'){
   attempts++;check(e.sourceAt<=e.receivedAt&&e.receivedAt<=e.frameAt&&e.frameAt<=e.at,'Execution source clock');
   check(e.at-e.frameAt<=3000,'Execution frame stale');check(e.at-e.sourceAt<=3000,'Execution book stale');
   const delay=e.scenario==='base'?1000:2000;check(e.at-e.signalAt>=delay,'Execution delay missing');
   const k=key+':'+e.report.tokenId,previous=usedSources.get(k);check(previous===undefined||e.sourceAt>previous,'Source liquidity reused');usedSources.set(k,e.sourceAt);
   check(e.report.createdAt===e.at,'Execution clock/report differs');
   check(ledger,'Execution lacks account identity');ledger.fees+=e.report.fees;
   if(e.report.side==='buy')ledger.cash-=e.report.notional+e.report.fees;
   else {ledger.cash+=e.report.notional-e.report.fees;const t=ledger.owned.get(e.tradeId);check(t,'Sale lacks owned inventory');moneyEqual(t.remaining-e.report.filled,e.remaining,'Sale inventory transition');t.remaining=e.remaining;}
   check(ledger.cash>=-1e-5,'Execution spends nonexistent capital');
   if(e.report.filled>0&&e.report.filled<e.report.size-1e-7)partial++;
  }
  if(e.kind==='opened'){check(ledger&&!ledger.owned.has(e.id),'Opening ownership');check([...ledger.owned.values()].every(t=>t.queued),'Two active positions');ledger.owned.set(e.id,{remaining:e.remaining,costPerShare:e.costPerShare,queued:false});}
  if(e.kind==='queued'){const t=ledger?.owned.get(e.tradeId);check(t&&!t.queued,'Queue ownership');t.queued=true;}
  if(e.kind==='settled'){settled++;check(e.at>=e.observedAt,'Early settlement event');const t=ledger?.owned.get(e.tradeId);check(t,'Settlement lacks owned inventory');moneyEqual(t.remaining,e.size,'Settlement own size');ledger.cash+=e.payout;t.remaining=0;}
  if(e.kind==='closed'){const t=ledger?.owned.get(e.id);check(t,'Close lacks owned inventory');moneyEqual(t.remaining,0,'Close without complete sale/payment');ledger.owned.delete(e.id);ledger.closed++;}
  if(ledger){const locked=[...ledger.owned.values()].reduce((n,t)=>n+t.remaining*t.costPerShare,0);check(locked<=10+1e-5,'Account exposure exceeds registered budget');ledger.maxLockedCost=Math.max(ledger.maxLockedCost,locked);}
 }
 return {events,executionAttempts:attempts,settled,partialReports:partial,sha256:digest.digest('hex'),ledgers:Object.fromEntries([...ledgers].map(([id,l])=>[id,{cash:l.cash,fees:l.fees,closed:l.closed,owned:l.owned.size,remaining:[...l.owned.values()].reduce((n,t)=>n+t.remaining,0),maxLockedCost:l.maxLockedCost}]))};
}
function auditCausalForecastChain(forecasts,report){
 const events=forecasts.flatMap(f=>[{kind:'forecast',at:f.at,f},...(f.updated?[{kind:'update',at:f.knownAt,f}]:[])])
  .sort((a,b)=>a.at-b.at||(a.kind===b.kind?a.f.slug.localeCompare(b.f.slug):a.kind==='update'?-1:1));
 let params=[0,0],updates=0,through=null;
 for(const e of events){
  if(e.kind==='forecast')check(isDeepStrictEqual(e.f.params,params),'Online forecast params backfilled '+e.f.slug);
  else {check(isDeepStrictEqual(e.f.update.before,params)&&e.f.update.at===e.at,'Online update chain '+e.f.slug);params=e.f.update.after;updates++;through=e.at;}
 }
 check(updates===report.updates&&through===report.causalSeed.adaptiveThrough&&isDeepStrictEqual(params,report.causalSeed.params),'Final adaptive state differs');
 check(report.causalSeed.knownAt===report.cutoff,'Final seed evidence cutoff');
}
function auditPromotion(report,registration){
 const verified=[];const find=(scope,scenario,id)=>report.accounts.find(a=>a.scope===scope&&a.scenario===scenario&&a.id===id);
 const gates=registration.protocol.historicalPromotion;const candidateIds=registration.candidates.filter(c=>c.id!=='baseline').map(c=>c.id);
 for(const id of candidateIds){const reasons=[];
  for(const scope of ['validation-new-independent-100','test-new-independent-100']){
   const dates=(scope.startsWith('validation')?report.split.validation:report.split.test).filter(d=>!report.split.partialBoundaryDates.includes(d));
   const a=find(scope,'base',id),b=find(scope,'base','baseline'),s=find(scope,'stress',id),bs=find(scope,'stress','baseline');
   const sum=account=>dates.reduce((n,d)=>n+(account.netByEntryDay[d]??0),0);
   const net=sum(a),increment=net-sum(b),stressNet=sum(s),stressIncrement=stressNet-sum(bs),completed=dates.reduce((n,d)=>n+(a.dates[d]?.completed??0),0);
   if(dates.length<3)reasons.push(scope+':insufficient-dates');
   if(completed<(scope.startsWith('validation')?gates.minimumCompletedValidation:gates.minimumCompletedTest))reasons.push(scope+':insufficient-completed-trades');
   if(!(net>0))reasons.push(scope+':absolute-after-cost-net-not-positive');
   if(!(increment>0))reasons.push(scope+':no-increment');
   if(!(stressNet>0&&stressIncrement>0))reasons.push(scope+':delay-fee-stress-not-positive');
   const differences=dates.map(d=>(a.netByEntryDay[d]??0)-(b.netByEntryDay[d]??0)),draws=[];let seed=0x6317c7;
   const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
   if(dates.length>=3)for(let i=0;i<10000;i++){let sample=0;for(let j=0;j<dates.length;j++)sample+=differences[Math.floor(random()*dates.length)];draws.push(sample/dates.length);}
   draws.sort((a,b)=>a-b);const lower=draws[Math.min(draws.length-1,Math.floor(draws.length*gates.familywiseAlpha/candidateIds.length))]??null;
   if(!(lower>0))reasons.push(scope+':date-block-multiple-candidate-bound-not-positive');
   const unknown=[a,b,s,bs].reduce((n,arm)=>n+dates.reduce((m,d)=>m+(arm.dates[d]?.unresolved??0),0),0);
   if(unknown)reasons.push(scope+':unresolved-inventory-or-control');
   const positives=dates.map(d=>Math.max(0,a.netByEntryDay[d]??0)),total=positives.reduce((n,x)=>n+x,0),share=total?Math.max(...positives)/total:null;
   if(!(share!==null&&share<=gates.bestPositiveDateShareMaximum))reasons.push(scope+':profit-concentration');
   const recorded=report.promotion.checks.find(c=>c.id===id)?.parts[scope];
   check(recorded&&recorded.completed===completed,'Promotion completion differs '+id);
   for(const [k,v]of Object.entries({net,increment,stressNet,stressIncrement,dateBlockLower:lower,maxPositiveDateShare:share}))if(v!==null)moneyEqual(recorded[k],v,'Promotion '+k+' '+id);else check(recorded[k]===null,'Promotion null field '+id);
  }
  const record=report.promotion.checks.find(c=>c.id===id);check(isDeepStrictEqual(record.reasons,reasons)&&record.pass===(reasons.length===0),'Promotion reasons/pass differs '+id);if(!reasons.length)verified.push(id);
 }
 check(isDeepStrictEqual(verified,report.promotion.eligible)&&report.promotion.realTrading===false&&report.promotion.baselineEligible===false,'Promoted set/live flag differs');
 return {checked:candidateIds.length,eligible:verified};
}
export async function independentFinalAudit(directory,{partial=false}={}) {
 const auditSourceSha256=hash(readFileSync(fileURLToPath(import.meta.url))),registration=read(join(directory,'registration.json')),catalog=read(registration.catalogPath);
 check(registration.catalogSha256===hash(readFileSync(registration.catalogPath)),'Catalog digest');
 check(registration.cutoff===catalog.cutoff,'Frozen cutoff');
 const summaries=[],accounts=[],parts=[];let first=null;
 const finalReport=!partial&&existsSync(join(directory,'report.json'))?read(join(directory,'report.json')):null;
 const partitionPaths=finalReport?.partitionRuns??[0,1,2].map(i=>join(directory,'part-'+i));
 check(partitionPaths.length===3,'Unexpected number of policy partitions');
 for(let i=0;i<3;i++){
  const part=partitionPaths[i];if(!existsSync(join(part,'report.json'))){if(partial)continue;throw Error('Missing partition '+i);}
  const report=read(join(part,'report.json')),pre=read(join(part,'pre-registration.json')),completion=read(join(part,'completion.json'));
  check(completion.reportSha256===hash(readFileSync(join(part,'report.json'))),'Child report digest '+i);
  check(completion.rounds===5070&&report.frames===1478434&&completion.frames===report.frames,'Full history counts '+i);
  check(report.cutoff===catalog.cutoff&&isDeepStrictEqual(report.split,registration.split),'Child cutoff/split '+i);
  check(isDeepStrictEqual(pre.candidateIds,registration.partitions[i])&&isDeepStrictEqual(pre.protocol,registration.protocol),'Child candidate list/protocol '+i);
  for(const [p,h]of Object.entries(pre.sources)){check(registration.sources[p]===h,'Child registration source '+p);check(hash(readFileSync(join(part,'source',p)))===h,'Archived child source '+p);}
  check(isDeepStrictEqual(pre.sources,completion.sources),'Child completion sources '+i);
  if(first)for(const k of ['cutoff','frames','split','forecasts','updates','fixedTraining','causalSeed','pair','maker'])check(isDeepStrictEqual(first[k],report[k]),'Child causal field differs '+k);else first=report;
  const training=read(join(part,'training.json')),forecasts=read(join(part,'forecasts.json'));
  check(training.length===report.fixedTraining,'Training size '+i);check(forecasts.length===report.forecasts,'Forecast size '+i);
  for(const row of training){check(row.knownAt<report.split.validationAt-60000,'Training label leaked '+row.slug);check(report.split.train.includes(day(Number(row.slug.split('-').at(-1))*1000)),'Nontraining round in fit');}
  for(const f of forecasts){check(f.at>=Number(f.slug.split('-').at(-1))*1000+120000&&f.at<=Number(f.slug.split('-').at(-1))*1000+125000,'120 second feature clock '+f.slug);if(f.updated){check(f.knownAt>=f.at&&f.knownAt<=catalog.cutoff,'Forecast knowledge '+f.slug);const l=catalog.labels.find(l=>l.scope==='strict'&&l.label.slug===f.slug);check(l&&l.at===f.knownAt&&f.y===l.label.payouts.Up,'Forecast used nonstrict/late/different label '+f.slug);moneyEqual(f.opening,l.label.opening,'Forecast opening differs from verified strict label');}}
  auditCausalForecastChain(forecasts,report);
  for(const summary of report.accounts){const filename=[summary.scope,summary.scenario,summary.id].join('__')+'.json';const a=read(join(part,filename));accounts.push(cashAudit(a,summary,catalog));summaries.push(summary);}
  const eventStream=await eventAudit(join(part,'events.jsonl'),catalog.cutoff);check(eventStream.sha256===completion.eventSha256,'Child event digest '+i);
  for(const s of report.accounts){const l=eventStream.ledgers[[s.scope,s.scenario,s.id].join(':')]??{cash:100,fees:0,closed:0,owned:0,remaining:0};
   moneyEqual(l.cash,s.cash,'Stream cash differs');moneyEqual(l.fees,s.fees,'Stream fees differs');check(l.closed===s.completed&&l.owned===s.unresolved,'Stream terminal/inventory ownership differs');moneyEqual(l.cash+l.remaining-100,s.accountNetRange.upper,'Stream unknown asset bound');}
  parts.push({partition:i,directory:part,frames:report.frames,rounds:completion.rounds,accounts:report.accounts.length,training:training.length,forecasts:forecasts.length,...eventStream});
 }
 const keys=summaries.map(a=>[a.scope,a.scenario,a.id].join(':'));check(new Set(keys).size===keys.length,'Duplicate partition accounts');
 let finalStatus='partial-audit',promotion=null;
 if(!partial){
  check(accounts.length===114,'Missing independent accounts');
  const report=read(join(directory,'report.json')),certificate=read(join(directory,'certificate.json'));
  check(certificate.reportSha256===hash(readFileSync(join(directory,'report.json'))),'Final report digest');check(certificate.registrationSha256===hash(readFileSync(join(directory,'registration.json'))),'Final registration digest');
  check(isDeepStrictEqual(certificate.sources,registration.sources)&&isDeepStrictEqual(report.sources,registration.sources),'Final source registration');
  if(certificate.mechanicalRecovery){
   const recoveryPath=join(directory,certificate.mechanicalRecovery.recordPath),recovery=read(recoveryPath);
   check(hash(readFileSync(recoveryPath))===certificate.mechanicalRecovery.recordSha256,'Recovery record digest');
   check(hash(readFileSync(join(resolve(directory,'..'),'recover-full-history.mjs')))===certificate.mechanicalRecovery.orchestrationSha256,'Recovery wrapper digest');
   check(recovery.originalRegistrationSha256===certificate.registrationSha256&&isDeepStrictEqual(recovery.sources,registration.sources),'Recovery original registration');
   check(recovery.incompletePartition===0&&recovery.replacementPath===report.partitionRuns[0],'Recovery path differs');
   check(recovery.unchangedCandidates&&recovery.unchangedThresholds&&recovery.unchangedFrozenInput&&!recovery.partialEconomicResultsUsed,'Recovery economic protocol altered');
  }
  for(const [p,h]of Object.entries(registration.sources))check(hash(readFileSync(join(resolve(directory,'../../..'),p)))===h,'Current source mutated '+p);
  check(isDeepStrictEqual(report.accounts,summaries),'Merged account summaries differ');
  for(const k of ['cutoff','frames','split','forecasts','updates','fixedTraining','causalSeed','pair','maker'])check(isDeepStrictEqual(first[k],report[k]),'Merged causal field differs '+k);
  check(isDeepStrictEqual(certificate.eligible,report.promotion.eligible),'Final eligible certificate differs');promotion=auditPromotion(report,registration);finalStatus='all-checks-passed';
 }
 check(auditSourceSha256===hash(readFileSync(fileURLToPath(import.meta.url))),'Independent audit implementation changed');
 const output={version:'independent-node-only-final-history-audit-v1',status:finalStatus,checkedAt:Date.now(),auditSourceSha256,cutoff:catalog.cutoff,catalogSha256:registration.catalogSha256,parts,accountsChecked:accounts.length,accounts,promotion,
  interpretation:['The audit directly sums owned order reports and original official payment receipts without importing the replay accounting functions.','Known-frame drawdown is incomplete when expired inventory cannot be marked; unknown inventory receives payout bounds, not zero profit.','All full-history accounts continuously retain capital and queue occupancy; separate validation and test accounts are predeclared independent starting capital.','P2 context coverage is descriptive and was not consumed by this replay suite.','Retrospective multiple-candidate date tests do not establish future profitability.']};
 writeFileSync(join(directory,partial?'independent-final-audit-partial.json':'independent-final-audit.json'),JSON.stringify(output,null,2)+'\n');
 if(!partial){
  const totalAttempts=parts.reduce((n,p)=>n+p.executionAttempts,0),totalEvents=parts.reduce((n,p)=>n+p.events,0);
  const md=['# 全历史回放独立复核','',`复核完成：${new Date(output.checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false})}，香港时间。`,
   '',`同一冻结输入的5070个盘口、1,478,434个按时间接受的报价帧；${accounts.length}个独立账户，${totalEvents.toLocaleString('en-US')}条事件、${totalAttempts.toLocaleString('en-US')}次执行尝试全部复核通过。`,'',
   '三片按策略分组，每片都回放全部历史。中断片仅按原登记规则从头机械重跑，原中断数据与其他两片保留；没有按交易表现换参数或重新注入同一账户资金。','',
   '- 原目录登记、catalog、最终报告、完成证书与恢复记录SHA一致，归档源码与当前原24项源码一致。',
   '- 所有执行均满足源时间≤收到时间≤帧时间≤执行时间、至少1/2秒延迟、新源不重复、当帧步长、保护限价与每笔买入$1。',
   '- 逐笔报告直接复算现金、费用、剩余份额和已完成净收益；另从事件流独立重建全过程现金、单活动仓位、到期队列与$10占用预算。',
   '- 到期未知资产保留份额及最小/最大兑付范围，付款最早来自冻结的官方receipt，没有把盘口结束当现金到账。',
   '- 120秒预测与严格标签的在线参数链一致；固定训练标签全部早于验证边界60秒，没有未来标签或最终参数回填。',
   '- 验证/测试所有18个候选的绝对扣费收益、相对收益、延迟/费用压力、日期数量、完成数量、未知库存、收益集中度及多重候选日块下界独立重算。','',
   `历史晋升复核通过的候选：${promotion.eligible.length?promotion.eligible.join('、'):'无'}。`,'',
   '复核的是因果回放与会计自洽性。公开显示深度仍是反事实模拟成交；未知队列、挂单返佣和两腿完成/合并到账未得到历史验证。回溯验证/测试日期此前已看过，也存在数据中断，不能视为未见样本或未来盈利证明。','',
   '逐项数据见 independent-final-audit.json；原报告/登记/证书保持不变。'];
  writeFileSync(join(directory,'完整回放独立复核.md'),md.join('\n')+'\n');
 }
 return {status:output.status,parts:parts.length,accounts:accounts.length,eventAttempts:parts.reduce((n,p)=>n+p.executionAttempts,0)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await independentFinalAudit(resolve(process.argv[2]),{partial:process.argv.includes('--partial')})));
