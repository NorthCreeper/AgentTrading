import {freshBook} from './strategy.mjs';
import {e18ToPrice} from './chart-model.mjs';
import {computeRayAmountSize,rayStrengthAllocation} from './ray-onetap-sizing.mjs';
import {rayCalendarThreshold} from './ray-calendar-policy.mjs';
import {validRayOpeningEvidence,rayOpeningVersion} from './ray-opening.mjs';
export const rayProtocol=Object.freeze({version:'ray-twap-event-onetap-v8',riskPolicy:'equity-per-order-v1',aggregateCostCap:null,lateSeconds:120,minPrice:.55,maxPrice:.85,
 asymHigh:.80,asymLow:.20,hardSkip:.90,shares:100,maximumSharesPerRound:100,equitySizePct:.025,
 minimumEquitySizePct:.025,maximumEquitySizePct:.10,allocation:'validated-strength-or-minimum',minimumShares:5,pollMs:0,entryTimingVersion:'ray-qualified-source-event-v1',decisionCadence:'new-source-event',
 entryPolicy:'one-filled-entry-per-market-v1',maximumEntriesPerRound:1,
 openingToleranceMs:0,openingVersion:rayOpeningVersion,openingBasis:'opening-60s-twap',twapMaxAgeMs:5000,openingFallback:false,exitRevision:'ray-official-settlement-v1',
 thresholds:{morning:40,midday:60,night:80},calendarThresholdVersion:'ray-calendar-threshold-v1',random50:false,paperOnly:true,
 execution:'At most one positively filled entry per market across both outcomes; zero-fill FAK may retry only after changed source liquidity; fresh reference/book events recheck all conditions. Amount-based FAK with fee-inclusive maxSpend, 2c local price protection capped at 85c, unfilled remainder cancelled; allocation 2.5%-10% requires validated strength, otherwise 2.5%; cumulative filled shares per round <=100'});
export function raySession(now){const hour=new Date(now+28800000).getUTCHours();return hour>=6&&hour<12?'morning':hour>=12&&hour<22?'midday':'night';}
export function validRayOpening(o,m,now){
 return validRayOpeningEvidence(o,m,now);
}
export function evaluateRay({frame,config={},now,equity,roundUsedShares=0,opening=frame?.rayOpening,allowOpeningProxy=false}){
 const p=rayProtocol,result={version:p.version,time:now,calibrated:false,execution:'paper',scoreType:'fixed-twap-deviation-and-book-asymmetry',candidates:[],selected:null,protocol:p};
 const session=raySession(now),calendarThreshold=rayCalendarThreshold(now,session),threshold=calendarThreshold.thresholdUsd;
 Object.assign(result,{session,thresholdUsd:threshold,calendarThreshold});
 const reject=(code,reason)=>({...result,reasonCode:code,reason});
 if(!frame?.market||!Number.isFinite(now)||frame.now>now)return reject('missing_frame','等待匹配盘口');
 const m=frame.market,remaining=m.end-now;
 if(remaining<=0||now<m.start||remaining>p.lateSeconds*1000)return reject('not_late','Ray 等待最后 120 秒');
 if(!validRayOpening(opening,m,now))return reject(opening?.status==='conflict'?'opening_conflict':'opening_unknown',
  opening?.status==='conflict'?'Ray 开盘60秒TWAP来源冲突，暂停本轮新开仓':'Ray 缺少当时可知的开盘60秒TWAP，不使用现价、近邻或未来回填');
 const twap=frame.twap,value=e18ToPrice(twap?.valueE18);
 if(!value||twap?.windowSeconds!==60||![twap?.timestamp,twap?.receivedAt].every(t=>Number.isFinite(t)&&t<=now&&now-t<=p.twapMaxAgeMs))return reject('twap_unavailable','Ray 等待新鲜 TWAP');
 const deviation=value-opening.value;
 Object.assign(result,{session,thresholdUsd:threshold,twap:value,opening:structuredClone(opening),deviationUsd:deviation});
 if(Math.abs(deviation)<threshold)return reject('twap_deviation_below','TWAP 偏离未达到本时段门槛');
 const outcome=deviation>0?'Up':'Down',other=outcome==='Up'?'Down':'Up';
 const book=frame.books?.find(b=>b.tokenId===m.tokens[outcome]),opposite=frame.books?.find(b=>b.tokenId===m.tokens[other]);
 if(![book,opposite].every(b=>freshBook(b,now,config.staleMs??3000)&&b.asks?.length&&b.bids?.length&&b.asks[0][0]>b.bids[0][0]))return reject('book_unavailable','Ray 等待双侧新鲜完整盘口');
 const ask=book.asks[0][0],oppositeAsk=opposite.asks[0][0];
 const c={version:p.version,tokenId:m.tokens[outcome],outcome,eligible:false,mode:'taker',limit:ask,makerPrice:ask,
  bidDepth:book.bids.reduce((s,l)=>s+l[1],0),ask,oppositeAsk,deviationUsd:deviation,thresholdUsd:threshold,session,
  opening:structuredClone(opening),calendarThreshold:structuredClone(calendarThreshold),reason:'等待 Ray 条件',exitRevision:p.exitRevision};result.candidates.push(c);
 if(ask>=p.hardSkip)return reject('chase_ge_90','Ray 不追买 90 美分以上');
 if(ask<p.minPrice||ask>p.maxPrice)return reject('price_out_of_band','Ray 买价不在 55–85 美分范围');
 if(ask<p.asymHigh||oppositeAsk>p.asymLow)return reject('book_not_asym','Ray 盘口未达到 80/20 条件');
 if(!Number.isFinite(m.minSize)||!Number.isFinite(m.tick)||m.tick<=0||!Number.isFinite(m.fee?.rate)||m.fee.rate<0||!Number.isFinite(m.fee?.exponent)||m.fee.exponent<0)return reject('execution_metadata_unknown','Ray 缺少最小份额、tick 或费率');
 if(Math.abs(ask/m.tick-Math.round(ask/m.tick))>1e-7)return reject('invalid_tick','Ray 最优卖价不符合 tick');
  const sizing=computeRayAmountSize({equity,book,market:m,maxShares:config.size??p.shares,
   roundUsedShares,limitCap:p.maxPrice});
  result.sizing=sizing;c.sizing=structuredClone(sizing);
 if(!sizing.ok){const reason=sizing.reasonCode==='equity_unknown'?'Ray 等待可信净值，不能使用固定份额代替':sizing.reasonCode==='round_share_cap'?'Ray 本轮剩余额度容不下完整比例请求，跳过本次，不缩小预算':'Ray 预算不足最低请求或完整请求超过单次份额限制；强度未经验证，不提高比例凑单';return reject(sizing.reasonCode,reason);}
  const shares=sizing.finalShares;
  Object.assign(c,{eligible:true,orderSize:shares,amountUsd:sizing.amountUsd,maxSpend:sizing.maxSpend,
   limit:sizing.quote.limit,makerPrice:sizing.quote.best,expectedNotional:sizing.quote.notional,
   expectedEntryFees:sizing.quote.fees,executionVersion:sizing.quote.executionVersion,
   allocation:rayStrengthAllocation(),reason:'Ray：晚段 TWAP 偏离及 80/20 盘口通过，按含费预算发一张金额 FAK，未成交取消，持有至官方结算'});
 result.selected=c;result.reasonCode='actionable_ray_twap_band';result.reason=c.reason;return result;
}
