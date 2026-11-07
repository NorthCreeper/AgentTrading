import {createReadStream} from 'node:fs';
import {readdir, stat, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {managedCashflows} from './managed-position-accounting.mjs';
import {marketWindowFor,formatMarketWindow} from './market-time.mjs';

export const tradeLedgerVersion='btc5m-readonly-trade-ledger-v1';
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SOURCE=new RegExp(`^(${UUID})(-trades)?\\.jsonl$`,'i');
const EPS=1e-7, finite=x=>typeof x==='number'&&Number.isFinite(x), num=x=>finite(x)?x:null;
const rounded=x=>Math.round((x+Number.EPSILON)*1e8)/1e8;
const values=x=>Array.isArray(x)?x:Object.values(x??{});
const compactMarket=m=>m?Object.fromEntries(['slug','conditionId','tokens','start','end','tick','minSize','fee'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]])):null;
const reportKey=r=>r?.id?`${r.id}|${r.tokenId??'?'}|${r.createdAt??'unrecorded'}`:null;
const ownerReportKey=(r,sessionId)=>`${sessionId??'unknown-session'}|${reportKey(r)}`;
const groupKey=(r,meta)=>`${meta.tradeId?`trade:${meta.tradeId}`:`session:${meta.sessionId??'unknown'}`}|${reportKey(r)}`;
const protocol=t=>t?.version??t?.entryDecision?.version??t?.parameters?.rayProtocolVersion??null;
function windowOf(row){const w=marketWindowFor(row);return {...w,displayHkt:formatMarketWindow(w)};}
function originOf(value){return ['automatic','manual-one-tap','manual-other'].includes(value)?value:'unknown';}
function err(message,statusCode=400){return Object.assign(new Error(message),{statusCode});}
function preserveEvent(row,sessionId,source){
  const base={sessionId,source,time:num(row.time),type:row.type,id:row.id,audit:row.audit??null};
  if(row.type==='report')return {...base,report:row.report,deltaFilled:row.deltaFilled,
    intent:row.state?.active?.intent??null,market:compactMarket(row.state?.active?.market)};
  if(row.type==='strategy_closed')return {...base,trade:{...row,market:compactMarket(row.market)}};
  if(row.type==='paper_funding')return {...base,funding:row.funding};
  if(row.type==='experiment_start')return {...base,experiment:row.experiment};
  if(row.type==='paper_settlement')return {...base,tradeId:row.tradeId,slug:row.slug,settlement:Object.fromEntries(
    ['id','size','payout','winner','observedAt','creditedAt','verificationVersion','verificationSource','scope'].map(k=>[k,row[k]]))};
  return null;
}
function normalizeQuery(input={}){
  const get=k=>input instanceof URLSearchParams?input.get(k):input[k];
  const q={scope:get('scope')||'current-strategy',view:get('view')||'positions',status:get('status')||'all',
    outcome:get('outcome')||'all',origin:get('origin')||'all',q:String(get('q')??'').slice(0,200).toLowerCase(),
    sessionId:get('sessionId')||'',experimentId:get('experimentId')||'',offset:Number(get('offset')??0),limit:Number(get('limit')??25)};
  if(!['current-strategy','current-session','all'].includes(q.scope)||!['positions','fills','cashFlows'].includes(q.view)||
    !['all','closed','open','pending','unknown'].includes(q.status)||!['all','Up','Down'].includes(q.outcome)||
    !['all','automatic','manual-one-tap','manual-other','unknown'].includes(q.origin)||
    !Number.isInteger(q.offset)||q.offset<0||!Number.isInteger(q.limit)||q.limit<1||q.limit>250)
    throw err('账本筛选参数无效');
  return q;
}
function aggregatePositions(rows,fillCount){
  const sum=(key,selected=rows)=>rounded(selected.reduce((s,r)=>s+(finite(r[key])?r[key]:0),0));
  const completeSum=(key,selected=rows)=>selected.every(r=>finite(r[key]))?sum(key,selected):null;
  const closed=rows.filter(r=>r.status==='closed'),known=closed.filter(r=>finite(r.net));
  return {closed:closed.length,open:rows.filter(r=>r.status==='open').length,pending:rows.filter(r=>r.status==='pending').length,
    wins:known.filter(r=>r.net>EPS).length,losses:known.filter(r=>r.net< -EPS).length,breakeven:known.filter(r=>Math.abs(r.net)<=EPS).length,
    net:completeSum('net',closed),knownNetSubtotal:sum('net',known),recordedNet:completeSum('recordedNet',closed),cashflowVerifiedNet:completeSum('cashflowVerifiedNet',closed),
    fees:completeSum('fees'),knownFeesSubtotal:sum('fees'),unknownFees:rows.filter(r=>!finite(r.fees)).length,
    buyNotional:completeSum('buyNotional'),knownBuyNotionalSubtotal:sum('buyNotional'),
    sellNotional:completeSum('sellNotional'),knownSellNotionalSubtotal:sum('sellNotional'),
    payout:completeSum('payout'),knownPayoutSubtotal:sum('payout'),fillCount,
    unknown:rows.filter(r=>r.status==='unknown'||r.integrityWarnings.length>0||r.status==='closed'&&!finite(r.net)).length,
    unknownNet:closed.filter(r=>!finite(r.net)).length,netKnownClosed:known.length,netUnknownClosed:closed.length-known.length,
    verifiedClosed:closed.filter(r=>finite(r.cashflowVerifiedNet)).length,
    recordedOnlyClosed:closed.filter(r=>!finite(r.cashflowVerifiedNet)&&finite(r.recordedNet)).length,
    netBasis:'Closed positions only. Open, pending and unverified amounts are not zero PnL; funding excluded.'};
}

// The only accepted source names are actual UUID session journals and closed-
// trade journals. Research, replay, shadow and audit outputs cannot enter this
// ledger. Reads are asynchronous, bounded at the captured file size and cached.
export function createTradeLedger({directory,getSnapshot=null,clock=Date.now,cacheMs=5000,worker=true}={}){
  if(!directory)throw new TypeError('directory required');
  if(worker&&isMainThread)return createWorkerLedger({directory,getSnapshot,clock,cacheMs});
  const files=new Map();let refreshing=null,lastRefresh=0,built=null,state=null,closed=false;
  async function readSource(name,info){
    const match=SOURCE.exec(name),isTrades=Boolean(match[2]),sessionId=match[1];
    let item=files.get(name);
    if(!item||info.size<item.offset||info.mtimeMs!==item.mtime&&info.size===item.offset){
      item={name,sessionId,isTrades,offset:0,tail:'',rows:[],badLines:0,line:0,mtime:0,decoder:new StringDecoder('utf8')};files.set(name,item);
    }
    if(info.size===item.offset){item.mtime=info.mtimeMs;return;}
    const decoder=item.decoder;let text=item.tail,processed=0;
    const consume=async line=>{
      item.line++;if(!line.trim())return;
      try{const row=JSON.parse(line),source={file:name,line:item.line};
        if(isTrades){if(row?.id)item.rows.push({sessionId,source,trade:{...row,market:compactMarket(row.market)}});else item.badLines++;}
        else {const selected=preserveEvent(row,sessionId,source);if(selected)item.rows.push(selected);}
      }catch{item.badLines++;}
      if(++processed%150===0)await yieldTurn();
    };
    for await(const chunk of createReadStream(join(directory,name),{start:item.offset,end:info.size-1,highWaterMark:64*1024})){
      text+=decoder.write(chunk);let index;
      while((index=text.indexOf('\n'))>=0){const line=text.slice(0,index);text=text.slice(index+1);await consume(line);}
      if(text.length>8*1024*1024){item.badLines++;text='';}
    }
    item.tail=text;item.offset=info.size;item.mtime=info.mtimeMs;
  }
  async function refresh(){
    if(closed)throw err('账本读取器已关闭',503);
    if(built&&clock()-lastRefresh<cacheMs)return;
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      const names=(await readdir(directory)).filter(n=>SOURCE.test(n)).sort();let changed=!built;
      for(const name of names){const info=await stat(join(directory,name)),prior=files.get(name);
        if(!prior||prior.offset!==info.size||prior.mtime!==info.mtimeMs){await readSource(name,info);changed=true;}}
      for(const name of files.keys())if(!names.includes(name)){files.delete(name);changed=true;}
      // One small state snapshot complements journals for still-owned positions.
      // It never writes back or invokes controller accounting/trading methods.
      if(getSnapshot)state=structuredClone(await getSnapshot());
      else {try{state=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));}catch{state=null;}}
      built=await buildLedger(files,state,clock());lastRefresh=clock();
    })().finally(()=>{refreshing=null;});
    return refreshing;
  }
  function filters(rows,q){
    const currentSession=state?.sessionId??null,currentProtocol=protocol(state?.experiment)??state?.experiment?.profile?.rayProtocolVersion??
      state?.strategy?.experiment?.profile?.rayProtocolVersion??state?.strategy?.rayProtocol?.version??null;
    return rows.filter(r=>{
      if(q.scope==='current-session'&&r.sessionId!==currentSession&&!r.sessionIds?.includes(currentSession))return false;
      if(q.scope==='current-strategy'&&(!currentProtocol||r.protocolVersion!==currentProtocol))return false;
      if(q.sessionId&&r.sessionId!==q.sessionId&&!r.sessionIds?.includes(q.sessionId))return false;
      if(q.experimentId&&r.experimentId!==q.experimentId)return false;
      if(q.status!=='all'&&r.status!==q.status||q.outcome!=='all'&&r.outcome!==q.outcome||q.origin!=='all'&&r.origin!==q.origin)return false;
      if(q.q&&!([r.id,r.tradeId,r.orderId,r.slug,r.tokenId,r.sessionId,r.experimentId,r.protocolVersion,r.origin,r.closeMethod].join(' ').toLowerCase().includes(q.q)))return false;
      return true;
    });
  }
  async function query(input={},exportAll=false){
    const q=normalizeQuery(input);await refresh();
    const rows=filters(built[q.view],q).sort((a,b)=>(b.time??b.closedAt??b.openedAt??0)-(a.time??a.closedAt??a.openedAt??0)||a.id.localeCompare(b.id));
    const selectedIds=new Set(rows.map(r=>q.view==='positions'?r.id:r.tradeId));
    const positions=q.view==='positions'?rows:q.view==='fills'?built.positions.filter(r=>selectedIds.has(r.id)):[];
    const associatedFills=q.view==='positions'?built.fills.filter(r=>selectedIds.has(r.tradeId)):q.view==='fills'?rows:[];
    const summary=aggregatePositions(positions,associatedFills.length);
    if(q.view==='fills'){
      const sum=(key,selected=rows)=>rounded(selected.reduce((s,r)=>s+(finite(r[key])?r[key]:0),0));
      const completeSum=(key,selected=rows)=>selected.every(r=>finite(r[key]))?sum(key,selected):null;
      summary.positionFees=summary.fees;summary.fees=completeSum('fees');summary.knownFeesSubtotal=sum('fees');
      summary.buyNotional=completeSum('notional',rows.filter(r=>r.side==='buy'));
      summary.sellNotional=completeSum('notional',rows.filter(r=>r.side==='sell'));
      summary.knownBuyNotionalSubtotal=sum('notional',rows.filter(r=>r.side==='buy'));
      summary.knownSellNotionalSubtotal=sum('notional',rows.filter(r=>r.side==='sell'));
      summary.cashChange=completeSum('cashChange');summary.knownCashChangeSubtotal=sum('cashChange');
      summary.unknownFillFees=rows.filter(r=>!finite(r.fees)).length;summary.unknownFees=summary.unknownFillFees;
      summary.netBasis='Net and win/loss are associated complete positions; fees and notionals are only filtered positive fill deltas. Funding excluded.';
    }
    if(q.view==='cashFlows')summary.funding=rounded(rows.reduce((s,r)=>s+(r.amount??0),0));
    return {version:tradeLedgerVersion,generatedAt:clock(),scope:q.scope,view:q.view,rows:exportAll?rows:rows.slice(q.offset,q.offset+q.limit),
      total:rows.length,offset:exportAll?0:q.offset,limit:exportAll?rows.length:q.limit,summary,options:built.options,integrity:built.integrity,
      current:{sessionId:state?.sessionId??null,experimentId:state?.experiment?.id??state?.strategy?.experiment?.id??null,
        protocolVersion:state?.experiment?.profile?.rayProtocolVersion??state?.strategy?.experiment?.profile?.rayProtocolVersion??null},
      semantics:{executionMode:'paper',realTrading:false,fillTime:'Local reconciliation observation; missing report times remain unknown. Creation time is not matching time.',
        accountScope:'Recorded runtime sessions only; no research or backtest records. Sessions may have separate funding/reset histories.',
        cacheMs,incremental:true,readOnly:true}};
  }
  return {query,export:async(input={},format='json')=>{
    if(!['json','csv'].includes(format))throw err('导出格式无效');
    const data=await query(input,true);return {data,body:format==='csv'?ledgerCsv(data):JSON.stringify(data,null,2),
      contentType:format==='csv'?'text/csv; charset=utf-8':'application/json; charset=utf-8',fileName:`btc5m-ledger-${data.scope}-${data.view}.${format}`};
  },close(){closed=true;files.clear();built=null;}};
}

// Parsing/reconstructing years of ledger history must never share the trading
// controller's timing loop. Only a small owned-state clone and paged output cross
// this boundary; the worker owns all journals, caches, JSON parsing and exports.
function createWorkerLedger({directory,getSnapshot,clock,cacheMs}){
  let worker=null,sequence=0,closed=false;const pending=new Map();
  function ensureWorker(){
    if(worker)return worker;
    worker=new Worker(new URL(import.meta.url),{workerData:{btcTradeLedger:true,directory,cacheMs,externalSnapshot:Boolean(getSnapshot)},
      execArgv:[],name:'btc5m-readonly-ledger'});
    worker.on('message',message=>{
      const waiting=pending.get(message.id);if(!waiting)return;pending.delete(message.id);
      if(message.error)waiting.reject(err(message.error.message,message.error.statusCode??503));else waiting.resolve(message.result);
      if(!pending.size)worker?.unref();
    });
    const fail=error=>{for(const item of pending.values())item.reject(error);pending.clear();worker=null;};
    worker.on('error',fail);worker.on('exit',code=>{if(!closed&&code!==0)fail(err('账本独立读取进程已退出，可刷新重试',503));});
    worker.unref();return worker;
  }
  async function dispatch(op,input,format){
    if(closed)throw err('账本读取器已关闭',503);
    const query=input instanceof URLSearchParams?Object.fromEntries(input):input;
    normalizeQuery(query);if(op==='export'&&!['json','csv'].includes(format))throw err('导出格式无效');
    const snapshot=getSnapshot?structuredClone(await getSnapshot()):null;
    const id=++sequence,w=ensureWorker();w.ref();
    return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});w.postMessage({id,op,query,format,now:clock(),snapshot});});
  }
  return {query:(input={})=>dispatch('query',input),export:(input={},format='json')=>dispatch('export',input,format),
    close(){closed=true;for(const item of pending.values())item.reject(err('账本读取器已关闭',503));pending.clear();return worker?.terminate();}};
}

if(!isMainThread&&workerData?.btcTradeLedger){
  let workerNow=Date.now(),snapshot=null,chain=Promise.resolve();
  const ledger=createTradeLedger({directory:workerData.directory,cacheMs:workerData.cacheMs,clock:()=>workerNow,worker:false,
    getSnapshot:workerData.externalSnapshot?()=>snapshot:null});
  parentPort.on('message',message=>{chain=chain.then(async()=>{
    workerNow=message.now;snapshot=message.snapshot;
    try{const result=message.op==='export'?await ledger.export(message.query,message.format):await ledger.query(message.query);
      result.semantics&&(result.semantics.workerIsolated=true);parentPort.postMessage({id:message.id,result});}
    catch(error){parentPort.postMessage({id:message.id,error:{message:error.message,statusCode:error.statusCode??503}});}
  });});
}

async function buildLedger(files,state,now){
  const trades=new Map(),events=[],experiments=new Map(),funding=new Map(),warnings=[];
  let malformedLines=0,incompleteTails=0,duplicateTrades=0;
  const addTrade=(t,sessionId,source,kind='closed')=>{
    if(!t?.id)return;const prior=trades.get(t.id);
    if(prior){if(kind==='closed'&&prior.kind==='closed')duplicateTrades++;prior.sessions.add(sessionId);if(kind!=='closed'&&prior.kind==='closed')return;}
    const merged={...(prior?.trade??{}),...t};
    trades.set(t.id,{trade:merged,sessionId:prior?.sessionId??sessionId,sessions:prior?.sessions??new Set([sessionId]),source:source??prior?.source,kind});
  };
  for(const item of files.values()){
    malformedLines+=item.badLines;if(item.tail.trim())incompleteTails++;
    for(const row of item.rows){
      if(item.isTrades)addTrade(row.trade,row.sessionId,row.source);
      else {events.push(row);if(row.type==='experiment_start'&&row.experiment?.id)experiments.set(row.experiment.id,{...row.experiment,sessionId:row.sessionId});}
    }
    await yieldTurn();
  }
  events.sort((a,b)=>(a.time??0)-(b.time??0));
  for(const row of events)if(row.type==='strategy_closed'){
    if(!trades.has(row.trade.id))addTrade(row.trade,row.sessionId,row.source);
    else trades.get(row.trade.id).sessions.add(row.sessionId);
  }
  const currentSession=state?.sessionId??null,ss=state?.strategy??state??{};
  const currentExperiment=state?.experiment??ss.experiment;
  if(currentExperiment?.id)experiments.set(currentExperiment.id,{...currentExperiment,sessionId:currentSession});
  for(const t of [state?.strategyTrade,ss.managedPosition,ss.openPosition,...values(state?.rayOwnedPositions??ss.rayOwnedPositions)])if(t)
    addTrade(t,currentSession,{file:'current-state'},'active');
  for(const t of values(state?.pendingSettlements??ss.pendingSettlements??ss.settlementQueue?.positions))if(t)addTrade(t,currentSession,{file:'current-state'},'pending');
  for(const t of currentExperiment?.recentTrades??[])if(!trades.has(t.id))addTrade(t,currentSession,{file:'current-experiment'});

  const reportOwners=new Map(),byToken=new Map();
  for(const [id,item]of trades){const t=item.trade;
    const reports=values(t.orderReports);const token=t.tokenId??t.entryDecision?.tokenId??reports.find(r=>r.tokenId)?.tokenId??t.market?.tokens?.[t.outcome];
    item.tokenId=token??null;
    for(const r of reports)for(const sessionId of item.sessions){const key=reportKey(r);if(key)reportOwners.set(ownerReportKey(r,sessionId),id);}
    if(token){const rows=byToken.get(token)??[];rows.push(item);byToken.set(token,rows);}
  }
  const orderGroups=new Map();
  function addReport(report,meta){
    if(!reportKey(report)||!finite(report.filled)||report.filled<0||!['buy','sell'].includes(report.side))return;
    const key=groupKey(report,meta);
    const group=orderGroups.get(key)??{key,observations:[],meta:{}};
    group.observations.push({report, ...meta});
    group.meta={...group.meta,...Object.fromEntries(Object.entries(meta).filter(([,v])=>v!==null&&v!==undefined))};
    orderGroups.set(key,group);
  }
  const experimentAt=new Map();
  for(const row of events){
    if(row.type==='experiment_start')experimentAt.set(row.sessionId,row.experiment?.id??null);
    if(row.type==='paper_funding'&&row.funding?.id)funding.set(row.funding.id,{...row.funding,sessionId:row.sessionId,source:row.source,
      experimentId:row.audit?.experimentId??experimentAt.get(row.sessionId)??null});
    if(row.type==='report'){
      const r=row.report,key=reportKey(r);if(!key)continue;
      let tradeId=row.audit?.tradeId??reportOwners.get(ownerReportKey(r,row.sessionId))??null;
      // Older sessions lack audit IDs. Bind by exact token plus recorded position
      // observation interval only when the identity is unambiguous.
      if(!tradeId){const matches=(byToken.get(r.tokenId)??[]).filter(x=>finite(x.trade.openedAt)&&finite(row.time)&&
        row.time>=x.trade.openedAt-10&&(!finite(x.trade.closedAt)||row.time<=x.trade.closedAt+10));
        if(matches.length===1)tradeId=matches[0].trade.id;}
      if(tradeId&&trades.has(tradeId))trades.get(tradeId).sessions.add(row.sessionId);
      addReport(r,{sessionId:row.sessionId,tradeId,experimentId:row.audit?.experimentId??experimentAt.get(row.sessionId)??null,
        slug:row.audit?.slug??row.market?.slug??row.intent?.marketSlug??null,outcome:row.intent?.outcome??null,market:row.market,
        intent:row.intent,time:row.time,timeBasis:finite(row.time)?'journal-report-observed':'unknown',source:row.source,
        recordedDelta:num(row.deltaFilled)});
    }
  }
  // Reports in closed/owned positions are authoritative cumulative fallbacks.
  // Missing event history may establish total fills, never their exact times.
  for(const [id,item]of trades)for(const r of values(item.trade.orderReports))addReport(r,{sessionId:item.sessionId,tradeId:id,
    experimentId:item.trade.experimentId??null,slug:item.trade.slug,outcome:item.trade.outcome,market:item.trade.market,
    time:null,timeBasis:'unknown-position-cumulative-fallback',source:item.source});
  for(const r of state?.orders??[])addReport(r,{sessionId:currentSession,tradeId:reportOwners.get(ownerReportKey(r,currentSession))??null,
    time:null,timeBasis:'unknown-state-cumulative-fallback',source:{file:'current-state'}});

  const fills=[],fillsByTrade=new Map(),orderWarnings=new Map();let regressions=0,conflicts=0,unknownTimes=0;
  for(const group of orderGroups.values()){
    const observed=group.observations.filter(o=>finite(o.time)).sort((a,b)=>a.time-b.time);
    const fallback=group.observations.filter(o=>!finite(o.time));
    const ordered=[...observed,...fallback];let previous={filled:0,notional:0,fees:0},latest=null,index=0;
    const meta={...group.meta,...observed.find(o=>o.tradeId),...observed.at(-1)};
    const associated=trades.get(meta.tradeId),t=associated?.trade;
    const tradeId=t?.id??`order-only:${group.key}`;
    for(const observation of ordered){
      const r=observation.report,df=r.filled-previous.filled;
      if(df< -EPS){if(finite(observation.time)){regressions++;orderWarnings.set(group.key,'累计成交报告回退，已保留更高已成交量');}continue;}
      if(Math.abs(df)<=EPS){
        if(finite(r.notional)&&finite(previous.notional)&&Math.abs(r.notional-previous.notional)>EPS||
          finite(r.fees)&&finite(previous.fees)&&Math.abs(r.fees-previous.fees)>EPS){conflicts++;orderWarnings.set(group.key,'相同累计成交量对应金额或费用冲突');}
        if(!latest)latest=r;continue;
      }
      const dn=finite(r.notional)&&finite(previous.notional)?r.notional-previous.notional:null;
      const fee=finite(r.fees)&&finite(previous.fees)?r.fees-previous.fees:null;
      const valid=finite(dn)&&dn>0&&finite(fee)&&fee>=0;
      const integrityWarnings=[];
      if(!valid)integrityWarnings.push('成交金额或手续费未记录/不一致，现金收支未知');
      if(!finite(observation.time)){unknownTimes++;integrityWarnings.push('缺少逐次成交观测时间；不能用下单时间代替');}
      const protocolVersion=protocol(t)??experiments.get(t?.experimentId??meta.experimentId)?.profile?.rayProtocolVersion??null;
      const origin=t?originOf(t.origin):meta.intent?.strategyManaged===false?'manual-other':'unknown';
      const common={id:`fill:${group.key}:${++index}`,tradeId,orderId:r.id,sessionId:observation.sessionId??meta.sessionId,
        sessionIds:associated?[...associated.sessions]:[meta.sessionId],experimentId:t?.experimentId??meta.experimentId??null,
        protocolVersion,executionMode:'paper',origin,status:'unknown',slug:t?.slug??meta.slug??null,
        outcome:t?.outcome??meta.outcome??null,tokenId:r.tokenId,market:compactMarket(t?.market??meta.market),
        time:num(observation.time),createdAt:num(r.createdAt),timeBasis:observation.timeBasis,
        openedAt:num(t?.openedAt),closedAt:num(t?.closedAt),side:r.side,filled:rounded(df),notional:finite(dn)&&dn>0?rounded(dn):null,
        fees:finite(fee)&&fee>=0?rounded(fee):null,cashChange:valid?rounded(r.side==='buy'?-dn-fee:dn-fee):null,
        price:finite(dn)&&df>0?dn/df:null,report:r,fills:null,
        fillDetailBasis:'report.fills contains cumulative depth fills; row filled/notional/fees are positive deltas, not repeated cumulative depth.',
        entryLots:t?.entryLots??[],integrityWarnings,
        source:observation.source};
      common.marketWindow=windowOf(common);fills.push(common);
      const related=fillsByTrade.get(tradeId)??[];related.push(common);fillsByTrade.set(tradeId,related);
      previous={filled:r.filled,notional:num(r.notional),fees:num(r.fees)};latest=r;
    }
    group.latest=latest??ordered.at(-1)?.report;group.tradeId=tradeId;
    if(!t&&group.latest?.filled>0){
      const r=group.latest;addTrade({id:tradeId,tokenId:r.tokenId,slug:meta.slug,outcome:meta.outcome,market:meta.market,
        origin:meta.intent?.strategyManaged===false?'manual-other':'unknown',experimentId:meta.experimentId,
        orderReports:[r],openedAt:null,closedAt:null,orderOnly:true},meta.sessionId,meta.source,'unknown');
    }
    if(orderGroups.size&&fills.length%150===0)await yieldTurn();
  }
  const positions=[];
  for(const [id,item]of trades){
    const t=item.trade,integrityWarnings=[],reports=values(t.orderReports);
    // Legacy close records may omit tokenId even though their exact report and
    // market identity carry it; use only an unambiguous identity for cash flows.
    const tokens=new Set(reports.filter(r=>r.filled>0&&r.tokenId).map(r=>r.tokenId));
    const tokenId=t.tokenId??t.entryDecision?.tokenId??(tokens.size===1?[...tokens][0]:t.market?.tokens?.[t.outcome])??null;
    const normalized={...t,tokenId};let flow=managedCashflows(normalized);
    const linked=fillsByTrade.get(id)??[];
    if(!reports.length&&linked.length){
      const recovered=new Map();for(const f of linked){const key=reportKey(f.report);const old=recovered.get(key);if(!old||f.report.filled>old.filled)recovered.set(key,f.report);}
      normalized.orderReports=[...recovered.values()];flow=managedCashflows(normalized);
    }
    const uniqueReports=[...new Map(values(normalized.orderReports).map(r=>[reportKey(r),r])).values()];
    const total=(side,key)=>{const selected=uniqueReports.filter(r=>!side||r.side===side);
      return selected.every(r=>finite(r[key])&&r[key]>=0)?rounded(selected.reduce((s,r)=>s+r[key],0)):null;};
    const buyNotional=flow?.buyNotional??(uniqueReports.length?total('buy','notional'):null),
      sellNotional=flow?.sellNotional??(uniqueReports.length?total('sell','notional'):null),
      buyFees=flow?.buyFees??(uniqueReports.length?total('buy','fees'):null),
      sellFees=flow?.sellFees??(uniqueReports.length?total('sell','fees'):null),
      reportFees=uniqueReports.length?total(null,'fees'):null;
    const closed=finite(t.closedAt)&&item.kind==='closed',status=closed?'closed':item.kind==='pending'?'pending':item.kind==='active'?
      (finite(t.market?.end)&&now>=t.market.end?'pending':'open'):'unknown';
    const reportIssue=values(normalized.orderReports).map(r=>orderWarnings.get(groupKey(r,{tradeId:id,sessionId:item.sessionId}))).find(Boolean);
    const trulyClosed=closed&&flow&&flow.remaining<=EPS&&!reportIssue;
    const recordedNet=num(t.net),cashflowVerifiedNet=trulyClosed?flow.net:null;
    if(t.origin===undefined)integrityWarnings.push('原始记录未注明手动/自动来源');
    if(!flow)integrityWarnings.push('逐仓成交现金流证据不完整；保留原记录结果');
    if(closed&&flow&&flow.remaining>EPS)integrityWarnings.push('已平仓记录仍有未解释份额，现金流净收益未核实');
    if(trulyClosed&&finite(recordedNet)&&Math.abs(recordedNet-flow.net)>EPS)integrityWarnings.push('原记录盈亏与逐仓现金流不一致');
    if(t.orderOnly)integrityWarnings.push('只有订单成交事实，缺少完整持仓与平仓/兑付记录，盈亏未知');
    if(reportIssue)integrityWarnings.push(reportIssue);
    const exp=experiments.get(t.experimentId),protocolVersion=protocol(t)??exp?.profile?.rayProtocolVersion??null;
    const row={id,sessionId:item.sessionId,sessionIds:[...item.sessions],experimentId:t.experimentId??null,
      protocolVersion,executionMode:'paper',origin:originOf(t.origin),status,slug:t.slug??null,outcome:t.outcome??null,tokenId,
      market:compactMarket(t.market),openedAt:num(t.openedAt),closedAt:num(t.closedAt),time:num(t.closedAt??t.openedAt),
      bought:flow?.bought??num(t.bought)??(uniqueReports.length?total('buy','filled'):null),
      sold:flow?.sold??num(t.sold)??(uniqueReports.length?total('sell','filled'):null),remaining:flow?.remaining??null,
      entryAverage:flow?.bought?flow.buyNotional/flow.bought:num(t.entryAverage),exitAverage:flow?.sold?flow.sellNotional/flow.sold:num(t.exitAverage),
      buyNotional,sellNotional,fees:flow?.fees??reportFees??num(t.fees),
      buyCost:flow?.buyCost??(finite(buyNotional)&&finite(buyFees)?rounded(buyNotional+buyFees):null),
      proceeds:flow?rounded(flow.sellNet+flow.settlementPayout):finite(sellNotional)&&finite(sellFees)?rounded(sellNotional-sellFees+(t.settlement?.payout??0)):null,
      payout:flow?.settlementPayout??num(t.settlement?.payout),net:closed?(cashflowVerifiedNet??recordedNet):null,
      recordedNet,cashflowVerifiedNet,cashChange:flow?.net??(finite(buyNotional)&&finite(sellNotional)&&finite(reportFees)?rounded(sellNotional-buyNotional-reportFees+(t.settlement?.payout??0)):null),
      cashflowSource:reports.length?'position-order-reports':linked.length?'recovered-from-journal-reports':'unavailable',
      accountingSource:cashflowVerifiedNet!==null?'verified-position-order-cashflows':closed&&recordedNet!==null?'legacy-recorded-result':'incomplete-or-open',
      closeMethod:t.closeMethod??null,exitReason:t.exitReason??null,entryLots:t.entryLots??[],orderReports:normalized.orderReports??reports,
      settlement:t.settlement??null,fillCount:linked.length,integrityWarnings,source:item.source};
    for(const key of ['parameters','entryDecision','signalAt','amountUsd','maxSpend','riskBudget','timing','version','positionManagementVersion',
      'signalAt','holdingDecision','maxFavorableNet','maxAdverseNet','filledEntries','fillTiming','auditVersion','accountingRevision'])
      row[key]=t[key]??null;
    row.marketWindow=windowOf(row);if(row.marketWindow.status==='conflict')row.integrityWarnings.push('盘口时间或合约身份存在冲突');
    positions.push(row);for(const f of linked){f.status=row.status;f.protocolVersion=row.protocolVersion;f.origin=row.origin;f.sessionIds=row.sessionIds;}
  }
  for(const cf of state?.portfolio?.cashFlows??[]){const prior=funding.get(cf.id);if(!prior&&cf.id)funding.set(cf.id,{...cf,sessionId:currentSession,source:{file:'current-state'},experimentId:null});}
  const cashFlows=[...funding.values()].map(cf=>({id:cf.id,sessionId:cf.sessionId,sessionIds:[cf.sessionId],experimentId:cf.experimentId??null,
    protocolVersion:experiments.get(cf.experimentId)?.profile?.rayProtocolVersion??null,executionMode:'paper',origin:'unknown',status:'unknown',
    slug:null,outcome:null,tokenId:null,time:num(cf.time),openedAt:null,closedAt:null,amount:num(cf.amount),type:cf.type??'unknown',
    requestId:cf.requestId??null,integrityWarnings:finite(cf.amount)?[]:['充值金额未知'],source:cf.source}));
  if(malformedLines)warnings.push(`${malformedLines} 行日志不能解析，未伪造缺失事实`);
  if(incompleteTails)warnings.push(`${incompleteTails} 个日志末行尚未写完，等待下次增量读取`);
  if(regressions)warnings.push(`${regressions} 条累计成交报告回退`);
  if(conflicts)warnings.push(`${conflicts} 条累计成交金额或费用冲突`);
  if(unknownTimes)warnings.push(`${unknownTimes} 条成交只有累计证据，实际观测时间未知`);
  const unknownOrigins=positions.filter(r=>r.origin==='unknown').length,recordedOnly=positions.filter(r=>r.accountingSource==='legacy-recorded-result').length;
  if(unknownOrigins)warnings.push(`${unknownOrigins} 个持仓缺少原始来源标记`);
  if(recordedOnly)warnings.push(`${recordedOnly} 个历史平仓仅保留原记录盈亏口径`);
  if(!state)warnings.push('当前运行状态不可读，当前策略/会话筛选无法确认');
  return {positions,fills,cashFlows,options:{sessions:[...new Set([...files.values()].map(x=>x.sessionId))].sort(),
    experiments:[...experiments.values()].map(e=>({id:e.id,sessionId:e.sessionId,startedAt:e.startedAt,protocolVersion:e.profile?.rayProtocolVersion??null,
      model:e.profile?.strategy?.model??null}))},
    integrity:{status:warnings.length?'attention':'ok',warnings,sourceFiles:files.size,malformedLines,incompleteTails,
      reportRegressions:regressions,reportConflicts:conflicts,unknownFillTimes:unknownTimes,unknownOrigins,recordedOnlyClosed:recordedOnly,
      sourceBytes:[...files.values()].reduce((s,x)=>s+x.offset,0),builtAt:now,snapshotObservedAt:state?.now??now,
      captureBasis:'Each journal is read to its captured byte prefix; owned state is cloned before construction. Newer snapshot reports may have unknown fill observation times until next refresh.',
      readOnly:true,historyRewritten:false,
      statement:'Paper runtime reconciliation records, not exchange executions or backtest output. Unknown evidence stays unknown.'}};
}

export function ledgerCsv(data){
  const common=['id','sessionId','experimentId','protocolVersion','executionMode','origin','status','slug','outcome','tokenId','marketStartHkt','marketEndHkt','time','openedAt','closedAt'];
  const extra=data.view==='positions'?['bought','sold','remaining','entryAverage','exitAverage','buyNotional','sellNotional','buyCost','proceeds','fees','payout','net','recordedNet','cashflowVerifiedNet','cashChange','accountingSource','closeMethod','entryLots','orderReports','settlement']:
    data.view==='fills'?['tradeId','orderId','side','filled','price','notional','fees','cashChange','createdAt','timeBasis','report','fills']:['amount','type','requestId'];
  const columns=[...common,...extra,'integrityWarnings'];
  const cell=value=>{let text=value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);
    // CSV imports must not execute arbitrary log fields as spreadsheet formulas.
    if(typeof value==='string'&&/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  const hkt=ms=>finite(ms)?new Date(ms+8*3600000).toISOString().replace('T',' ').replace('Z',' HKT'):null;
  return '\uFEFF'+[columns.map(cell).join(','),...data.rows.map(row=>columns.map(k=>cell(k==='marketStartHkt'?hkt(row.marketWindow?.start):k==='marketEndHkt'?hkt(row.marketWindow?.end):row[k])).join(','))].join('\r\n')+'\r\n';
}
