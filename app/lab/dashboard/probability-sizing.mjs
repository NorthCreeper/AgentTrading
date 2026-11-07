import {createHash} from 'node:crypto';
import {oneTapQuote,floorTwo} from '../one-tap-order.mjs';
import {computeRayAmountSize} from './ray-onetap-sizing.mjs';

export const probabilitySizingProtocol=Object.freeze({version:'ray-probability-liquidity-shadow-v1',
 scope:'shadow-only',adopted:false,minimumPct:.025,maximumPct:.10,kellyFraction:.10,
 maximumShares:100,minimumValidationDates:3,minimumValidationSamples:59,minimumLowerProbability:.95,
 maximumPredictionAgeMs:5000,bookMaxAgeMs:3000,slippageCents:2,limitCap:.85,
 calibrationSchema:'btc5m-probability-calibration-v1',registryScope:'terminal-probability-sizing-shadow'});

const finite=Number.isFinite,epsilon=1e-8,hashPattern=/^[a-f0-9]{64}$/;
const hktDay=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
const nyDay=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(ms);
const validDay=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&finite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;

// This is only arithmetic on a supplied probability assumption. It neither
// validates that assumption nor authorizes allocation or submission.
export function fractionalKellyPct(probabilityLowerBound,costPerShare){
 if(!finite(probabilityLowerBound)||probabilityLowerBound<0||probabilityLowerBound>1||
  !finite(costPerShare)||costPerShare<=0||costPerShare>=1)return null;
 return probabilitySizingProtocol.kellyFraction*Math.max(0,(probabilityLowerBound-costPerShare)/(1-costPerShare));
}

export function calibrationJsonSha256(json){
 return typeof json==='string'?createHash('sha256').update(json,'utf8').digest('hex'):null;
}

// The registry must come from an independently maintained local registration,
// never from a record's self-declared "registered" or "validated" flags. Exact
// original JSON bytes are bound, so changing any model/evidence field fails.
// No registry is installed by this module, and even valid evidence stays shadow.
export function validateProbabilityCalibration({calibrationJson=null,calibrationRegistry=[],prediction=null,market=null,now,
 expectedFeaturesSha256=null,expectedGroupKey=null}={}){
 const p=probabilitySizingProtocol,base={valid:false,reasonCode:'calibration_unavailable',artifactSha256:null,
  modelId:null,modelSha256:null,probabilityLowerBound:null,independentDates:null,validationSamples:null};
 const reject=reasonCode=>({...base,reasonCode});
 if(typeof calibrationJson!=='string'||!calibrationJson)return reject('calibration_unavailable');
 if(Buffer.byteLength(calibrationJson,'utf8')>65536)return reject('calibration_too_large');
 const sha256=calibrationJsonSha256(calibrationJson);base.artifactSha256=sha256;
 const registry=Array.isArray(calibrationRegistry)?calibrationRegistry.find(x=>x?.sha256===sha256):null;
 if(!registry||registry.registered!==true||registry.scope!==p.registryScope)return reject('calibration_not_registered');
 let artifact;try{artifact=JSON.parse(calibrationJson);}catch{return reject('calibration_invalid_json');}
 if(!artifact||Array.isArray(artifact)||artifact.version!==p.calibrationSchema)return reject('calibration_schema_unknown');
 const a=artifact;
 if(typeof a.id!=='string'||!a.id||typeof a.modelId!=='string'||!a.modelId||!hashPattern.test(a.modelSha256??'')||
  a.modelId!==registry.modelId||a.modelSha256!==registry.modelSha256||!hashPattern.test(a.protocolSha256??'')||
  a.protocolSha256!==registry.protocolSha256)return reject('calibration_model_binding_mismatch');
 Object.assign(base,{modelId:a.modelId,modelSha256:a.modelSha256});
 const times=[a.trainedThrough,a.validationStart,a.validatedThrough,a.knownAt,a.expiresAt,registry.preRegisteredAt,registry.registeredAt,now];
 if(!times.every(t=>finite(t)&&t>0)||!(a.trainedThrough<=registry.preRegisteredAt&&registry.preRegisteredAt<a.validationStart&&
  a.validationStart<=a.validatedThrough&&a.validatedThrough<=a.knownAt&&a.knownAt<=registry.registeredAt&&
  registry.registeredAt<=now&&now<=a.expiresAt))return reject('calibration_time_evidence_invalid');
 if(a.target!=='verified-official-payout-winner'||a.executionVersion!=='one-tap-max-spend-v1'||
  a.outcomeVerification!=='gamma-clob-canonical-payout'||a.validationMethod!=='independent-ny-date-out-of-time'||
  a.confidenceMethod!=='date-cluster-one-sided-95-lower'||a.validated!==true||a.leakageChecksPassed!==true)
  return reject('calibration_validation_not_qualified');
 const dates=a.independentDates;
 if(!Array.isArray(dates)||dates.length<p.minimumValidationDates||new Set(dates).size!==dates.length||
  dates.some(d=>!validDay(d)||d<nyDay(a.validationStart)||d>nyDay(a.validatedThrough))||
  !Number.isSafeInteger(a.validationSamples)||a.validationSamples<p.minimumValidationSamples)
  return reject('calibration_insufficient_independent_evidence');
 Object.assign(base,{independentDates:dates.length,validationSamples:a.validationSamples});
 if(!finite(a.probabilityLowerBound)||a.probabilityLowerBound<p.minimumLowerProbability||a.probabilityLowerBound>1||
  !finite(a.reversalUpperBound)||a.reversalUpperBound<0||a.reversalUpperBound>1-p.minimumLowerProbability+epsilon||
  Math.abs(a.probabilityLowerBound+a.reversalUpperBound-1)>epsilon||typeof a.groupKey!=='string'||!a.groupKey||
  !Array.isArray(registry.groups)||!registry.groups.includes(a.groupKey))return reject('calibration_probability_not_qualified');
 if(!hashPattern.test(expectedFeaturesSha256??'')||typeof expectedGroupKey!=='string'||!expectedGroupKey)
  return reject('prediction_context_not_bound');
 if(!prediction||prediction.modelId!==a.modelId||prediction.modelSha256!==a.modelSha256||prediction.calibrationId!==a.id||
  prediction.calibrationSha256!==sha256||prediction.groupKey!==a.groupKey||!hashPattern.test(prediction.featuresSha256??'')||
  prediction.featuresSha256!==expectedFeaturesSha256||prediction.groupKey!==expectedGroupKey||
  prediction.slug!==market?.slug||prediction.conditionId!==market?.conditionId||!['Up','Down'].includes(prediction.outcome)||
  market?.tokens?.[prediction.outcome]!==prediction.tokenId)return reject('prediction_identity_mismatch');
 if(![prediction.time,prediction.knownAt].every(t=>finite(t)&&t>0&&t<=now&&now-t<=p.maximumPredictionAgeMs)||
  prediction.knownAt<prediction.time||prediction.time<a.knownAt||prediction.time<registry.registeredAt)
  return reject('prediction_time_invalid');
 if(!finite(prediction.probabilityLowerBound)||prediction.probabilityLowerBound<p.minimumLowerProbability||
  prediction.probabilityLowerBound>a.probabilityLowerBound+epsilon)return reject('prediction_probability_not_bound');
 return {...base,valid:true,reasonCode:'registered_shadow_calibration',probabilityLowerBound:prediction.probabilityLowerBound,
  groupKey:a.groupKey,calibrationId:a.id,knownAt:a.knownAt,expiresAt:a.expiresAt};
}

function capacityPlanner({equity,cash,book,market,maxShares,roundUsedShares}){
 const p=probabilitySizingProtocol,shareLimit=Math.min(p.maximumShares,maxShares,p.maximumShares-roundUsedShares);
 const maxCents=Math.max(0,Math.floor(floorTwo(Math.min(equity*p.maximumPct,cash))*100+epsilon));
 const minimumCents=Math.max(1,Math.floor(floorTwo(equity*p.minimumPct)*100+epsilon));
 const quotes=new Map();
 function quote(cents){
  if(cents<1)return null;
  if(!quotes.has(cents))quotes.set(cents,oneTapQuote(book,market,cents/100,{slippageCents:p.slippageCents,
   limitCap:p.limitCap,maxShares:Infinity}));
  return quotes.get(cents);
 }
 const plannedPct=cents=>cents===minimumCents?p.minimumPct:cents/100/equity;
 const full=q=>Boolean(q?.allowed&&q.complete&&q.size<=shareLimit+epsilon&&q.size>=market.minSize&&
  q.total<=q.maxSpend+epsilon&&q.total<=cash+epsilon);
 // At low budgets the minimum request may not exist. Treat those budgets as
 // below the upper capacity boundary, then require a complete legal result.
 function upper(cents){const q=quote(cents);return !q||q.size<=shareLimit+epsilon&&(q.size<market.minSize||q.complete);}
 const largest=(ceiling,predicate)=>{let lo=0,hi=ceiling;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(predicate(mid))lo=mid;else hi=mid-1;}return lo;};
 const capacityCents=largest(maxCents,upper),capacityQuote=quote(capacityCents);
 return {shareLimit,maxCents,minimumCents,capacityCents,capacityQuote:full(capacityQuote)?capacityQuote:null,
  plannedPct,quote,full,largest,quoteCount:()=>quotes.size};
}

export function computeProbabilitySizingShadow({equity,cash,book,market,now,roundUsedShares=0,maxShares=100,
 prediction=null,calibrationJson=null,calibrationRegistry=[],expectedFeaturesSha256=null,expectedGroupKey=null}={}){
 const p=probabilitySizingProtocol,result={version:p.version,scope:p.scope,adopted:false,actualAllocation:p.minimumPct,
  actualOrdersPlaced:0,requiresParentAdmission:true,minimumPct:p.minimumPct,maximumPct:p.maximumPct,kellyFraction:p.kellyFraction,
  time:finite(now)?now:null,equity:finite(equity)?equity:null,cash:finite(cash)?cash:null,roundUsedShares,maxShares,
  status:'unvalidated',reasonCode:null,probabilityLowerBound:null,costPerShare:null,rawPct:null,candidatePct:null,
  plannedMaxSpend:null,quote:null,liquidityCapacityPct:null,liquidityCapacityMaxSpend:null,liquidityCapacityMeetsMinimum:false,
  baseline:null,calibration:null};
 const reject=(reasonCode,status=result.status)=>({...result,status,reasonCode});
 if(!finite(equity)||equity<=0||!finite(cash)||cash<0||!finite(now)||now<=0)return reject('account_or_clock_unknown');
 if(!finite(roundUsedShares)||roundUsedShares<0||roundUsedShares>p.maximumShares||!finite(maxShares)||maxShares<=0)
  return reject('share_guard_invalid');
 if(!book||![book.timestamp,book.receivedAt].every(t=>finite(t)&&t<=now&&now-t<=p.bookMaxAgeMs))return reject('book_stale_or_unknown');
 if(!market||typeof market.slug!=='string'||!/^btc-updown-5m-\d+$/.test(market.slug)||!market.conditionId||
  !market.tokens?.Up||!market.tokens?.Down||market.tokens.Up===market.tokens.Down||
  !Object.values(market.tokens).includes(book.tokenId)||!finite(market.start)||market.end!==market.start+300000||
  market.start!==Number(market.slug.split('-').at(-1))*1000)return reject('market_identity_unknown');
 if(!Array.isArray(book.asks)||!Array.isArray(book.bids)||!book.asks.length||!book.bids.length||
  !book.asks.every((level,i)=>Array.isArray(level)&&finite(level[0])&&level[0]>0&&level[0]<1&&finite(level[1])&&level[1]>=0&&
   (!i||level[0]>=book.asks[i-1][0]))||
  !book.bids.every((level,i)=>Array.isArray(level)&&finite(level[0])&&level[0]>0&&level[0]<1&&finite(level[1])&&level[1]>=0&&
   (!i||level[0]<=book.bids[i-1][0]))||
  book.asks[0][0]<=book.bids[0][0]||book.asks[0][0]<.8||book.asks[0][0]>p.limitCap)
  return reject('entry_book_outside_current_band');
 const shareLimit=Math.min(p.maximumShares,maxShares,p.maximumShares-roundUsedShares);
 if(!finite(market.minSize)||shareLimit<market.minSize)return reject('remaining_shares_below_minimum');
 try{
  const b=computeRayAmountSize({equity,book,market,maxShares,roundUsedShares,limitCap:p.limitCap});
  result.baseline={...b,cashSufficient:finite(b.maxSpend)&&b.maxSpend<=cash+epsilon,
   scope:'unchanged-production-baseline',actualAllocation:p.minimumPct};
  const baselineCost=b.quote?.filled>0?b.quote.total/b.quote.filled:null;
  result.probabilityRequirements=finite(baselineCost)&&baselineCost>0&&baselineCost<1?{
   costPerShare:baselineCost,breakEven:baselineCost,
   minimumAllocationProbability:baselineCost+(p.minimumPct/p.kellyFraction)*(1-baselineCost),
   maximumAllocationProbability:baselineCost+(p.maximumPct/p.kellyFraction)*(1-baselineCost),
   basis:'arithmetic at current 2.5% baseline quote only; larger orders must be requoted; not a probability estimate',
   validated:false}:null;
  const planner=capacityPlanner({equity,cash,book,market,maxShares,roundUsedShares});
  result.liquidityCapacityMaxSpend=planner.capacityQuote?.maxSpend??null;
  result.liquidityCapacityPct=planner.capacityQuote?Math.min(p.maximumPct,planner.plannedPct(planner.capacityCents)):null;
  result.liquidityCapacityMeetsMinimum=Boolean(planner.capacityQuote&&planner.capacityCents>=planner.minimumCents&&
   result.liquidityCapacityPct>=p.minimumPct-epsilon);
  result.calibration=validateProbabilityCalibration({calibrationJson,calibrationRegistry,prediction,market,now,
   expectedFeaturesSha256,expectedGroupKey});
  if(!result.calibration.valid)return reject(result.calibration.reasonCode);
  if(prediction.tokenId!==book.tokenId)return reject('prediction_book_token_mismatch');
  result.probabilityLowerBound=result.calibration.probabilityLowerBound;
  if(!planner.capacityQuote)return reject('no_complete_depth_capacity','candidate-skipped');
  const qualifies=cents=>{
   if(!cents)return true;const q=planner.quote(cents);
   if(q.size<market.minSize)return true;
   if(!planner.full(q))return false;
   const c=q.total/q.filled,k=fractionalKellyPct(result.probabilityLowerBound,c);
   return k!==null&&planner.plannedPct(cents)<=Math.min(p.maximumPct,k)+epsilon;
  };
  const selected=planner.largest(planner.capacityCents,qualifies),q=planner.quote(selected);
  const selectedPct=selected?planner.plannedPct(selected):null,c=q?.filled?q.total/q.filled:null;
  result.costPerShare=c;result.rawPct=fractionalKellyPct(result.probabilityLowerBound,c);
  result.quoteEvaluations=planner.quoteCount();
  if(!q||!planner.full(q)||selected<planner.minimumCents||!finite(selectedPct)||selectedPct<p.minimumPct-epsilon||
   result.rawPct===null||selectedPct>Math.min(p.maximumPct,result.rawPct)+epsilon)
   return reject('validated_fraction_or_capacity_below_minimum','candidate-skipped');
  Object.assign(result,{status:'candidate-ready-shadow',reasonCode:'calibrated_probability_and_complete_depth_candidate',
   candidatePct:selectedPct,plannedMaxSpend:q.maxSpend,quote:q,limitingFactors:[]});
  if(selectedPct<Math.min(p.maximumPct,result.rawPct)-.0001)result.limitingFactors.push('cash-depth-or-request-share-cap');
  if(result.rawPct>p.maximumPct)result.limitingFactors.push('maximum-percentage');
  result.decisionDateHkt=hktDay(now);
  return result;
 }catch(error){return {...reject('execution_metadata_or_depth_invalid'),diagnosticError:error.message};}
}
