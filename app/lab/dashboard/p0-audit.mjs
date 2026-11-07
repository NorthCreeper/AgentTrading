// Read-only diagnostics. No value returned here may authorize or veto an order.
import {amountQuote} from '../amount-order.mjs';
import {round} from '../paper-broker.mjs';
import {freshBook,depthQuote} from './strategy.mjs';
import {forwardProtocol} from './forward-strategy.mjs';
import {referenceStatus,referenceMaxAgeMs} from './reference-price.mjs';
import {managedInventory} from './managed-position-accounting.mjs';

export const auditVersion='p0-observability-v1';
const finite=Number.isFinite;
const continuous=(xs,start,end,tail)=>xs.length>=10 && xs[0].time<=start+2000 && end-xs.at(-1).time<=tail &&
  xs.every((r,i)=>!i || r.time>xs[i-1].time && r.time-xs[i-1].time<=5000);
const all=xs=>xs.every(x=>x===true);
export function opportunitySnapshot({frame,decision,history=[],prices=[],reference,config,strategy,now,account,
  trade=null,pendingSettlements=[],funded=false,attempted=false,running,paused,mode,busy=false,sessionId=null,experimentId=null}) {
  if(!frame)return null;
  const {market,books}=frame,age=now-market.start;
  const rows=history.filter(r=>r.slug===market.slug && r.time>=now-30000 && r.time<=now);
  const ps=prices.filter(r=>r.time>=now-30000 && r.time<=now && finite(r.receivedAt) && r.receivedAt<=now);
  const ref=referenceStatus(reference,now);
  const common={window:age>=forwardProtocol.entryStartMs && age<forwardProtocol.entryEndMs,
    bookContinuous:continuous(rows,now-30000,now,3000),btcContinuous:continuous(ps,now-30000,now,referenceMaxAgeMs),referenceFresh:ref.ready};
  const inventory=Object.entries(account.holdings??{}).filter(([,size])=>size>0);
  const ownedInventory=managedInventory({trade,pendingSettlements,holdings:account.holdings,inventoryCost:account.inventoryCost,now});
  const accountChecks={running:running===true,automatic:mode==='auto',paper:strategy.execution==='paper',
    unpaused:!paused,unhalted:!account.halted,noActiveOrder:!account.active,noBusyOrder:!busy,
    noPosition:!ownedInventory.entryBlocked,unusedRound:!attempted};
  const candidates=['Up','Down'].map(outcome=>{
    const book=books.find(b=>b.tokenId===market.tokens[outcome]),key=outcome.toLowerCase();
    const bookReady=freshBook(book,now,config.staleMs)&&Boolean(book.bids.length&&book.asks.length);
    const priceWindow=common.bookContinuous&&rows.every(r=>finite(r[key]));
    const move=priceWindow?round(rows.at(-1)[key]-rows[0][key]):null;
    const spread=bookReady?round(book.asks[0][0]-book.bids[0][0]):null;
    let q=null,sell=null,quoteError=null;
    if(bookReady)try{q=amountQuote(book,market,config.buyUnits??1);
      if(q.filled>0)sell=depthQuote(book,'sell',q.filled,market,round(Math.max(market.tick,book.bids[0][0]-.02)));
    }catch(error){quoteError=error.message;}
    const cost=q?.filled>0&&sell?.complete?round((q.notional+q.fees-sell.notional+sell.fees)/q.filled):null;
    const score=move!==null&&cost!==null?round(move-cost-strategy.costBuffer):null;
    const exposure=config.maxLoss===0||funded?ownedInventory.totalCost:Math.max(ownedInventory.totalCost,-account.cash);
    const pending=q? q.amountUsd+q.size*market.fee.rate*.25**market.fee.exponent:null;
    const checks={...common,bookFresh:bookReady,priceWindow,
      momentum:move===null?null:move>=forwardProtocol.minimumMove,
      spread:spread===null?null:spread>0&&spread<=strategy.maxSpread,
      amountAllowed:bookReady?Boolean(q?.allowed):null,buyDepth:bookReady?Boolean(q?.complete):null,
      sellDepth:bookReady?Boolean(sell?.complete):null,edge:score===null?null:score>=strategy.minNetEdge,
      exposureBudget:pending===null?null:config.riskPolicy==='equity-per-order-v1'&&config.maxExposure===null?true:exposure+pending<=config.maxExposure,
      cashBudget:pending===null?null:!funded||finite(account.cash)&&account.cash+1e-8>=pending,
      lossGate:!(config.maxLoss>0&&inventory.length===0&&account.cash<=-config.maxLoss)};
    const signal=all([common.window,common.bookContinuous,common.btcContinuous,common.referenceFresh,bookReady,priceWindow,checks.momentum]);
    const costs=signal&&all([checks.spread,checks.amountAllowed,checks.buyDepth,checks.sellDepth,checks.edge]);
    return {outcome,checks,blockers:Object.entries(checks).filter(([,v])=>v===false).map(([k])=>k),
      unknown:Object.entries(checks).filter(([,v])=>v===null).map(([k])=>k),
      sourceAt:book?.timestamp??null,receivedAt:book?.receivedAt??null,transportReceivedAt:book?.transportReceivedAt??null,
      sourceAgeMs:book?now-book.timestamp:null,sourceHash:book?.sourceHash??null,move30:move,spread,score,quoteError,
      stages:{data:bookReady&&ref.ready,continuous:bookReady&&ref.ready&&priceWindow&&common.btcContinuous,
        signal,costs,account:costs&&all(Object.values(accountChecks))&&checks.exposureBudget===true&&checks.cashBudget===true&&checks.lossGate===true}};
  });
  const opening=prices.find(p=>p.time===market.start&&p.receivedAt<=now);
  const stages=Object.fromEntries(['data','continuous','signal','costs','account'].map(k=>[k,candidates.some(c=>c.stages[k])]));
  return {version:auditVersion,kind:'opportunity',sessionId,experimentId,time:now,frameAt:frame.now,
    slug:market.slug,marketStart:market.start,marketEnd:market.end,decisionAt:decision?.time??null,
    entryVersion:decision?.version??null,exitPolicy:strategy.exitPolicy,executionVersion:decision?.executionVersion??null,
    supportedStrategy:strategy.model==='forward-momentum',accountChecks,
    accountBlockers:Object.entries(accountChecks).filter(([,v])=>!v).map(([k])=>k),
    positionPhase:trade?now>=trade.market.end?'awaiting-resolution':'tradable-holding':ownedInventory.unmanagedCount?'unmanaged-holding':ownedInventory.pendingCount?'pending-settlements':'flat',
    pendingSettlementCount:ownedInventory.pendingCount,pendingSettlementCost:ownedInventory.pendingCost,
    totalInventoryCost:ownedInventory.totalCost,inventoryOwnership:ownedInventory,funded,
    occupiedByTradeId:trade?.id??null,openingReference:{available:Boolean(opening),valueE18:opening?.valueE18??null,
      observedAt:opening?.time??null,receivedAt:opening?.receivedAt??null,basis:'exact-market-start-twap-sample'},
    reference:{ready:ref.ready,sourceAgeMs:ref.sourceAgeMs,receiptAgeMs:ref.receiptAgeMs,publishedAt:reference?.publishedAt??null},
    candidates,stages,selectedOutcome:decision?.selected?.outcome??null,
    decisionAgreement:strategy.model==='forward-momentum'?stages.costs===Boolean(decision?.selected):null,
    note:'Independent diagnostic checks; unknown is not false. Frame counts are not elapsed time. Account stage is not a submitted order.'};
}

export function tradeTiming(trade,closedAt) {
  const end=trade.market?.end??null,opened=trade.openedAt;
  const fills=Object.values(trade.fillTiming??{}),first=fills.map(x=>x.firstFilledAt).filter(finite);
  return {version:auditVersion,signalAt:trade.signalAt??null,firstRecordedFillAt:first.length?Math.min(...first):null,
    openedAt:opened,marketEnd:end,closedAt,paperCapitalReleasedAt:closedAt,
    tradableHoldingMs:finite(opened)&&finite(end)?Math.max(0,Math.min(closedAt,end)-opened):null,
    postExpiryOccupancyMs:finite(end)?Math.max(0,closedAt-Math.max(end,opened??end)):null,
    labelObservedAt:trade.settlement?.observedAt??null,
    expiryToObservedLabelMs:trade.settlement&&finite(end)?trade.settlement.observedAt-end:null,
    labelToPaperCreditMs:trade.settlement?trade.settlement.creditedAt-trade.settlement.observedAt:null,
    officialReportedClosedAt:trade.settlement?.officialReportedClosedAt??null,
    fillTiming:fills,realRedemptionAt:null,
    note:'Paper release only; no on-chain redemption. Verification observation time is not official publication time.'};
}

export function summarizeOpportunity(prior,row) {
  if(prior&&row.frameAt<=prior.lastFrameAt)return prior;
  const s=prior??{version:auditVersion,slug:row.slug,firstAt:row.time,frames:0,lastFrameAt:null,
    stages:{},blockers:{},unknown:{},maxFrameGapMs:0,decisionDisagreements:0};
  if(s.lastFrameAt!==null)s.maxFrameGapMs=Math.max(s.maxFrameGapMs,row.frameAt-s.lastFrameAt);
  s.lastAt=row.time;s.lastFrameAt=row.frameAt;s.frames++;
  for(const [k,v] of Object.entries(row.stages))if(v)s.stages[k]=(s.stages[k]??0)+1;
  for(const k of new Set([...row.accountBlockers,...row.candidates.flatMap(c=>c.blockers.map(b=>c.outcome+':'+b))]))s.blockers[k]=(s.blockers[k]??0)+1;
  for(const c of row.candidates)for(const k of c.unknown)s.unknown[c.outcome+':'+k]=(s.unknown[c.outcome+':'+k]??0)+1;
  if(row.decisionAgreement===false)s.decisionDisagreements++;
  return s;
}
