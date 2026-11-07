import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,resolve} from 'node:path';
import {managedCashflows,validManagedSettlement} from './managed-position-accounting.mjs';
import {feeFor,round as round8} from '../paper-broker.mjs';
import {validRayOpeningEvidence,rayOpeningVersion} from './ray-opening.mjs';

const schema='ray-alignment-observation-v1';
const protocol='ray-twap-event-onetap-v8';
const legacyTwapProtocol='ray-twap-calendar-onetap-v7';
const legacySingleEntryProtocol='ray-twap-calendar-onetap-v6';
const legacyEquityProtocol='ray-twap-calendar-onetap-v5';
const legacyCalendarProtocol='ray-twap-calendar-onetap-v4';
const legacyAmountProtocol='ray-twap-band-onetap-v3';
const legacyProtocol='ray-twap-band-equity-v2';
const knownProtocols=[protocol,legacyTwapProtocol,legacySingleEntryProtocol,legacyEquityProtocol,legacyCalendarProtocol,legacyAmountProtocol,legacyProtocol];
const singleEntryProtocols=[protocol,legacyTwapProtocol,legacySingleEntryProtocol];
const marketEntryPolicy='one-filled-entry-per-market-v1';
const riskPolicyVersion='equity-per-order-v1';
const validRiskPolicy=p=>record(p)&&p.version===riskPolicyVersion&&p.minimumPct===.025&&p.maximumPct===.10&&
 p.aggregateCostCap===null&&p.feeInclusive===true;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/i.test(x);
const sessionAt=now=>{const h=new Date(now+28800000).getUTCHours();return h>=6&&h<12?'morning':h>=12&&h<22?'midday':'night';};
const sessionThreshold={morning:40,midday:60,night:80};
const nyDateFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const nonnegative=x=>Number.isFinite(x)&&x>=0;
const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
const twoDecimals=x=>nonnegative(x)&&Math.abs(x*100-Math.round(x*100))<=1e-7;
const fiveDecimals=x=>nonnegative(x)&&Math.abs(x*1e5-Math.round(x*1e5))<=1e-6;
const list=value=>Array.isArray(value)?value:record(value)?Object.values(value):[];
// Keep the original v6 source contract; do not relabel historical spot as v7 TWAP.
const validLegacyV6Opening=(o,m,now)=>record(o)&&record(m)&&o.slug===m.slug&&o.conditionId===m.conditionId&&
 Number.isFinite(o.value)&&o.value>0&&Number.isFinite(o.knownAt)&&o.knownAt<=now&&
 (o.source==='gamma-price-to-beat'&&o.referenceAt===m.start||
  o.source==='rtds-chainlink-spot'&&Number.isFinite(o.referenceAt)&&Math.abs(o.referenceAt-m.start)<=2500&&o.referenceAt<=o.knownAt);

// This observer has no account, controller, network or output-file access. Its
// result certifies only the registered source bytes and the supplied snapshot.
// Historical cash conservation, source availability and profitability require
// separate evidence; none are inferred from a green current-state result.
export function createRayRuntimeCheck({registrationPath,clock=Date.now,sourceCacheMs=30000}={}) {
 let sourceCache=null;
 const cacheMs=Math.min(30000,Math.max(0,Number.isFinite(sourceCacheMs)?sourceCacheMs:30000));
 function inspect(state) {
  const checkedAt=clock(),checks=[],errors=[],coverage={orders:'retained-controller-order-snapshot',
   lots:'current-owned-positions-and-provided-recent-closed-positions',closedTradesLimit:100,
   historicalCashConservation:false,profitabilityVerified:false,registrationBaselineInferred:false,
   historicalEntryEquityIndependentlyReconstructed:false,marketFeeExternallyVerified:false,
   feeFormulaBasis:'recorded-market-metadata'};
  const out={version:schema,status:'waiting-registration',scope:'current-ray-runtime-only',allHistoryVerified:false,
   checkedAt,checks,errors,coverage,legacyAudit:null,registrationPath:registrationPath??null};
  const add=(name,ok,detail={})=>{checks.push({name,status:ok?'verified':'failed',...detail});if(!ok)errors.push({check:name,...detail});return ok;};
  let registration,registrationDigest;
  try{
   if(typeof registrationPath!=='string'||!registrationPath)throw Object.assign(Error('Ray observation registration is not configured'),{code:'ENOENT'});
   const bytes=readFileSync(registrationPath);registrationDigest=sha(bytes);registration=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  }catch(error){
   out.status=error.code==='ENOENT'?'waiting-registration':'degraded';
   checks.push({name:'registration',status:error.code==='ENOENT'?'waiting':'failed',message:error.message});
   if(error.code!=='ENOENT')errors.push({check:'registration',message:error.message});
   return out;
  }
  out.legacyAudit=record(registration?.legacyAudit)?structuredClone(registration.legacyAudit):null;
  out.registrationSha256=registrationDigest;
  const registrationOK=add('registration',record(registration)&&(registration.schema??registration.version)===schema&&
   registration.protocolVersion===protocol&&typeof registration.sessionId==='string'&&registration.sessionId.length>0&&
   registration.maxExposure===null&&validRiskPolicy(registration.riskPolicy)&&
   Array.isArray(registration.sourceFiles)&&registration.sourceFiles.length>0,
   {schema:registration?.schema??registration?.version??null,protocolVersion:registration?.protocolVersion??null});
  if(!registrationOK){out.status='degraded';return out;}
  const cached=sourceCache&&sourceCache.digest===registrationDigest&&checkedAt>=sourceCache.at&&checkedAt-sourceCache.at<cacheMs;
  if(!cached){
   const files=[],seen=new Set();
   for(const item of registration.sourceFiles){
    const path=typeof item?.path==='string'?(isAbsolute(item.path)?item.path:resolve(dirname(registrationPath),item.path)):null;
    let actual=null,message=null;
    if(!path||!/^([a-f0-9]{64})$/i.test(item?.sha256??''))message='Invalid source file registration';
    else if(seen.has(path.toLowerCase()))message='Duplicate registered source path';
    else{seen.add(path.toLowerCase());try{actual=sha(readFileSync(path));}catch(error){message=error.message;}}
    files.push({path,expected:item?.sha256??null,actual,ok:!message&&actual===item.sha256.toLowerCase(),message});
   }
   sourceCache={digest:registrationDigest,at:checkedAt,files};
  }
  out.sourceCheckedAt=sourceCache.at;out.sourceCacheUsed=Boolean(cached);
  add('registered-source-bytes',sourceCache.files.every(f=>f.ok),{files:structuredClone(sourceCache.files),cacheMaxAgeMs:cacheMs});
  if(!record(state)){add('snapshot',false,{message:'A full current controller snapshot is required'});out.status='degraded';return out;}
  add('paper-only',state.realTrading===false,{realTrading:state.realTrading??null});
  add('registered-session',state.sessionId===registration.sessionId,{expected:registration.sessionId,actual:state.sessionId??null});
  const aligned=state.strategy?.config?.model==='ray-twap-band'&&state.strategy?.config?.execution==='paper'&&
   state.strategy?.rayProtocol?.version===registration.protocolVersion&&state.config?.size===100;
  checks.push({name:'aligned-runtime',status:aligned?'verified':'waiting-migration',protocolVersion:state.strategy?.rayProtocol?.version??null,
   size:state.config?.size??null,expectedProtocolVersion:registration.protocolVersion});
  out.riskPolicy=structuredClone(registration.riskPolicy);
  add('equity-per-order-risk-policy',state.config?.riskPolicy===riskPolicyVersion&&state.config?.maxExposure===null,
   {policy:state.config?.riskPolicy??null,aggregateCostCap:state.config?.maxExposure??null,
    minimumPct:registration.riskPolicy.minimumPct,maximumPct:registration.riskPolicy.maximumPct,feeInclusive:true});
  add('finite-account-balances',nonnegative(state.account?.cash)&&nonnegative(state.account?.fees),
   {cash:state.account?.cash??null,fees:state.account?.fees??null});
  add('execution-not-halted',state.account?.halted===null,{halted:state.account?.halted??null});
  if(!aligned){out.status=errors.length?'degraded':'waiting-migration';return out;}
  const snapshotAt=state.now;
  add('snapshot-time',Number.isFinite(snapshotAt)&&snapshotAt<=checkedAt&&checkedAt-snapshotAt<=30000,{snapshotAt:snapshotAt??null});
  add('opening-runtime-contract',state.strategy?.rayProtocol?.openingVersion===rayOpeningVersion&&
   state.strategy?.rayProtocol?.openingBasis==='opening-60s-twap'&&state.strategy?.rayProtocol?.openingToleranceMs===0&&
   state.strategy?.rayProtocol?.openingFallback===false,{openingVersion:state.strategy?.rayProtocol?.openingVersion??null});
  const frameOpening=state.frame?.rayOpening,frameMarket=state.frame?.market,
   frameOpeningValid=validRayOpeningEvidence(frameOpening,frameMarket,snapshotAt),
   currentDecision=state.strategy?.decision,currentSelected=currentDecision?.version===protocol?currentDecision.selected:null;
  coverage.currentOpening={available:frameOpeningValid,source:frameOpening?.source??null,
   knownAt:frameOpening?.knownAt??null,windowSeconds:frameOpening?.windowSeconds??null,
   status:frameOpeningValid?'verified':frameOpening?.status==='conflict'?'blocked-conflict':'waiting-exact-opening',
   historicalLegacySourceRewritten:false};
  if(frameOpeningValid)add('current-opening-60s-evidence',true,{source:frameOpening.source,knownAt:frameOpening.knownAt});
  else checks.push({name:'current-opening-60s-evidence',status:'waiting',
   source:frameOpening?.source??null,message:'No usable current v7 opening; no spot, nearest sample or future backfill is certified'});
  if(currentSelected)add('current-selected-opening-evidence',frameOpeningValid&&
   validRayOpeningEvidence(currentSelected.opening,frameMarket,currentDecision.time)&&
   ['value','valueE18','source','referenceAt','knownAt','windowSeconds'].every(k=>currentSelected.opening[k]===frameOpening[k]),
   {decisionAt:currentDecision.time??null,scope:'supplied-v7-current-actionable-decision-only'});
  else checks.push({name:'current-selected-opening-evidence',status:'not-observed',
   message:'No supplied actionable v7 selection; missing or legacy frame opening remains blocked rather than converted'});
  const orders=new Map();
  add('order-snapshot-present',Array.isArray(state.orders),{count:Array.isArray(state.orders)?state.orders.length:null});
  for(const order of list(state.orders)){
   const ok=record(order)&&typeof order.id==='string'&&order.id.length>0&&!orders.has(order.id)&&typeof order.tokenId==='string'&&
    ['buy','sell'].includes(order.side)&&['open','filled','cancelled','rejected'].includes(order.status)&&
    [order.filled,order.notional,order.fees,order.size].every(nonnegative)&&
    order.filled<=order.size+1e-8&&order.notional<=order.filled+1e-8&&
    !(order.filled===0&&(order.notional!==0||order.fees!==0))&&!(order.filled>0&&order.notional<=0);
   if(!ok)add('valid-order-report',false,{orderId:order?.id??null});
   if(order?.id)orders.set(order.id,order);
  }
  checks.push({name:'retained-order-report-consistency',status:errors.some(e=>e.check==='valid-order-report')?'failed':'verified',count:orders.size});
  const evidence=record(state.rayAuditEvidence)?state.rayAuditEvidence:{};
  const active=state.strategy?.rayOwnedPositions,queue=state.strategy?.settlementQueue;
  add('active-ray-owners-present',Array.isArray(active),{count:Array.isArray(active)?active.length:null});
  const pendingFull=Array.isArray(evidence.pendingSettlements),pending=pendingFull?evidence.pendingSettlements:[];
  const summaries=Array.isArray(queue?.positions)?queue.positions:[];
  const pendingCount=Number.isInteger(queue?.count)&&queue.count>=0?queue.count:null;
  add('settlement-queue-present',pendingCount!==null&&summaries.length===pendingCount,{count:pendingCount});
  if(pendingFull)add('queued-owner-evidence',pending.length===pendingCount,{count:pending.length});
  else if(pendingCount>0)add('queued-owner-evidence',false,{message:'Queue summaries omit order reports and entry lots; full read-only pending evidence is required',count:pendingCount});
  else checks.push({name:'queued-owner-evidence',status:'not-observed',message:'No queued positions in this snapshot'});
  coverage.pendingEntryLots=pendingFull?'full-current-queue':pendingCount===0?'no-pending-positions':'summaries-only';
  const closedProvided=Array.isArray(evidence.closedTrades),closed=closedProvided?evidence.closedTrades.slice(-100):[];
  coverage.providedRecentClosedPositions=closed.length;coverage.closedPositions=closedProvided?'provided-recent-positions-at-most-100':'not-provided';
  const labels=record(evidence.financialLabels)?evidence.financialLabels:null;
  coverage.officialLabels=labels?'provided-verified-label-map':'not-provided';
  const legacy=state.strategy?.managedPosition;
  const current=[legacy,...list(active),...pending].filter(Boolean),ownerTokens=new Map(),ids=new Set();
  const holdings=record(state.account?.holdings)?state.account.holdings:null,costs=record(state.account?.inventoryCost)?state.account.inventoryCost:null;
  add('inventory-snapshot-present',Boolean(holdings&&costs));
  for(const owner of current){
   const unique=typeof owner?.id==='string'&&!ids.has(owner.id)&&typeof owner.tokenId==='string'&&!ownerTokens.has(owner.tokenId);
   if(!unique)add('unique-current-owner',false,{tradeId:owner?.id??null,tokenId:owner?.tokenId??null});
   ids.add(owner?.id);ownerTokens.set(owner?.tokenId,owner);
   const market=owner.market;
   add('owned-market-identity',record(market)&&/^btc-updown-5m-\d+$/.test(market.slug??'')&&owner.slug===market.slug&&
    Number(market.slug.split('-').at(-1))*1000===market.start&&market.end===market.start+300000&&
    typeof market.conditionId==='string'&&market.conditionId.length>0&&['Up','Down'].includes(owner.outcome)&&
    typeof market.tokens?.Up==='string'&&typeof market.tokens?.Down==='string'&&market.tokens.Up!==market.tokens.Down&&
    market.tokens[owner.outcome]===owner.tokenId,{tradeId:owner.id});
   const held=holdings?.[owner.tokenId]??0,flow=managedCashflows(owner);
   const inflight=state.account?.active?.intent?.tokenId===owner.tokenId&&held===0&&owner.openedAt===null;
   add('owned-inventory-retained',flow?close(flow.remaining,held):inflight,{tradeId:owner.id,tokenId:owner.tokenId,
    held,documentedRemaining:flow?.remaining??null,scope:'current-owned-remaining-inventory-only'});
   if(held>0&&flow)add('owned-inventory-cost',nonnegative(costs?.[owner.tokenId])&&close(costs[owner.tokenId],flow.costPerShare*held),{tradeId:owner.id});
   if(pending.includes(owner)){
    const summary=summaries.find(s=>s.id===owner.id);
    add('queued-inventory-locked',snapshotAt>=owner.market?.end&&held>0&&Boolean(summary)&&close(summary.size,held)&&
     close(summary.cost,costs?.[owner.tokenId]),{tradeId:owner.id,scope:'present-queued-shares-not-historical-cash-credits'});
   }
  }
  for(const [tokenId,size] of Object.entries(holdings??{})){
   if(!nonnegative(size)||size>0&&!ownerTokens.has(tokenId))add('inventory-has-unique-owner',false,{tokenId,size});
  }
  let exposure=0;
  for(const [tokenId,size] of Object.entries(holdings??{}).filter(([,size])=>size>0)){
   if(!nonnegative(costs?.[tokenId]))add('known-inventory-cost',false,{tokenId});else exposure+=costs[tokenId];
  }
  add('finite-owned-acquisition-cost',Number.isFinite(exposure)&&exposure>=0,
   {cost:exposure,aggregateCostCap:null,basis:'retained-acquisition-cost-reported-without-an-aggregate-dollar-limit'});
  coverage.aggregateAcquisitionCost=Number.isFinite(exposure)?exposure:null;
  coverage.aggregateCostCap=null;
  const roundFills=state.strategy?.rayRoundFills,roundOrders=new Map();
  add('round-fill-ledger-present',record(roundFills));
  for(const [slug,rows] of Object.entries(record(roundFills)?roundFills:{})){
   if(!/^btc-updown-5m-\d+$/.test(slug)||!record(rows)){add('round-fill-ledger-identity',false,{slug});continue;}
   let shares=0;
   for(const [orderId,row] of Object.entries(rows)){
    const order=orders.get(orderId),valid=record(row)&&nonnegative(row.filled)&&
     !roundOrders.has(orderId)&&order?.side==='buy'&&order.tokenId===row.tokenId&&close(order.filled,row.filled)&&
     (order.market?.slug===slug||state.markets?.[row.tokenId]?.slug===slug);
    if(!valid)add('round-fill-matches-order',false,{slug,orderId});
    if(nonnegative(row?.filled))shares+=row.filled;roundOrders.set(orderId,{...row,slug});
   }
   add('round-share-cap',Number.isFinite(shares)&&shares<=100+1e-8,{slug,filledShares:shares,maximum:100});
  }
  const claimedReports=new Map(),lotIds=new Set();let lotsChecked=0,budgetsChecked=0,settlementsChecked=0,
   calendarLotsChecked=0,calendarActiveNoiseLotsChecked=0,riskBudgetsChecked=0,manualRiskBudgetsChecked=0;
  const riskBudgetValid=(budget,at,maxSpend,owner)=>record(budget)&&budget.policy===riskPolicyVersion&&
   nonnegative(budget.equity)&&budget.equity>0&&Number.isFinite(budget.pct)&&budget.pct>=.025&&budget.pct<=.10&&
   budget.minPct===.025&&budget.maxPct===.10&&budget.feeInclusive===true&&
   twoDecimals(budget.maxSpend)&&budget.maxSpend>0&&close(budget.maxSpend,maxSpend)&&
   close(budget.maxSpend,Math.floor(budget.equity*budget.pct*100+1e-8)/100)&&
   nonnegative(budget.availableCash)&&budget.maxSpend<=budget.availableCash+1e-8&&
   Number.isFinite(budget.at)&&Number.isFinite(at)&&budget.at>=at&&budget.at<=snapshotAt&&
   Number.isFinite(owner.market?.end)&&budget.at<owner.market.end&&
   Number.isFinite(owner.parameters?.config?.staleMs??state.config?.staleMs??3000)&&
   budget.at-at<=(owner.parameters?.config?.staleMs??state.config?.staleMs??3000);
  // Old manual owners retain their original account history. Newly managed
  // manual entries identify this contract in their recorded config or budget.
  for(const owner of [...current,...closed].filter(t=>t.origin==='manual-one-tap'&&
   (t.parameters?.config?.riskPolicy===riskPolicyVersion||t.riskBudget?.policy===riskPolicyVersion))){
   manualRiskBudgetsChecked++;
   const budget=owner.riskBudget,buys=list(owner.orderReports).filter(r=>r?.side==='buy');
   add('manual-equity-risk-budget',riskBudgetValid(budget,owner.signalAt,owner.maxSpend,owner)&&
    buys.every(r=>close(r.maxSpend,budget?.maxSpend))&&
    buys.reduce((sum,r)=>sum+r.notional+r.fees,0)<=budget.maxSpend+1e-7,
    {tradeId:owner.id,scope:'recorded-manual-entry-budget-not-reconstructed-historical-equity'});
  }
  // Completed trade exports identify their token through the recorded market
  // and outcome; they do not repeat the owner's tokenId at the top level.
  const closedIds=new Set(closed.map(t=>t.id));
  const positions=[...current,...closed.map(t=>({...t,tokenId:t.tokenId??t.market?.tokens?.[t.outcome]}))]
   .filter(t=>knownProtocols.includes(t.entryDecision?.version??t.version));
  // v6 consumes a market on its first positive buy report, including a partial
  // fill. Stored locks can outlive their original session, so those rows are
  // checked for retention/shape without inventing an unavailable order report.
  // Earlier protocols intentionally allowed multiple buys in one market.
  const marketEntries=state.strategy?.rayMarketEntries;
  add('single-entry-runtime-policy',state.strategy?.rayProtocol?.entryPolicy===marketEntryPolicy&&
   state.strategy?.rayProtocol?.maximumEntriesPerRound===1,
   {entryPolicy:state.strategy?.rayProtocol?.entryPolicy??null,maximumEntriesPerRound:state.strategy?.rayProtocol?.maximumEntriesPerRound??null});
  add('market-entry-ledger-present',record(marketEntries));
  let retainedForeignLocks=0,currentLocksChecked=0;
  for(const [slug,entry] of Object.entries(record(marketEntries)?marketEntries:{})){
   const valid=record(entry)&&/^btc-updown-5m-\d+$/.test(slug)&&entry.version==='btc5m-market-entry-v1'&&
    entry.slug===slug&&typeof entry.sessionId==='string'&&entry.sessionId.length>0&&
    typeof entry.orderId==='string'&&entry.orderId.length>0&&typeof entry.tokenId==='string'&&entry.tokenId.length>0&&
    Number.isFinite(entry.filled)&&entry.filled>0&&
    Number.isFinite(entry.recordedAt)&&entry.recordedAt<=snapshotAt&&
    ['reconciled-order-report','restored-order-report'].includes(entry.source)&&
    (entry.protocolVersion===null||typeof entry.protocolVersion==='string'&&entry.protocolVersion.length>0);
   add('market-entry-lock-evidence',valid,{slug,orderId:entry?.orderId??null,
    recordedAtSemantics:'local-lock-recording-time-not-fill-time'});
   if(entry?.sessionId===state.sessionId){
    currentLocksChecked++;const order=orders.get(entry.orderId);
    add('market-entry-lock-matches-current-order',Boolean(order)&&order.side==='buy'&&order.filled>0&&
     order.tokenId===entry.tokenId&&entry.filled<=order.filled+1e-8&&
     (order.market?.slug===slug||state.markets?.[entry.tokenId]?.slug===slug),{slug,orderId:entry.orderId});
   }else retainedForeignLocks++;
  }
  let retainedPositiveOrders=0;
  for(const order of orders.values())if(order.side==='buy'&&order.filled>0){
   const slug=order.market?.slug??state.markets?.[order.tokenId]?.slug;
   if(!/^btc-updown-5m-\d+$/.test(slug??''))continue;
   retainedPositiveOrders++;
   add('retained-positive-buy-market-consumed',record(marketEntries?.[slug]),{slug,orderId:order.id,
    scope:'all-retained-positive-buys-consume-market-without-retroactive-legacy-single-order-count'});
  }
  const singleEntryOrders=new Map(),seenSingleEntryOwners=new Set(),singleEntryMarketsByProtocol=new Map(singleEntryProtocols.map(p=>[p,new Set()]));
  for(const owner of [...current,...closed]){
   // Manual entries retain their original forward decision label; the Ray
   // profile records which entry policy actually governed their submission.
   const ownerVersion=owner.parameters?.rayProtocolVersion??owner.entryDecision?.version??owner.version;
   if(!singleEntryProtocols.includes(ownerVersion)||seenSingleEntryOwners.has(owner.id))continue;seenSingleEntryOwners.add(owner.id);
   const slug=owner.slug??owner.market?.slug;
   for(const report of list(owner.orderReports).filter(r=>r?.side==='buy'&&r.filled>0)){
    const entries=singleEntryOrders.get(slug)??new Set();entries.add(report.id);singleEntryOrders.set(slug,entries);
    singleEntryMarketsByProtocol.get(ownerVersion).add(slug);
    const lock=marketEntries?.[slug];
    add('single-entry-filled-order-lock',record(lock)&&lock.orderId===report.id&&
     lock.tokenId===report.tokenId&&lock.sessionId===state.sessionId,{slug,tradeId:owner.id,orderId:report.id,
      scope:'provided-v6-v7-automatic-and-manual-positive-buy-reports'});
   }
  }
  for(const [slug,entries] of singleEntryOrders)add('single-entry-positive-orders-per-market',entries.size<=1,
   {slug,positiveBuyOrders:entries.size,maximum:1,protocolVersion:protocol});
  const marketSlug=state.frame?.market?.slug??null,summary=state.strategy?.rayEntrySummary,
   consumed=Boolean(marketSlug&&record(marketEntries?.[marketSlug]));
  add('single-entry-current-round-summary',record(summary)&&summary.round===marketSlug&&
   summary.entryPolicy===marketEntryPolicy&&summary.maxEntriesPerRound===1&&summary.roundEntryConsumed===consumed,
   {slug:marketSlug,consumed,reportedConsumed:summary?.roundEntryConsumed??null});
  const lock=marketEntries?.[marketSlug],decision=state.strategy?.decision,market=state.frame?.market;
  // A decision created before the synchronous fill remains a valid historical
  // observation. Only a later decision can demonstrate the consumed gate.
  const postLockDecision=consumed&&decision?.version===protocol&&Number.isFinite(decision.time)&&
   decision.time>lock.recordedAt&&decision.time>=market?.end-120000&&decision.time<market?.end;
  if(postLockDecision)add('single-entry-post-lock-decision',decision.selected===null&&decision.reasonCode==='round_already_entered',
   {slug:marketSlug,decisionAt:decision.time,lockRecordedAt:lock.recordedAt});
  else checks.push({name:'single-entry-post-lock-decision',status:'not-observed',
   message:'No supplied later current-protocol late-window decision for a consumed current market'});
  coverage.singleEntryPolicy={version:marketEntryPolicy,protocolVersion:protocol,currentSessionLocksChecked:currentLocksChecked,
   retainedOtherSessionLocks:retainedForeignLocks,retainedPositiveBuyReports:retainedPositiveOrders,
   providedSingleEntryMarkets:singleEntryOrders.size,providedV8Markets:singleEntryMarketsByProtocol.get(protocol).size,providedV7Markets:singleEntryMarketsByProtocol.get(legacyTwapProtocol).size,
   providedV6Markets:singleEntryMarketsByProtocol.get(legacySingleEntryProtocol).size,postLockDecisionObserved:Boolean(postLockDecision),
   olderMultiEntryProtocolsRetained:true,otherSessionOrderAuthenticityVerified:false,
   orderVersionOutsideProvidedOwners:'not-inferred',lockRecordedAtIsFillTime:false};
  const seenPositions=new Set();
  for(const position of positions){
   const ownerVersion=position.entryDecision?.version??position.version;
   const oneTap=[protocol,legacyTwapProtocol,legacySingleEntryProtocol,legacyEquityProtocol,legacyCalendarProtocol,legacyAmountProtocol].includes(ownerVersion),
    calendar=[protocol,legacyTwapProtocol,legacySingleEntryProtocol,legacyEquityProtocol,legacyCalendarProtocol].includes(ownerVersion),
    equityRisk=[protocol,legacyTwapProtocol,legacySingleEntryProtocol,legacyEquityProtocol].includes(ownerVersion);
   if(seenPositions.has(position.id)){add('position-evidence-unique',false,{tradeId:position.id});continue;}seenPositions.add(position.id);
   if(closedIds.has(position.id)){
    const flow=managedCashflows(position);
    add('provided-close-fully-accounted',Boolean(flow)&&close(flow.remaining,0)&&
     (position.settlement||close(flow.sold,flow.bought)),{tradeId:position.id,scope:'provided-recent-closes-only'});
    add('provided-close-summary-matches-cashflows',Boolean(flow)&&close(position.net,flow.net)&&
     close(position.fees,flow.fees)&&close(position.bought,flow.bought)&&close(position.sold,flow.sold),
     {tradeId:position.id,scope:'provided-recent-closes-only'});
   }
   const ownerReports=new Map(list(position.orderReports).map(r=>[r.id,r]));
   add('entry-lot-evidence-present',Array.isArray(position.entryLots),{tradeId:position.id});
   for(const lot of list(position.entryLots)){
    lotsChecked++;const sizing=lot?.sizing,lotReportMap=new Map();
    add('entry-lot-unique',typeof lot?.id==='string'&&!lotIds.has(lot.id),{tradeId:position.id,entryLotId:lot?.id??null});lotIds.add(lot?.id);
    if(singleEntryProtocols.includes(ownerVersion)){
     const opening=lot?.decision?.opening,modern=[protocol,legacyTwapProtocol].includes(ownerVersion);
     add('lot-opening-evidence',modern?validRayOpeningEvidence(opening,position.market,lot?.signalAt):
      validLegacyV6Opening(opening,position.market,lot?.signalAt),{tradeId:position.id,entryLotId:lot?.id??null,
       protocolVersion:ownerVersion,source:opening?.source??null,
       scope:modern?'recorded-exact-60s-opening-known-by-signal':'retained-v6-spot-or-gamma-opening-contract-not-repaired-or-relabeled'});
     if(position.entryLots?.[0]===lot)add('owner-first-lot-opening-evidence',
      JSON.stringify(position.entryDecision?.opening)===JSON.stringify(opening),{tradeId:position.id,protocolVersion:ownerVersion});
    }
    if(calendar){
     calendarLotsChecked++;
     const decision=lot?.decision,c=decision?.calendarThreshold,context=c?.context,signalAt=lot?.signalAt;
     const signalValid=Number.isFinite(signalAt)&&signalAt>=position.market?.end-120000&&
      signalAt>=position.market?.start&&signalAt<position.market?.end&&signalAt<=snapshotAt;
     const session=signalValid?sessionAt(signalAt):null,base=sessionThreshold[session];
     const np=signalValid?Object.fromEntries(nyDateFormatter.formatToParts(signalAt).map(p=>[p.type,p.value])):null;
     const dateNy=np?`${np.year}-${np.month}-${np.day}`:null,weekend=np?['Sat','Sun'].includes(np.weekday):null;
     const provenance=record(c)&&c.version==='ray-calendar-threshold-v1'&&record(context)&&
      context.version==='ray-calendar-context-v1'&&context.decisionAt===signalAt&&
      context.timeZone==='America/New_York'&&typeof context.known==='boolean'&&
      context.dateNy===dateNy&&context.weekend===weekend&&
      typeof c.primaryType==='string'&&c.primaryType===context.primaryType&&c.session===session&&
      close(c.baseThresholdUsd,base)&&close(c.thresholdUsd,decision?.thresholdUsd)&&
      c.returnValidated===false&&c.riskAllocationEffect==='none'&&typeof c.active==='boolean'&&
      typeof c.status==='string'&&c.status.length>0&&
      (c.calendarSourceSha256===null||digest(c.calendarSourceSha256))&&
      (c.policySourceSha256===null||digest(c.policySourceSha256))&&
      (!context.known||digest(c.calendarSourceSha256));
     const active=c?.active===true;
     if(active)calendarActiveNoiseLotsChecked++;
     const activeValid=provenance&&context.known&&c.calibration==='noise-scale-only'&&c.status==='calendar-noise-scale'&&
      typeof c.policyRevision==='string'&&c.policyRevision.length>0&&
      Number.isFinite(c.fitThrough)&&Number.isFinite(c.policyAvailableAt)&&Number.isFinite(c.validUntil)&&
      c.fitThrough<=c.policyAvailableAt&&c.policyAvailableAt<=signalAt&&signalAt<c.validUntil&&
      c.validUntil>c.policyAvailableAt&&c.validUntil-c.policyAvailableAt<=31*86400000&&
      c.thresholdUsd>=base*.5&&c.thresholdUsd<=base*1.5&&Number.isInteger(c.thresholdUsd/5)&&
      c.support?.trainingDates>=6&&Number.isInteger(c.support.trainingDates)&&
      c.support?.testDates>=3&&Number.isInteger(c.support.testDates)&&
      c.support?.baselineTrainingDates>=10&&Number.isInteger(c.support.baselineTrainingDates)&&
      c.support?.baselineTestDates>=5&&Number.isInteger(c.support.baselineTestDates)&&
      digest(c.calendarSourceSha256)&&digest(c.policySourceSha256);
     const fallbackValid=provenance&&c.active===false&&c.calibration==='none'&&c.status!=='calendar-noise-scale'&&
      close(c.thresholdUsd,base);
     const pinned=ownerVersion!==protocol?
      registration.legacyCalendarSources?.[ownerVersion]??registration.calendarSources:registration.calendarSources;
     const sourcePinned=record(pinned)&&
      (c?.calendarSourceSha256===null||c?.calendarSourceSha256===pinned.calendarSha256)&&
      (c?.policySourceSha256===null||c?.policySourceSha256===pinned.policySha256);
     add('lot-calendar-threshold-evidence',signalValid&&record(decision)&&decision.version===ownerVersion&&
      sourcePinned&&(active?activeValid:fallbackValid),{tradeId:position.id,entryLotId:lot?.id??null,
       active,scope:'recorded-calendar-noise-provenance-not-return-validation'});
     const first=position.entryLots?.[0];
     if(first===lot)add('owner-first-lot-calendar-evidence',
      close(position.entryDecision?.thresholdUsd,decision?.thresholdUsd)&&
      JSON.stringify(position.entryDecision?.calendarThreshold)===JSON.stringify(c),{tradeId:position.id});
    }
    let filled=0,cost=0;
    for(const report of list(lot?.orderReports)){
     const actual=orders.get(report?.id),own=ownerReports.get(report?.id);
     const match=typeof report?.id==='string'&&!lotReportMap.has(report.id)&&!claimedReports.has(report.id)&&report.side==='buy'&&
      report.tokenId===position.tokenId&&actual?.side==='buy'&&actual.tokenId===position.tokenId&&
      ['filled','notional','fees'].every(k=>close(report[k],actual[k])&&close(report[k],own?.[k]));
     if(!match)add('lot-report-matches-owner-order',false,{tradeId:position.id,entryLotId:lot?.id??null,orderId:report?.id??null});
     if(!oneTap)add('legacy-v2-integer-fill',Number.isInteger(report?.filled),
      {tradeId:position.id,entryLotId:lot?.id??null,orderId:report?.id??null});
     if(oneTap)add('lot-onetap-order-contract',Boolean(match)&&report.orderType==='FAK'&&report.postOnly===false&&
      report.executionVersion==='one-tap-max-spend-v1'&&report.feePrecision===5&&fiveDecimals(report.fees)&&
      twoDecimals(report.size)&&close(report.size,lot.requestedShares)&&
      twoDecimals(report.amountUsd)&&report.amountUsd>0&&close(report.amountUsd,lot.requestedAmountUsd)&&
      twoDecimals(report.maxSpend)&&close(report.maxSpend,lot.maxSpend)&&report.amountUsd<=report.maxSpend+1e-8&&
      report.notional<=report.amountUsd+1e-8&&report.notional+report.fees<=report.maxSpend+1e-7&&
      Number.isFinite(report.price)&&report.price>0&&report.price<=.85+1e-8&&
      ['size','amountUsd','maxSpend','price','feePrecision'].every(k=>close(report[k],actual?.[k])&&close(report[k],own?.[k]))&&
      record(report.marketFee)&&close(report.marketFee.rate,position.market?.fee?.rate)&&
      close(report.marketFee.exponent,position.market?.fee?.exponent)&&
      [actual,own].every(r=>r?.orderType==='FAK'&&r.postOnly===false&&r.executionVersion==='one-tap-max-spend-v1'&&
       close(r.marketFee?.rate,report.marketFee.rate)&&close(r.marketFee?.exponent,report.marketFee.exponent)),
      {tradeId:position.id,entryLotId:lot?.id??null,orderId:report?.id??null});
     if(oneTap){
      const fills=report?.fills,hasFills=Array.isArray(fills),rows=hasFills?fills:[];
      let expectedNotional=0;
      const rowsValid=hasFills&&record(report.marketFee)&&(report.filled===0||rows.length>0)&&rows.every(fill=>{
       if(!record(fill)||!Number.isFinite(fill.size)||fill.size<=0||!Number.isFinite(fill.price)||fill.price<=0||fill.price>=1||
        fill.price>report.price+1e-8||fill.feePrecision!==5||!nonnegative(fill.notional)||!fiveDecimals(fill.fee))return false;
       // Preserve the broker's cumulative eight-decimal cash convention. A
       // per-level standalone rounding can differ at exact half boundaries.
       const next=round8(expectedNotional+fill.size*fill.price),delta=round8(next-expectedNotional);
       expectedNotional=next;
       return fill.notional===delta&&fill.fee===feeFor(fill.size,fill.price,report.marketFee,5);
      });
      add('lot-onetap-fill-evidence',rowsValid&&
       round8(rows.reduce((sum,fill)=>sum+(fill?.size??NaN),0))===report.filled&&
       round8(rows.reduce((sum,fill)=>sum+(fill?.notional??NaN),0))===report.notional&&
       expectedNotional===report.notional&&
       round8(rows.reduce((sum,fill)=>sum+(fill?.fee??NaN),0))===report.fees&&
       JSON.stringify(fills)===JSON.stringify(actual?.fills)&&JSON.stringify(fills)===JSON.stringify(own?.fills),
       {tradeId:position.id,entryLotId:lot?.id??null,orderId:report?.id??null,
        basis:'recorded-per-price-paper-fills-and-five-decimal-fees'});
     }
     lotReportMap.set(report?.id,report);claimedReports.set(report?.id,lot?.id);
     const round=roundOrders.get(report?.id);
     if(!round||round.slug!==position.slug||round.tokenId!==position.tokenId||!close(round.filled,report?.filled))
      add('lot-report-matches-round-ledger',false,{tradeId:position.id,orderId:report?.id??null});
     filled+=report?.filled??NaN;cost+=(report?.notional??NaN)+(report?.fees??NaN);
    }
    add('lot-cumulative-totals',close(filled,lot?.filled)&&close(cost,lot?.cost),{entryLotId:lot?.id??null});
    const legacyMetadata=record(sizing)&&nonnegative(sizing.equity)&&close(sizing.pct,.025)&&close(sizing.budget,sizing.equity*.025)&&
     nonnegative(sizing.feePerShare)&&Number.isFinite(sizing.ask)&&sizing.ask>0&&sizing.ask<1&&
     close(sizing.costPerShare,sizing.ask+sizing.feePerShare)&&Number.isInteger(sizing.rawShares)&&
     sizing.rawShares===Math.floor(sizing.budget/sizing.costPerShare)&&Number.isInteger(sizing.finalShares)&&
     sizing.finalShares>=Math.max(5,position.market?.minSize??5)&&sizing.finalShares<=100&&
     close(sizing.finalShares,lot?.requestedShares)&&sizing.finalShares<=sizing.rawShares&&sizing.finalShares<=sizing.askDepth&&
     nonnegative(sizing.roundUsedShares)&&sizing.finalShares+sizing.roundUsedShares<=100+1e-8;
    const quote=sizing?.quote,allocation=sizing?.allocation;
    const amountMetadata=record(sizing)&&sizing.version==='ray-onetap-equity-v1'&&sizing.feePrecision===5&&
     nonnegative(sizing.equity)&&sizing.equity>0&&Number.isFinite(sizing.pct)&&sizing.pct>=.025&&sizing.pct<=.10&&
     close(sizing.budget,sizing.equity*sizing.pct)&&twoDecimals(sizing.maxSpend)&&sizing.maxSpend>0&&
     sizing.maxSpend<=sizing.budget+1e-8&&twoDecimals(sizing.amountUsd)&&sizing.amountUsd>0&&sizing.amountUsd<=sizing.maxSpend&&
     close(lot.maxSpend,sizing.maxSpend)&&close(lot.requestedAmountUsd,sizing.amountUsd)&&
     twoDecimals(sizing.finalShares)&&sizing.finalShares>=position.market?.minSize&&sizing.finalShares<=100&&
     close(sizing.finalShares,lot.requestedShares)&&nonnegative(sizing.roundUsedShares)&&
     close(sizing.remainingRoundShares,100-sizing.roundUsedShares)&&sizing.finalShares<=sizing.remainingRoundShares+1e-8&&
     record(quote)&&quote.allowed===true&&quote.executionVersion==='one-tap-max-spend-v1'&&quote.feePrecision===5&&
     close(quote.size,sizing.finalShares)&&close(quote.amountUsd,sizing.amountUsd)&&close(quote.maxSpend,sizing.maxSpend)&&
     Number.isFinite(quote.best)&&quote.best>0&&Number.isFinite(quote.limit)&&quote.limit>=quote.best&&quote.limit<=.85+1e-8&&
     Number.isFinite(position.market?.tick)&&position.market.tick>0&&close(quote.limit/position.market.tick,Math.round(quote.limit/position.market.tick))&&
     nonnegative(quote.filled)&&quote.filled<=quote.size+1e-8&&nonnegative(quote.notional)&&quote.notional<=quote.amountUsd+1e-8&&
     fiveDecimals(quote.fees)&&close(quote.total,quote.notional+quote.fees)&&quote.total<=quote.maxSpend+1e-7&&
     record(allocation)&&allocation.version==='ray-strength-validation-v1'&&close(allocation.pct,sizing.pct)&&
     close(allocation.minimumPct,.025)&&close(allocation.maximumPct,.10)&&typeof allocation.validated==='boolean'&&
     (allocation.validated||close(sizing.pct,.025));
    const metadata=oneTap?amountMetadata:legacyMetadata;
    add('lot-sizing-evidence',metadata,{entryLotId:lot?.id??null,protocolVersion:ownerVersion});
    if(equityRisk){
     riskBudgetsChecked++;
     const budget=lot.riskBudget;
     add('lot-equity-risk-budget',riskBudgetValid(budget,lot.signalAt,lot.maxSpend,position)&&
      close(budget?.equity,sizing?.equity)&&close(budget?.pct,sizing?.pct)&&cost<=budget.maxSpend+1e-7,
      {tradeId:position.id,entryLotId:lot?.id??null,
       scope:'recorded-entry-equity-and-cash-budget-not-independent-historical-reconstruction'});
    }
    const fee=position.market?.fee;
    add('lot-fee-formula',record(sizing)&&nonnegative(fee?.rate)&&nonnegative(fee?.exponent)&&
     (oneTap?sizing.feePrecision===5&&quote?.feePrecision===5&&fiveDecimals(quote?.fees):
      Number.isFinite(sizing.ask)&&close(sizing.feePerShare,feeFor(1,sizing.ask,fee))),
     {entryLotId:lot?.id??null,basis:'recorded-market-metadata-not-external-fee-verification'});
    if(filled>0){budgetsChecked++;add('filled-lot-budget',metadata&&nonnegative(cost)&&cost<=(oneTap?sizing.maxSpend:sizing.budget)+1e-7&&
      filled<=sizing.finalShares+1e-8,{entryLotId:lot?.id??null,filled,cost,budget:sizing?.budget??null});}
   }
   for(const report of ownerReports.values())if(report.side==='buy'&&!claimedReports.has(report.id))
    add('owned-buy-has-entry-lot',false,{tradeId:position.id,orderId:report.id});
   if(position.settlement){
    settlementsChecked++;const payout=position.settlement,label=labels?.[position.slug];
    add('observed-settlement-official-evidence',Boolean(label)&&validManagedSettlement(position,label,snapshotAt)&&
     payout.scope==='paper-financial-only'&&payout.winner===label.winner&&payout.verificationVersion===label.version&&
     close(payout.payout,payout.size*label.payouts[position.outcome])&&payout.observedAt===label.observedAt&&
     Number.isFinite(payout.creditedAt)&&payout.creditedAt>=label.observedAt&&payout.creditedAt<=snapshotAt,
     {tradeId:position.id,scope:'provided-current-or-recent-position-evidence-only'});
   }
  }
  coverage.positionsWithLotEvidence=positions.length;coverage.entryLotsChecked=lotsChecked;coverage.filledLotBudgetsChecked=budgetsChecked;
  coverage.calendarEntryLotsChecked=calendarLotsChecked;coverage.calendarActiveNoiseLotsChecked=calendarActiveNoiseLotsChecked;
  coverage.calendarThresholdVerification='provided-lot-recorded-provenance-only-not-profitability';
  coverage.equityPerOrderRiskBudgetsChecked=riskBudgetsChecked;
  coverage.manualEquityPerOrderRiskBudgetsChecked=manualRiskBudgetsChecked;
  const activeIntent=state.account?.active?.intent;
  if(activeIntent?.side==='buy'){
   const activeOwner=current.find(t=>t.tokenId===activeIntent.tokenId),
    activeLot=activeOwner?.entryLots?.find(l=>l.id===activeIntent.rayEntryLotId);
   const currentContract=[protocol,legacyTwapProtocol,legacySingleEntryProtocol,legacyEquityProtocol].includes(activeOwner?.entryDecision?.version??activeOwner?.version)||
    activeOwner?.parameters?.config?.riskPolicy===riskPolicyVersion||activeIntent.riskBudget?.policy===riskPolicyVersion;
   if(currentContract)add('active-entry-equity-risk-budget',
    riskBudgetValid(activeIntent.riskBudget,activeLot?.signalAt??activeOwner?.signalAt,activeIntent.maxSpend,activeOwner)&&
    JSON.stringify(activeIntent.riskBudget)===JSON.stringify(activeLot?.riskBudget??activeOwner?.riskBudget),
    {intentId:activeIntent.id??null,tradeId:activeOwner?.id??null});
  }
  coverage.settlementsChecked=settlementsChecked;coverage.roundFillRows=roundOrders.size;
  coverage.roundFillRowsWithLotEvidence=[...roundOrders.keys()].filter(id=>claimedReports.has(id)).length;
  coverage.roundFillRowsWithoutProvidedLotEvidence=roundOrders.size-coverage.roundFillRowsWithLotEvidence;
  checks.push({name:'provided-lot-and-settlement-coverage',status:'verified',entryLotsChecked:lotsChecked,
   filledLotBudgetsChecked:budgetsChecked,settlementsChecked,allHistoricalLotsVerified:false,
   message:'Checks cover supplied current owners and at most 100 provided recent closes; older closed lot budgets and past cash releases are not inferred'});
  out.status=errors.length?'degraded':'verified';
  return out;
 }
 return {check(state){
  try{return inspect(state);}
  catch(error){return {version:schema,status:'degraded',scope:'current-ray-runtime-only',allHistoryVerified:false,
    checkedAt:clock(),checks:[{name:'snapshot-shape',status:'failed',message:error.message}],
    errors:[{check:'snapshot-shape',message:error.message}],coverage:{completed:false,allHistoricalLotsVerified:false,
      historicalCashConservation:false,profitabilityVerified:false},legacyAudit:null,registrationPath:registrationPath??null};}
 },close(){sourceCache=null;}};
}
