import { settlementFeatures, settlementProtocol, probability } from './settlement-model.mjs';
import { amountQuote } from '../amount-order.mjs';
import { depthQuote } from './strategy.mjs';
import { round } from '../paper-broker.mjs';

export const valueProtocol = Object.freeze({
  version:'p3-settlement-calibration-v2', anchorMs:120000, windowMs:5000,
  baseline:'raw-up-midpoint', features:'existing-verified-twap-distance-trend-variation',
  ridge:settlementProtocol.ridge, maxLogitCorrection:settlementProtocol.maxLogitCorrection,
  minimumRounds:300, minimumTrainingDates:7, minimumValidationDates:3, minimumTestDates:3,
  trainFraction:.6, validationFraction:.2, labelPurgeMs:60000,
  diagnosticOnly:true, changesTradingRules:false,
});

// Reuse the recorded TWAP features; the remaining-time scale is a feature,
// not a Brownian estimate of settlement probability. Do not renormalize prices.
export function valueFeatures(frame, prices, now) {
  const f=settlementFeatures(frame,prices,now);
  if(!f)return null;
  const mid=(f.books[0].bids[0][0]+f.books[0].asks[0][0])/2;
  if(!Number.isFinite(mid)||mid<=0||mid>=1)return null;
  return {...f,legacyMarketProbability:f.marketProbability,marketProbability:mid};
}

export function valueEconomics(frame, features, pUp, amountUsd=1, holdings={}) {
  if(!Number.isFinite(pUp)||pUp<=0||pUp>=1)return null;
  const quotedEntries=[],ownedPositions=[];
  for(const [i,outcome] of ['Up','Down'].entries()) {
    const book=features.books[i],chance=outcome==='Up'?pUp:1-pUp,tokenId=frame.market.tokens[outcome];
    let q;try{q=amountQuote(book,frame.market,amountUsd);}catch{}
    quotedEntries.push(q?.allowed&&q.complete ? {
      outcome,amountUsd,size:q.filled,quotedCost:round(q.notional+q.fees),
      costPerShare:round((q.notional+q.fees)/q.filled),
      expectedSettlementProfit:round(q.filled*chance-q.notional-q.fees),
      probabilityEstimate:chance,quoteOnly:true,actualExecutionVerified:false,
    }:{outcome,amountUsd,quoteOnly:true,actualExecutionVerified:false,reason:q?.reason??'报价或金额无效'});
    const held=holdings[tokenId];
    if(!(held>0))continue;
    const limit=round(Math.max(frame.market.tick,book.bids[0][0]-.02));
    const sale=depthQuote(book,'sell',held,frame.market,limit);
    const sellNowNet=sale?.complete?round(sale.notional-sale.fees):null;
    const expectedSettlementValue=round(held*chance);
    ownedPositions.push({outcome,tokenId,size:held,expectedSettlementValue,sellNowNet,
      continuationMinusImmediate:sellNowNet===null?null:round(expectedSettlementValue-sellNowNet),
      acquisitionCostRole:'sunk-cost-excluded',settlementWaitCostModeled:false,
      executionLatencyModeled:false,diagnosticOnly:true});
  }
  return {quotedEntries,ownedPositions,settlementGasModeled:false,capitalOccupancyModeled:false};
}

export function valueDecision({frame,prices,now,artifact,amountUsd=1,holdings={}}) {
  const d={version:valueProtocol.version,time:now,diagnosticOnly:true,pUp:null,
    marketProbability:null,modelId:artifact?.id??null,features:null,economics:null,reason:'等待本轮第120秒观察'};
  if(!frame||frame.now>now)return d;
  const age=now-frame.market.start;
  if(age>valueProtocol.anchorMs+valueProtocol.windowMs)return {...d,reason:'本轮固定观察窗口已结束；模型不能用于其他持有时刻'};
  const f=valueFeatures(frame,prices,now);
  if(!f)return {...d,reason:age<valueProtocol.anchorMs?d.reason:'缺少准确开盘、连续TWAP或新鲜双边盘口'};
  d.marketProbability=f.marketProbability;
  if(artifact?.version!==valueProtocol.version||!artifact.model||!Number.isFinite(artifact.fittedAt)||artifact.fittedAt>now)
    return {...d,reason:'模型尚未就绪，或模型训练发生在观察时刻之后'};
  const p=probability(artifact.model,f);
  if(p===null)return {...d,reason:'当前特征超出模型范围，保留未知'};
  return {...d,pUp:p,features:{x:f.x,opening:f.opening},
    economics:valueEconomics(frame,f,p,amountUsd,holdings),
    reason:'120秒固定时点的研究估计；尚未完成前瞻与账户收益验证，不参与买卖'};
}
