import {oneTapQuote} from '../one-tap-order.mjs';

export const rayAmountSizingProtocol=Object.freeze({version:'ray-onetap-equity-v1',minimumPct:.025,maximumPct:.10,
 maximumShares:100,slippageCents:2,allocation:'validated-strength-or-minimum',feeInclusive:true});

// No historical strength-to-return calibration has been admitted. A larger
// deviation alone is not evidence of a better after-cost trade. Keep that
// uncertainty in every entry record rather than manufacturing a 10% signal.
export function rayStrengthAllocation(){return {version:'ray-strength-validation-v1',pct:.025,
 minimumPct:.025,maximumPct:.10,validated:false,status:'awaiting-independent-validation',
 reason:'尚无通过独立验证的信号强度与扣费收益映射，按 2.5% 基线，不自动放大到 10%'};}

export function computeRayAmountSize({equity,book,market,maxShares=100,roundUsedShares=0,limitCap=.85}={}){
 const allocation=rayStrengthAllocation(),p=rayAmountSizingProtocol;
 const s={version:p.version,mode:'one-tap-max-spend',equity:Number.isFinite(equity)?equity:null,pct:allocation.pct,
  allocation,budget:null,maxSpend:null,amountUsd:null,feePrecision:5,roundUsedShares,
  remainingRoundShares:null,maxShares,finalShares:0,quote:null,ok:false,reasonCode:null};
 const fail=reasonCode=>({...s,reasonCode});
 if(!Number.isFinite(equity)||equity<0)return fail('equity_unknown');
 s.budget=equity*allocation.pct;
 if(!Number.isFinite(roundUsedShares)||roundUsedShares<0||roundUsedShares>100)return fail('round_share_cap');
 s.remainingRoundShares=Math.max(0,100-roundUsedShares);
 if(!Number.isFinite(market?.minSize)||s.remainingRoundShares<market.minSize)return fail('round_share_cap');
 if(!Number.isFinite(maxShares)||maxShares<=0)return fail('size_below_min');
 try{
  const q=oneTapQuote(book,market,s.budget,{slippageCents:p.slippageCents,limitCap,
   maxShares:Infinity});
  Object.assign(s,{quote:q,maxSpend:q.maxSpend,amountUsd:q.amountUsd,finalShares:q.size,
   ask:q.best,limit:q.limit,expectedNotional:q.notional,expectedEntryFees:q.fees});
  // The share guard can veto an entry, but must not silently shrink a
  // percentage-sized request into the round's remaining share allowance.
  if(q.size>s.remainingRoundShares+1e-8)return fail('round_share_cap');
  if(q.size>Math.min(maxShares,p.maximumShares)+1e-8)return fail('size_below_min');
  if(!q.allowed)return fail('size_below_min');
  return {...s,ok:true,reasonCode:'ok'};
 }catch(error){return {...fail('size_below_min'),error:error.message};}
}
