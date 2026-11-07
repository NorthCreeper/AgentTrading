import {round} from '../paper-broker.mjs';
import {freshBook,depthQuote} from './strategy.mjs';
import {e18ToPrice} from './chart-model.mjs';

export const marketExitRevision='market-information-v1';
// A falsifiable signal rule, not a calibrated probability or an optimal stopping model.
export const marketExitProtocol=Object.freeze({revision:marketExitRevision,confirmationMs:5000,lookbackMs:30000,basis:'adaptive-book-momentum',btcRole:'diagnostic-only'});
function window(rows,now,ms,value,minCount) {
 const xs=rows.filter(r=>r.time>=now-ms&&r.time<=now);
 if(xs.length<minCount || xs[0].time>now-ms+2000 || now-xs.at(-1).time>5000 ||
  xs.some((r,i)=>!Number.isFinite(value(r)) || i && (r.time<=xs[i-1].time||r.time-xs[i-1].time>5000)))return null;
 return xs;
}
export function marketInformationExit(trade,held,book,market,now,config,history,prices=[],researchMode='pm-only') {
 let decision={time:now,revision:marketExitRevision,status:'data-unavailable',reason:'等待连续且可成交的盘口信息',
  heldMs:now-trade.openedAt,remainingMs:market.end-now,holdLimitMs:null,confirmationMs:5000,confirmedMs:0};
 const finish=(reason=null)=>{trade.holdingDecision=decision;return reason?{reason,net:decision.netAtVisibleDepth,limit:decision.limit,visibleFilled:decision.visibleFilled}:null;};
 const reset=()=>{delete trade.marketReversal;};
 if(now>=market.end){reset();decision.status='awaiting-resolution';decision.reason='盘口已结束，保留剩余份额等待官方结果核实';return finish();}
 if(trade.slug!==market.slug || trade.tokenId!==market.tokens[trade.outcome] || book?.tokenId!==trade.tokenId ||
  !freshBook(book,now,config.staleMs) || !Number.isFinite(held)||held<=0||!book.bids.length) {reset();return finish();}
 const limit=round(Math.max(market.tick,book.bids[0][0]-.02)),q=depthQuote(book,'sell',held,market,limit);
 if(!q?.filled){reset();return finish();}
 const net=round(q.notional-q.fees-trade.costPerShare*q.filled);
 Object.assign(decision,{limit,netAtVisibleDepth:net,completeDepth:q.complete,visibleFilled:q.filled,bookAt:book.timestamp});
 if(q.complete){trade.maxFavorableNet=Math.max(trade.maxFavorableNet??net,net);trade.maxAdverseNet=Math.min(trade.maxAdverseNet??net,net);}
 const key=trade.outcome.toLowerCase(),sign=trade.outcome==='Up'?1:-1;
 const rows=history.filter(r=>r.slug===market.slug);
 const value=r=>r[key+'BookValid']===false?NaN:r[key];
 const pm=window(rows,now,30000,value,10),short=window(rows,now,10000,value,4);
 const known=prices.filter(p=>Number.isFinite(p.receivedAt)&&p.receivedAt<=now&&p.time<=now);
 const btc=window(known,now,30000,p=>e18ToPrice(p.valueE18),10),btcShort=window(known,now,10000,p=>e18ToPrice(p.valueE18),4);
 const latest=known.at(-1);
 if(!pm||!short||!book.asks.length) {reset();return finish();}
 const btcReady=Boolean(btc&&btcShort&&latest&&now-latest.receivedAt<=5000&&now-latest.time<=5000);
 if(researchMode!=='pm-only'&&!btcReady){reset();return finish();}
 const opening=known.find(p=>p.time===market.start),last=btcReady?e18ToPrice(latest.valueE18):null;
 const move30=round(pm.at(-1)[key]-pm[0][key]),move10=round(short.at(-1)[key]-short[0][key]);
 const btc30=btcReady?sign*(last-e18ToPrice(btc[0].valueE18)):null,btc10=btcReady?sign*(last-e18ToPrice(btcShort[0].valueE18)):null;
 const offset=btcReady&&opening?sign*(last-e18ToPrice(opening.valueE18)):null;
 // Realized 30-second price variation and current spread set the noise scale.
 const variation=Math.sqrt(pm.slice(1).reduce((s,r,i)=>s+(r[key]-pm[i][key])**2,0));
 const spread=book.asks[0][0]-book.bids[0][0],threshold=Math.max(market.tick,spread,variation);
 if(spread<=0){reset();return finish();}
 const pmAgainst=move30<=-threshold && move10<0;
 const btcAgainst=btc30<0 && btc10<0;
 const sourceCrossed=offset!==null && offset<0 && btc10<0;
 const support=offset!==null && offset>0 && btc30>=0 && btc10>=0;
 const adverse=pmAgainst && (researchMode==='joint'?(btcAgainst||sourceCrossed):researchMode==='pm-only'?true:!support);
 const sampleAt=researchMode==='pm-only'?pm.at(-1).time:Math.min(pm.at(-1).time,latest.time),prior=trade.marketReversal;
 if(!adverse)reset();
 else if(prior && (now<prior.observedAt||sampleAt<prior.sampleAt||book.timestamp<prior.bookAt))reset();
 else if(!prior || now-prior.observedAt>5000 || sampleAt-prior.sampleAt>5000) {
  trade.marketReversal={since:sampleAt,sampleAt,bookAt:book.timestamp,observedAt:now,confirmedMs:0};
 } else if(sampleAt>prior.sampleAt && book.timestamp>prior.bookAt) {
  prior.sampleAt=sampleAt;prior.bookAt=book.timestamp;prior.observedAt=now;prior.confirmedMs=sampleAt-prior.since;
 }
 const confirmedMs=trade.marketReversal?.confirmedMs??0,exit=adverse&&confirmedMs>=5000;
 Object.assign(decision,{status:exit?'exit':adverse?'confirming-reversal':support?'supported-hold':'hold',
  reason:exit?'盘口跌势超过当前噪声与价差，短期仍走弱，已连续确认 5 秒':adverse?
   `盘口跌幅超过波动尺度且短期仍走弱，已确认 ${Math.min(confirmedMs,5000)/1000} / 5 秒`:support?
   'BTC 仍位于本方向开盘基准一侧，10 秒与 30 秒变化支持持有':'盘口尚未持续转弱，继续观察至信号变化或结算',
  move30,move10,btcReady,btcMove30Usd:btc30===null?null:round(btc30),btcMove10Usd:btc10===null?null:round(btc10),btcOpeningOffsetUsd:offset===null?null:round(offset),
  noiseThreshold:round(threshold),spread:round(spread),realizedVariation:round(variation),
  pmAgainst,btcAgainst,sourceCrossed,holdingSupport:support,btcRole:'diagnostic-only',confirmedMs,sampleAt,btcAt:latest?.time??null});
 return finish(exit?decision.reason:null);
}
