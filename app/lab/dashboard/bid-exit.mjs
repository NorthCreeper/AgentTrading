import {freshBook,depthQuote} from './strategy.mjs';
import {round} from '../paper-broker.mjs';

export const bidExitVersion='executable-bid-exit-v1';
export const bidExitProtocol=Object.freeze({version:bidExitVersion,lookbackMs:30000,shortMs:10000,confirmationMs:5000,
 basis:'same-current-inventory net liquidation per share',maxGapMs:3000,fullDepthRequired:true,btcRole:'not-used'});
export class BidHistory {
 rows=[];
 add(frame,now){
  if(this.rows.length&&now<=this.rows.at(-1).time)return;
  this.rows=this.rows.filter(r=>r.slug===frame.market.slug&&r.time>=now-35000);
  this.rows.push({time:now,slug:frame.market.slug,conditionId:frame.market.conditionId,books:structuredClone(frame.books),fee:{...frame.market.fee},tick:frame.market.tick});
 }
}
// Pure research signal. No controller, broker, orders, or capital are touched.
export function executableBidExit(trade,held,book,market,now,config,rows){
 const reset=()=>{delete trade.bidReversal;};
 const finish=(status,reason,extra={})=>{trade.bidDecision={version:bidExitVersion,time:now,status,reason,...extra};return null;};
 if(now>=market.end){reset();return finish('awaiting-resolution','轮次结束，等待核实结算');}
 if(trade.slug!==market.slug||trade.tokenId!==market.tokens[trade.outcome]||book?.tokenId!==trade.tokenId||!Number.isFinite(held)||held<=0||
  !freshBook(book,now,config.staleMs)||!book.bids.length){reset();return finish('data-unavailable','没有新鲜且匹配的可卖买盘');}
 const values=rows.filter(r=>r.slug===market.slug&&r.conditionId===market.conditionId&&r.time>=now-30000&&r.time<=now).map(r=>{
  const b=r.books.find(b=>b.tokenId===trade.tokenId),valid=freshBook(b,r.time,config.staleMs)&&b?.bids.length;
  const q=valid?depthQuote(b,'sell',held,{fee:r.fee},round(Math.max(r.tick,b.bids[0][0]-.02))):null;
  return {time:r.time,sourceAt:b?.timestamp,value:q?.complete?(q.notional-q.fees)/held:null};
 });
 const window=ms=>{
  const xs=values.filter(r=>r.time>=now-ms),min=ms===30000?10:4;
  return xs.length>=min&&xs[0].time<=now-ms+2000&&now-xs.at(-1).time<=2000&&new Set(xs.map(r=>r.sourceAt)).size>=min&&
   xs.every((r,i)=>Number.isFinite(r.value)&&(!i||r.time>xs[i-1].time&&r.time-xs[i-1].time<=3000&&r.sourceAt>=xs[i-1].sourceAt))?xs:null;
 };
 const long=window(30000),short=window(10000),limit=round(Math.max(market.tick,book.bids[0][0]-.02));
 const q=depthQuote(book,'sell',held,market,limit);
 if(!long||!short||!q?.complete){reset();return finish('data-unavailable','等待连续且足额可卖的持仓价值观察');}
 const current=(q.notional-q.fees)/held;
 const move30=current-long[0].value,move10=current-short[0].value;
 const variation=Math.sqrt(long.slice(1).reduce((s,r,i)=>s+(r.value-long[i].value)**2,0));
 const spread=book.asks.length?book.asks[0][0]-book.bids[0][0]:null;
 if(spread!==null&&spread<=0){reset();return finish('data-unavailable','买卖盘交叉');}
 const depthSlippage=Math.max(0,book.bids[0][0]-q.average),threshold=Math.max(market.tick,spread??0,depthSlippage,variation);
 const adverse=move30<=-threshold+1e-10&&move10<0;
 const prior=trade.bidReversal;
 if(!adverse)reset();
 else if(!prior||now-prior.observedAt>3000||now<prior.observedAt||book.timestamp<prior.sourceAt||prior.size!==held){
  trade.bidReversal={since:now,sourceAt:book.timestamp,observedAt:now,confirmedMs:0,size:held};
 }else if(book.timestamp>prior.sourceAt){prior.sourceAt=book.timestamp;prior.observedAt=now;prior.confirmedMs=now-prior.since;}
 const confirmedMs=trade.bidReversal?.confirmedMs??0,exit=adverse&&confirmedMs>=5000;
 const status=exit?'exit':adverse?'confirming-reversal':move30>=0&&move10>=0?'supported-hold':'hold';
 const reason=exit?'足额净卖出价值持续转弱并确认5秒':adverse?'净卖出价值转弱，等待连续确认':status==='supported-hold'?'净卖出价值未走弱，继续观察':'尚无持续转弱证据';
 finish(status,reason,{move30:round(move30),move10:round(move10),threshold:round(threshold),variation:round(variation),spread,depthSlippage:round(depthSlippage),
  netPerShare:round(current),netProceeds:round(q.notional-q.fees),confirmedMs,sourceAt:book.timestamp,limit,size:held});
 return exit?{reason,limit,net:round(q.notional-q.fees-trade.cost),visibleFilled:q.filled}:null;
}
