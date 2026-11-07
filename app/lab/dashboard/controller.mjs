import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Lifecycle } from '../lifecycle.mjs';
import { PaperBroker, round, terminal } from '../paper-broker.mjs';
import { DiagnosticPublicFeed as PublicFeed } from './diagnostic-public-feed.mjs';
import { trimHistory, e18ToPrice, openingReference } from './chart-model.mjs';
import { strategyDefaults, validateStrategyConfig, evaluateStrategy, replacementAllowed, exitDecision, freshBook } from './strategy.mjs';
import { evaluateExecutionEdge } from './execution-edge.mjs';
import { SettlementShadow } from './settlement-shadow.mjs';
import { writeJsonAtomic, PersistenceError } from './atomic-json.mjs';
import { amountQuote, orderSizeAllowed, amountExecutionVersion } from '../amount-order.mjs';
import { evaluateForward, forwardExit, forwardProtocol, summarizeForwardBatch } from './forward-strategy.mjs';
import { StrategyObservation } from './strategy-observation.mjs';
import { P1Study } from './p1-study.mjs';
import { P2Context } from './p2-context.mjs';
import { P3Study } from './p3-study.mjs';
import { P3ConfirmationStudy } from './p3-confirmation.mjs';
import { SettlementValueResearch } from './settlement-value-research.mjs';
import { ContinuationStudy } from './continuation-study.mjs';
import { AdaptiveResearch } from './adaptive-research.mjs';
import { adaptiveWorkAvailable } from './adaptive-scheduling.mjs';
import { AdaptiveAccountStudy } from './adaptive-account.mjs';
import { adaptiveAccountClockStatus } from './adaptive-account-clock-guard.mjs';
import { referenceStatus } from './reference-price.mjs';
import {marketInformationExit,marketExitRevision,marketExitProtocol} from './market-exit.mjs';
import {auditVersion,opportunitySnapshot,summarizeOpportunity,tradeTiming} from './p0-audit.mjs';
import {AccountMetrics,accountValuation} from './account-metrics.mjs';
import {managedCashflows,validManagedSettlement,managedInventory} from './managed-position-accounting.mjs';
import {EvolutionCoordinator,compatibleEvolutionConfig} from './evolution-coordinator.mjs';
import {BidHistory} from './bid-exit.mjs';
import {isManagedExitRevision,runManagedExit,resetManagedConfirmation} from './exit-policy.mjs';
import {evaluateRay,rayProtocol,raySession,validRayOpening} from './ray-strategy.mjs';
import {restoreRunIntent,nextRunIntent} from './run-intent.mjs';
import {oneTapQuote,oneTapExecutionVersion} from '../one-tap-order.mjs';
import {rayStrengthAllocation} from './ray-onetap-sizing.mjs';
import {RayDynamicTwap} from './ray-dynamic-twap.mjs';
import {calendarThresholdKey} from './calendar-threshold.mjs';
import {RayTerminalObserver} from './ray-terminal-observer.mjs';
import {OrderflowResearch} from './orderflow-research.mjs';
import {RayEntryTrigger,rayEntryTimingVersion as entryTimingVersion} from './ray-entry-trigger.mjs';
import {AdmissionResearch} from './admission-research.mjs';
import {writeStateCheckpoint} from './state-checkpoint.mjs';

export const positionManagementVersion='owned-settlement-queue-v1';

export const defaults = { maxExposure: 10, maxLoss: 2, size: 5, makerMs: 10_000,
  exitMakerMs: 2000, holdMs: 15_000, staleMs: 3000 };
const bounds = { maxExposure: [1, 1000], maxLoss: [0, 1000], size: [1, 1000], buyUnits: [1, 1000],
  makerMs: [1000, 60_000], exitMakerMs: [1000, 30_000], holdMs: [1000, 120_000], staleMs: [1000, 10_000] };
export class ControlError extends Error {}
export class MarketDataStaleError extends ControlError {
  constructor(evidence) {
    super('盘口数据过期，等待连接恢复');
    this.code='market-data-stale-before-submit';
    this.preSubmit=true;
    this.evidence=Object.freeze({...evidence});
  }
}
const preSubmitState = controller => JSON.stringify({sequence:controller.sequence,brokerSequence:controller.broker.sequence,
  orders:controller.broker.orders.size,applied:[...controller.engine.applied],usedIntents:[...controller.engine.usedIntents],
  cash:controller.engine.cash,fees:controller.engine.fees,holdings:[...controller.engine.holdings],
  inventoryCost:[...controller.engine.inventoryCost],active:controller.engine.active,busy:controller.engine.busy,halted:controller.engine.halted});
const storageHalt = reason => /^本地状态保存失败/.test(reason ?? '') || /^(EPERM|EACCES|EBUSY):.*rename.*state\.json/.test(reason ?? '');
const accountFingerprint = state => createHash('sha256').update(JSON.stringify({ cash: state.account.cash,
  fees: state.account.fees, holdings: state.account.holdings, active: state.account.active,
  orders: state.orders, applied: state.applied, brokerSequence: state.brokerSequence,portfolio:state.portfolio??null })).digest('hex');

export class DashboardController {
  running = false; paused = false; mode = 'observe'; config = { ...defaults };
  runIntent=restoreRunIntent(undefined); runtimeRecovery=null; serviceRuntime=null;
  recoveryHold=null;
  recoveryEvidence=null;recoveryBaseline=null;checkpointMarker=null;
  observationPersistence={lastAt:null,criticalKey:null,writes:0,coalesced:0,windowMs:5000};
  frame = null; sources = {}; history = []; log = []; markets = {};
  attempted = new Set(); entryAt = null; sequence = 0; requestIds = new Map();
  chain = Promise.resolve(); listeners = new Set(); lightListeners = new Set();
  feedGeneration = 0;
  priceHistory = []; priceReference = null;
  latestTwap = null;
  strategyConfig = { ...strategyDefaults }; strategyTrade = null; strategyDecision = null;
  pendingSettlements = [];
  rayOwnedPositions = []; rayRoundFills = {}; rayMarketEntries = {}; rayAlignmentVersion = null;
  rayDynamicTwap = new RayDynamicTwap();
  rayEntryTrigger = new RayEntryTrigger();
  orderflowResearch=null; orderflowLastSummary=null; orderflowError=null;
  exitHistory = new BidHistory();
  experiment = null;
  auditRounds = new Map(); auditLatest = null; auditError = null; auditSegment = randomUUID();
  constructor({ directory, clock = Date.now, feedFactory = options => new PublicFeed(options),admissionResearchConfig={stage:0} }) {
    this.directory = directory; this.clock = clock; this.feedFactory = feedFactory;
    this.admissionResearchConfig={...admissionResearchConfig};this.admissionResearch=null;
    this.accountMetrics=new AccountMetrics({now:clock()});
    mkdirSync(directory, { recursive: true });
    try { this.strategyObservation=new StrategyObservation(directory); }
    catch(e) { this.observationError=e.message; }
    try { this.p1Study=new P1Study(directory); } catch(e) { this.p1Error=e.message; }
    try { this.p3Study=new P3Study(directory); } catch(e) { this.p3Error=e.message; }
    try { this.p3Confirmation=new P3ConfirmationStudy(directory); } catch(e) { this.p3ConfirmationError=e.message; }
    this.p2Context=new P2Context({clock,write:(kind,row)=>this.record('-p2-'+kind,row)});
    this.terminalObserver=new RayTerminalObserver({clock,write:row=>{
      this.record('-ray-terminal-risk',{...row,sessionId:this.sessionId,experimentId:this.experiment?.id??null,segmentId:this.auditSegment});
      return true;
    }});
    this.storageFaultPath = join(directory, 'persistence-error.json');
    this.storageFault = existsSync(this.storageFaultPath) ? JSON.parse(readFileSync(this.storageFaultPath, 'utf8')) : null;
    try { this.edgeArtifact=JSON.parse(readFileSync(new URL('./reports/execution-edge-model.json',import.meta.url),'utf8')); }
    catch { this.edgeArtifact=null; }
    const readReport = name => { try { return JSON.parse(readFileSync(new URL('./reports/' + name, import.meta.url), 'utf8')); } catch { return null; } };
    const settlementReport = readReport('settlement-forward-research.json') ?? readReport('settlement-research.json');
    this.settlement = new SettlementShadow({ directory,clock, artifact: readReport('settlement-forward-model.json') ?? readReport('settlement-model.json'),
      seedMarkets: directory.endsWith('runtime') ? (readReport('settlement-input.json')?.rounds ?? []).map(r => r.market) : [],
      historical: settlementReport ? { usable: settlementReport.usableRounds, parts: settlementReport.parts } : null });
    try { this.valueResearch=new SettlementValueResearch(directory,readReport('p3-value-model.json'),readReport('p3-value-calibration.json')); }
    catch(e) { this.valueResearchError=e.message; }
    try { this.continuationStudy=new ContinuationStudy(directory); }
    catch(e) { this.continuationError=e.message; }
    try { this.adaptiveResearch=new AdaptiveResearch(directory,{createdAt:this.clock()}); }
    catch(e) { this.adaptiveResearchError=e.message; }
    try { this.adaptiveAccountStudy=new AdaptiveAccountStudy(directory,{createdAt:this.clock()}); }
    catch(e) { this.adaptiveAccountError=e.message; }
    this.newEngine();
    this.sessionId = randomUUID();
  }
  newEngine() {
    this.broker = new PaperBroker();
    this.broker.staleMs = this.config.staleMs;
    this.engine = new Lifecycle(this.broker, { ...this.config, journal: event => this.event(event),
      beforeSubmit: ({intent,market,phase,request,now}) => {
        if(intent.side==='buy'&&this.strategyConfig.model==='ray-twap-band'&&this.rayMarketEntered(market?.slug))return false;
        if(intent.side==='buy'&&this.config.riskPolicy==='equity-per-order-v1') {
          const equity=this.raySizingEquity(now),r=intent.riskBudget;
          if(this.paused||!equity.known||!r||r.policy!==this.config.riskPolicy||r.equity!==equity.value||
            r.availableCash!==this.engine.cash||r.feeInclusive!==true||r.at>now||now-r.at>this.config.staleMs||
            request.maxSpend!==r.maxSpend||intent.maxSpend!==r.maxSpend||request.maxSpend>this.engine.cash+1e-8)return false;
        }
        if (!intent.strategyManaged || intent.side!=='buy') return true;
        if (this.strategyConfig.execution!=='paper' || this.paused) return false;
        const decision=this.evaluate(now,request.size);
        if(decision.version===rayProtocol.version){const c=decision.selected;return Boolean(phase==='taker'&&c?.eligible&&c.tokenId===intent.tokenId&&
          intent.entryPolicy==='ray-onetap-last-120s-v1'&&request.orderType==='FAK'&&
          request.maxSpend===intent.maxSpend&&request.amountUsd===intent.amountUsd&&request.size===intent.size&&
          request.maxSpend<=c.maxSpend+1e-8&&request.amountUsd<=c.amountUsd+1e-8&&
          request.size<=c.orderSize+1e-8&&request.price<=c.limit+1e-8&&request.price<=rayProtocol.maxPrice&&request.price>=c.ask&&
          calendarThresholdKey(intent.calendarThreshold)===calendarThresholdKey(c.calendarThreshold));}
        if(intent.amountUsd!==undefined) {
          const c=decision.candidates.find(c=>c.tokenId===intent.tokenId);
          return Boolean(phase==='taker' && c?.eligible && c.amountUsd===request.amountUsd && c.limit<=request.price);
        }
        if(decision.version==='execution-edge-v2') {
          const c=decision.candidates.find(c=>c.tokenId===intent.tokenId);
          return Boolean(phase==='taker' && c?.eligible && c.limit<=request.price);
        }
        if(phase==='maker') {
          const c=decision.candidates.find(c=>c.tokenId===intent.tokenId);
          return Boolean(c?.eligible && c.targetBid-c.exitFeePerShare-request.price-this.strategyConfig.costBuffer>=this.strategyConfig.minNetEdge);
        }
        return replacementAllowed(decision,intent,this.frame?.books.find(b=>b.tokenId===intent.tokenId),market,now,this.config,this.strategyConfig,request.size);
      } });
  }
  async initialize() {
    const path = join(this.directory, 'state.json');
    if (!existsSync(path)) { this.configureEvolution();this.configureAdmissionResearch();this.event({ type: 'ready', message: '控制台已就绪，等待启动' }); this.save(); return; }
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved.version !== 1 || saved.realTrading !== false) throw new Error('Unsupported state');
      if(saved.recoveryEvidence){
        if(!['prefix-recovery-v1','paper-recovery-baseline-v1'].includes(saved.recoveryEvidence.version))throw Error('Unknown recovery evidence');
        this.recoveryEvidence=structuredClone(saved.recoveryEvidence);
      }
      if(saved.recoveryBaseline){const b=saved.recoveryBaseline;
        if(b.version!=='paper-recovery-baseline-v1'||typeof b.id!=='string'||!Number.isFinite(b.startedAt)||
          !Number.isFinite(b.cash)||!Number.isFinite(b.fees)||!Number.isSafeInteger(b.completedTrades)||b.unresolvedBytes!==421)throw Error('Invalid recovery baseline');
        this.recoveryBaseline=structuredClone(b);
      }
      if(saved.recoveryHold!==undefined&&saved.recoveryHold!==null){
        const h=saved.recoveryHold;
        if(h.version!=='btc5m-recovery-hold-v1'||typeof h.reason!=='string'||!h.reason.length||!Number.isFinite(h.verifiedThrough)||
          !Number.isSafeInteger(h.unresolvedBytes)||h.unresolvedBytes<0)throw Error('Invalid recovery hold');
        this.recoveryHold=structuredClone(h);this.paused=true;
      }
      this.validateConfig(saved.config); this.config = saved.config;
      validateStrategyConfig(saved.strategyConfig ?? {});
      this.strategyConfig = { ...strategyDefaults, ...saved.strategyConfig };
      this.strategyTrade = saved.strategyTrade ?? null;
      this.pendingSettlements = saved.pendingSettlements ?? [];
      this.rayOwnedPositions=saved.rayOwnedPositions??[];this.rayRoundFills=saved.rayRoundFills??{};
      if(saved.rayMarketEntryPolicy!==undefined&&saved.rayMarketEntryPolicy!==rayProtocol.entryPolicy)
        throw Error('Unknown market entry policy');
      if(saved.rayMarketEntryPolicy!==undefined&&!Object.hasOwn(saved,'rayMarketEntries'))
        throw Error('Market entry ledger is missing');
      if(Object.hasOwn(saved,'rayMarketEntries')&&(!saved.rayMarketEntries||typeof saved.rayMarketEntries!=='object'||Array.isArray(saved.rayMarketEntries)))
        throw Error('Invalid market entry ledger');
      this.rayMarketEntries=Object.hasOwn(saved,'rayMarketEntries')?saved.rayMarketEntries:{};
      this.rayAlignmentVersion=saved.rayAlignmentVersion??null;
      this.rayDecisionSlot=saved.rayDecisionSlot??null;
      this.rayEntryTrigger=new RayEntryTrigger(saved.rayEntryTrigger??null);
      if(this.rayEntryTrigger.restoreError)throw Error(this.rayEntryTrigger.restoreError);
      this.rayDynamicTwap=new RayDynamicTwap(saved.rayDynamicTwap??null);
      if(!Array.isArray(this.rayOwnedPositions)||this.rayOwnedPositions.some(t=>!t?.id||
          !['ray-twap-band-equity-v2','ray-twap-band-onetap-v3','ray-twap-calendar-onetap-v4','ray-twap-calendar-onetap-v5','ray-twap-calendar-onetap-v6','ray-twap-calendar-onetap-v7',rayProtocol.version].includes(t.entryDecision?.version)||!Array.isArray(t.entryLots)||
          !managedCashflows(t)&&!(saved.account.active?.intent.tokenId===t.tokenId&&
            t.entryLots.some(l=>l.id===saved.account.active.intent.rayEntryLotId&&l.intentId===saved.account.active.intent.id)&&
            !(saved.account.holdings[t.tokenId]>0)&&t.openedAt===null))||
        !Array.isArray(this.pendingSettlements)||this.pendingSettlements.some(t=>!t?.id||!managedCashflows(t))||
        new Set(this.ownedTrades().map(t=>t.id)).size!==this.ownedTrades().length||
        new Set(this.ownedTrades().map(t=>t.tokenId)).size!==this.ownedTrades().length)throw Error('Invalid owned settlement queue');
      resetManagedConfirmation(this.strategyTrade);
      this.experiment = saved.experiment ?? null;
      this.mode = saved.mode; this.runIntent=restoreRunIntent(saved.runIntent,saved.mode); this.sessionId = saved.sessionId; this.newEngine();
      this.frame = saved.frame; this.markets = saved.markets; this.history = saved.history; this.log = saved.log;
      this.history = trimHistory(this.history, this.frame?.now ?? this.clock());
      this.priceHistory = trimHistory(saved.priceHistory ?? [], Math.max(this.frame?.now ?? 0, saved.priceHistory?.at(-1)?.time ?? 0) || this.clock());
      this.priceReference = saved.priceReference ?? null;
      this.engine.holdings = new Map(Object.entries(saved.account.holdings));
      // Older snapshots did not store position cost. Recover it from recorded
      // fills, then retain costs only for actually held tokens (not settled ones).
      const costs=new Map(),sizes=new Map();
      for(const o of saved.orders) {
        const size=sizes.get(o.tokenId)??0,cost=costs.get(o.tokenId)??0;
        if(o.side==='buy'){sizes.set(o.tokenId,size+o.filled);costs.set(o.tokenId,cost+o.notional+o.fees);}
        else {const left=Math.max(0,size-o.filled);sizes.set(o.tokenId,left);costs.set(o.tokenId,size?cost*left/size:0);}
      }
      this.engine.inventoryCost=new Map([...this.engine.holdings].map(([id,size])=>[id,
        saved.account.inventoryCost?.[id]??(sizes.get(id)>0?round(costs.get(id)*size/sizes.get(id)):size)]));
      const restoredInventory=this.managedInventory();
      if(this.pendingSettlements.length && (restoredInventory.pendingCount!==this.pendingSettlements.length ||
        restoredInventory.conflictingTokens.length || restoredInventory.unknownCost))throw Error('Settlement queue does not match restored inventory');
      for(const trade of this.ownedTrades()){
        const flow=managedCashflows(trade),held=this.engine.holdings.get(trade.tokenId)??0;
        if(flow&&Math.abs(flow.remaining-held)>1e-7)throw Error('Owned cashflow records do not match restored inventory');
        if(held>0&&flow&&!restoredInventory.positions.some(p=>p.tradeId===trade.id&&p.kind!=='unmanaged'))
          throw Error('Owned inventory identity or acquisition cost is inconsistent');
      }
      this.engine.cash = saved.account.cash; this.engine.fees = saved.account.fees;
      this.engine.active = saved.account.active; this.engine.halted = saved.account.halted;
      if(this.recoveryHold)this.engine.halted=`账户恢复核对锁：${this.recoveryHold.reason}`;
      this.engine.applied = new Map(saved.applied); this.engine.usedIntents = new Set(saved.usedIntents);
      this.broker.orders = new Map(saved.orders.map(o => [o.id, o])); this.broker.sequence = saved.brokerSequence;
      this.validateRayRoundFills();
      this.restoreRayMarketEntries();
      this.attempted = new Set(saved.attempted); this.sequence = saved.sequence;
      this.requestIds = new Map(saved.requestIds ?? []);
      this.entryAt = saved.entryAt;
      this.accountMetrics=new AccountMetrics({saved:saved.portfolio??null,now:this.clock()});
      this.engine.externalFunds=round(this.accountMetrics.state.cashFlows.reduce((s,f)=>s+f.amount,0));
      if(!saved.portfolio)this.accountMetrics.seedUnmanaged(this.engine.snapshot(),saved.orders,this.ownedTrades().map(t=>t.tokenId));
      for(const trade of this.exportStrategyTrades().trades)this.accountMetrics.addClose(trade);
      if (this.storageFault) this.engine.halted = this.storageFault.message;
      if (this.settlement.financialConflict)this.engine.halted='已核实结算结果发生矛盾，请核对官方结果与账户记录';
      // Simulated resting orders from a previous process are cancelled and reconciled before reuse.
      await this.engine.tick(this.clock(), { stop: true });
      this.syncStrategyTrade();
      this.parkExpiredPosition();
      this.configureEvolution(saved.evolution??null);
      this.configureAdmissionResearch(saved.admissionResearch??null);
      this.event({ type: 'restored', message: '已恢复上次模拟账户；保持停止，旧模拟挂单已核对' });
      if (!storageHalt(this.engine.halted)) this.save();
    } catch (error) {
      if (error instanceof PersistenceError) { this.handleRuntimeError(error); return; }
      this.engine.halt(`本地状态恢复失败：${error.message}。请保留 state.json 后检查，不能覆盖账户。`);
      this.restoreFailed = true;
    }
  }
  enqueue(fn) {
    const work = this.chain.then(async () => {
      try {
        try { return await fn(); }
        finally { if (!this.restoreFailed && !storageHalt(this.engine.halted)) { this.syncStrategyTrade(); this.save({observation:true}); } }
      } catch (error) {
        if (error instanceof PersistenceError) this.handleRuntimeError(error);
        throw error;
      } finally { this.publish(); }
    });
    this.chain = work.catch(() => {}); return work;
  }
  subscribe(fn,{snapshot=true}={}) { const listeners=snapshot?this.listeners:this.lightListeners;listeners.add(fn);return()=>listeners.delete(fn); }
  publish() { const state=this.listeners.size?this.snapshot():undefined;for(const fn of this.listeners)fn(state);for(const fn of this.lightListeners)fn(); }
  event(event) {
    const owner=event.type==='report'?this.ownedTrades().find(t=>t.tokenId===event.report?.tokenId):null;
    if(event.type==='report'&&event.report?.side==='buy'&&event.report.filled>0)
      this.recordRayMarketEntry(event.report,this.engine?.active?.market??this.markets[event.report.tokenId],{
        source:'reconciled-order-report',protocolVersion:owner?.parameters?.rayProtocolVersion??owner?.entryDecision?.version??
          (this.strategyConfig.model==='ray-twap-band'?rayProtocol.version:null)});
    if(event.type==='report')this.accountMetrics.report(event.report,{managed:Boolean(owner),now:this.clock()});
    if(event.type==='strategy_closed')this.accountMetrics.addClose(event);
    if(owner && this.engine?.active?.intent.tokenId===owner.tokenId) {
      owner.orderReports??={};
      owner.orderReports[event.report.id]=structuredClone(event.report);
      if(event.deltaFilled>0) {
        const trade=owner,at=this.clock(),book=this.frame?.books.find(b=>b.tokenId===event.report.tokenId);
        trade.fillTiming??={};
        const prior=trade.fillTiming[event.report.id];
        trade.fillTiming[event.report.id]={orderId:event.report.id,side:event.report.side,
          firstFilledAt:prior?.firstFilledAt??at,lastFilledAt:at,filled:event.report.filled,
          sourceBookAt:book?.timestamp??null,receivedAt:book?.receivedAt??null,transportReceivedAt:book?.transportReceivedAt??null};
      }
      const lot=owner.entryLots?.find(l=>l.intentId===this.engine.active.intent.id);
      if(lot){
        lot.orderReports??={};lot.orderReports[event.report.id]=structuredClone(event.report);
        const reports=Object.values(lot.orderReports);lot.filled=round(reports.reduce((s,r)=>s+r.filled,0));
        lot.cost=round(reports.reduce((s,r)=>s+r.notional+r.fees,0));
        lot.status=event.report.status;
        if(event.report.side==='buy'){
          this.rayRoundFills[owner.slug]??={};
          this.rayRoundFills[owner.slug][event.report.id]={tokenId:owner.tokenId,filled:event.report.filled,experimentId:owner.experimentId};
        }
      }
    }
    const row = { id: randomUUID(), time: this.clock(), ...event,
      audit:{version:auditVersion,sessionId:this.sessionId,tradeId:event.tradeId??owner?.id??this.strategyTrade?.id??null,
        experimentId:owner?.experimentId??this.strategyTrade?.experimentId??null,slug:event.slug??this.engine?.active?.market?.slug??this.frame?.market?.slug??null} };
    this.record('',row);
    this.log.push(row); if (this.log.length > 300) this.log.shift();
  }
  record(suffix,row) {
    appendFileSync(join(this.directory, `${this.sessionId ?? 'startup'}${suffix}.jsonl`),JSON.stringify(row)+'\n',
      suffix===''||suffix==='-trades'?{flush:true}:{});
  }
  handleRuntimeError(error) {
    this.running = false; this.paused = true; this.feed?.stop(); this.feedGeneration++;
    for (const key of ['market', 'book', 'twap', 'resolution']) this.sources[key] = { state: 'stopped' };
    if (error instanceof PersistenceError) {
      this.storageFault = { message: error.message, time: this.clock(), target: error.target,
        temporary: error.temporary, expectedAccountFingerprint: accountFingerprint(this.savedState()) };
      try { writeFileSync(this.storageFaultPath, JSON.stringify(this.storageFault)); } catch { /* Keep in-memory halt even if disk is unavailable. */ }
    }
    try { this.engine.halt(error.message); } catch { this.engine.halted = error.message; }
    this.publish();
  }
  canRecoverStorage() {
    return !this.running && !this.restoreFailed && storageHalt(this.engine.halted) && !this.engine.active &&
      !this.engine.holdings.size && !this.strategyTrade && !this.rayOwnedPositions.length && !this.pendingSettlements.length && !this.settlement.ledger.summary().pending &&
      [...this.broker.orders.values()].every(o => terminal(o.status));
  }
  recoverStorage() {
    if (!this.canRecoverStorage()) throw new ControlError('只有停止且账户已无持仓、未完成订单的存储暂停可以核对恢复');
    const saved = JSON.parse(readFileSync(join(this.directory, 'state.json'), 'utf8'));
    const fingerprint = accountFingerprint(this.savedState());
    if (saved.sessionId !== this.sessionId || saved.realTrading !== false || accountFingerprint(saved) !== fingerprint ||
        this.storageFault && this.storageFault.expectedAccountFingerprint !== fingerprint)
      throw new ControlError('内存与磁盘账户不一致，保持暂停；请核对保留的快照与成交日志');
    // Recovery of a storage fault deliberately remains stopped, even when a
    // supervisor is enabled; it must not revive a pre-fault running request.
    this.runIntent=nextRunIntent(this.runIntent,{running:false,mode:this.mode,paused:true},this.clock());
    // First prove that both ledgers can be saved with the halt still set.
    this.settlement.save(); this.save();
    const previous = this.engine.halted;
    this.engine.halted = null;
    try { this.save(); if (existsSync(this.storageFaultPath)) unlinkSync(this.storageFaultPath); this.storageFault = null; }
    catch (error) { this.engine.halted = previous; throw error; }
    this.event({ type: 'storage_recovered', message: '状态文件保存已恢复，余额、持仓和订单核对一致；保持停止，可重新启动' });
  }
  savedState() {
    return { version: 1, realTrading: false, sessionId: this.sessionId, mode: this.mode,runIntent:this.runIntent,recoveryHold:this.recoveryHold,recoveryEvidence:this.recoveryEvidence,recoveryBaseline:this.recoveryBaseline,
      config: this.config, frame: this.frame, markets: this.markets, history: this.history, log: this.log,
      priceHistory: this.priceHistory, priceReference: this.priceReference,
      strategyConfig: this.strategyConfig, strategyTrade: this.strategyTrade, pendingSettlements:this.pendingSettlements,
      rayOwnedPositions:this.rayOwnedPositions,rayRoundFills:this.rayRoundFills,rayMarketEntries:this.rayMarketEntries,
      rayMarketEntryPolicy:rayProtocol.entryPolicy,rayAlignmentVersion:this.rayAlignmentVersion,
      rayDecisionSlot:this.rayDecisionSlot??null,rayEntryTrigger:this.rayEntryTrigger.saved(),
      rayDynamicTwap:this.rayDynamicTwap.saved(),
      admissionResearch:this.admissionResearch?.saved()??null,
      positionManagementVersion,experiment: this.experiment,
      evolution:this.evolutionCoordinator?.state??this.evolutionRecoveryState??null,
      portfolio:this.accountMetrics.saved(),
      account: this.engine.snapshot(), applied: [...this.engine.applied], usedIntents: [...this.engine.usedIntents],
      orders: [...this.broker.orders.values()], brokerSequence: this.broker.sequence,
      attempted: [...this.attempted], sequence: this.sequence, entryAt: this.entryAt, requestIds: [...this.requestIds] };
  }
  save({observation=false}={}) {
    this.accountMetrics.observe(this.portfolioValuation(),this.clock());
    const saved=this.savedState();
    const prior=this.checkpointMarker;
    this.checkpointMarker=writeStateCheckpoint(this.directory,saved,this.checkpointMarker);
    const criticalKey=createHash('sha256').update(JSON.stringify({portfolio:saved.portfolio,requestIds:saved.requestIds,
      lastAttempt:saved.rayEntryTrigger?.lastAttempt,recentAttempts:saved.rayEntryTrigger?.recentAttempts})).digest('hex');
    const persistence=this.observationPersistence,now=performance.now(),financialChanged=!prior||prior.generation!==this.checkpointMarker.generation;
    if(observation&&!financialChanged&&persistence.criticalKey===criticalKey&&persistence.lastAt!==null&&now-persistence.lastAt<persistence.windowMs){persistence.coalesced++;return;}
    writeJsonAtomic(join(this.directory, 'state.json'), saved);
    persistence.lastAt=now;persistence.criticalKey=criticalKey;persistence.writes++;
  }
  portfolioValuation(now=this.clock()) {
    return accountValuation({account:this.engine.snapshot(),frame:this.frame,markets:this.markets,trade:this.strategyTrade,
      ownedTrades:this.ownedTrades(),labels:this.financialLabels(),now,staleMs:this.config.staleMs});
  }
  exportStrategyTrades() {
    const path=join(this.directory,`${this.sessionId}-trades.jsonl`),unique=new Map();let unreadableLines=0;
    for(const line of existsSync(path)?readFileSync(path,'utf8').split('\n').filter(Boolean):[]) {
      try{const t=JSON.parse(line);unique.set(t.id,t);}catch{unreadableLines++;}
    }
    return {realTrading:false,sessionId:this.sessionId,experiment:this.experiment,openPosition:this.strategyTrade,
      pendingSettlements:this.pendingSettlements,rayOwnedPositions:this.rayOwnedPositions,rayRoundFills:this.rayRoundFills,rayMarketEntries:this.rayMarketEntries,positionManagementVersion,
      unreadableLines,trades:[...unique.values()]};
  }
  validateConfig(config) {
    if (!config || typeof config !== 'object') throw new ControlError('参数不能为空');
    const merged={...this.config,...config};
    if(merged.riskPolicy!==undefined&&merged.riskPolicy!=='equity-per-order-v1')throw new ControlError('仓位规则版本无效');
    if((merged.riskPolicy==='equity-per-order-v1')!==(merged.maxExposure===null))throw new ControlError('单笔净值规则必须明确关闭固定总成本上限');
    for (const [key, value] of Object.entries(config)) {
      if(key==='riskPolicy'||key==='maxExposure'&&value===null)continue;
      const bound = bounds[key];
      if (!bound || !Number.isFinite(value) || value < bound[0] || value > bound[1] || key === 'buyUnits' && !Number.isInteger(value))
        throw new ControlError(`参数 ${key} 不在允许范围内`);
    }
  }
  referenceFresh(now) {
    return referenceStatus(this.referencePrice(),now).ready;
  }
  referencePrice() {
    const cached=this.frame?.twap;
    return this.latestTwap && (!cached || this.latestTwap.timestamp>=cached.timestamp)?this.latestTwap:cached;
  }
  snapshot() {
    const now = this.clock(), account = this.engine.snapshot();
    const orders = [...this.broker.orders.values()].map(o => ({ ...o, market: this.markets[o.tokenId] ?? null }));
    const holdings = Object.entries(account.holdings).map(([tokenId, size]) => {
      const book = this.frame?.books.find(b => b.tokenId === tokenId);
      const fresh = this.running && this.engine.fresh(book, now);
      const owner=this.ownedTrades().find(t=>t.tokenId===tokenId),queued=this.pendingSettlements.some(t=>t.tokenId===tokenId);
      return { tokenId, size, market: owner?{outcome:owner.outcome,slug:owner.slug,end:owner.market.end}:this.markets[tokenId] ?? null,
        tradeId:owner?.id??null,origin:owner?.origin??null,management:queued?'awaiting-resolution':owner?'managed':'unmanaged',
        cost:account.inventoryCost[tokenId]??null,
        bid: fresh ? book?.bids[0]?.[0] ?? null : null, valuationFresh: Boolean(fresh) };
    });
    const allValued = holdings.every(h => h.bid !== null);
    const inventoryValue = allValued ? round(holdings.reduce((sum, h) => sum + h.size * h.bid, 0)) : null;
    return structuredClone({ version: 1, now, sessionId: this.sessionId, realTrading: false,
      running: this.running, paused: this.paused, mode: this.mode, runIntent:this.runIntent,recoveryHold:this.recoveryHold,recoveryEvidence:this.recoveryEvidence,recoveryBaseline:this.recoveryBaseline,runtimeRecovery:this.runtimeRecovery,serviceRuntime:this.serviceRuntime,config: this.config, storageRecoveryAvailable: this.canRecoverStorage(),
      persistence:{cacheSnapshotWindowMs:this.observationPersistence.windowMs,mainWrites:this.observationPersistence.writes,coalescedObservationWrites:this.observationPersistence.coalesced,semantics:'Financial/control/entry-intent/deduplication changes and explicit saves flush immediately; only observation caches coalesce. Source and trade journals keep their own full recording.'},
      status: this.engine.halted ? 'halted' : !this.running ? 'stopped' : this.paused ? 'paused' : 'running',
      clock:this.runtimeClock?.status()??{ready:true,semantics:'injected-controller-clock'},
      sources: this.sources, frame: this.frame, referenceFresh: Boolean(this.referenceFresh(now)),
      reference:referenceStatus(this.referencePrice(),now),
      account, holdings, inventoryValue, equity: inventoryValue === null ? null : round(account.cash + inventoryValue),
      portfolio:this.accountMetrics.summary({account,nav:this.portfolioValuation(now),now}),
      orders, history: this.history, log: this.log.slice(-150),
      priceHistory: this.priceHistory, priceReference: this.priceReference,
      dataAudit:{version:auditVersion,segmentId:this.auditSegment,error:this.auditError,
        scope:'Current process summaries; durable per-frame and feed journals contain earlier segments.',
        latest:this.auditLatest,rounds:[...this.auditRounds.values()].slice(-12)},
      settlementResearch: this.settlement.summary(),
      strategy: { config:this.strategyConfig, decision:this.strategyDecision, managedPosition:this.strategyTrade,
        rayOwnedPositions:this.rayOwnedPositions,rayRoundFills:this.rayRoundFills,rayMarketEntries:this.rayMarketEntries,rayEntrySummary:this.rayEntrySummary(now),rayEntryTiming:this.rayEntryTrigger.summary(),
        evolution:this.strategyConfig.model==='ray-twap-band'?{status:'archived-after-explicit-ray-replacement',error:null,automaticAdoption:false,originalStatePreserved:Boolean(this.evolutionRecoveryState)}:this.evolutionCoordinator?.summary(now)??{error:this.evolutionError??null},
        positionManagementVersion,settlementQueue:this.settlementQueueSummary(now),
        researchP1:this.p1Error?{error:this.p1Error}:this.p1Study?.summary(),
        researchP2:this.p2Context.summary(now),
        terminalRisk:this.terminalObserver.summary(now),
        admissionResearch:this.admissionResearch?.summary(now)??null,
        orderflowResearch:this.orderflowSummary(now),
        researchP3:this.p3Error?{error:this.p3Error}:this.p3Study?.summary(),
        researchP3b:this.p3ConfirmationError?{error:this.p3ConfirmationError}:this.p3Confirmation?.summary(now),
        researchValue:this.valueResearchError?{error:this.valueResearchError}:this.valueResearch?.summary(),
        researchContinuation:this.continuationError?{error:this.continuationError}:this.continuationStudy?.summary(),
        researchAdaptive:this.adaptiveResearchError?{error:this.adaptiveResearchError}:this.adaptiveResearch?.summary(),
        researchAdaptiveAccount:this.strategyConfig.model==='ray-twap-band'?this.archivedAdaptiveAccount():this.adaptiveAccountError?{error:this.adaptiveAccountError}:
          {...this.adaptiveAccountStudy?.summary(now),clockState:this.adaptiveAccountClockState??null},
        observation:this.observationError?{error:this.observationError}:this.strategyObservation?.summary(),
        model:this.strategyConfig.model==='ray-twap-band'?'Ray · 晚段 TWAP 与 80/20 盘口':this.strategyConfig.model==='forward-momentum'?'盘口恢复动量 · 前瞻模拟':this.strategyConfig.model==='execution-edge'?'实际退出净收益预测':'同轮参考价回归 + TWAP 方向确认', calibrated:false,
        rayProtocol:this.strategyConfig.model==='ray-twap-band'?rayProtocol:null,
        forwardProtocol:this.strategyConfig.model==='forward-momentum'?forwardProtocol:null,
        marketExitProtocol:this.strategyConfig.exitPolicy==='market'?marketExitProtocol:null,
        modelValidation:this.strategyConfig.model==='execution-edge'&&this.edgeArtifact?.promotion?{
          eligible:this.edgeArtifact.promotion.eligible,reason:this.edgeArtifact.promotion.reason,
          validationNet:this.edgeArtifact.promotion.validation?.net,diagnosticNet:this.edgeArtifact.promotion.diagnostic?.net,
          diagnosticTrades:this.edgeArtifact.promotion.diagnostic?.completedTrades}:null,experiment:this.experiment },
      step: !this.running ? 'stopped' : this.engine.halted ? 'halted' : this.engine.active?.phase ??
        (this.hasUnmanagedHoldings() ? 'holding' : this.mode === 'observe' ? 'observing' : 'waiting') });
  }
  async acceptFrame(frame) {
    if (!this.running) return;
    const previous = this.frame?.market.slug;
    this.frame = frame;
    if (previous !== frame.market.slug) this.priceReference = null;
    if (frame.twap) this.acceptPrice(frame.twap);
    this.priceReference ??= openingReference(this.priceHistory, frame.market);
    for (const [outcome, tokenId] of Object.entries(frame.market.tokens))
      this.markets[tokenId] = { outcome, slug: frame.market.slug, end: frame.market.end };
    for (const book of frame.books) this.broker.setBook(book);
    if (previous !== frame.market.slug) this.event({ type: 'round', message: '已切换 BTC 5 分钟盘口', slug: frame.market.slug });
    const up = frame.books.find(b => b.tokenId === frame.market.tokens.Up);
    const down = frame.books.find(b => b.tokenId === frame.market.tokens.Down);
    const upValid=freshBook(up,frame.now,this.config.staleMs),downValid=freshBook(down,frame.now,this.config.staleMs);
    this.history.push({ time: frame.now, slug: frame.market.slug,
      up: upValid && up?.bids[0] && up?.asks[0] ? (up.bids[0][0] + up.asks[0][0]) / 2 : null,
      down: downValid && down?.bids[0] && down?.asks[0] ? (down.bids[0][0] + down.asks[0][0]) / 2 : null,
      upAsk:upValid?(up?.asks[0]?.[0]??null):null,downAsk:downValid?(down?.asks[0]?.[0]??null):null,
      upBookValid:upValid,downBookValid:downValid,
      twap: frame.twap?.valueE18 ?? null });
    this.history = trimHistory(this.history, frame.now);
    this.exitHistory.add(frame,this.clock());
    this.rayDynamicTwap.observe(frame.twap,this.clock());
    this.record('-frames',frame);
    this.settlement.acceptFrame(frame, this.priceHistory, this.clock(), this.mode === 'auto' && !this.paused, this.config.buyUnits,
      {researchEnabled:this.strategyConfig.model!=='ray-twap-band'});
    this.settleForwardPosition();
    this.strategyDecision=this.evaluate(this.clock());
    this.observeAdmissionResearch(this.strategyDecision);
    this.record('-decisions',this.strategyDecision);
    this.observeContext();
    this.observeOrderflow();
    try{this.terminalObserver.sample({frame:this.frame,now:this.clock(),owners:this.ownedTrades(),account:this.engine.snapshot()});}
    catch(error){this.terminalObserver.writeError=error.message;}
    const active=this.engine.active;
    const c=this.strategyDecision.candidates.find(c=>c.tokenId===active?.intent.tokenId);
    const invalidSignal=active?.intent.strategyManaged && (!c?.eligible ||
      active.phase==='maker' && c.targetBid-c.exitFeePerShare-active.intent.makerPrice-this.strategyConfig.costBuffer<this.strategyConfig.minNetEdge);
    const cancelBuy = active?.intent.side === 'buy' && (this.paused || !this.referenceFresh(this.clock()) || invalidSignal);
    await this.engine.tick(this.clock(), { stop: this.mode === 'observe' || cancelBuy });
    this.syncStrategyTrade();this.parkExpiredPosition();this.settleForwardPosition();
    this.observeOpportunity();
    this.observeEvolution();
    if (this.mode === 'auto' || this.strategyTrade?.origin==='manual-one-tap') await this.autoStep();
    this.syncStrategyTrade();
    this.observeStrategies();
  }
  observeContext() {
    if(this.p2Context.error)return;
    try{this.p2Context.sample({frame:this.frame,prices:this.priceHistory,reference:this.referencePrice(),now:this.strategyDecision?.time??this.clock(),
      sessionId:this.sessionId,experimentId:this.experiment?.id??null,trade:this.strategyTrade,decision:this.strategyDecision});}
    catch(e){this.p2Context.error=e.message;}
  }
  observeOrderflow(){
    if(!this.orderflowResearch||!this.frame)return;
    try{
      const f=this.frame,now=this.clock(),quality=this.runtimeClock?.status()??{ready:true,semantics:'injected-controller-clock'};
      this.orderflowResearch.sample({now,clockReady:quality.ready===true,clockQuality:{calibratedAt:quality.calibratedAt??null,
        uncertaintyMs:quality.uncertaintyMs??null,localWallOffsetMs:quality.localWallOffsetMs??null,semantics:quality.semantics},
        sessionId:this.sessionId,experimentId:this.experiment?.id??null,
        marketSlug:f.market.slug,baseline:{protocolVersion:rayProtocol.version,frameAt:f.now,clockReady:f.clock?.ready===true,
          opening:f.rayOpening,twap:f.twap,chainlinkSpot:this.terminalObserver.spotRows.at(-1)??null,
          decision:{time:this.strategyDecision?.time,reasonCode:this.strategyDecision?.reasonCode,
            selectedOutcome:this.strategyDecision?.selected?.outcome??null},
          books:f.books.map(b=>({tokenId:b.tokenId,timestamp:b.timestamp,receivedAt:b.receivedAt,
            requestStartedAt:b.requestStartedAt??null,bids:b.bids.slice(0,5),asks:b.asks.slice(0,5)}))}});
    }catch(error){this.orderflowError=error.message;}
  }
  orderflowSummary(now=this.clock()){
    try{return {...(this.orderflowResearch?.summary(now)??this.orderflowLastSummary??
      {mode:'shadow-only',status:'not-started',executionConnected:false,validatedAllocationChange:false}),lifecycleError:this.orderflowError};}
    catch(error){this.orderflowError=error.message;return {mode:'shadow-only',status:'unavailable',lifecycleError:this.orderflowError,executionConnected:false,validatedAllocationChange:false};}
  }
  configureAdmissionResearch(saved=null){
    this.admissionResearch=new AdmissionResearch({config:this.admissionResearchConfig,clock:this.clock,saved,
      context:()=>({sessionId:this.sessionId,experimentId:this.experiment?.id??null,segmentId:this.auditSegment})});
  }
  observeAdmissionResearch(decision=null){
    const research=this.admissionResearch;
    if(!research||research.stage===0||!this.running||!this.frame||this.strategyConfig.model!=='ray-twap-band')return;
    research.guard(()=>{
      const now=this.clock(),d=decision??this.evaluate(now),equity=this.raySizingEquity(now);
      const clockReady=this.frame.clock?.ready===true&&(!this.runtimeClock||this.runtimeClock.status().ready===true);
      research.observe({...this.frame,clock:{...this.frame.clock,ready:clockReady}},{now,reference:this.referencePrice(),
        opening:this.frame.rayOpening,calendar:d.calendarThreshold?.context??null,
        actual:{protocolVersion:rayProtocol.version,decisionAt:d.time??null,reasonCode:d.reasonCode??null,
          eligible:Boolean(d.selected?.eligible),thresholdUsd:d.calendarThreshold?.thresholdUsd??null},
        equity:equity.known?equity.value:null,cash:this.engine.cash,roundUsedShares:this.rayRoundUsed(this.frame.market.slug),maxShares:100,
        flow:this.orderflowResearch?.shadow?.latest??null});
      research.acceptLabels(this.financialLabels(),{now});
    });
  }
  async closeAdmissionResearch(){
    const research=this.admissionResearch;if(!research||research.closed)return;
    research.clearCurrent('workflow-stopped',this.clock());let timer;
    try{
      const finished=await Promise.race([research.close().then(()=>true),new Promise(resolve=>{
        timer=setTimeout(()=>resolve(false),5000);timer.unref?.();
      })]);
      if(!finished)research.error='影子记录器关闭超时；末尾完整性未核实';
    }catch(error){research.error=error.message;}finally{clearTimeout(timer);}
  }
  async closeOrderflow(){
    const admissionClose=this.closeAdmissionResearch();
    try{await this.closeOrderflowRecorder();}finally{await admissionClose;}
  }
  async closeOrderflowRecorder(){
    const research=this.orderflowResearch;if(!research)return;
    let timer;
    try{
      const finished=await Promise.race([research.close().then(()=>true),new Promise(resolve=>{
        timer=setTimeout(()=>resolve(false),5000);timer.unref?.();
      })]);
      if(!finished)this.orderflowError='记录器关闭超时；末尾完整性未核实';
    }catch(error){this.orderflowError=error.message;}
    finally{clearTimeout(timer);this.orderflowLastSummary=this.orderflowSummary(this.clock());this.orderflowResearch=null;}
  }
  archivedAdaptiveAccount() {
    if(!this.adaptiveAccountArchive){
      const path=join(this.directory,'p3-adaptive-account.json');
      let old;try{old=JSON.parse(readFileSync(path,'utf8'));}catch{}
      this.adaptiveAccountArchive={archived:true,status:'archived-after-explicit-ray-replacement',entriesEnabled:false,
        priorIntegrityError:this.adaptiveAccountError??null,sourceEvidencePreserved:true,
        createdAt:old?.createdAt??null,startedAt:old?.startedAt??null,archivedSourcePath:path,
        accounts:structuredClone(old?.accounts??[])};
    }
    return this.adaptiveAccountArchive;
  }
  configureEvolution(saved=null) {
    this.evolutionRecoveryState=saved?structuredClone(saved):null;
    if(this.strategyConfig.model==='ray-twap-band'){this.evolutionCoordinator=null;this.evolutionError=null;return;}
    try{this.evolutionCoordinator=new EvolutionCoordinator(this.directory,{createdAt:this.clock(),saved});}
    catch(error){this.evolutionError=error.message;}
  }
  bindExitPolicy(origin,now=this.clock()) {
    if(this.strategyConfig.exitPolicy!=='market')return null;
    return this.evolutionCoordinator?.binding(now,this.config,this.strategyConfig,origin)??{
      policy:'market',exitRevision:marketExitRevision,boundAt:now,origin,scope:'paper-only',reason:this.evolutionError??'原市场退出'};
  }
  commitEvolution(plan) {
    const e=this.evolutionCoordinator,previous=e.state.governance,previousEvaluation=e.state.lastEvaluation;
    e.state.governance=plan.governance;
    if(plan.evaluation)e.state.lastEvaluation={id:plan.evaluation.id,batchId:plan.evaluation.batchId,pass:plan.evaluation.pass,
      evaluatedAt:plan.evaluation.evaluatedAt,gates:plan.evaluation.gates,evidencePath:plan.evidencePath};
    try{this.save();}catch(error){e.state.governance=previous;
      if(previousEvaluation===undefined)delete e.state.lastEvaluation;else e.state.lastEvaluation=previousEvaluation;
      throw error;}
    this.event({type:'strategy_iteration_gate',message:'候选策略固定批次验证结果已保存；已有仓位保留原退出版本',
      effectivePolicy:e.state.governance.effectivePolicy,phase:e.state.governance.phase,evidencePath:plan.evidencePath??null,
      evaluation:plan.evaluation??null});
  }
  observeEvolution({stop=false,event=false}={}) {
    const e=this.evolutionCoordinator;if(!e||this.evolutionError||e.error)return;
    try {
      const compatible=compatibleEvolutionConfig(this.config,this.strategyConfig);
      if(!compatible&&e.state.governance.effectivePolicy==='consensus'){
        this.commitEvolution({governance:{...e.state.governance,effectivePolicy:'market',phase:'rolled-back',
          generation:(e.state.governance.generation??0)+1,lastDecision:{at:this.clock(),kind:'configuration-fallback',reason:'主配置与已验证协议不一致'}}});
      }
      const plans=e.observe({frame:stop||event?null:this.frame,eventOnly:stop||event,history:this.history,prices:this.priceHistory,config:this.config,strategy:this.strategyConfig,now:this.clock()},
        this.financialLabels(),{allowEntry:!stop&&compatible&&this.running&&this.mode==='auto'&&!this.paused&&!this.engine.halted});
      for(const plan of plans)this.commitEvolution(plan);
    }catch(error){
      if(error instanceof PersistenceError)throw error;
      e.error=error.message;this.evolutionError=error.message;
      if(e.state.governance.effectivePolicy==='consensus')this.commitEvolution({governance:{...e.state.governance,
        effectivePolicy:'market',phase:'rolled-back',generation:(e.state.governance.generation??0)+1,
        lastDecision:{at:this.clock(),kind:'integrity-fallback',reason:error.message}}});
    }
  }
  observeValue() {
    if(this.strategyConfig.model==='ray-twap-band')return;
    if(!this.valueResearchError&&this.valueResearch)try {
      this.valueResearch.observe({frame:this.frame,prices:this.priceHistory,now:this.clock(),
        amountUsd:this.config.buyUnits??1,holdings:Object.fromEntries(this.engine.holdings)},this.settlement.labels);
    }catch(e){this.valueResearchError=e.message;this.valueResearch.error=e.message;}
    if(!this.adaptiveResearchError&&this.adaptiveResearch)try {
      const now=this.clock(),sourceSamples=this.valueResearch?.state.samples??{};
      if(adaptiveWorkAvailable(this.adaptiveResearch.state,sourceSamples,this.settlement.labels,now))
        this.adaptiveResearch.observe({now,sourceSamples,
          sessionId:this.sessionId,experimentId:this.experiment?.id??null},this.settlement.labels);
    }catch(e){this.adaptiveResearchError=e.message;this.adaptiveResearch.error=e.message;}
    this.observeAdaptiveAccounts();
  }
  observeAdaptiveAccounts() {
    if(this.strategyConfig.model==='ray-twap-band'||this.adaptiveAccountError||!this.adaptiveAccountStudy)return;
    try {
      const now=this.clock();
      this.adaptiveAccountClockState=adaptiveAccountClockStatus(this.adaptiveAccountStudy,now);
      if(!this.adaptiveAccountClockState.ready)return;
      this.adaptiveAccountStudy.observe({now,frame:this.frame,
        sourceSamples:this.adaptiveResearch?.state.samples??{},sessionId:this.sessionId,experimentId:this.experiment?.id??null,
        allowEntry:this.running&&this.mode==='auto'&&!this.paused&&!this.engine.halted&&this.strategyConfig.execution==='paper'},
        this.settlement.labels);
    }catch(e){this.adaptiveAccountError=e.message;this.adaptiveAccountStudy.error=e.message;}
  }
  captureContinuation(exitSignal=false) {
    if(this.strategyConfig.model==='ray-twap-band')return;
    if(this.continuationError||!this.continuationStudy)return;
    try {
      const now=this.clock(),trade=this.strategyTrade,context=this.p2Context.latest;
      const available=context&&context.time<=now&&now-context.time<=3000&&context.slug===trade?.slug;
      this.continuationStudy.capture({frame:this.frame,now,trade,size:this.engine.holdings.get(trade?.tokenId)??0,
        busy:Boolean(this.engine.active),exitSignal,sessionId:this.sessionId,
        contextId:available?context.id:null,
        features:available?{contextAt:context.time,reference:context.reference,venues:context.venues,
          windows:context.windows,deviations:context.deviations,activityWindows:context.activityWindows}:null});
    }catch(e){this.continuationError=e.message;this.continuationStudy.error=e.message;}
  }
  observeContinuation() {
    if(this.strategyConfig.model==='ray-twap-band')return;
    if(this.continuationError||!this.continuationStudy)return;
    try {this.continuationStudy.observe({frame:this.frame,now:this.clock()},this.settlement.labels);}
    catch(e){this.continuationError=e.message;this.continuationStudy.error=e.message;}
  }
  observeStrategies() {
    if(this.strategyConfig.model==='ray-twap-band')return;
    this.observeValue();
    this.observeContinuation();
    this.captureContinuation();
    if(!this.p3ConfirmationError&&this.p3Confirmation)try {
      this.p3Confirmation.observe({frame:this.frame,history:this.history,prices:this.priceHistory,config:this.config,strategy:this.strategyConfig,now:this.clock()},this.settlement.labels,
        this.running&&this.mode==='auto'&&!this.paused&&!this.engine.halted&&this.strategyConfig.execution==='paper'&&this.strategyConfig.model==='forward-momentum');
    }catch(e){this.p3ConfirmationError=e.message;}
    if(!this.p3Error&&this.p3Study)try {
      this.p3Study.observe({frame:this.frame,history:this.history,prices:this.priceHistory,config:this.config,strategy:this.strategyConfig,now:this.clock()},this.settlement.labels,
        this.running&&this.mode==='auto'&&!this.paused&&!this.engine.halted&&this.strategyConfig.execution==='paper'&&this.strategyConfig.model==='forward-momentum');
    }catch(e){this.p3Error=e.message;}
    if(!this.p1Error&&this.p1Study)try {
      this.p1Study.observe({frame:this.frame,history:this.history,prices:this.priceHistory,
        config:this.config,strategy:this.strategyConfig,now:this.clock()},this.settlement.labels,
        this.running&&this.mode==='auto'&&!this.paused&&!this.engine.halted&&this.strategyConfig.execution==='paper'&&this.strategyConfig.model==='forward-momentum');
    }catch(e){this.p1Error=e.message;}
    if(this.observationError || !this.strategyObservation)return;
    try {
      if(this.strategyTrade)this.strategyObservation.addMain(this.strategyTrade,this.engine.holdings.get(this.strategyTrade.tokenId));
      this.strategyObservation.observe({frame:this.frame,history:this.history,prices:this.priceHistory,
        config:this.config,strategy:this.strategyConfig,now:this.clock()},this.settlement.labels,
        this.running && this.mode==='auto' && !this.paused && !this.engine.halted && this.strategyConfig.execution==='paper' && this.strategyConfig.model==='forward-momentum');
    } catch(e) {
      // Research persistence must never interrupt the main position's exit.
      this.observationError=e.message;
    }
  }
  recordAudit(suffix,row) {
    if(this.auditError)return;
    try {this.record(suffix,{...row,version:auditVersion,segmentId:this.auditSegment,sessionId:this.sessionId});}
    catch(error){this.auditError=error.message;}
  }
  observeOpportunity() {
    if(this.auditError)return;
    try {
      const row=opportunitySnapshot({frame:this.frame,decision:this.strategyDecision,history:this.history,prices:this.priceHistory,
        reference:this.referencePrice(),config:this.config,strategy:this.strategyConfig,now:this.strategyDecision?.time??this.clock(),
        account:this.engine.snapshot(),trade:this.strategyTrade,pendingSettlements:this.pendingSettlements,
        funded:this.engine.externalFunds>0,positionManagementVersion,attempted:this.attempted.has(this.frame?.market.slug),
        running:this.running,paused:this.paused,mode:this.mode,busy:this.engine.busy,sessionId:this.sessionId,experimentId:this.experiment?.id});
      if(!row)return;
      this.auditLatest=row;
      const prior=this.auditRounds.get(row.slug);
      if(prior&&row.frameAt<=prior.lastFrameAt)return;
      this.recordAudit('-p0-opportunities',row);
      this.auditRounds.set(row.slug,summarizeOpportunity(prior,row));
      if(this.auditRounds.size>288)this.auditRounds.delete(this.auditRounds.keys().next().value);
    }catch(error){this.auditError=error.message;}
  }
  evaluate(now=this.clock(),size=this.config.size) {
    if(this.runtimeClock && !this.runtimeClock.status().ready)return {
      version:forwardProtocol.version,time:now,execution:'paper',candidates:[],selected:null,
      reason:'UTC 时间尚未通过独立校验，等待校时后继续判断行情',clockUnavailable:true};
    const input={frame:this.frame?{...this.frame,twap:this.referencePrice()}:null,history:this.history,prices:this.priceHistory,config:{...this.config,size},strategy:this.strategyConfig,now};
    if(this.strategyConfig.model==='ray-twap-band'){
      const decision=evaluateRay({...input,equity:this.raySizingEquity(now).value,roundUsedShares:this.rayRoundUsed(this.frame?.market?.slug)});
      const opening=this.frame?.rayOpening,value=e18ToPrice(input.frame?.twap?.valueE18);
      decision.dynamicTwap=this.rayDynamicTwap.summary({now,remainingSeconds:this.frame?(this.frame.market.end-now)/1000:null,
        baseThreshold:rayProtocol.thresholds[raySession(now)],deviationUsd:value&&validRayOpening(opening,this.frame.market,now)?value-opening.value:null});
      decision.dynamicTwap.baseThresholdBasis='original-time-band-without-calendar-stacking';
      if(this.rayMarketEntered(this.frame?.market?.slug)){
        decision.selected=null;decision.reasonCode='round_already_entered';
        decision.reason='本盘口已有买入成交；同一盘口只开一次仓，部分成交也不再补单或反向开仓';
        for(const candidate of decision.candidates){candidate.eligible=false;candidate.reason=decision.reason;}
      }
      return decision;
    }
    if(this.strategyConfig.model==='forward-momentum')return evaluateForward(input);
    const decision=this.strategyConfig.model==='execution-edge'?evaluateExecutionEdge(input,this.edgeArtifact):evaluateStrategy(input);
    if(!this.config.buyUnits || !this.frame) return decision;
    for(const c of decision.candidates) {
      const book=this.frame.books.find(b=>b.tokenId===c.tokenId);
      let q; try {q=amountQuote(book,this.frame.market,this.config.buyUnits);} catch(error) {c.eligible=false;c.reason=error.message;continue;}
      c.executionVersion=amountExecutionVersion;c.amountUsd=this.config.buyUnits;c.orderSize=q.size;c.mode='taker';c.limit=q.limit;c.makerPrice=q.best;
      if(decision.version==='execution-edge-v2') {c.eligible=false;c.reason='按金额下单已启用；原固定份额收益模型尚未验证此成交口径';continue;}
      const sized=evaluateStrategy({...input,config:{...input.config,size:q.filled}}).candidates.find(x=>x.tokenId===c.tokenId);
      c.takerEdge=sized?.takerEdge??null;
      c.eligible=Boolean(q.allowed && q.complete && sized?.eligible && c.takerEdge>=this.strategyConfig.minNetEdge);
      c.reason=!q.allowed?q.reason:!q.complete?'价格保护范围内深度不足，策略本轮不入场':c.eligible?'按金额单次市价买入，成本后余量满足条件':'按金额吃单的成本后余量不足';
    }
    decision.selected=decision.candidates.filter(c=>c.eligible).sort((a,b)=>b.takerEdge-a.takerEdge)[0]??null;
    decision.reason=decision.selected?`单次金额买入：${decision.selected.outcome} $${this.config.buyUnits}`:decision.candidates[0]?.reason??decision.reason;
    return decision;
  }
  ownedTrades() { return [this.strategyTrade,...this.rayOwnedPositions,...this.pendingSettlements].filter(Boolean); }
  rayRoundUsed(slug) {return round(Object.values(this.rayRoundFills[slug]??{}).reduce((s,r)=>s+r.filled,0));}
  rayMarketEntered(slug) {
    return Boolean(slug&&(this.rayMarketEntries?.[slug]||this.rayRoundUsed(slug)>0||
      [...this.broker.orders.values()].some(o=>o.side==='buy'&&o.filled>0&&this.markets[o.tokenId]?.slug===slug)));
  }
  recordRayMarketEntry(report,market,{source,protocolVersion=null}={}) {
    const slug=market?.slug;
    if(report?.side!=='buy'||!(report.filled>0)||!/^btc-updown-5m-\d+$/.test(slug??'')||this.rayMarketEntries[slug])return;
    this.rayMarketEntries[slug]={version:'btc5m-market-entry-v1',slug,sessionId:this.sessionId,orderId:report.id,
      tokenId:report.tokenId,filled:report.filled,recordedAt:this.clock(),source,protocolVersion};
  }
  restoreRayMarketEntries() {
    if(!this.rayMarketEntries||typeof this.rayMarketEntries!=='object'||Array.isArray(this.rayMarketEntries))
      throw Error('Invalid market entry ledger');
    for(const [slug,row] of Object.entries(this.rayMarketEntries)){
      if(!/^btc-updown-5m-\d+$/.test(slug)||row?.version!=='btc5m-market-entry-v1'||row.slug!==slug||
        typeof row.sessionId!=='string'||!row.sessionId||typeof row.orderId!=='string'||!row.orderId||
        typeof row.tokenId!=='string'||!row.tokenId||!Number.isFinite(row.filled)||row.filled<=0||
        !Number.isFinite(row.recordedAt)||!['reconciled-order-report','restored-order-report'].includes(row.source)||
        !(row.protocolVersion===null||typeof row.protocolVersion==='string'))throw Error('Invalid market entry evidence');
      // A new paper session retains the previous session's consumed markets.
      // Its orders remain in that session's immutable journal, not this broker.
      if(row.sessionId===this.sessionId){
        const order=this.broker.orders.get(row.orderId);
        if(!order||order.side!=='buy'||order.tokenId!==row.tokenId||order.filled<row.filled||
          this.markets[row.tokenId]?.slug!==slug)throw Error('Market entry ledger does not match reconciled orders');
      }
    }
    // Migration includes all historical positive buy reports in the current
    // session, including manual buys and protocols used before this policy.
    // recordedAt is when this evidence was registered, never a fill timestamp.
    for(const order of this.broker.orders.values())if(order.side==='buy'&&order.filled>0){
      const market=this.markets[order.tokenId];
      if(!market?.slug)throw Error('Filled buy order is missing its market identity');
      this.recordRayMarketEntry(order,market,{source:'restored-order-report'});
    }
  }
  validateRayRoundFills() {
    if(!this.rayRoundFills||Array.isArray(this.rayRoundFills)||typeof this.rayRoundFills!=='object')throw Error('Invalid Ray round fill ledger');
    for(const [slug,reports] of Object.entries(this.rayRoundFills)){
      if(!/^btc-updown-5m-\d+$/.test(slug)||!reports||typeof reports!=='object'||Array.isArray(reports))throw Error('Invalid Ray round fill identity');
      for(const [id,row] of Object.entries(reports)){
        const order=this.broker.orders.get(id);
        if(!row||!Number.isFinite(row.filled)||row.filled<0||!order||order.side!=='buy'||order.tokenId!==row.tokenId||
          order.filled!==row.filled||this.markets[row.tokenId]?.slug!==slug)throw Error('Ray round fills do not match reconciled orders');
      }
      if(this.rayRoundUsed(slug)>100+1e-8)throw Error('Ray round share limit exceeded');
    }
    for(const trade of [...this.ownedTrades(),...this.exportStrategyTrades().trades].filter(t=>
      ['ray-twap-band-equity-v2','ray-twap-band-onetap-v3','ray-twap-calendar-onetap-v4','ray-twap-calendar-onetap-v5','ray-twap-calendar-onetap-v6','ray-twap-calendar-onetap-v7',rayProtocol.version].includes(t.entryDecision?.version??t.version))){
      if(!Array.isArray(trade.entryLots))throw Error('Ray entry lot evidence missing');
      for(const report of Object.values(trade.orderReports??{}).filter(r=>r.side==='buy'))
        if(this.rayRoundFills[trade.slug]?.[report.id]?.filled!==report.filled)throw Error('Ray owned fills missing from round ledger');
    }
  }
  raySizingEquity(now=this.clock()) {
    const positions=[],unknown=reason=>({known:false,value:null,basis:'fresh-current-book-mid',reason,positions});
    if(!Number.isFinite(this.engine.cash)||this.engine.cash<0)return unknown('可用现金未核实');
    const inventory=this.managedInventory();
    if(inventory.unmanagedCount||inventory.unknownCost||inventory.conflictingTokens.length)return unknown('持仓所有权或成本未核实');
    let value=this.engine.cash;
    for(const [tokenId,size] of this.engine.holdings){
      const owner=this.ownedTrades().find(t=>t.tokenId===tokenId),market=owner?.market,current=this.frame?.market;
      if(!Number.isFinite(size)||size<=0||!market||now>=market.end)return unknown('过期待结算持仓缺少当前可核实估值');
      if(!current||current.slug!==market.slug||current.conditionId!==market.conditionId||current.start!==market.start||current.end!==market.end||
        ['Up','Down'].some(o=>current.tokens?.[o]!==market.tokens?.[o]))return unknown('持仓缺少匹配的当前盘口');
      const book=this.frame.books.find(b=>b.tokenId===tokenId),bid=book?.bids?.[0]?.[0],ask=book?.asks?.[0]?.[0];
      if(!freshBook(book,now,this.config.staleMs)||![bid,ask].every(p=>Number.isFinite(p)&&p>0&&p<1)||ask<=bid)
        return unknown('持仓缺少双侧新鲜报价，净值待核实');
      const mid=(bid+ask)/2;positions.push({tokenId,size,mid,bookAt:book.timestamp,receivedAt:book.receivedAt,value:round(size*mid)});value+=size*mid;
    }
    return Number.isFinite(value)?{known:true,value:round(value),basis:'fresh-current-book-mid',reason:'现金加全部持仓的当前新鲜中间价估值',positions}:unknown('净值数值无效');
  }
  rayEntrySummary(now=this.clock()) {
    const equity=this.raySizingEquity(now),used=this.rayRoundUsed(this.frame?.market?.slug);
    const filledEntries=Object.values(this.rayRoundFills).flatMap(r=>Object.values(r)).filter(r=>r.filled>0&&r.experimentId===this.experiment?.id).length;
    return {version:rayProtocol.version,round:this.frame?.market?.slug??null,roundUsedShares:used,
      roundRemainingShares:Math.max(0,rayProtocol.maximumSharesPerRound-used),maximumSharesPerRound:rayProtocol.maximumSharesPerRound,
      entryPolicy:rayProtocol.entryPolicy,maxEntriesPerRound:rayProtocol.maximumEntriesPerRound,
      roundEntryConsumed:this.rayMarketEntered(this.frame?.market?.slug),
      filledEntries,ownedPositions:this.rayOwnedPositions.length,equity:equity.value,equityKnown:equity.known,equityReason:equity.reason,equityBasis:equity.basis,
      allocation:rayStrengthAllocation()};
  }
  financialLabels() { return this.settlement.financialLabels??this.settlement.labels; }
  managedInventory() {return managedInventory({trade:this.strategyTrade,activeTrades:this.rayOwnedPositions,pendingSettlements:this.pendingSettlements,
    holdings:this.engine.holdings,inventoryCost:this.engine.inventoryCost,now:this.clock()});}
  hasUnmanagedHoldings() {return this.managedInventory().entryBlocked;}
  parkExpiredPosition() {
    let parked=false;
    for(const trade of [this.strategyTrade,...this.rayOwnedPositions].filter(Boolean))parked=this.parkOwnedPosition(trade)||parked;
    return parked;
  }
  parkOwnedPosition(trade) {
    const now=this.clock();
    if(!trade||!trade.market||now<trade.market.end||trade.openedAt===null||this.engine.halted||this.engine.busy||
      this.engine.active?.intent.tokenId===trade.tokenId||!(this.engine.holdings.get(trade.tokenId)>0))return false;
    const flow=managedCashflows(trade);
    if(!flow||Math.abs(flow.remaining-(this.engine.holdings.get(trade.tokenId)??0))>1e-7||
      !this.managedInventory().activeTokens.includes(trade.tokenId))return false;
    trade.parkedAt=now;trade.queueRevision=positionManagementVersion;
    delete trade.reversalObservation;delete trade.marketReversal;
    trade.holdingDecision={time:now,revision:trade.parameters?.exitRevision,status:'awaiting-resolution',
      reason:'到期库存移入待结算队列；未核实资金继续占用，全账户预算通过后可交易新盘口',
      heldMs:now-trade.openedAt,remainingMs:trade.market.end-now,holdLimitMs:null};
    this.pendingSettlements.push(trade);
    if(this.strategyTrade?.id===trade.id)this.strategyTrade=null;
    this.rayOwnedPositions=this.rayOwnedPositions.filter(t=>t.id!==trade.id);
    this.event({type:'position_queued',message:trade.holdingDecision.reason,tradeId:trade.id,slug:trade.slug,
      positionManagementVersion,size:this.engine.holdings.get(trade.tokenId),cost:this.engine.inventoryCost.get(trade.tokenId)});
    return true;
  }
  settlementQueueSummary(now=this.clock()) {
    const positions=this.pendingSettlements.map(t=>{const task=this.feed?.resolutionQueue?.get(t.slug);return {id:t.id,slug:t.slug,outcome:t.outcome,origin:t.origin??'automatic',
      tokenId:t.tokenId,market:t.market,openedAt:t.openedAt,parkedAt:t.parkedAt,
      size:this.engine.holdings.get(t.tokenId)??0,cost:this.engine.inventoryCost.get(t.tokenId)??null,
      waitMs:Math.max(0,now-t.market.end),queueRevision:t.queueRevision,
      lastCheckedAt:task?.checkedAt||null,nextCheckNotBefore:task?.checkedAt?task.checkedAt+60000:null,
      queryReason:task?.lastCheckReason??null,lastResult:task?.lastResult??null,lastError:task?.lastError??null};});
    return {version:positionManagementVersion,count:positions.length,positions,
      cost:positions.every(p=>Number.isFinite(p.cost))?round(positions.reduce((s,p)=>s+p.cost,0)):null,
      maximumPayout:round(positions.reduce((s,p)=>s+p.size,0)),
      longestWaitMs:Math.max(0,...positions.map(p=>p.waitMs)),cash:this.engine.cash,
      activePosition:Boolean(this.strategyTrade||this.rayOwnedPositions.length),unknownHoldings:this.managedInventory().unmanagedCount,
      scope:'Expired owned inventory remains locked until verified paper payout; only available cash may fund new entries.'};
  }
  acceptPrice(price) {
    if (!this.running || !price || e18ToPrice(price.valueE18) === null || !Number.isFinite(price.timestamp) ||
        !Number.isFinite(price.receivedAt) || price.receivedAt>this.clock() ||
        price.timestamp > this.clock() || price.timestamp < this.clock() - 600_000) return;
    if(!this.latestTwap || price.timestamp>this.latestTwap.timestamp)this.latestTwap=structuredClone(price);
    if(this.strategyConfig.model==='ray-twap-band')this.admissionResearch?.observeReference(price,{now:this.clock(),
      clockReady:!this.runtimeClock||this.runtimeClock.status().ready===true});
    if (this.priceHistory.some(row => row.time === price.timestamp)) return;
    const row = { time: price.timestamp, valueE18: price.valueE18, receivedAt: price.receivedAt,
      publishedAt:price.publishedAt??null,windowSeconds:price.windowSeconds??null };
    this.priceHistory = trimHistory([...this.priceHistory, row], this.clock());
    this.priceReference ??= openingReference(this.priceHistory, this.frame?.market);
    this.record('-prices',row);
  }
  async autoStep(triggerSource='frame') {
    if(!this.running||!this.frame)return;
    this.syncStrategyTrade();
    this.parkExpiredPosition();
    if(this.runtimeClock && !this.runtimeClock.status().ready){
      resetManagedConfirmation(this.strategyTrade);return;
    }
    const now=this.clock(), {market,books}=this.frame;
    for(const position of this.rayOwnedPositions)position.holdingDecision={time:now,status:'hold-to-official-settlement',reason:'Ray 持有至已核实官方结算，不以换轮方向代替兑付'};
    const trade=this.strategyTrade;
    if(this.strategyConfig.execution!=='paper' && trade?.origin!=='manual-one-tap' || this.engine.halted || this.engine.active) return;
    if(trade) {
      const held=this.engine.holdings.get(trade.tokenId)??0;
      if(!held) {this.strategyTrade=null;return;}
      if(trade.parameters?.exitRevision===rayProtocol.exitRevision){trade.holdingDecision={time:now,status:'hold-to-official-settlement',reason:'Ray 持有至已核实官方结算，不以换轮方向代替兑付'};return;}
      if(trade.openedAt===null) {
        trade.openedAt=now;
        trade.costPerShare=managedCashflows(trade)?.costPerShare??Math.max(0,(trade.baseCash-this.engine.cash)/held);
      }
      if(trade.slug!==market.slug) {
        if(isManagedExitRevision(trade.parameters?.exitRevision))runManagedExit({trade,held,book:null,market:trade.market,now,config:this.config,history:this.history,prices:this.priceHistory,bidHistory:this.exitHistory.rows});
        return;
      }
      const book=books.find(b=>b.tokenId===trade.tokenId);
      const candidate=this.strategyDecision?.candidates.find(c=>c.tokenId===trade.tokenId);
      const forward=trade.entryDecision?.version===forwardProtocol.version;
      const marketManaged=isManagedExitRevision(trade.parameters?.exitRevision);
      if(trade.parameters?.evolutionBinding&&!marketManaged)throw Error('策略仓位的绑定退出版本不在登记范围内');
      const exit=marketManaged?runManagedExit({trade,held,book,market,now,config:this.config,history:this.history,prices:this.priceHistory,bidHistory:this.exitHistory.rows}):forward?forwardExit(trade,held,book,market,now,this.config,this.strategyConfig,this.history):
        exitDecision(trade,held,book,market,now,this.config,this.strategyConfig,candidate);
      if((forward||marketManaged) && trade.holdingDecision)this.record('-holding-decisions',{
        tradeId:trade.id,experimentId:trade.experimentId,slug:trade.slug,outcome:trade.outcome,
        exitRevision:trade.parameters?.exitRevision??'immediate-reversal-v1',...trade.holdingDecision});
      if(exit) {
        if((forward||marketManaged) && (now<(trade.nextExitAt??0) || book.timestamp<=(trade.lastExitBookTimestamp??-1)))return;
        this.captureContinuation(true);
        trade.exitReason=exit.reason;
        if(forward||marketManaged){trade.nextExitAt=now+forwardProtocol.exitRetryMs;trade.lastExitBookTimestamp=book.timestamp;}
        this.event({type:'strategy_exit',message:exit.reason,netAtVisibleDepth:exit.net});
        const beforeSubmit=preSubmitState(this);
        try {
          await this.place({outcome:trade.outcome,side:'sell',size:held,mode:'taker',
            makerPrice:book.asks[0]?.[0]??exit.limit,limit:exit.limit,
            makerMs:this.config.exitMakerMs,strategyManaged:true},'auto');
        } catch(error) {
          // Only the typed check before intent allocation/submission may defer.
          // Unknown submission, storage and ownership failures keep their halt path.
          if(!(error instanceof MarketDataStaleError)||!error.preSubmit||error.evidence.source!=='auto'||
            this.engine.active||this.engine.busy||this.engine.halted||beforeSubmit!==preSubmitState(this))throw error;
          const deferredDecision=trade.holdingDecision;
          resetManagedConfirmation(trade);
          delete trade.nextExitAt;delete trade.lastExitBookTimestamp;delete trade.exitReason;
          trade.holdingDecision={...deferredDecision,time:this.clock(),status:'execution-deferred',
            reason:'盘口在提交前过期，本次未提交；等待新行情重新确认'};
          this.event({type:'strategy_execution_deferred',tradeId:trade.id,slug:trade.slug,outcome:trade.outcome,
            reasonCode:error.code,message:trade.holdingDecision.reason,preSubmit:true,submissionStateUnchanged:true,
            evidence:error.evidence});
        }
      }
      return;
    }
    if(this.strategyConfig.model==='ray-twap-band'){await this.autoRayEntry(now,triggerSource);return;}
    const candidate=this.strategyDecision?.selected;
    const ray=false;
    if(this.mode!=='auto' || this.paused || !candidate || this.attempted.has(market.slug) || this.hasUnmanagedHoldings()) return;
    this.attempted.add(market.slug);
    const binding=ray?null:this.bindExitPolicy('automatic',now);
    this.strategyTrade={tokenId:candidate.tokenId,outcome:candidate.outcome,slug:market.slug,
      p2EntryContextId:this.p2Context.link(now,market.slug),
      id:randomUUID(),experimentId:this.experiment?.id??null,baseFees:this.engine.fees,
      baseCash:this.engine.cash,openedAt:null,costPerShare:null,initialDepth:candidate.bidDepth,
      entryDecision:structuredClone(candidate),market:structuredClone(market),amountUsd:candidate.amountUsd??null,
      parameters:{config:structuredClone(this.config),strategy:structuredClone(this.strategyConfig),executionVersion:amountExecutionVersion,feedRevision:forwardProtocol.executionRevision,positionManagementVersion,exitRevision:ray?rayProtocol.exitRevision:binding?.exitRevision??forwardProtocol.exitRevision,...(binding?{evolutionBinding:binding}:{})},signalAt:now};
    try {
      await this.place({outcome:candidate.outcome,side:'buy',size:candidate.orderSize??this.config.size,units:candidate.amountUsd,marketSlug:market.slug,mode:candidate.amountUsd?'amount':candidate.mode,
        ...(ray?{entryPolicy:'ray-last-120s-v1'}:{}),makerPrice:candidate.makerPrice,limit:candidate.limit,makerMs:this.config.makerMs,strategyManaged:true},'auto');
      this.event({type:'strategy_entry',message:candidate.reason,outcome:candidate.outcome,
        makerEdge:candidate.makerEdge,takerEdge:candidate.takerEdge});
      if(ray&&!this.strategyTrade?.openedAt&&!this.engine.holdings.has(candidate.tokenId))this.attempted.delete(market.slug);
    } catch(error) {
      if(!this.engine.active && !this.engine.holdings.has(candidate.tokenId)) this.strategyTrade=null;
      if(ray&&!this.engine.active&&!this.engine.holdings.has(candidate.tokenId))this.attempted.delete(market.slug);
      this.event({type:'skip',message:'策略开仓未执行：'+error.message});
    }
  }
  async autoRayEntry(now,triggerSource='frame') {
    if(!this.running||!this.frame)return;
    if(this.mode!=='auto'||this.paused||this.engine.active||this.engine.busy||this.engine.halted||this.strategyTrade)return;
    // A retained owner belongs to its original experiment. New protocol/profile
    // experiments may manage it to settlement, but must never add new lots to it.
    if(this.rayOwnedPositions.some(t=>t.experimentId!==this.experiment?.id||t.entryDecision?.version!==rayProtocol.version))return;
    const inventory=this.managedInventory();
    if(inventory.unmanagedCount||inventory.unknownCost||inventory.conflictingTokens.length)return;
    const decision=this.evaluate(now),candidate=decision.selected,market=this.frame.market;
    this.strategyDecision=decision;
    if(!candidate)return;
    const entryTiming=this.rayEntryTrigger.plan({frame:this.frame,reference:this.referencePrice(),candidate,now,triggerSource});
    if(!entryTiming?.allowed)return;
    const existing=this.ownedTrades().find(t=>t.tokenId===candidate.tokenId);
    if(existing&&!this.rayOwnedPositions.includes(existing))return;
    const trade=existing??{tokenId:candidate.tokenId,outcome:candidate.outcome,slug:market.slug,id:randomUUID(),
      experimentId:this.experiment?.id??null,p2EntryContextId:this.p2Context.link(now,market.slug),
      baseFees:this.engine.fees,baseCash:this.engine.cash,openedAt:null,costPerShare:null,initialDepth:candidate.bidDepth,
      entryDecision:structuredClone(candidate),market:structuredClone(market),amountUsd:null,signalAt:now,entryLots:[],
      parameters:{config:structuredClone(this.config),strategy:structuredClone(this.strategyConfig),rayProtocolVersion:rayProtocol.version,
        entryPolicy:rayProtocol.entryPolicy,entryTimingVersion,executionVersion:oneTapExecutionVersion,feedRevision:forwardProtocol.executionRevision,positionManagementVersion,exitRevision:rayProtocol.exitRevision}};
    if(!existing)this.rayOwnedPositions.push(trade);
    const lot={id:randomUUID(),signalAt:now,decision:structuredClone(candidate),sizing:structuredClone(candidate.sizing??decision.sizing),
      requestedShares:candidate.orderSize,requestedAmountUsd:candidate.amountUsd,maxSpend:candidate.maxSpend,
      executionVersion:oneTapExecutionVersion,intentId:null,orderReports:{},filled:0,cost:0,status:'unsubmitted'};
    trade.entryLots.push(lot);
    lot.entryTiming=structuredClone(entryTiming);
    this.rayEntryTrigger.remember(entryTiming);
    this.event({type:'ray_entry_admission',tradeId:trade.id,entryLotId:lot.id,entryTiming,message:'完整准入条件按新行情事件通过，保留原FAK与每盘口一次规则'});
    try{
      await this.place({outcome:candidate.outcome,side:'buy',size:candidate.orderSize,amountUsd:candidate.amountUsd,maxSpend:candidate.maxSpend,
        marketSlug:market.slug,mode:'taker',entryPolicy:'ray-onetap-last-120s-v1',rayEntryLotId:lot.id,
        calendarThreshold:structuredClone(candidate.calendarThreshold),makerPrice:candidate.makerPrice,limit:candidate.limit,
        makerMs:this.config.makerMs,strategyManaged:true},'auto');
      this.event({type:'strategy_entry',tradeId:trade.id,entryLotId:lot.id,message:candidate.reason,outcome:candidate.outcome,
        sizing:lot.sizing,entryLot:structuredClone(lot),filled:lot.filled,roundUsedShares:this.rayRoundUsed(market.slug)});
    }catch(error){
      lot.error=error.message;lot.status=this.engine.active?'submission-uncertain':'not-filled';
      this.event({type:'skip',tradeId:trade.id,entryLotId:lot.id,message:'策略开仓未执行：'+error.message,sizing:lot.sizing,entryLot:structuredClone(lot)});
    }
    // No-fill attempts stay in the immutable event journal. A live or uncertain
    // order must retain its owner until its final report has been reconciled.
    this.syncManagedTrade(trade);
  }
  syncStrategyTrade() {
    for(const trade of this.ownedTrades())this.syncManagedTrade(trade);
  }
  syncManagedTrade(trade) {
    if(!trade || this.engine.active?.intent.tokenId===trade.tokenId) return;
    const held=this.engine.holdings.get(trade.tokenId)??0;
    if(!held) {
      if(trade.openedAt!==null) {
        const flow=managedCashflows(trade);
        if(flow&&flow.remaining>1e-7){this.engine.halt('仓位余量与实际库存不一致，不能记作已平仓');
          throw Error('Owned inventory disappeared without sale or verified settlement');}
        if(!flow&&(this.pendingSettlements.length||trade.parameters?.positionManagementVersion===positionManagementVersion))
          throw Error('Managed position accounting is incomplete; preserve owned inventory');
        const result={id:trade.id??randomUUID(),experimentId:trade.experimentId??null,slug:trade.slug,outcome:trade.outcome,
          openedAt:trade.openedAt,closedAt:this.clock(),net:flow?.net??round(this.engine.cash-trade.baseCash),
          fees:flow?.fees??(Number.isFinite(trade.baseFees)?round(this.engine.fees-trade.baseFees):null),
          entryDecision:trade.entryDecision??null,version:trade.entryDecision?.version??null,origin:trade.origin??'automatic',
          p2EntryContextId:trade.p2EntryContextId??null,p2CloseContextId:this.p2Context.link(this.clock(),trade.slug),
          amountUsd:trade.amountUsd??null,maxSpend:trade.maxSpend??null,riskBudget:trade.riskBudget??null,
          parameters:trade.parameters??null,signalAt:trade.signalAt??null,
          exitReason:trade.exitReason??'持仓已清空',closeMethod:trade.settlement?'verified-paper-settlement':'book-sale',
          settlement:trade.settlement??null,orderReports:flow?.orderReports??Object.values(trade.orderReports??{}),
          entryLots:trade.entryLots??null,filledEntries:trade.entryLots?.filter(l=>l.filled>0).length??null,
          market:trade.market??null,timing:tradeTiming(trade,this.clock()),auditVersion,
          holdingDecision:trade.holdingDecision??null,
          maxFavorableNet:trade.maxFavorableNet??null,maxAdverseNet:trade.maxAdverseNet??null,
          positionManagementVersion:trade.parameters?.positionManagementVersion??null,queueRevision:trade.queueRevision??null,
          accountingRevision:flow?'managed-order-cashflows-v1':'legacy-single-position-cash'};
        const buys=result.orderReports.filter(o=>o.side==='buy'),sells=result.orderReports.filter(o=>o.side==='sell');
        result.bought=flow?.bought??round(buys.reduce((s,o)=>s+o.filled,0));result.sold=flow?.sold??round(sells.reduce((s,o)=>s+o.filled,0));
        result.entryAverage=result.bought?buys.reduce((s,o)=>s+o.notional,0)/result.bought:null;
        result.exitAverage=result.sold?sells.reduce((s,o)=>s+o.notional,0)/result.sold:null;
        this.record('-trades',result);
        if(!this.p1Error&&this.p1Study)try{this.p1Study.addClose(result);}catch(e){this.p1Error=e.message;}
        this.event({type:'strategy_closed',message:'策略仓位已平仓',...result});
        if(this.experiment && result.experimentId===this.experiment.id) {
          this.experiment.completedTrades++;this.experiment.winningTrades+=Number(result.net>0);
          this.experiment.net=round(this.experiment.net+result.net);
          this.experiment.fees=round(this.experiment.fees+(result.fees??0));
          this.experiment.lastTrade=result;
          this.experiment.recentTrades=[...(this.experiment.recentTrades??[]),result].slice(-100);
          this.experiment.peakNet=Math.max(this.experiment.peakNet??0,this.experiment.net);
          this.experiment.maxDrawdown=Math.max(this.experiment.maxDrawdown??0,this.experiment.peakNet-this.experiment.net);
          this.experiment.reviewReady=this.experiment.completedTrades>=forwardProtocol.reviewEveryTrades;
          if(result.version===forwardProtocol.version && this.experiment.completedTrades%forwardProtocol.reviewEveryTrades===0) {
            const review={id:`${this.experiment.id}:${this.experiment.completedTrades}`,time:this.clock(),version:result.version,
              experimentId:this.experiment.id,throughTrade:this.experiment.completedTrades,
              ...summarizeForwardBatch(this.experiment.recentTrades.slice(-forwardProtocol.reviewEveryTrades))};
            this.experiment.latestReview=review;this.record('-reviews',review);
            this.event({type:'experiment_review',message:'已完成 20 笔自动模拟交易统计复盘，参数保持固定',review});
          }
        }
      }
      if(this.strategyTrade?.id===trade.id)this.strategyTrade=null;
      this.rayOwnedPositions=this.rayOwnedPositions.filter(t=>t.id!==trade.id);
      this.pendingSettlements=this.pendingSettlements.filter(t=>t.id!==trade.id);return;
    }
    if(trade.openedAt===null) {
      trade.openedAt=this.clock(); trade.costPerShare=managedCashflows(trade)?.costPerShare??Math.max(0,(trade.baseCash-this.engine.cash)/held);
    }
    if(trade.entryLots?.length){const flow=managedCashflows(trade);if(flow)trade.costPerShare=flow.costPerShare;}
  }
  settleForwardPosition() {
    let credited=false;
    for(const trade of this.ownedTrades())credited=this.settleManagedPosition(trade)||credited;
    return credited;
  }
  settleManagedPosition(trade) {
    if(!trade || (trade.entryDecision?.version!==forwardProtocol.version && trade.parameters?.exitRevision!==rayProtocol.exitRevision && !isManagedExitRevision(trade.parameters?.exitRevision)) ||
      this.engine.active?.intent.tokenId===trade.tokenId || this.engine.halted)return false;
    const label=this.financialLabels().get(trade.slug),market=trade.market,now=this.clock();
    if(!validManagedSettlement(trade,label,now))return false;
    const key=`paper-settlement:${trade.id}`,held=this.engine.holdings.get(trade.tokenId)??0;
    if(!held || this.engine.usedIntents.has(key))return false;
    const flow=managedCashflows(trade);
    if((this.pendingSettlements.some(t=>t.id===trade.id)||trade.parameters?.positionManagementVersion===positionManagementVersion) &&
      (!flow||Math.abs(flow.remaining-held)>1e-7)){
      this.engine.halt('仓位成交记录与待结算库存不一致，请核对账务');return false;
    }
    const payout=round(held*label.payouts[trade.outcome]);
    this.engine.cash=round(this.engine.cash+payout);this.engine.holdings.delete(trade.tokenId);this.engine.inventoryCost.delete(trade.tokenId);this.engine.usedIntents.add(key);
    trade.settlement={id:key,size:held,payout,winner:label.winner,observedAt:label.observedAt,creditedAt:now,
      officialReportedClosedAt:label.closedAt??null,verificationVersion:label.version,verificationSource:label.source,
      priceCrossCheck:label.priceCrossCheck??'research-metadata-verified',scope:'paper-financial-only'};
    trade.exitReason='未卖出余量按已核实官方结果模拟结算';
    this.event({type:'paper_settlement',message:trade.exitReason,tradeId:trade.id,slug:trade.slug,...trade.settlement});
    this.syncManagedTrade(trade);return true;
  }
  async place(input, source = 'manual') {
    if(this.runtimeClock && !this.runtimeClock.status().ready)throw new ControlError('UTC 时间尚未通过独立校验，等待校时');
    if (!this.running || this.mode === 'observe') throw new ControlError('请先启动手动模拟或自动模拟');
    if (!this.frame) throw new ControlError('尚未收到当前盘口');
    if(source==='manual'){this.syncStrategyTrade();this.parkExpiredPosition();}
    if (source==='manual' && input.side==='buy' && (this.strategyTrade||this.rayOwnedPositions.length)) throw new ControlError('已有策略管理中的仓位；先结束该仓位再手动买入');
    if (this.engine.active || this.engine.busy) throw new ControlError('有未完成订单，请先等待或撤单');
    if (this.engine.halted) throw new ControlError(this.engine.halted);
    const { market, books } = this.frame, now = this.clock();
    if(input.side==='buy'&&this.strategyConfig.model==='ray-twap-band'&&this.rayMarketEntered(market.slug))
      throw new ControlError('本盘口已有买入成交；同一盘口只开一次仓，不能补单或反向开仓');
    if(source==='manual'&&this.strategyConfig.model==='ray-twap-band'&&input.side==='buy'&&input.mode!=='amount')
      throw new ControlError('当前买入使用 One-Tap 金额入口，请提交含费金额预算');
    if(input.mode==='amount') {
      if(input.marketSlug!==market.slug) throw new ControlError('盘口已换轮，请核对当前 Up / Down 后重新点击');
      if(input.side!=='buy' || !['Up','Down'].includes(input.outcome)) throw new ControlError('一键金额订单仅用于买入 Up 或 Down');
      const book=books.find(b=>b.tokenId===market.tokens[input.outcome]);
      const oneTap=source==='manual'&&this.strategyConfig.model==='ray-twap-band';
      let quote; try {quote=oneTap?oneTapQuote(book,market,input.units):amountQuote(book,market,input.units);} catch(error) {throw new ControlError(error.message);}
      if(!quote.allowed) throw new ControlError(quote.reason);
      if(oneTap){const equity=this.raySizingEquity(now),low=Math.floor(equity.value*.025*100+1e-8)/100,high=Math.floor(equity.value*.10*100+1e-8)/100;
        if(!equity.known||quote.maxSpend<low-1e-8||quote.maxSpend>high+1e-8)throw new ControlError('一键买入含费预算须在可核实净值 2.5%–10% 内');}
      input={...input,mode:'taker',amountUsd:quote.amountUsd,size:quote.size,makerPrice:quote.best,limit:quote.limit,makerMs:1000,
        ...(oneTap?{maxSpend:quote.maxSpend,executionVersion:oneTapExecutionVersion}:{})};
    }
    if (!['Up', 'Down'].includes(input.outcome) || !['buy', 'sell'].includes(input.side) ||
        !['maker', 'taker', 'maker_then_taker', 'fok'].includes(input.mode)) throw new ControlError('订单选项无效');
    if (input.side === 'buy' && this.paused) throw new ControlError('已暂停开仓；可以卖出已有持仓');
    if (input.side === 'buy' && !this.referenceFresh(now)) throw new ControlError(referenceStatus(this.referencePrice(),now).reason);
    const tokenId = market.tokens[input.outcome];
    const book = books.find(b => b.tokenId === tokenId);
    if (!this.engine.fresh(book, now)) throw new MarketDataStaleError({source,side:input.side,
      tokenId,frameAt:this.frame.now,bookAt:book?.timestamp??null,receivedAt:book?.receivedAt??null,
      checkedAt:now,staleMs:this.config.staleMs});
    if(input.side==='buy'&&this.config.riskPolicy==='equity-per-order-v1') {
      const equity=this.raySizingEquity(now),maxSpend=input.maxSpend;
      const low=equity.known?Math.floor(equity.value*.025*100+1e-8)/100:null;
      const high=equity.known?Math.floor(equity.value*.10*100+1e-8)/100:null;
      if(!equity.known||!(equity.value>0)||!Number.isFinite(maxSpend)||maxSpend<low-1e-8||maxSpend>high+1e-8||
        maxSpend>this.engine.cash+1e-8)throw new ControlError('含费预算须为可核实净值的 2.5%–10%，且不超过可用现金');
      const pct=source==='auto'?rayStrengthAllocation().pct:Math.max(.025,Math.min(.10,maxSpend/equity.value));
      if(Math.abs(Math.floor(equity.value*pct*100+1e-8)/100-maxSpend)>1e-8)throw new ControlError('单笔预算与已验证仓位比例不一致');
      // Ignore any client-supplied equity or risk evidence. This snapshot is
      // calculated here and checked again immediately before broker submission.
      input={...input,riskBudget:{policy:this.config.riskPolicy,equity:equity.value,pct,minPct:.025,maxPct:.10,
        maxSpend,at:now,availableCash:this.engine.cash,feeInclusive:true}};
    }
    const intent = { ...input, tokenId, id: `${source}-${++this.sequence}`, makerMs: input.makerMs ?? this.config.makerMs };
    if(input.rayEntryLotId){
      const owner=this.rayOwnedPositions.find(t=>t.tokenId===tokenId),lot=owner?.entryLots.find(l=>l.id===input.rayEntryLotId);
      if(source!=='auto'||!lot||lot.intentId)throw new ControlError('Ray 入场记录归属不匹配');
      if(intent.riskBudget)lot.riskBudget=structuredClone(intent.riskBudget);
      lot.intentId=intent.id;lot.status='submitted';
    }
    if (!orderSizeAllowed(intent, market)) throw new ControlError(intent.mode.startsWith('maker') ?
      `限价挂单份额不得少于 ${market.minSize}` : '市价买入最低 $1；市价卖出数量须大于零且不超过持仓');
    if (!Number.isFinite(intent.makerMs) || intent.makerMs < 1000 || intent.makerMs > 60_000) throw new ControlError('挂单等待时间须为 1–60 秒');
    if (input.side === 'sell' && intent.size > (this.engine.holdings.get(tokenId) ?? 0)) throw new ControlError('卖出份额超过可用持仓');
    const manageManual=source==='manual' && intent.side==='buy' && intent.amountUsd!==undefined && this.strategyConfig.exitPolicy==='market';
    if(manageManual) {
      if(this.hasUnmanagedHoldings())throw new ControlError('已有持仓处于活跃或未归属状态，先完成该仓位管理再一键买入');
      const binding=this.bindExitPolicy('manual-one-tap',now);
      this.strategyTrade={id:randomUUID(),origin:'manual-one-tap',experimentId:null,tokenId,outcome:input.outcome,slug:market.slug,
        p2EntryContextId:this.p2Context.link(now,market.slug),
        market:structuredClone(market),baseCash:this.engine.cash,baseFees:this.engine.fees,openedAt:null,costPerShare:null,
        amountUsd:intent.amountUsd,...(intent.maxSpend!==undefined?{maxSpend:intent.maxSpend}:{}),
        ...(intent.riskBudget?{riskBudget:structuredClone(intent.riskBudget)}:{}),signalAt:now,entryDecision:{version:forwardProtocol.version,tokenId,outcome:input.outcome,reason:'手动选择方向与金额，市场信息策略管理退出'},
        parameters:{config:structuredClone(this.config),strategy:structuredClone(this.strategyConfig),executionVersion:intent.maxSpend!==undefined?oneTapExecutionVersion:amountExecutionVersion,
          ...(this.strategyConfig.model==='ray-twap-band'?{rayProtocolVersion:rayProtocol.version,entryPolicy:rayProtocol.entryPolicy}:{}),
          feedRevision:forwardProtocol.executionRevision,positionManagementVersion,exitRevision:binding?.exitRevision??marketExitRevision,evolutionBinding:binding}};
    }
    try {
      if (!await this.engine.start(intent, market, now))throw new ControlError('订单被风控拒绝：检查价格步长、开仓时段、仓位预算或亏损上限');
    } catch(e) {if(manageManual && !this.engine.holdings.has(tokenId) && !this.engine.active)this.strategyTrade=null;throw e;}
    if(manageManual){this.attempted.add(market.slug);this.syncStrategyTrade();this.observeStrategies();}
    this.event({ type: 'action', message: `${source === 'auto' ? '自动' : '手动'}${input.side === 'buy' ? '买入' : '卖出'} ${input.outcome} ${input.size} 份`, intentId: intent.id });
    return { accepted: true, intentId: intent.id };
  }
  command(action, input = {}, internal = {}) {
    return this.enqueue(async () => {
      if (this.restoreFailed) throw new ControlError('本地状态恢复失败，请先检查状态文件');
      if(this.recoveryHold&&action!=='stop')throw new ControlError(`账户恢复核对锁：${this.recoveryHold.reason}`);
      if (action === 'start') {
        if(internal.expectedIntentRevision!==undefined&&this.runIntent.revision!==internal.expectedIntentRevision)throw new ControlError('运行意图已改变，取消旧恢复请求');
        if (this.running) throw new ControlError('工作流已经运行');
        if (!['observe', 'manual', 'auto'].includes(input.mode)) throw new ControlError('运行模式无效');
        if (this.engine.halted) throw new ControlError('执行层已暂停，需要先核对异常');
        if (input.mode === 'observe' && (this.engine.holdings.size || this.engine.active)) throw new ControlError('仍有模拟持仓，请使用模拟模式继续管理');
        this.mode = input.mode; this.running = true; this.paused = internal.restorePaused===true||input.paused===true;
        if(this.admissionResearch?.closed)this.configureAdmissionResearch(this.admissionResearch.saved());
        if(this.mode==='auto' && this.strategyConfig.execution==='paper' && (!this.engine.holdings.size||this.strategyConfig.model==='ray-twap-band') && !this.engine.active) {
          const profile={config:{...this.config},strategy:{...this.strategyConfig},executionVersion:this.strategyConfig.model==='ray-twap-band'?oneTapExecutionVersion:amountExecutionVersion,feedRevision:forwardProtocol.executionRevision,exitRevision:this.strategyConfig.model==='ray-twap-band'?rayProtocol.exitRevision:this.strategyConfig.exitPolicy==='market'?marketExitRevision:forwardProtocol.exitRevision,modelId:this.strategyConfig.model==='execution-edge'?this.edgeArtifact?.id??null:null,
            ...(this.strategyConfig.model==='ray-twap-band'?{rayProtocolVersion:rayProtocol.version,entryPolicy:rayProtocol.entryPolicy,entryTimingVersion}: {})};
          if(!this.experiment || JSON.stringify(this.experiment.profile)!==JSON.stringify(profile)) {
            this.experiment={id:randomUUID(),startedAt:this.clock(),profile,completedTrades:0,winningTrades:0,net:0,fees:0,lastTrade:null,
              ...(this.strategyConfig.model==='ray-twap-band'?{countingUnit:'completed-round-token-position',entryCountingUnit:'filled-amount-fak-order'}:{})};
            this.event({type:'experiment_start',message:'已开始自动模拟策略实验',experiment:this.experiment});
          }
        }
        const generation = ++this.feedGeneration;
        this.sources = { market: { state: 'connecting' }, book: { state: 'connecting' }, twap: { state: 'connecting' } };
        this.feed = this.feedFactory({
          clock:this.clock,clockStatus:()=>this.runtimeClock?.status()??{ready:true},
          onSpot:row=>{if(this.running&&generation===this.feedGeneration&&!this.p2Context.error)try{this.p2Context.ingest(row);}catch(e){this.p2Context.error=e.message;}},
          onSpotStatus:row=>{if(generation===this.feedGeneration&&(this.running||row.state==='stopped'))try{this.p2Context.status(row);}catch(e){this.p2Context.error=e.message;}},
          captureSpotDepthDiff:true,
          onSpotRaw:row=>{if(generation===this.feedGeneration&&(this.running||row.state==='stopped')){
            const status=this.runtimeClock?.status()??{ready:true,semantics:'injected-controller-clock'};
            this.orderflowResearch?.raw({...row,clockQuality:{ready:status.ready===true,calibratedAt:status.calibratedAt??null,
              uncertaintyMs:status.uncertaintyMs??null,localWallOffsetMs:status.localWallOffsetMs??null,semantics:status.semantics}});
          }},
          initialBooks:this.frame?.books??[],
          initialRayOpening:this.frame?.rayOpening??null,
          initialTwapRows:this.priceHistory,
          onDiagnostic:row=>{if(this.running&&generation===this.feedGeneration){
            this.recordAudit('-p0-feed',row);
            if(row.kind==='chainlink-reference')this.terminalObserver.ingestDiagnostic(row);
          }},
          resolutionMarkets: [...new Map([...this.ownedTrades().map(t=>t.market),...this.settlement.pending(),
            ...this.admissionResearch?.pendingMarkets()??[],
            ...this.evolutionCoordinator?.maintenanceResolutionMarkets?.()??[]].map(m=>[m.slug,m])).values()],
          priorityResolutionMarkets:()=>[...this.ownedTrades().map(t=>t.slug),
            ...this.evolutionCoordinator?.maintenanceResolutionMarkets?.().map(m=>m.slug)??[]],
          onResolution: evidence => this.enqueue(() => {
            if (!this.running || generation !== this.feedGeneration) return false;
            let accepted;
            try {accepted=this.settlement.acceptResolution(evidence,this.clock());}
            catch(error){if(error.financialConflict)this.engine.halt('已核实结算结果发生矛盾，请核对官方结果与账户记录');throw error;}
            if(accepted||this.financialLabels().has(evidence.market.slug)){
              this.admissionResearch?.acceptLabels(this.financialLabels(),{now:this.clock()});
              this.settleForwardPosition();this.observeValue();this.observeContinuation();this.observeEvolution({event:true});
            }
            return accepted;
          }),
          onPrice: price => { void this.enqueue(async () => {
            if (generation !== this.feedGeneration || !this.running)return;
            const prior=this.latestTwap;this.acceptPrice(price);
            if(this.latestTwap!==prior)this.observeAdmissionResearch();
            if(this.latestTwap!==prior && this.strategyConfig.model==='ray-twap-band' && this.mode==='auto' && !this.paused)await this.autoStep('reference');
          }).catch(error => { this.handleRuntimeError(error); }); },
          onFrame: frame => { void this.enqueue(() => {
            if (generation === this.feedGeneration) return this.acceptFrame(frame);
          }).catch(error => { this.handleRuntimeError(error); }); },
          onStatus: status => { void this.enqueue(async () => {
            if (!this.running || generation !== this.feedGeneration) return;
            const changed = this.sources[status.name]?.state !== status.state;
            this.sources[status.name] = status;
            if(['book','twap'].includes(status.name)&&status.state!=='connected')this.terminalObserver.reset(status.name+':'+status.state);
            if(status.name==='twap'&&status.state!=='connected')this.admissionResearch?.clearCurrent('twap:'+status.state,this.clock());
            if(status.name==='book'&&status.state!=='connected')this.admissionResearch?.invalidateBook('book:'+status.state,this.clock());
            if (changed) this.event({ type: 'connection', ...status });
            if(status.name==='book' && status.state==='error') {
              resetManagedConfirmation(this.strategyTrade);this.exitHistory=new BidHistory();
              this.strategyObservation?.resetConfirmation();
            }
            if (status.name === 'book' && status.state === 'error') await this.engine.tick(this.clock(), { stop: true });
          }).catch(error => { this.handleRuntimeError(error); }); },
        });
        this.orderflowError=null;this.orderflowLastSummary=null;
        if(this.feed?.spot)try{
          this.orderflowResearch=new OrderflowResearch({directory:join(this.directory,'orderflow-raw'),clock:this.clock,
            onDepthResnapshot:reason=>{if(this.running&&generation===this.feedGeneration)this.feed?.spot?.requestDepthSnapshot(reason);}});
        }catch(error){this.orderflowError=error.message;}
        this.syncStrategyTrade();this.parkExpiredPosition();this.settleForwardPosition();
        this.runIntent=nextRunIntent(this.runIntent,{running:true,mode:this.mode,paused:this.paused},this.clock());
        this.feed.start(); this.event({ type: 'start', message: '工作流已启动', mode: this.mode });
      } else if (action === 'stop') {
        if(!internal.preserveRunIntent)this.runIntent=nextRunIntent(this.runIntent,{running:false,mode:this.mode,paused:true},this.clock());
        this.running = false; this.paused = true; this.feed?.stop();
        await this.closeOrderflow();
        this.terminalObserver.reset('workflow-stopped');
        resetManagedConfirmation(this.strategyTrade);this.exitHistory=new BidHistory();
        this.strategyObservation?.resetConfirmation();
        this.feedGeneration++;
        await this.engine.tick(this.clock(), { stop: true });
        this.syncStrategyTrade();this.parkExpiredPosition();
        this.observeAdaptiveAccounts();
        this.observeEvolution({stop:true});
        if(this.evolutionCoordinator&&!this.evolutionError)try{this.evolutionCoordinator.save();}catch(error){this.evolutionError=error.message;this.evolutionCoordinator.error=error.message;}
        // Post-expiry observation cursors can change without target events.
        // Preserve those in-memory research records before process shutdown.
        if(this.continuationStudy&&!this.continuationError)try{this.continuationStudy.save([]);}
        catch(error){this.continuationError=error.message;this.continuationStudy.error=error.message;}
        for (const key of ['market', 'book', 'twap', 'resolution']) this.sources[key] = { state: 'stopped' };
        this.event({ type: 'stop', message: '已停止并核对模拟挂单；保留未平仓份额' });
      } else if (action === 'pause' || action === 'resume') {
        if (!this.running || this.mode === 'observe') throw new ControlError('请先启动模拟工作流');
        this.paused = action === 'pause';
        this.runIntent=nextRunIntent(this.runIntent,{running:true,mode:this.mode,paused:this.paused},this.clock());
        if (this.paused && this.engine.active?.intent.side === 'buy') await this.engine.tick(this.clock(), { stop: true });
        if (this.paused){this.observeAdaptiveAccounts();this.observeEvolution({stop:true});}
        this.event({ type: action, message: this.paused ? '已暂停开仓；已有持仓仍可卖出' : '已恢复开仓' });
      } else if (action === 'cancel') {
        if (!this.engine.active || this.engine.active.orderId !== input.orderId) throw new ControlError('该订单已结束或不属于当前未完成订单');
        await this.engine.tick(this.clock(), { stop: true });
        if (this.engine.active) throw new ControlError('撤单未确认，执行层已暂停');
        this.event({ type: 'action', message: '模拟订单已撤销并核对' });
      } else if (action === 'order') {
        if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)) throw new ControlError('缺少有效请求编号');
        if (this.requestIds.has(input.requestId)) return this.requestIds.get(input.requestId);
        const result = await this.place(input);
        this.requestIds.set(input.requestId, result);
        if (this.requestIds.size > 1000) this.requestIds.delete(this.requestIds.keys().next().value);
        return result;
      } else if (action === 'config') {
        if (this.running || this.engine.active || this.strategyTrade || this.rayOwnedPositions.length || this.pendingSettlements.length) throw new ControlError('先停止工作流且结束策略持仓，再修改参数');
        this.validateConfig(input);
        if(input.buyUnits!==undefined && this.settlement.ledger.summary().pending) throw new ControlError('先等待影子持仓结算，再修改单次买入金额');
        this.config = { ...this.config, ...input };
        for (const key of ['maxExposure', 'maxLoss', 'staleMs']) this.engine[key] = this.config[key];
        this.engine.riskPolicy=this.config.riskPolicy??'aggregate-cost-v1';
        this.broker.staleMs = this.config.staleMs;
        this.event({ type: 'config', message: '参数已保存', config: this.config });
      } else if (action === 'addPaperFunds') {
        if(this.engine.halted||this.storageFault)throw new ControlError('账户异常暂停期间不能充值，请先核对状态');
        const previous={cash:this.engine.cash,externalFunds:this.engine.externalFunds,baseCash:this.strategyTrade?.baseCash,metrics:this.accountMetrics.saved()};
        let deposit;
        try{deposit=this.accountMetrics.deposit({amount:input.amount,requestId:input.requestId,now:this.clock()});}
        catch(error){throw new ControlError(error.message);}
        if(deposit.duplicate)return {accepted:true,duplicate:true,flow:deposit.flow,cash:this.engine.cash};
        this.engine.cash=round(this.engine.cash+deposit.flow.amount);
        this.engine.externalFunds=round(this.engine.externalFunds+deposit.flow.amount);
        // Cash-flow-based strategy PnL and entry cost must not mistake funding
        // for a profitable exit or a cheaper acquisition.
        if(this.strategyTrade&&Number.isFinite(this.strategyTrade.baseCash))this.strategyTrade.baseCash=round(this.strategyTrade.baseCash+deposit.flow.amount);
        try{this.save();}
        catch(error){
          this.engine.cash=previous.cash;
          this.engine.externalFunds=previous.externalFunds;
          if(this.strategyTrade)this.strategyTrade.baseCash=previous.baseCash;
          this.accountMetrics=new AccountMetrics({saved:previous.metrics});
          throw error;
        }
        this.event({type:'paper_funding',message:`已增加模拟资金 $${deposit.flow.amount.toFixed(2)}；充值不计入交易收益`,funding:deposit.flow,cash:this.engine.cash});
        return {accepted:true,duplicate:false,flow:deposit.flow,cash:this.engine.cash};
      } else if(action==='replaceMainStrategy'||action==='alignRayFolder') {
        if(this.running||this.engine.active||this.engine.busy||this.engine.halted)throw new ControlError('先停止并核对挂单，不能在执行中替换主策略');
        const align=action==='alignRayFolder';
        if(align&&input.protocolVersion!==rayProtocol.version)throw new ControlError('Ray 对齐版本与当前代码不一致');
        if(align&&this.rayAlignmentVersion===rayProtocol.version)return {accepted:true,duplicate:true,protocolVersion:rayProtocol.version};
        if(!align&&input.model!=='ray-twap-band')throw new ControlError('仅支持本次明确指定的 Ray 替换');
        if(this.experiment){const path=join(this.directory,'experiment-'+this.experiment.id+'.json');if(!existsSync(path))writeFileSync(path,JSON.stringify(this.experiment,null,2)+'\n',{flag:'wx'});}
        this.evolutionRecoveryState=this.evolutionCoordinator?.state??this.evolutionRecoveryState;
        this.evolutionCoordinator=null;this.evolutionError=null;
        this.experiment=null;
        this.strategyConfig={...this.strategyConfig,execution:'paper',model:'ray-twap-band',exitPolicy:'market',stopLossUsd:0};
        this.config={...this.config,size:rayProtocol.shares,riskPolicy:'equity-per-order-v1',maxExposure:null};
        if(align)this.rayAlignmentVersion=rayProtocol.version;
        this.engine.maxExposure=this.config.maxExposure;
        this.engine.riskPolicy=this.config.riskPolicy;
        this.strategyDecision=this.evaluate();
        this.event({type:align?'main_strategy_aligned':'main_strategy_replaced',message:align?'已对齐单盘口一次开仓；任何正成交后本盘口不再补单或反向开仓，零成交可重试；单笔含费预算仍为可核实净值的 2.5%–10%，验证不足采用 2.5% 基线，资金和历史保留':'已按用户指定替换为 Ray；单盘口一次开仓，单笔净值 2.5%–10%，保留原资金、历史及已有仓位退出版本',protocol:rayProtocol});
      } else if (action === 'strategyConfig') {
        if(this.running || this.engine.active || this.strategyTrade || this.rayOwnedPositions.length || this.pendingSettlements.length) throw new ControlError('先停止且结束策略持仓，再修改策略参数');
        try { validateStrategyConfig(input); } catch(error) { throw new ControlError(error.message); }
        this.strategyConfig={...this.strategyConfig,...input};
        this.strategyDecision=this.evaluate();
        this.event({type:'strategy_config',message:'策略参数已保存',config:this.strategyConfig});
      } else if (action === 'recoverStorage') {
        this.recoverStorage();
      } else if (action === 'reset') {
        if (this.running || this.engine.active || this.engine.holdings.size || this.pendingSettlements.length) throw new ControlError('只有停止且无持仓、无挂单时才能新建会话');
        if (this.engine.halted) throw new ControlError('请先核对异常，不能用新会话绕过暂停');
        this.sessionId = randomUUID(); this.newEngine(); this.log = []; this.history = [];
        this.priceHistory = []; this.priceReference = null; this.latestTwap=null;
        this.strategyTrade=null; this.pendingSettlements=[];this.rayOwnedPositions=[];this.rayRoundFills={};this.rayDecisionSlot=null;this.rayEntryTrigger=new RayEntryTrigger();this.rayAlignmentVersion=null;this.strategyDecision=null;this.rayDynamicTwap=new RayDynamicTwap();
        this.experiment=null;
        this.accountMetrics=new AccountMetrics({now:this.clock()});
        this.attempted.clear(); this.requestIds.clear(); this.entryAt = null;
        this.event({ type: 'reset', message: '已新建模拟会话；历史日志保留' });
      } else throw new ControlError('未知操作');
      return { accepted: true };
    });
  }
}
