import {randomUUID} from 'node:crypto';
import {round} from '../paper-broker.mjs';
import {e18ToPrice} from './chart-model.mjs';
import {researchBook} from './p2-book.mjs';

export const p2Version='p2-causal-spot-context-v2';
const fresh=(p,now)=>Boolean(p&&p.sourceAt<=now&&p.receivedAt<=now&&now-p.sourceAt<=3000&&now-p.receivedAt<=3000);
const emptyActivity=()=>({messages:0,tradeCount:0,quantityBtc:0,takerBuyBtc:0,takerSellBtc:0,firstSourceAt:null,lastSourceAt:null,firstReceivedAt:null,lastReceivedAt:null});
export function spotWindow(rows,now,seconds,venue,opening=null){
 const xs=rows.filter(r=>r.time>=now-seconds*1000&&r.time<=now),key=venue;
 if(xs.length<Math.floor(seconds/2)||xs[0].time>now-seconds*1000+2000||now-xs.at(-1).time>2000||
  xs.some((r,i)=>!r[key]?.ready||!Number.isFinite(r[key].price)||i&&(r.time<=xs[i-1].time||r.time-xs[i-1].time>3000||r[key].epoch!==xs[i-1][key].epoch)))return null;
 const ps=xs.map(r=>r[key].price),rets=ps.slice(1).map((p,i)=>Math.log(p/ps[i])),net=Math.log(ps.at(-1)/ps[0]),rv=Math.sqrt(rets.reduce((s,x)=>s+x*x,0)),path=rets.reduce((s,x)=>s+Math.abs(x),0);
 const up=rets.filter(x=>x>0).length,down=rets.filter(x=>x<0).length;let crossings=0,sign=0;
 if(opening)for(const p of ps){const next=Math.sign(p-opening);if(next&&sign&&next!==sign)crossings++;if(next)sign=next;}
 return {samples:xs.length,observedWindowMs:xs.at(-1).time-xs[0].time,returnBps:round(net*1e4),realizedVolBps:round(rv*1e4),
  range:round(Math.max(...ps)-Math.min(...ps)),pathEfficiency:path?round(Math.abs(net)/path):null,
  directionalConsistency:up+down?round(Math.max(up,down)/(up+down)):null,openingCrossings:opening?crossings:null,
  openingOffsetOverRealizedScale:opening&&rv>0?round((ps.at(-1)-opening)/(ps.at(-1)*rv)):null};
}
export class P2Context {
 constructor({write=()=>{},clock=Date.now}={}){
  this.write=write;this.clock=clock;this.segmentId=randomUUID();this.sources={};this.seen=new Map();this.history=[];this.latest=null;
  this.epochs={binance:0,coinbase:0};this.prices={};this.depth=null;this.activity=emptyActivity();this.counts={accepted:0,rejected:0,duplicates:0,sequenceGaps:0,frames:0};this.error=null;
 }
 emit(kind,row){if(this.error)return;try{this.write(kind,{version:p2Version,segmentId:this.segmentId,...row});}catch(e){this.error=e.message;}}
 invalidate(venue){this.epochs[venue]++;delete this.prices[venue];if(venue==='binance')this.depth=null;for(const key of this.seen.keys())if(key.startsWith(venue+':'))this.seen.delete(key);}
 status(row){
  this.sources[row.venue]=row;
  if(['connecting','disconnected','stopped','error','stale','rejected'].includes(row.state))this.invalidate(row.venue);
  this.emit('feed',{kind:'connection',...row});
 }
 ingest(row){
  if(this.error)return false;
  const fail=reason=>{this.counts.rejected++;this.invalidate(row.venue);this.emit('feed',{kind:'rejected',time:this.clock(),venue:row.venue,reason,sourceAt:row.sourceAt,receivedAt:row.receivedAt,sequence:row.sequence});return false;};
  if(!['binance','coinbase'].includes(row.venue)||!Number.isFinite(row.receivedAt)||row.receivedAt>this.clock())return fail('invalid-receipt');
  if(row.kind!=='depth'&&(!Number.isFinite(row.sourceAt)||row.sourceAt>row.receivedAt||row.publishedAt!==null&&row.publishedAt>row.receivedAt))return fail('future-or-missing-source-time');
  const key=row.venue+':'+row.kind,prior=this.seen.get(key);
  if(prior&&prior.connectionId===row.connectionId){
   if(row.sequence===prior.sequence){
    const shape=({receivedAt,...r})=>JSON.stringify(r);
    if(shape(row)!==shape(prior))return fail('same-sequence-conflict');
    this.counts.duplicates++;return false;
   }
   if(row.sequence<prior.sequence||row.sourceAt!==null&&row.sourceAt<prior.sourceAt||row.receivedAt<prior.receivedAt)return fail('regressed-sequence-or-clock');
   // Coinbase ticker sequence intentionally skips non-ticker messages; depth is a full top-five snapshot.
   if(row.kind==='trade'&&row.sequence!==prior.sequence+1){this.counts.sequenceGaps++;this.epochs[row.venue]++;this.emit('feed',{kind:'aggregate-trade-gap',time:row.receivedAt,previous:prior.sequence,current:row.sequence});}
  }else if(prior){this.invalidate(row.venue);}
  this.seen.set(key,row);this.counts.accepted++;
  if(row.kind==='depth')this.depth=row;
  else this.prices[row.venue]=row;
  if(row.kind==='trade'){
   const a=this.activity;a.messages++;a.tradeCount+=row.tradeCount;a.quantityBtc+=row.quantity;
   a[row.takerSide==='buy'?'takerBuyBtc':'takerSellBtc']+=row.quantity;
   a.firstSourceAt??=row.sourceAt;a.lastSourceAt=row.sourceAt;a.firstReceivedAt??=row.receivedAt;a.lastReceivedAt=row.receivedAt;
  }
  return true;
 }
 sample({frame,prices=[],reference,now,sessionId,experimentId,trade,decision}){
  if(this.error||!frame||frame.now>now||this.latest&&frame.now<=this.latest.frameAt)return null;
  const venues={};
  for(const venue of ['binance','coinbase']){
   const p=this.prices[venue],ready=fresh(p,now);
   venues[venue]={ready,epoch:this.epochs[venue],quote:venue==='binance'?'USDT':'USD',price:ready?p.price:null,
    sourceAt:p?.sourceAt??null,publishedAt:p?.publishedAt??null,receivedAt:p?.receivedAt??null,sequence:p?.sequence??null,connectionId:p?.connectionId??null,
    sourceAgeMs:p?now-p.sourceAt:null,receiptAgeMs:p?now-p.receivedAt:null,deliveryMs:p?p.receivedAt-p.sourceAt:null,
    reason:ready?null:p?'stale-or-future':'no-current-segment-data'};
  }
  const tw=reference,twReady=Boolean(tw&&tw.timestamp<=now&&tw.receivedAt<=now&&now-tw.timestamp<=5000&&now-tw.receivedAt<=5000);
  const twPrice=twReady?e18ToPrice(tw.valueE18):null;
  const op=prices.find(p=>p.time===frame.market.start&&p.receivedAt<=now),opening=op?e18ToPrice(op.valueE18):null;
  const usdGap=venues.coinbase.ready&&twPrice?round(venues.coinbase.price-twPrice):null;
  const sample={time:now,...venues,usdGap};
  this.history.push(sample);this.history=this.history.filter(r=>r.time>=now-65000);
  const windows=Object.fromEntries(['binance','coinbase'].map(v=>[v,Object.fromEntries([10,30,60].map(s=>[s,spotWindow(this.history,now,s,v,v==='coinbase'?opening:null)]))]));
  const d=this.depth,depthReady=Boolean(d&&d.receivedAt<=now&&now-d.receivedAt<=3000);
  const bidSize=depthReady?d.bids.reduce((s,l)=>s+l[1],0):null,askSize=depthReady?d.asks.reduce((s,l)=>s+l[1],0):null;
  const activity={...this.activity,quantityBtc:round(this.activity.quantityBtc),takerBuyBtc:round(this.activity.takerBuyBtc),takerSellBtc:round(this.activity.takerSellBtc),
   from:this.latest?.time??null,to:now,intervalComplete:Boolean(this.latest&&now-this.latest.time<=3000&&this.latest.venues.binance.epoch===venues.binance.epoch)};
  sample.activity=activity;
  const activityWindows=Object.fromEntries([10,30,60].map(seconds=>{
   const xs=this.history.filter(r=>r.activity?.from>=now-seconds*1000&&r.time<=now),ok=xs.length>=Math.floor(seconds/2)&&
    xs[0].activity.from<=now-seconds*1000+2000&&xs.every(r=>r.activity.intervalComplete);
   if(!ok)return[seconds,null];
   const sum=key=>round(xs.reduce((n,r)=>n+r.activity[key],0)),qty=sum('quantityBtc'),buy=sum('takerBuyBtc'),sell=sum('takerSellBtc');
   return[seconds,{basis:'receipt-time-intervals',from:xs[0].activity.from,to:now,messages:sum('messages'),tradeCount:sum('tradeCount'),quantityBtc:qty,
    observedTakerImbalance:qty?round((buy-sell)/qty):null}];
  }));
  const pm={};
  for(const outcome of ['Up','Down']){
   const b=frame.books.find(b=>b.tokenId===frame.market.tokens[outcome]);
   pm[outcome]=researchBook(b,frame.market,outcome,now,decision?.candidates.find(c=>c.outcome===outcome)?.move30??null);
  }
  const skew=venues.binance.ready&&venues.coinbase.ready?Math.abs(venues.binance.sourceAt-venues.coinbase.sourceAt):null;
  const pairReady=skew!==null&&skew<=1000;
  const gapRows=this.history.filter(r=>r.time>=now-30000&&r.time<=now);
  const gapContinuous=windows.coinbase[30]&&gapRows.every(r=>r.usdGap!==null);
  const ny=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(now);
  const row={id:`${sessionId}:p2:${this.segmentId}:${now}`,version:p2Version,segmentId:this.segmentId,sessionId,experimentId,time:now,frameAt:frame.now,
   slug:frame.market.slug,marketStart:frame.market.start,marketEnd:frame.market.end,conditionId:frame.market.conditionId,fee:frame.market.fee,tick:frame.market.tick,
   managedTradeId:trade?.id??null,origin:trade?.origin??'automatic',selectedOutcome:decision?.selected?.outcome??null,remainingSeconds:(frame.market.end-now)/1000,
   hongKongTime:new Date(now+8*3600000).toISOString().slice(0,19),newYorkLocalClock:ny,usExchangeOpen:null,
   venues,windows,pm,reference:{ready:twReady,price:twPrice,sourceAt:tw?.timestamp??null,publishedAt:tw?.publishedAt??null,receivedAt:tw?.receivedAt??null,
    openingPrice:opening,openingReceivedAt:op?.receivedAt??null,twapOpeningOffset:twPrice&&opening?round(twPrice-opening):null},
   deviations:{spotUsdMinusTwapUsd:usdGap,spotTwapGapChange30:gapContinuous?round(usdGap-gapRows[0].usdGap):null,
    crossVenueUsdtUsdBps:pairReady?round((venues.binance.price/venues.coinbase.price-1)*1e4):null,sourceSkewMs:skew,
    basisMeaning:'cross-venue and quote-currency difference, not a pure USDT/USD exchange rate or executable arbitrage'},
   activity,activityWindows,binanceDepth:{ready:depthReady,sourceAt:null,receivedAt:d?.receivedAt??null,sequence:d?.sequence??null,sourceTimeVerified:false,
    spread:depthReady?round(d.asks[0][0]-d.bids[0][0]):null,imbalance5:depthReady?round((bidSize-askSize)/(bidSize+askSize)):null,
    bids:depthReady?d.bids:[],asks:depthReady?d.asks:[]},
   quality:{diagnosticOnly:true,calibratedProbability:false,sourceClockSemantics:'exchange trade time versus local availability',counts:{...this.counts}}};
  this.counts.frames++;this.activity=emptyActivity();this.latest=row;this.emit('context',row);return row;
 }
 link(now,slug){return this.latest&&!this.error&&this.latest.slug===slug&&now>=this.latest.time&&now-this.latest.time<=3000?this.latest.id:null;}
 summary(now=this.clock()){
  const l=this.latest,current=l&&now>=l.time&&now-l.time<=3000;
  return {version:p2Version,segmentId:this.segmentId,error:this.error,diagnosticOnly:true,counts:this.counts,sources:this.sources,
   lastAt:l?.time??null,current:Boolean(current),latest:current?l:null};
 }
}
