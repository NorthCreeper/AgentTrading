import { amountQuote, amountExecutionVersion } from '../amount-order.mjs';
import { round } from '../paper-broker.mjs';
import { depthQuote, freshBook } from './strategy.mjs';
import { e18ToPrice } from './chart-model.mjs';
import { entryContext } from './entry-context.mjs';
import { referenceMaxAgeMs } from './reference-price.mjs';

export const forwardProtocol = Object.freeze({ version:'forward-momentum-v1', executionRevision:'synchronized-reference-v2', exitRevision:'confirmed-reversal-v1', reversalConfirmationMs:5000, referenceMaxAgeMs, lookbackMs:30000,
  minimumMove:.03, entryStartMs:30000, entryEndMs:210000, exitBeforeEndMs:60000,
  maxTradesPerRound:1, exitSlippageCents:2, exitRetryMs:2000, reviewEveryTrades:20 });
function continuous(rows,start,end,maxEndAgeMs=3000) {
  return rows.length>=10 && rows[0].time<=start+2000 && end-rows.at(-1).time<=maxEndAgeMs &&
    rows.every((r,i)=>!i || r.time>rows[i-1].time && r.time-rows[i-1].time<=5000);
}
export function evaluateForward({frame,history=[],prices=[],config,strategy,now,researchPolicy=null}) {
  const result={version:forwardProtocol.version,executionVersion:amountExecutionVersion,time:now,calibrated:false,execution:strategy.execution,
    historicalProfitGate:false,reason:'等待前瞻模拟信号',candidates:[],selected:null};
  const reject=reason=>({...result,reason});
  if(!frame || frame.now>now)return reject('等待当前盘口');
  const {market,books}=frame,age=now-market.start;
  if(age<forwardProtocol.entryStartMs || age>=forwardProtocol.entryEndMs)return reject('前瞻模拟开仓窗口为本轮第 30–210 秒');
  const recent=history.filter(r=>r.slug===market.slug && r.time>=now-30000 && r.time<=now);
  const ps=prices.filter(r=>r.time>=now-30000 && r.time<=now && Number.isFinite(r.receivedAt) && r.receivedAt<=now);
  // Keep the frozen research baseline's 3-second tail condition for comparison.
  const bookContinuous=continuous(recent,now-30000,now),btcContinuous=continuous(ps,now-30000,now,researchPolicy?3000:referenceMaxAgeMs);
  result.dataQuality={bookContinuous,btcContinuous,btcLatestAgeMs:ps.length?now-ps.at(-1).time:null};
  if(!bookContinuous)return reject('需要连续 30 秒同轮盘口记录');
  if((!researchPolicy || researchPolicy.strict) && !btcContinuous)return reject('BTC 均价未连续覆盖 30 秒；盘口连续性已通过');
  if(!ps.length || now-ps.at(-1).time>referenceMaxAgeMs || now-ps.at(-1).receivedAt>referenceMaxAgeMs)return reject('BTC 均价过期');
  const first=ps[0].time<=now-28000?e18ToPrice(ps[0].valueE18):null,last=e18ToPrice(ps.at(-1).valueE18);
  if(!last)return reject('BTC 均价无效');
  const opening=prices.find(p=>p.time===market.start && p.receivedAt<=now),openingPrice=opening?e18ToPrice(opening.valueE18):null;
  for(const outcome of ['Up','Down']) {
    const tokenId=market.tokens[outcome],book=books.find(b=>b.tokenId===tokenId),key=outcome.toLowerCase();
    const c={version:forwardProtocol.version,executionVersion:amountExecutionVersion,outcome,tokenId,eligible:false,mode:'taker',reference:null,makerEdge:null,takerEdge:null,
      scoreType:'past-momentum-minus-current-costs',reason:'等待报价',ageSeconds:age/1000,
      btcMove30Bps:first?round((last/first-1)*10000):null,btcOpeningOffsetBps:openingPrice?round((last/openingPrice-1)*10000):null};
    result.candidates.push(c);
    c.context=entryContext({frame,history,prices,outcome,now,staleMs:config.staleMs});
    if(!freshBook(book,now,config.staleMs) || !book.bids.length || !book.asks.length){c.reason='盘口过期或缺少买卖报价';continue;}
    if(recent.some(r=>!Number.isFinite(r[key]))){c.reason='同轮报价有缺口';continue;}
    c.move30=round(recent.at(-1)[key]-recent[0][key]);c.spread=round(book.asks[0][0]-book.bids[0][0]);
    c.bidDepth=book.bids.slice(0,5).reduce((s,l)=>s+l[1],0);c.askDepth=book.asks.slice(0,5).reduce((s,l)=>s+l[1],0);
    c.obi=(c.bidDepth-c.askDepth)/Math.max(1e-8,c.bidDepth+c.askDepth);
    if(c.spread<=0 || c.spread>strategy.maxSpread){c.reason='价差超出策略范围';continue;}
    let q;try{q=amountQuote(book,market,config.buyUnits??1);}catch(e){c.reason=e.message;continue;}
    Object.assign(c,{amountUsd:q.amountUsd,orderSize:q.size,expectedFilled:q.filled,expectedNotional:q.notional,
      expectedEntryFees:q.fees,makerPrice:q.best,limit:q.limit,takerPrice:q.average});
    if(!q.allowed || !q.complete){c.reason=q.reason??'价格保护内买入深度不足';continue;}
    if(researchPolicy && q.average>researchPolicy.cap){c.reason='对照实验：买入价超过固定上限';continue;}
    if(researchPolicy?.align && (c.btcMove30Bps===null || c.btcMove30Bps*(outcome==='Up'?1:-1)<=0)){c.reason='对照实验：BTC 30 秒变化未同向';continue;}
    const sellLimit=round(Math.max(market.tick,book.bids[0][0]-.02));
    const exit=depthQuote(book,'sell',q.filled,market,sellLimit);
    if(!exit?.complete){c.reason='当前价格保护范围内退出深度不足';continue;}
    c.roundTripCostPerShare=round((q.notional+q.fees-exit.notional+exit.fees)/q.filled);
    c.takerEdge=round(c.move30-c.roundTripCostPerShare-strategy.costBuffer);
    if(c.move30<forwardProtocol.minimumMove){c.reason='该方向最近 30 秒涨幅不足 3 美分';continue;}
    if(c.takerEdge<strategy.minNetEdge){c.reason='历史动量不足以覆盖当前往返成本与缓冲';continue;}
    c.eligible=true;c.reason='前瞻模拟：恢复动量通过当次检查，按美元预算执行';
  }
  result.selected=result.candidates.filter(c=>c.eligible).sort((a,b)=>b.takerEdge-a.takerEdge)[0]??null;
  result.reason=result.selected?`${result.selected.outcome} $${result.selected.amountUsd} · 当次检查通过，可自动模拟开仓`:
    result.candidates.map(c=>`${c.outcome}：${c.reason}`).join('；');
  return result;
}

export function forwardExit(trade,held,book,market,now,config,strategy,history,researchPolicy=null) {
  // Old research arms and restored pre-revision positions retain their rules.
  const confirmationMs=researchPolicy?researchPolicy.confirmationMs??0:
    trade.parameters && trade.parameters.exitRevision!==forwardProtocol.exitRevision?0:forwardProtocol.reversalConfirmationMs;
  const invalid=reason=>{delete trade.reversalObservation;trade.holdingDecision={time:now,status:'data-unavailable',reason,confirmationMs,confirmedMs:0};return null;};
  if(trade.slug && trade.slug!==market.slug || book?.tokenId!==market.tokens[trade.outcome])return invalid('盘口身份不匹配，等待正确报价');
  if(!freshBook(book,now,config.staleMs) || !Number.isFinite(held) || held<1e-8 || !book.bids.length)return invalid('可卖报价缺失或过期，反转确认重新计时');
  const limit=round(Math.max(market.tick,book.bids[0][0]-.02)),q=depthQuote(book,'sell',held,market,limit);
  if(!q?.filled)return invalid('保护价内没有可卖深度，反转确认重新计时');
  const net=round(q.notional-q.fees-trade.costPerShare*q.filled);
  const rows=history.filter(r=>r.slug===market.slug&&r.time>=now-30000&&r.time<=now),key=trade.outcome.toLowerCase();
  const move=continuous(rows,now-30000,now)&&rows.every(r=>Number.isFinite(r[key]))?rows.at(-1)[key]-rows[0][key]:null;
  const negative=move!==null && round(move)<=-forwardProtocol.minimumMove;
  const sampleAt=rows.at(-1)?.time;
  let observation=trade.reversalObservation;
  if(!negative) {delete trade.reversalObservation;observation=null;}
  else if(!observation || observation.slug!==market.slug || now<observation.observedAt || now-observation.observedAt>5000 ||
    sampleAt<observation.sampleAt || sampleAt-observation.sampleAt>5000 || book.timestamp<observation.bookAt) {
    observation=trade.reversalObservation={slug:market.slug,since:sampleAt,sampleAt,bookAt:book.timestamp,observedAt:now,confirmedMs:0};
  } else if(sampleAt>observation.sampleAt && book.timestamp>observation.bookAt) {
    // Repeated snapshots and time spent disconnected cannot mature a signal.
    observation.sampleAt=sampleAt;observation.bookAt=book.timestamp;observation.observedAt=now;
    observation.confirmedMs=sampleAt-observation.since;
  }
  const confirmedMs=observation?.confirmedMs??0;
  let reason=null;
  if(now>=market.end-forwardProtocol.exitBeforeEndMs)reason='结束前 60 秒退出，减少尾盘无法成交风险';
  else if(strategy.stopLossUsd>0 && net<=-strategy.stopLossUsd)reason='达到策略持仓损失阈值';
  else if(now-trade.openedAt>=config.holdMs)reason='达到前瞻模拟持有时限';
  else if((researchPolicy===null || researchPolicy.reversal!==null) &&
    now-trade.openedAt>=(researchPolicy?.reversal??10)*1000 && negative && confirmedMs>=confirmationMs)
    reason=confirmationMs?'所持方向 30 秒动量反转已持续确认 5 秒':'所持方向 30 秒动量已经反转';
  const recent10=rows.filter(r=>r.time>=now-10000);
  const move10=move!==null && recent10[0]?.time<=now-8000?round(recent10.at(-1)[key]-recent10[0][key]):null;
  trade.holdingDecision={time:now,status:reason?'exit':move===null?'momentum-unavailable':negative?'confirming-reversal':'hold',
    reason:reason??(move===null?'动量记录不连续；损失线、持有时限和尾盘退出仍有效':negative?
      `反转已观察 ${Math.min(confirmedMs,confirmationMs)/1000} / ${confirmationMs/1000} 秒，尚未满足全部反转退出条件`:
      '未达到反转退出条件，继续按损失线和持有时限管理'),
    move30:move===null?null:round(move),move10,netAtVisibleDepth:net,completeDepth:q.complete,
    heldMs:now-trade.openedAt,remainingMs:market.end-now,holdLimitMs:config.holdMs,
    confirmationMs,confirmedMs,reversalSince:observation?.since??null,bookAt:book.timestamp,sampleAt};
  if(q.complete){trade.maxFavorableNet=Math.max(trade.maxFavorableNet??net,net);trade.maxAdverseNet=Math.min(trade.maxAdverseNet??net,net);}
  return reason?{reason,net,limit,visibleFilled:q.filled}:null;
}

export function summarizeForwardBatch(trades) {
  const sum=(key)=>round(trades.reduce((s,t)=>s+(t[key]??0),0));
  const groups={};
  for(const t of trades){const band=t.entryAverage<=.05?'0–5¢':t.entryAverage<=.1?'5–10¢':t.entryAverage<=.2?'10–20¢':'20¢以上';
    const g=groups[band]??={trades:0,net:0,fees:0};g.trades++;g.net=round(g.net+t.net);g.fees=round(g.fees+(t.fees??0));}
  return {trades:trades.length,net:sum('net'),fees:sum('fees'),winRate:trades.length?trades.filter(t=>t.net>0).length/trades.length:null,
    meanHoldingSeconds:trades.length?trades.reduce((s,t)=>s+(t.closedAt-t.openedAt)/1000,0)/trades.length:null,
    settlements:trades.filter(t=>t.closeMethod==='verified-paper-settlement').length,entryPriceGroups:groups,
    interpretation:'固定版本的实际模拟成交汇总；不构成盈利证明，不自动改参数或提高金额'};
}
