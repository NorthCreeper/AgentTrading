import {feeFor,round} from './paper-broker.mjs';

// Separate from the retained amount-market-v2 research execution assumptions.
export const oneTapExecutionVersion='one-tap-max-spend-v1';
export const oneTapFeePrecision=5;
export const twoDecimals=value=>Number.isFinite(value)&&value>=0&&
  Math.abs(value*100-Math.round(value*100))<=1e-7;
export function floorTwo(value){
  if(!Number.isFinite(value)||value<0)return NaN;
  const units=Math.floor(value*100+Number.EPSILON*Math.abs(value*100)),result=units/100;
  return result>value?(units-1)/100:result;
}

export function oneTapAmountAllowed(order,market){
  return order?.side==='buy'&&order.mode==='taker'&&
    twoDecimals(order.amountUsd)&&order.amountUsd>0&&twoDecimals(order.maxSpend)&&
    order.maxSpend>=order.amountUsd&&twoDecimals(order.size)&&order.size>0&&
    Number.isFinite(market?.minSize)&&market.minSize>0&&order.size>=market.minSize;
}

// Official market BUY amount is principal. maxSpend is a separate all-in cap.
// Both requested shares and dollars have two decimals; a partial fill can be
// smaller than the signed request's market minimum.
export function oneTapComplete(order){
  return order.filled>=order.size-1e-8||order.notional>=order.amountUsd-1e-7;
}

function maximumFeeRatio(low,high,fee){
  const ratio=price=>fee.rate*(price*(1-price))**fee.exponent/price;
  const candidates=[ratio(low),ratio(high)];
  if(fee.exponent>1){
    const stationary=(fee.exponent-1)/(2*fee.exponent-1);
    if(stationary>=low&&stationary<=high)candidates.push(ratio(stationary));
  }
  return Math.max(...candidates);
}

// The same all-in guard is applied at execution, even if depth/fees differ
// from the preview. Never assume a successful acknowledgement is a fill.
export function oneTapFillSize({wanted,price,amountRemaining,spendRemaining,fee}){
  if(![wanted,price,amountRemaining,spendRemaining,fee?.rate,fee?.exponent].every(Number.isFinite)||
    wanted<=0||price<=0||price>=1||amountRemaining<=0||spendRemaining<=0)return 0;
  let units=Math.floor(Math.min(wanted,amountRemaining/price)*1e8+1e-7);
  if(units<=0)return 0;
  const affordable=count=>round(count/1e8*price+feeFor(count/1e8,price,fee,oneTapFeePrecision))<=spendRemaining+1e-8;
  if(!affordable(units)){
    let left=0,right=units;
    while(left<right){const mid=Math.ceil((left+right)/2);if(affordable(mid))left=mid;else right=mid-1;}
    units=left;
  }
  return units/1e8;
}

export function oneTapQuote(book,market,maxSpend,{slippageCents=2,limitCap=1-market?.tick,maxShares=Infinity}={}){
  if(!Number.isFinite(maxSpend)||maxSpend<=0)throw Error('含费买入预算须大于零');
  if(!Number.isFinite(slippageCents)||slippageCents<0||slippageCents>10)throw Error('价格保护范围无效');
  if(!Number.isFinite(market?.tick)||market.tick<=0||market.tick>=1||
    !Number.isFinite(market.minSize)||market.minSize<=0||!Number.isFinite(market.fee?.rate)||market.fee.rate<0||
    !Number.isFinite(market.fee?.exponent)||market.fee.exponent<0)throw Error('缺少有效 tick、最低份额或费率');
  if(!Number.isFinite(limitCap)||limitCap<=0||limitCap>=1||!(maxShares===Infinity||Number.isFinite(maxShares)&&maxShares>0))
    throw Error('价格或份额上限无效');
  if(!Array.isArray(book?.asks)||!book.asks.length)throw Error('没有可用卖盘');
  if(book.asks.some(([price,size],index)=>!Number.isFinite(price)||price<=0||price>=1||
    !Number.isFinite(size)||size<0||index>0&&price<book.asks[index-1][0]))throw Error('卖盘价位或深度无效');
  const best=book.asks[0][0],limit=round(Math.floor((Math.min(1-market.tick,limitCap,best+slippageCents/100)+1e-10)/market.tick)*market.tick);
  const cap=floorTwo(maxSpend),feeReserveRatio=limit>=best?maximumFeeRatio(best,limit,market.fee):null;
  const amountUsd=feeReserveRatio===null?0:floorTwo(cap/(1+feeReserveRatio));
  const size=amountUsd>0?floorTwo(Math.min(amountUsd/best,maxShares)):0;
  const quote={amountUsd,maxSpend:cap,size,filled:0,notional:0,fees:0,total:0,limit,best,allowed:false,complete:false,
    minimumShares:market.minSize,feePrecision:oneTapFeePrecision,feeReserveRatio,
    executionVersion:oneTapExecutionVersion,reason:null};
  if(limit<best){quote.reason='价格保护上限低于当前卖一';return quote;}
  if(!oneTapAmountAllowed({...quote,side:'buy',mode:'taker'},market)){
    quote.reason=`含费预算或份额上限不足最低 ${market.minSize} 份请求，不抬高预算`;return quote;
  }
  for(const [price,available]of book.asks){
    if(price>limit||quote.filled>=size-1e-8)break;
    const quantity=oneTapFillSize({wanted:Math.min(available,round(size-quote.filled)),price,
      amountRemaining:round(amountUsd-quote.notional),spendRemaining:round(cap-quote.notional-quote.fees),fee:market.fee});
    if(quantity<=0)continue;
    quote.filled=round(quote.filled+quantity);quote.notional=round(quote.notional+price*quantity);
    quote.fees=round(quote.fees+feeFor(quantity,price,market.fee,oneTapFeePrecision));
  }
  quote.total=round(quote.notional+quote.fees);quote.allowed=quote.filled>0;quote.complete=oneTapComplete(quote);
  quote.average=quote.filled?quote.notional/quote.filled:null;
  if(!quote.allowed)quote.reason='价格保护范围内没有可成交卖盘';
  return quote;
}
