const finite=Number.isFinite;
const integer=Number.isSafeInteger;
const number=x=>{const n=Number(x);if(!finite(n))throw Error('non-finite-number');return n;};
const sides=raw=>{if(!Array.isArray(raw)||raw.length>10000)throw Error('invalid-level-array');return raw.map(row=>{if(!Array.isArray(row)||row.length!==2)throw Error('invalid-level');const p=number(row[0]),q=number(row[1]);if(p<=0||q<0)throw Error('invalid-level-value');return [p,q];});};
const normalizedClock=(row,sourceAt,publishedAt=sourceAt)=>integer(row.receivedAt)&&integer(sourceAt)&&sourceAt<=row.receivedAt&&integer(publishedAt)&&publishedAt>=sourceAt&&publishedAt<=row.receivedAt;
const unknown=reason=>({status:'unknown',reason});

// Source observations only. This module contains no entry, exit, sizing, order,
// account or trading methods. All intervals use events known by sample time.
export class OrderflowShadow {
 constructor({clock=Date.now,onDepthResnapshot=()=>{},maxTradeRows=100000,maxDepthBuffer=1000,maxBookLevels=20000,maxAgeMs=3000}={}){
  Object.assign(this,{clock,onDepthResnapshot,maxTradeRows,maxDepthBuffer,maxBookLevels,maxAgeMs});this.connectionId=null;this.connected=false;this.flowEpoch=0;this.depthEpoch=0;this.trades=[];this.tradeHead=0;this.lastTrade=null;this.coverageStartedAt=null;this.flowReason='warming-up';this.buffer=[];this.depth=null;this.depthReason='awaiting-snapshot';this.depthChanges=[];
  this.counts={raw:0,trades:0,tradeDuplicates:0,tradeGaps:0,tradeConflicts:0,rejected:0,depthUpdates:0,depthDuplicates:0,depthGaps:0,snapshots:0,recordingGaps:0,resnapshotRequests:0};this.latest=null;this.lastSampleSlot=null;this.lastError=null;this.lastRawAt=null;
 }
 resetFlow(reason){this.flowEpoch++;this.trades=[];this.tradeHead=0;this.lastTrade=null;this.coverageStartedAt=null;this.flowReason=reason;}
 resetDepth(reason,{request=false}={}){this.depthEpoch++;this.depth=null;this.depthReason=reason;this.depthChanges=[];this.buffer=[];if(request)this.requestSnapshot(reason);}
 requestSnapshot(reason){this.counts.resnapshotRequests++;try{this.onDepthResnapshot(reason);}catch(error){this.lastError=error.message;}}
 recordingGap(gap){this.counts.recordingGaps++;this.resetFlow('recording-gap');this.resetDepth('recording-gap',{request:true});this.lastError=gap.reason??'recording-gap';}
 setConnection(id){if(id!==this.connectionId){this.connectionId=id;this.resetFlow('new-connection');this.resetDepth('new-connection');}}
 ingest(row){
  this.counts.raw++;this.lastRawAt=row.receivedAt;
  try{
   if(row.kind==='recording-gap'){this.recordingGap(row);return false;}
   if(row.venue!=='binance')return false;
   if(!integer(row.receivedAt)||row.receivedAt>this.clock())throw Error('invalid-receive-clock');
   if(row.kind==='feed-status'){
    if(row.state==='connected'){this.setConnection(row.connectionId);this.connected=true;}
    else if(['connecting','disconnected','stale','error','stopped'].includes(row.state)){this.setConnection(row.connectionId??this.connectionId);this.connected=false;this.resetFlow(`feed-${row.state}`);this.resetDepth(`feed-${row.state}`);}
    else if(row.state==='snapshot-error'){this.resetDepth('snapshot-error');}
    return true;
   }
   if(!row.connectionId||row.connectionId!==this.connectionId)return false;
   if(row.kind==='depth-snapshot')return this.snapshot(row);
   if(row.kind!=='ws-raw')return false;
   const raw=JSON.parse(row.rawText),d=raw.data;
   if(raw.stream==='btcusdt@aggTrade')return this.trade(row,d);
   if(raw.stream==='btcusdt@depth@100ms')return this.diff(row,d);
   // depth5 is preserved as raw, but never masquerades as continuous depth.
   return false;
  }catch(error){this.counts.rejected++;this.lastError=error.message;this.resetFlow('rejected-raw');this.resetDepth('rejected-raw',{request:true});return false;}
 }
 trade(row,d){
  if(d?.e!=='aggTrade'||d.s!=='BTCUSDT'||![d.a,d.f,d.l].every(integer)||d.a<0||d.f<0||d.l<d.f||typeof d.m!=='boolean'||!normalizedClock(row,d.T,d.E))throw Error('invalid-aggregate-trade');
  const p=number(d.p),q=number(d.q);if(p<=0||q<=0||!finite(p*q))throw Error('invalid-trade-amount');
  const fingerprint=JSON.stringify(d);
  if(this.lastTrade){
   if(d.a===this.lastTrade.sequence){if(fingerprint===this.lastTrade.fingerprint){this.counts.tradeDuplicates++;return false;}this.counts.tradeConflicts++;this.resetFlow('aggregate-id-conflict');}
   else if(d.a<this.lastTrade.sequence){this.counts.tradeConflicts++;this.resetFlow('aggregate-id-backward');return false;}
   else if(d.a!==this.lastTrade.sequence+1||d.T<this.lastTrade.sourceAt){this.counts.tradeGaps++;this.resetFlow('aggregate-id-or-time-gap');}
  }
  this.coverageStartedAt??=d.T;
  const trade={sequence:d.a,sourceAt:d.T,publishedAt:d.E,knownAt:row.receivedAt,price:p,quantityBtc:q,quoteUsdt:p*q,takerSide:d.m?'sell':'buy',matchCount:d.l-d.f+1,epoch:this.flowEpoch,fingerprint,observationSequence:row.observationSequence??null};
  this.lastTrade=trade;this.trades.push(trade);this.counts.trades++;this.flowReason=null;
  while(this.tradeHead<this.trades.length&&this.trades[this.tradeHead].sourceAt<d.T-35000)this.tradeHead++;
  if(this.tradeHead>10000){this.trades=this.trades.slice(this.tradeHead);this.tradeHead=0;}
  if(this.trades.length-this.tradeHead>this.maxTradeRows){this.resetFlow('trade-memory-bound');return false;}
  return true;
 }
 snapshot(row){
  if(row.httpStatus!==200){this.resetDepth('snapshot-http-error');return false;}
  const raw=JSON.parse(row.rawText),bids=sides(raw.bids),asks=sides(raw.asks);
  if(!integer(raw.lastUpdateId)||raw.lastUpdateId<0||!bids.length||!asks.length||bids.length>5000||asks.length>5000||bids.some((x,i)=>x[1]<=0||(i&&x[0]>=bids[i-1][0]))||asks.some((x,i)=>x[1]<=0||(i&&x[0]<=asks[i-1][0]))||bids[0][0]>=asks[0][0])throw Error('invalid-depth-snapshot');
  const buffered=this.buffer;this.buffer=[];this.depthEpoch++;this.depthChanges=[];
  this.depth={bids:new Map(bids),asks:new Map(asks),lastUpdateId:raw.lastUpdateId,snapshotUpdateId:raw.lastUpdateId,snapshotKnownAt:row.receivedAt,snapshotObservationSequence:row.observationSequence??null,bidBoundary:bids.at(-1)[0],askBoundary:asks.at(-1)[0],bridged:false,lastSourceAt:null,lastKnownAt:row.receivedAt,lastFingerprint:null};
  this.depthReason='awaiting-bridge';this.counts.snapshots++;
  for(const item of buffered){if(!this.apply(item.row,item.d))break;}
  return true;
 }
 diff(row,d){
  if(d?.e!=='depthUpdate'||d.s!=='BTCUSDT'||![d.U,d.u].every(integer)||d.U<0||d.u<d.U||!normalizedClock(row,d.E))throw Error('invalid-depth-update');
  sides(d.b);sides(d.a);
  if(!this.depth){
   if(this.buffer.length>=this.maxDepthBuffer){this.resetDepth('depth-buffer-bound',{request:true});}
   this.buffer.push({row,d});return true;
  }
  return this.apply(row,d);
 }
 apply(row,d){
  const book=this.depth;if(!book)return false;
  const fingerprint=JSON.stringify(d);
  if(d.u<=book.lastUpdateId){
   if(d.u===book.lastUpdateId&&book.lastFingerprint&&fingerprint!==book.lastFingerprint){this.counts.depthGaps++;this.resetDepth('depth-id-conflict',{request:true});return false;}
   this.counts.depthDuplicates++;return true;
  }
  if(d.U>book.lastUpdateId+1||(book.lastSourceAt!==null&&d.E<book.lastSourceAt)){
   this.counts.depthGaps++;this.resetDepth('depth-sequence-gap',{request:true});this.buffer.push({row,d});return false;
  }
  const knownAt=Math.max(row.receivedAt,book.snapshotKnownAt);
  const change={sourceAt:d.E,knownAt,epoch:this.depthEpoch,bidAddedBtc:0,bidReducedBtc:0,askAddedBtc:0,askReducedBtc:0,levels:0};
  for(const [name,levels] of [['bids',sides(d.b)],['asks',sides(d.a)]]){
   const map=book[name],side=name==='bids'?'bid':'ask';
   for(const [p,q] of levels){
    const known=name==='bids'?p>=book.bidBoundary:p<=book.askBoundary,previous=map.get(p)??0;
    if(known){const delta=q-previous;if(delta>0)change[`${side}AddedBtc`]+=delta;else change[`${side}ReducedBtc`]-=delta;change.levels++;}
    if(q===0)map.delete(p);else map.set(p,q);
   }
  }
  if(book.bids.size>this.maxBookLevels||book.asks.size>this.maxBookLevels){this.resetDepth('depth-map-bound',{request:true});return false;}
  book.lastUpdateId=d.u;book.lastSourceAt=d.E;book.lastKnownAt=knownAt;book.lastFingerprint=fingerprint;book.bridged=true;book.lastObservationSequence=row.observationSequence??null;this.depthReason=null;this.counts.depthUpdates++;
  this.depthChanges.push(change);while(this.depthChanges.length&&this.depthChanges[0].sourceAt<d.E-35000)this.depthChanges.shift();
  if(this.depthChanges.length>5000){this.resetDepth('depth-change-memory-bound',{request:true});return false;}
  return true;
 }
 flowWindow(now,seconds){
  const start=now-seconds*1000,last=this.lastTrade;
  if(!this.connected||!last||this.coverageStartedAt===null||this.coverageStartedAt>start)return unknown(this.flowReason??'warming-up');
  if(now-last.sourceAt>this.maxAgeMs||now-last.knownAt>this.maxAgeMs)return unknown('stale-trade-stream');
  const rows=this.trades.slice(this.tradeHead).filter(r=>r.sourceAt>start&&r.sourceAt<=now&&r.knownAt<=now);
  if(!rows.length)return unknown('no-fresh-trade-observations');
  let buyBtc=0,sellBtc=0,buyUsdt=0,sellUsdt=0,matchCount=0,maxAggregateQuoteUsdt=0;
  for(const r of rows){if(r.takerSide==='buy'){buyBtc+=r.quantityBtc;buyUsdt+=r.quoteUsdt;}else{sellBtc+=r.quantityBtc;sellUsdt+=r.quoteUsdt;}matchCount+=r.matchCount;maxAggregateQuoteUsdt=Math.max(maxAggregateQuoteUsdt,r.quoteUsdt);}
  const total=buyBtc+sellBtc;
  return {status:'observed',seconds,windowStart:start,windowEnd:now,coverageStartedAt:this.coverageStartedAt,epoch:this.flowEpoch,aggregateCount:rows.length,matchCount,buyBtc,sellBtc,buyUsdt,sellUsdt,netBtc:buyBtc-sellBtc,netUsdt:buyUsdt-sellUsdt,takerQuantityImbalance:total?(buyBtc-sellBtc)/total:null,
   maxAggregateQuoteUsdt,firstPriceUsdt:rows[0].price,lastPriceUsdt:rows.at(-1).price,observedPriceChangeBps:(rows.at(-1).price/rows[0].price-1)*10000,firstObservationSequence:rows[0].observationSequence,lastObservationSequence:rows.at(-1).observationSequence,
   timeBasis:'venue-match-time; received before sample',scope:'Binance BTCUSDT aggregate matches; not participant identity or all venues'};
 }
 bookSample(now){
  const b=this.depth;if(!this.connected||!b||!b.bridged)return {...unknown(this.depthReason??'awaiting-bridge'),continuous:false,epoch:this.depthEpoch,bufferedUpdates:this.buffer.length};
  if(now-b.lastSourceAt>this.maxAgeMs||now-b.lastKnownAt>this.maxAgeMs)return {...unknown('stale-depth-stream'),continuous:false,epoch:this.depthEpoch};
  const bids=[...b.bids].sort((a,z)=>z[0]-a[0]).slice(0,5),asks=[...b.asks].sort((a,z)=>a[0]-z[0]).slice(0,5);
  if(bids.length<5||asks.length<5||bids[4][0]<b.bidBoundary||asks[4][0]>b.askBoundary||bids[0][0]>=asks[0][0])return {...unknown('snapshot-boundary-exhausted-or-crossed'),continuous:false,epoch:this.depthEpoch};
  const bidBtc=bids.reduce((s,r)=>s+r[1],0),askBtc=asks.reduce((s,r)=>s+r[1],0);
  return {status:'observed',continuous:true,epoch:this.depthEpoch,lastUpdateId:b.lastUpdateId,snapshotUpdateId:b.snapshotUpdateId,snapshotKnownAt:b.snapshotKnownAt,snapshotObservationSequence:b.snapshotObservationSequence,lastObservationSequence:b.lastObservationSequence,lastSourceAt:b.lastSourceAt,lastKnownAt:b.lastKnownAt,bids,asks,top5BidBtc:bidBtc,top5AskBtc:askBtc,top5QuantityImbalance:(bidBtc-askBtc)/(bidBtc+askBtc),spreadUsdt:asks[0][0]-bids[0][0],knownSnapshotPriceBand:{minimumBid:b.bidBoundary,maximumAsk:b.askBoundary},fullMarketDepthKnown:false};
 }
 depthWindow(now,seconds,book){
  if(!book.continuous)return unknown(book.reason);
  const start=now-seconds*1000;if(this.depth.snapshotKnownAt>start)return unknown('warming-up-since-snapshot');
  const rows=this.depthChanges.filter(r=>r.sourceAt>start&&r.sourceAt<=now&&r.knownAt<=now&&r.epoch===this.depthEpoch);
  const totals={bidAddedBtc:0,bidReducedBtc:0,askAddedBtc:0,askReducedBtc:0};for(const r of rows)for(const k of Object.keys(totals))totals[k]+=r[k];
  return {status:'observed',seconds,updates:rows.length,...totals,interpretation:'net displayed price-level quantity changes inside initial snapshot band; reductions cannot be attributed to cancellations or executions'};
 }
 sample(context={}){
  const now=context.now??this.clock();if(!integer(now)||now>this.clock())return null;
  const slot=Math.floor(now/1000);if(slot===this.lastSampleSlot)return null;this.lastSampleSlot=slot;
  const book=this.bookSample(now),windows={},depthWindows={};for(const seconds of [1,3,10,30]){windows[seconds]=this.flowWindow(now,seconds);depthWindows[seconds]=this.depthWindow(now,seconds,book);}
  this.latest={version:'btc-orderflow-shadow-v1',mode:'shadow-only',time:now,connectionId:this.connectionId,context:structuredClone(context),windows,continuousDepth:book,depthWindows,
   attribution:{status:'unverified',largeParticipantIdentity:null,cancellationVolume:null,absorptionAlpha:null,reason:'public aggregate matches and L2 changes cannot identify individual participants, queue orders, cancels or reliable predictive advantage'},
   comparison:{status:'prospective-data-collection',baseline:'correct-opening-TWAP + current spot + executable Polymarket quotes',incrementalAdvantageVerified:false,sizingUse:false,tradingUse:false},counts:{...this.counts}};
  return this.latest;
 }
 summary(now=this.clock()){return {version:'btc-orderflow-shadow-v1',mode:'shadow-only',connected:this.connected,connectionId:this.connectionId,lastRawAt:this.lastRawAt,lastError:this.lastError,counts:{...this.counts},bufferedDepthUpdates:this.buffer.length,retainedTradeRows:this.trades.length-this.tradeHead,flowEpoch:this.flowEpoch,depthEpoch:this.depthEpoch,continuousDepth:this.bookSample(now),latest:this.latest};}
}
