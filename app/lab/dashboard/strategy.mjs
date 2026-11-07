import { feeFor, round } from '../paper-broker.mjs';
import { e18ToPrice } from './chart-model.mjs';

// Adapted ideas: crypto-hft/orderbook.ts (OBI), market-making/engine.ts
// (weighted midpoint, EMA), venue-arbitrage.ts (net cost gate).
// This short-horizon reversion hypothesis is NOT a calibrated settlement probability.
export const strategyDefaults={execution:'shadow',model:'reference',exitPolicy:'legacy',minNetEdge:.01,costBuffer:.01,maxSpread:.04,stopLossUsd:.5};
export function validateStrategyConfig(config) {
  if(!config || typeof config!=='object') throw Error('策略参数无效');
  for(const [key,value] of Object.entries(config)) {
    if(key==='execution') {if(!['shadow','paper'].includes(value)) throw Error('策略执行方式无效');continue;}
    if(key==='model') {if(!['reference','execution-edge','forward-momentum','ray-twap-band'].includes(value))throw Error('策略模型无效');continue;}
    if(key==='exitPolicy') {if(!['legacy','market'].includes(value))throw Error('退出模式无效');continue;}
    const ranges={minNetEdge:[.005,.2],costBuffer:[.005,.2],maxSpread:[.01,.2],stopLossUsd:[0,10]};
    const range=ranges[key];
    if(!range || !Number.isFinite(value) || value<range[0] || value>range[1]) throw Error(`策略参数 ${key} 超出范围`);
  }
}
export const freshBook=(book,now,staleMs=3000)=>Boolean(book && ['timestamp','receivedAt'].every(k=>
  Number.isFinite(book[k]) && now>=book[k] && now-book[k]<=staleMs));

export function depthQuote(book,side,size,market,limit=side==='buy'?1:0) {
  if(!book || !Number.isFinite(size) || size<=0) return null;
  let filled=0,notional=0,fees=0,worst=null;
  for(const [price,available] of side==='buy'?book.asks:book.bids) {
    if(side==='buy'?price>limit:price<limit) break;
    const quantity=Math.min(available,size-filled);
    if(quantity<=0) continue;
    filled+=quantity; notional+=quantity*price; fees+=feeFor(quantity,price,market.fee); worst=price;
    if(filled>=size-1e-8) break;
  }
  return {filled:round(filled),complete:filled>=size-1e-8,average:filled?notional/filled:null,
    notional:round(notional),fees:round(fees),worst};
}

function continuous(rows,start,end,key='time',maxGap=5000) {
  if(rows.length<10 || rows[0][key]>start+2000 || end-rows.at(-1)[key]>maxGap) return false;
  return rows.every((row,i)=>i===0 || row[key]>rows[i-1][key] && row[key]-rows[i-1][key]<=maxGap);
}

export function evaluateStrategy({frame,history=[],prices=[],config,strategy=strategyDefaults,now}) {
  const result={version:'reference-reversion-v1',time:now,calibrated:false,execution:strategy.execution,
    reason:'等待行情',candidates:[],selected:null};
  const reject=reason=>({...result,reason});
  if(!frame) return reject('等待行情');
  const {market,books}=frame,lookback=30_000;
  if(now<market.start+15_000 || now>=market.end-90_000) return reject('不在策略开仓时段');
  if(config.size<market.minSize) return reject('配置份额低于当前盘口最小份额');
  const recent=history.filter(r=>r.slug===market.slug && r.time>=now-lookback && r.time<=now);
  const referencePrices=prices.filter(r=>r.time>=now-lookback && r.time<=now);
  if(!continuous(recent,now-lookback,now) || !continuous(referencePrices,now-lookback,now))
    return reject('需要连续 30 秒的同轮盘口与 TWAP 数据');
  const last=referencePrices.at(-1);
  if(now-last.time>5000 || !Number.isFinite(last.receivedAt) || now<last.receivedAt || now-last.receivedAt>5000)
    return reject('TWAP 数据过期');
  const firstPrice=e18ToPrice(referencePrices[0].valueE18),lastPrice=e18ToPrice(last.valueE18);
  if(firstPrice===null || lastPrice===null) return reject('TWAP 价格无效');
  const move=(lastPrice/firstPrice-1)*100;
  for(const outcome of ['Up','Down']) {
    const tokenId=market.tokens[outcome],book=books.find(b=>b.tokenId===tokenId);
    const c={outcome,tokenId,reason:'盘口无效',eligible:false,mode:null,reference:null,makerEdge:null,takerEdge:null,twapMovePct:move};
    result.candidates.push(c);
    if(!freshBook(book,now,config.staleMs) || !book.bids.length || !book.asks.length) {c.reason='盘口过期或深度为空';continue;}
    const key=outcome.toLowerCase(),points=recent.map(r=>r[key]);
    if(points.some(p=>!Number.isFinite(p))) {c.reason='历史报价有缺口';continue;}
    const bid=book.bids[0][0],ask=book.asks[0][0],spread=ask-bid;
    const bidDepth=book.bids.slice(0,5).reduce((a,l)=>a+l[1],0),askDepth=book.asks.slice(0,5).reduce((a,l)=>a+l[1],0);
    const obi=(bidDepth-askDepth)/Math.max(1e-8,bidDepth+askDepth);
    const micro=(bid*book.asks[0][1]+ask*book.bids[0][1])/(book.bids[0][1]+book.asks[0][1]);
    let ema=points[0];
    for(let i=1;i<points.length;i++) {const alpha=1-Math.exp(-(recent[i].time-recent[i-1].time)/15_000);ema+=alpha*(points[i]-ema);}
    const reference=.75*ema+.25*micro;
    const targetBid=Math.max(market.tick,Math.min(1-market.tick,reference-spread/2));
    const exitFee=feeFor(1,targetBid,market.fee);
    const buy=depthQuote(book,'buy',config.size,market);
    Object.assign(c,{reference,ema,micro,spread,obi,bidDepth,askDepth,targetBid,makerPrice:bid,
      makerEdge:round(targetBid-exitFee-bid-strategy.costBuffer),
      takerEdge:buy?.complete?round(targetBid-exitFee-buy.average-buy.fees/config.size-strategy.costBuffer):null,
      entryFeePerShare:buy?.complete?buy.fees/config.size:null,exitFeePerShare:exitFee,
      takerPrice:buy?.average??null,limit:buy?.worst??ask,costBuffer:strategy.costBuffer});
    if(spread<=0 || spread>strategy.maxSpread) {c.reason='价差过大';continue;}
    if(!buy?.complete || bidDepth<config.size) {c.reason='买入或退出可见深度不足';continue;}
    if((outcome==='Up'?move:-move)<=0) {c.reason='TWAP 方向未确认';continue;}
    if(obi<-.2) {c.reason='订单簿买方深度偏弱';continue;}
    if(c.takerEdge>=strategy.minNetEdge) {c.mode='taker';c.reason='参考价回归假设下，吃单扣费后有余量';}
    else if(c.makerEdge>=strategy.minNetEdge) {c.mode='maker_then_taker';c.reason='仅挂单价格有余量；超时须重新检查吃单';}
    else {c.reason='扣除双边费用及缓冲后余量不足';continue;}
    c.eligible=true;
  }
  result.selected=result.candidates.filter(c=>c.eligible).sort((a,b)=>(b.mode==='taker'?b.takerEdge:b.makerEdge)-(a.mode==='taker'?a.takerEdge:a.makerEdge))[0]??null;
  result.reason=result.selected?`${strategy.execution==='shadow'?'影子信号':'模拟候选'}：${result.selected.outcome} · ${result.selected.reason}`:'没有满足全部条件的候选';
  return result;
}

export function replacementAllowed(decision,intent,book,market,now,config,strategy,size) {
  const candidate=decision?.candidates.find(c=>c.tokenId===intent.tokenId);
  if(!candidate?.eligible || !freshBook(book,now,config.staleMs)) return false;
  const quote=depthQuote(book,'buy',size,market,intent.limit);
  if(!quote?.complete) return false;
  const edge=candidate.targetBid-candidate.exitFeePerShare-quote.average-quote.fees/size-strategy.costBuffer;
  return edge>=strategy.minNetEdge;
}

export function exitDecision(trade,held,book,market,now,config,strategy,candidate) {
  if(!freshBook(book,now,config.staleMs) || !Number.isFinite(held) || held<1e-8) return null;
  const quote=depthQuote(book,'sell',held,market);
  if(!quote?.filled) return null;
  // Do not value an unfillable remainder as sold. A partial risk exit is still useful.
  const net=quote.notional-quote.fees-trade.costPerShare*quote.filled;
  const depth=book.bids.slice(0,5).reduce((s,l)=>s+l[1],0);
  let reason=null;
  if(now>=market.end-35_000) reason='临近结束降低持仓';
  else if(strategy.stopLossUsd>0 && net<=-strategy.stopLossUsd) reason='达到策略持仓损失阈值';
  else if(trade.initialDepth>0 && depth<trade.initialDepth*.4) reason='买盘深度明显下降';
  else if(now-trade.openedAt>=config.holdMs) reason='达到最长持有时间';
  else if(trade.entryDecision?.version!=='execution-edge-v2' && net>=strategy.minNetEdge*quote.filled) reason='扣费后达到退出目标';
  else if(trade.entryDecision?.version!=='execution-edge-v2' && candidate?.reference!=null && candidate.targetBid-candidate.exitFeePerShare-(quote.average-quote.fees/quote.filled)<=0) reason='继续持有的参考价余量消失';
  return reason?{reason,net:round(net),limit:quote.worst}:null;
}
