import { round } from '../paper-broker.mjs';
import { e18ToPrice } from './chart-model.mjs';
import { freshBook, depthQuote } from './strategy.mjs';

// Descriptive, receive-time-only features. These never authorize or veto an order.
export function entryContext({frame,history=[],prices=[],outcome,now,staleMs=3000}) {
  const m=frame.market,key=outcome.toLowerCase(),askKey=key+'Ask',validKey=key+'BookValid';
  const rows=history.filter(r=>r.slug===m.slug && r.time>=m.start && r.time<=now).sort((a,b)=>a.time-b.time);
  const valid=r=>r?.[validKey]===true && Number.isFinite(r[askKey]);
  let first=null,firstCrossing=false,total=0,run=0,runKnown=false,previous=null,missing=false;
  for(const r of rows) {
    const contiguous=previous && r.time>previous.time && r.time-previous.time<=5000 && valid(previous) && valid(r);
    if(!valid(r) || previous && !contiguous)missing=true;
    if(valid(r) && r[askKey]<=.1) {
      if(first===null){first=r.time;firstCrossing=Boolean(contiguous && previous[askKey]>.1);}
      if(contiguous && previous[askKey]<=.1){total+=(r.time-previous.time)/1000;run+=(r.time-previous.time)/1000;}
      else {run=0;runKnown=Boolean(contiguous && previous[askKey]>.1);}
    } else {run=0;runKnown=valid(r);}
    previous=r;
  }
  const last=rows.at(-1),fresh=valid(last)&&now-last.time<=staleMs;
  const ps=prices.filter(p=>p.time<=now&&p.receivedAt<=now&&p.time>=now-60000&&e18ToPrice(p.valueE18)!==null).sort((a,b)=>a.time-b.time);
  const pLast=ps.at(-1),btcFresh=pLast&&now-pLast.time<=5000&&now-pLast.receivedAt<=5000;
  const btc=btcFresh?e18ToPrice(pLast.valueE18):null;
  const opening=prices.find(p=>p.time===m.start&&p.receivedAt<=now),base=opening?e18ToPrice(opening.valueE18):null;
  const contiguousPrices=ps.length>=10&&ps[0].time<=now-58000&&btcFresh&&ps.every((p,i)=>!i||p.time>ps[i-1].time&&p.time-ps[i-1].time<=5000);
  const values=ps.map(p=>e18ToPrice(p.valueE18)),range=contiguousPrices?Math.max(...values)-Math.min(...values):null;
  const offset=btc!==null&&base!==null?btc-base:null;
  const up=frame.books.find(b=>b.tokenId===m.tokens.Up),down=frame.books.find(b=>b.tokenId===m.tokens.Down);
  const mid=freshBook(up,now,staleMs)&&up.bids.length&&up.asks.length?(up.bids[0][0]+up.asks[0][0])/2:null;
  let pairCost=null;
  if([up,down].every(b=>freshBook(b,now,staleMs)&&b.asks.length)) {
    const quotes=[up,down].map(b=>depthQuote(b,'buy',m.minSize,m,Math.min(1-m.tick,b.asks[0][0]+.02)));
    if(quotes.every(q=>q?.complete))pairCost=round(quotes.reduce((s,q)=>s+q.notional+q.fees,0)/m.minSize);
  }
  return {version:'entry-context-v1',descriptiveOnly:true,secondsRemaining:Math.max(0,(m.end-now)/1000),
    hongKongHour:new Date(now+8*3600000).getUTCHours(),
    firstObservedAskBelow10AgeSeconds:first===null?null:(first-m.start)/1000,
    firstLowWasObservedCrossing:firstCrossing,
    observedBelow10Seconds:round(total),currentBelow10RunSeconds:fresh?round(run):null,
    currentLowRunStartKnown:Boolean(fresh&&runKnown),
    roundStartCovered:Boolean(rows.length&&rows[0].time<=m.start+5000&&valid(rows[0])),hasObservationGap:missing,
    twapOffsetUsd:offset===null?null:round(offset),twapRange60Usd:range===null?null:round(range),
    offsetToRecentTwapRange:offset!==null&&range>0?round(offset/range):null,
    pmTwapDirectionDisagree:offset!==null&&offset!==0&&mid!==null&&mid!==.5?(mid-.5)*offset<0:null,
    equalSharePairCost:pairCost,pairBookTimestampDifferenceMs:up&&down?Math.abs(up.timestamp-down.timestamp):null,
    note:'Observed ask durations exclude gaps; TWAP range ratio is not a calibrated probability. Pair quotes are not atomic.'};
}
