import {validRayOpeningEvidence} from './ray-opening.mjs';
// A fixed, uncalibrated candidate. This module can observe risk, never place an order.
export const rayTerminalRiskProtocol=Object.freeze({
  version:'ray-terminal-book-spot-shadow-v1',mode:'shadow',lateMs:60000,
  heldAskMaximum:.40,oppositeBidMinimum:.60,confirmationMs:2000,
  minimumDistinctObservations:3,maximumGapMs:3000,bookMaxAgeMs:3000,
  referenceMaxAgeMs:5000,minimumExecutionDelayMs:1000,
  fixedDollarStop:null,maximumHoldMs:null,forcedFinalMinuteExit:false,
  returnValidated:false,allocationEffect:'none',
});

const finite=Number.isFinite;
const fresh=(source,received,now,age)=>[source,received].every(t=>finite(t)&&t<=now&&now-t<=age)&&source<=received;
const side=d=>d>0?'Up':d<0?'Down':'Tie';
function openingValid(o,m,now){
  return Boolean(o?.basis==='opening-60s-twap'&&validRayOpeningEvidence(o,m,now));
}
function bookValid(book,now){
  return Boolean(book&&fresh(book.timestamp,book.receivedAt,now,rayTerminalRiskProtocol.bookMaxAgeMs)&&
    (!finite(book.transportReceivedAt)||fresh(book.timestamp,book.transportReceivedAt,now,rayTerminalRiskProtocol.bookMaxAgeMs))&&
    book.bids?.length&&book.asks?.length&&
    [book.bids[0],book.asks[0]].every(l=>Array.isArray(l)&&finite(l[0])&&l[0]>0&&l[0]<1&&finite(l[1])&&l[1]>0)&&
    book.bids[0][0]<book.asks[0][0]);
}

// Integrate observed Chainlink spot as a local piecewise-constant proxy only.
// RTDS spot is not proof of the constituent data in the official TWAP product.
export function terminalTwapProxy({market,opening,spotRows=[],now}){
  const result={version:'terminal-spot-integral-proxy-v1',official:false,usedForSignal:false,
    assumption:'Recorded RTDS spot is piecewise constant; last known spot persists until market end.',
    status:'unavailable',projectedEndTwap:null,futureMeanBreakEven:null};
  if(!market||!openingValid(opening,market,now)||now<market.end-60000||now>=market.end)return result;
  const start=market.end-60000;
  const rows=spotRows.filter(r=>r.source==='rtds-chainlink-spot'&&finite(r.value)&&r.value>0&&
    finite(r.referenceAt)&&finite(r.knownAt)&&r.referenceAt<=r.knownAt&&r.knownAt<=now&&r.referenceAt<=now)
    .sort((a,b)=>a.referenceAt-b.referenceAt||a.knownAt-b.knownAt)
    .filter((r,i,a)=>!i||r.referenceAt!==a[i-1].referenceAt);
  const before=rows.filter(r=>r.referenceAt<=start).at(-1),after=rows.filter(r=>r.referenceAt>start);
  if(!before||start-before.referenceAt>5000||!after.length)return result;
  const points=[before,...after],latest=points.at(-1);
  if(!fresh(latest.referenceAt,latest.knownAt,now,5000)||points.some((r,i)=>i&&r.referenceAt-points[i-1].referenceAt>5000))return result;
  let integral=0,cursor=start,value=before.value;
  for(const r of after){integral+=value*(r.referenceAt-cursor);cursor=r.referenceAt;value=r.value;}
  const unknownMs=market.end-cursor;
  return {...result,status:'proxy-only',knownWindowMs:cursor-start,unknownWindowMs:unknownMs,
    latestSourceAt:latest.referenceAt,latestKnownAt:latest.knownAt,
    projectedEndTwap:(integral+value*unknownMs)/60000,
    futureMeanBreakEven:unknownMs>0?(60000*opening.value-integral)/unknownMs:null,
    openingValue:opening.value};
}

export function evaluateRayTerminalRisk({frame,trade,opening=frame?.rayOpening,spot,spotRows=[],now=frame?.now,
  prior=null,connectionEpoch=null,dataGap=false}={}){
  const p=rayTerminalRiskProtocol,m=frame?.market;
  let decision={version:p.version,mode:'shadow',action:'observe',time:now,status:'data-unavailable',
    candidateExit:false,signalAt:null,earliestExecutionAt:null,confirmedMs:0,
    returnValidated:false,allocationEffect:'none',reasonCode:'missing-frame',
    sourceTimestampSemantics:'unverified-server-timestamp',terminalProxy:terminalTwapProxy({market:m,opening,spotRows,now})};
  const finish=(reasonCode,status='data-unavailable',state=null)=>({state,decision:{...decision,status,reasonCode}});
  if(!m||!finite(now)||!finite(frame.now)||frame.now>now||now-frame.now>p.bookMaxAgeMs)return finish('missing-or-stale-frame');
  decision.remainingMs=m.end-now;
  if(!trade||trade.slug!==m.slug||!['Up','Down'].includes(trade.outcome)||
    trade.tokenId!==m.tokens?.[trade.outcome]||trade.market?.conditionId&&trade.market.conditionId!==m.conditionId)
    return finish('holding-market-token-mismatch');
  if(now>=m.end)return finish('awaiting-official-resolution','awaiting-resolution');
  if(now<m.start||m.end-now>p.lateMs)return finish('outside-last-60-seconds','outside-window');
  if(!frame.clock?.ready)return finish('clock-unready');
  if(dataGap)return finish('feed-gap-or-disconnect');
  if(!openingValid(opening,m,now))return finish('correct-opening-twap-unavailable');
  const tw=frame.twap,twap=typeof tw?.valueE18==='string'&&/^\d+$/.test(tw.valueE18)?Number(tw.valueE18)/1e18:NaN;
  if(tw?.windowSeconds!==60||!finite(twap)||twap<=0||!fresh(tw.timestamp,tw.receivedAt,now,p.referenceMaxAgeMs))return finish('twap-unavailable');
  if(spot?.source!=='rtds-chainlink-spot'||!finite(spot.value)||spot.value<=0||
    !fresh(spot.referenceAt,spot.knownAt,now,p.referenceMaxAgeMs))return finish('chainlink-spot-unavailable');
  const held=frame.books?.find(b=>b.tokenId===trade.tokenId),other=trade.outcome==='Up'?'Down':'Up';
  const opposite=frame.books?.find(b=>b.tokenId===m.tokens[other]);
  if(!bookValid(held,now)||!bookValid(opposite,now))return finish('two-sided-books-unavailable');
  const heldAsk=held.asks[0][0],oppositeBid=opposite.bids[0][0],spotDirection=side(spot.value-opening.value),twapDirection=side(twap-opening.value);
  Object.assign(decision,{slug:m.slug,conditionId:m.conditionId,tokenId:trade.tokenId,outcome:trade.outcome,
    opening:structuredClone(opening),heldBid:held.bids[0][0],heldAsk,oppositeBid,
    twapDeviationUsd:twap-opening.value,spotDeviationUsd:spot.value-opening.value,
    spotMinusTwapUsd:spot.value-twap,twapDirection,spotDirection,
    bookOpposesHolding:heldAsk<=p.heldAskMaximum&&oppositeBid>=p.oppositeBidMinimum,
    spotOpposesHolding:spotDirection===other,
    currentTwapDisagreesWithBook:heldAsk<=p.heldAskMaximum&&oppositeBid>=p.oppositeBidMinimum&&twapDirection===trade.outcome,
    sourceAt:{heldBook:held.timestamp,oppositeBook:opposite.timestamp,spot:spot.referenceAt,twap:tw.timestamp},
    receivedAt:{heldBook:held.receivedAt,oppositeBook:opposite.receivedAt,spot:spot.knownAt,twap:tw.receivedAt}});
  if(heldAsk>p.heldAskMaximum||oppositeBid<p.oppositeBidMinimum||spotDirection!==other)return finish('reversal-not-jointly-observed','hold');
  const key=[m.slug,m.conditionId,trade.tokenId,opening.value,opening.knownAt,connectionEpoch].join('|');
  const sampleAt=Math.min(held.timestamp,opposite.timestamp,spot.referenceAt);
  const canContinue=prior?.key===key&&now>prior.observedAt&&now-prior.observedAt<=p.maximumGapMs&&
    sampleAt>=prior.sampleAt&&sampleAt-prior.sampleAt<=p.maximumGapMs;
  let state=canContinue?{...prior,observedAt:now}:{key,since:now,sampleAt,observedAt:now,count:1,
    heldBookAt:held.timestamp,oppositeBookAt:opposite.timestamp,spotAt:spot.referenceAt,signalAt:null};
  if(canContinue&&held.timestamp>prior.heldBookAt&&opposite.timestamp>prior.oppositeBookAt&&spot.referenceAt>prior.spotAt){
    state={...state,sampleAt,count:prior.count+1,heldBookAt:held.timestamp,oppositeBookAt:opposite.timestamp,spotAt:spot.referenceAt};
  }
  state.firstSampleAt=canContinue?(prior.firstSampleAt??prior.sampleAt):sampleAt;
  const duration=Math.min(now-state.since,sampleAt-state.firstSampleAt);
  const confirmed=state.count>=p.minimumDistinctObservations&&duration>=p.confirmationMs;
  if(confirmed&&!state.signalAt)state.signalAt=now;
  decision={...decision,status:confirmed?'shadow-exit-candidate':'confirming',reasonCode:confirmed?'joint-reversal-confirmed':'confirming-joint-reversal',
    confirmedMs:duration,distinctObservations:state.count,candidateExit:confirmed,
    signalAt:state.signalAt,earliestExecutionAt:state.signalAt===null?null:state.signalAt+p.minimumExecutionDelayMs};
  return {state,decision};
}

// The signal's own snapshot can never be its hypothetical execution snapshot.
export function deferredTerminalQuoteEligibility({signal,frame,trade,now=frame?.now}={}){
  const reject=reason=>({eligible:false,reason});
  if(!signal?.candidateExit||!finite(signal.signalAt)||!finite(signal.earliestExecutionAt)||
    signal.earliestExecutionAt<signal.signalAt+rayTerminalRiskProtocol.minimumExecutionDelayMs)return reject('no-confirmed-signal');
  if(!frame?.market||frame.market.slug!==signal.slug||frame.market.conditionId!==signal.conditionId||
    trade?.slug!==signal.slug||trade?.tokenId!==signal.tokenId||frame.market.tokens?.[trade.outcome]!==trade.tokenId)return reject('market-token-mismatch');
  if(!frame.clock?.ready||!finite(now)||!finite(frame.now)||now<signal.earliestExecutionAt||frame.now>now||now-frame.now>3000||now>=frame.market.end)return reject('delay-or-market-window');
  const book=frame.books?.find(b=>b.tokenId===trade.tokenId);
  if(!bookValid(book,now)||book.timestamp<signal.earliestExecutionAt||book.receivedAt<signal.earliestExecutionAt||
    finite(book.requestStartedAt)&&book.requestStartedAt<signal.earliestExecutionAt)return reject('need-new-post-delay-owned-book');
  return {eligible:true,reason:'post-delay-real-owned-book',bookAt:book.timestamp,receivedAt:book.receivedAt,
    elapsedMs:now-signal.signalAt};
}
