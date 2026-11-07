import {e18ToPrice} from './chart-model.mjs';

export const dynamicTwapVersion='ray-causal-vol-time-shadow-v1';
const shortMs=1800000,longMs=21600000;
const validPoint=p=>p&&[p.referenceAt,p.knownAt,p.value].every(Number.isFinite)&&p.value>0&&p.referenceAt<=p.knownAt;

// A diagnostic observer only. It never changes an entry threshold or budget.
// Missing observations remove coverage; elapsed disconnect time is not a zero
// price move. Source time controls sampling; receipt time controls availability.
export class RayDynamicTwap {
 constructor(saved=null){
  this.points=[];this.firstKnownAt=null;this.latestObserved=null;this.restoreError=null;
  if(saved){
   if(saved.version!==dynamicTwapVersion||!Array.isArray(saved.points)||saved.points.length>4500||
    saved.points.some((p,i)=>!validPoint(p)||i>0&&(p.referenceAt<=saved.points[i-1].referenceAt||p.knownAt<saved.points[i-1].knownAt))||
    saved.firstKnownAt!==null&&(!Number.isFinite(saved.firstKnownAt)||saved.points[0]&&saved.firstKnownAt>saved.points[0].knownAt))
     this.restoreError='动态观察缓存无效，重新积累；未用于交易';
   else {this.points=structuredClone(saved.points);this.firstKnownAt=saved.firstKnownAt;
    this.latestObserved=validPoint(saved.latestObserved)?structuredClone(saved.latestObserved):this.points.at(-1)??null;}
  }
 }
 saved(){return {version:dynamicTwapVersion,points:structuredClone(this.points),firstKnownAt:this.firstKnownAt,latestObserved:structuredClone(this.latestObserved)};}
 observe(twap,now){
  const value=e18ToPrice(twap?.valueE18),ref=twap?.timestamp,known=twap?.receivedAt;
  if(twap?.windowSeconds!==60||!value||![ref,known,now].every(Number.isFinite)||ref>now||known>now||now-ref>5000||now-known>5000||ref>known)return false;
  if(!this.latestObserved||ref>=this.latestObserved.referenceAt&&known>=this.latestObserved.knownAt)
   this.latestObserved={referenceAt:ref,knownAt:known,value};
  const last=this.points.at(-1);
  if(last&&(ref-last.referenceAt<5000||known<last.knownAt))return false;
  this.firstKnownAt??=known;this.points.push({referenceAt:ref,knownAt:known,value});
  // Retain a predecessor for an interval that ends inside the long window.
  while(this.points.length>1&&this.points[1].knownAt<now-longMs)this.points.shift();
  if(this.points.length>4500)this.points.splice(0,this.points.length-4500);
  return true;
 }
 summary({now,remainingSeconds,baseThreshold,deviationUsd=null}={}){
  const result={version:dynamicTwapVersion,scope:'shadow-only',adopted:false,ready:false,
   status:'warming-up',reason:'等待六小时过去波动与完整覆盖',shortSeconds:1800,longSeconds:21600,
   shortCoverage:0,longCoverage:0,volatilityRatio:null,baseThresholdUsd:baseThreshold??null,
   thresholdUsd:null,signedDeviationUsd:deviationUsd,strength:null,remainingSeconds,
   observations:this.points.length,firstKnownAt:this.firstKnownAt,restoreError:this.restoreError};
  if(!Number.isFinite(now))return result;
  const rv=window=>{let square=0,seconds=0;for(let i=1;i<this.points.length;i++){
   const a=this.points[i-1],b=this.points[i];if(b.knownAt>now||b.knownAt<now-window)continue;
   const dt=(b.referenceAt-a.referenceAt)/1000;if(dt<=0||dt>10)continue;
   square+=(b.value-a.value)**2;seconds+=dt;
  }return {variance:seconds>0?square/seconds:null,coverage:Math.min(1,seconds/(window/1000))};};
  const short=rv(shortMs),long=rv(longMs);result.shortCoverage=short.coverage;result.longCoverage=long.coverage;
  const last=this.latestObserved;
  if(!last||last.knownAt>now||last.referenceAt>now||now-last.knownAt>5000||now-last.referenceAt>5000){
   result.status='stale';result.reason='最新 TWAP 观察过期，保留缺口';return result;
  }
  if(this.firstKnownAt===null||now-this.firstKnownAt<longMs||short.coverage<.8||long.coverage<.8||
   !Number.isFinite(short.variance)||!Number.isFinite(long.variance)||long.variance<=0)return result;
  result.volatilityRatio=Math.min(2,Math.max(.5,Math.sqrt(short.variance/long.variance)));
  result.shortVarianceUsd2PerSecond=short.variance;result.longVarianceUsd2PerSecond=long.variance;
  if(!Number.isFinite(remainingSeconds)||remainingSeconds<=0||remainingSeconds>120||!Number.isFinite(baseThreshold)||baseThreshold<=0){
   result.status='outside-entry-window';result.reason='波动就绪，等待最后 120 秒';return result;
  }
  result.thresholdUsd=baseThreshold*result.volatilityRatio*Math.sqrt(Math.max(remainingSeconds,1)/120);
  result.strength=Number.isFinite(deviationUsd)?Math.abs(deviationUsd)/result.thresholdUsd:null;
  result.ready=true;result.status='shadow-ready';result.reason='动态门槛仅记录；尚未通过收益及强度仓位验证';return result;
 }
}
