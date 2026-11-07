// Pure paper sizing: no account access, network requests, or account mutation.
// The budget and final integer rounding match paper_bot/sizing.py.
export const raySizingProtocol=Object.freeze({version:'ray-equity-size-v1',pct:.025,maximumShares:100,minimumShares:5});

export function computeRaySize({equity,ask,fee,askDepth,maxShares=raySizingProtocol.maximumShares,
 minShares=raySizingProtocol.minimumShares,roundUsedShares=0,roundShareCap=raySizingProtocol.maximumShares}={}){
 const p=raySizingProtocol,s={version:p.version,mode:'equity-pct',equity:Number.isFinite(equity)?equity:null,pct:p.pct,
  budget:null,ask,feePerShare:null,costPerShare:null,rawShares:null,askDepth,maxShares,
  minShares:Math.max(p.minimumShares,minShares),roundUsedShares,remainingRoundShares:null,finalShares:0,clamps:[],ok:false,reasonCode:null};
 const fail=code=>({...s,reasonCode:code});
 if(!Number.isFinite(equity)||equity<0)return fail('equity_unknown');
 s.budget=equity*p.pct;
 if(![ask,fee?.rate,fee?.exponent,askDepth,maxShares,s.minShares,roundShareCap].every(Number.isFinite)
  ||ask<=0||ask>=1||fee.rate<0||fee.exponent<0||askDepth<0||maxShares<=0||roundShareCap<=0)return fail('size_below_min');
 s.feePerShare=fee.rate*(ask*(1-ask))**fee.exponent;
 s.costPerShare=ask+s.feePerShare;
 if(!Number.isFinite(s.budget)||!Number.isFinite(s.costPerShare)||s.costPerShare<=0)return fail('equity_unknown');
 s.rawShares=Math.floor(s.budget/s.costPerShare);
 s.maxShares=Math.min(maxShares,p.maximumShares);
 s.clamps.push('equity_pct');
 if(!Number.isFinite(roundUsedShares)||roundUsedShares<0)return fail('round_share_cap');
 s.remainingRoundShares=Math.max(0,Math.min(roundShareCap,p.maximumShares)-roundUsedShares);
 if(s.remainingRoundShares<s.minShares){s.clamps.push('round_share_cap');return fail('round_share_cap');}
 let final=s.rawShares;
 if(final>askDepth){final=askDepth;s.clamps.push('depth');}
 if(final>s.maxShares){final=s.maxShares;s.clamps.push('max_size');}
 if(final>s.remainingRoundShares){final=s.remainingRoundShares;s.clamps.push('round_share_cap');}
 s.finalShares=Math.max(0,Math.floor(final));
 if(s.finalShares<s.minShares){s.clamps.push('min_size');return fail('size_below_min');}
 return {...s,ok:true,reasonCode:'ok'};
}
