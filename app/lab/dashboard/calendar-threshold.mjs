export const calendarThresholdVersion='ray-calendar-threshold-v1';
const baseline=Object.freeze({morning:40,midday:60,night:80});
export function calendarPolicyType(context){
 if(context?.primaryType!=='macro_release')return context?.primaryType??'calendar_unknown';
 const excluded=new Set(['crypto_expiry','equity_monthly_expiry','equity_quarterly_expiry']);
 const kinds=[...new Set((context.eventWindows??[]).filter(e=>!excluded.has(e.kind??e.event?.kind))
  .map(e=>e.kind??e.event?.kind??'unknown'))].sort();
 return 'macro_release:'+(kinds.join('+')||'unknown');
}
export const calendarThresholdKey=value=>JSON.stringify({version:value?.version,session:value?.session,
 primaryType:value?.primaryType,policyType:value?.policyType,dateNy:value?.context?.dateNy,status:value?.status,active:value?.active,
 thresholdUsd:value?.thresholdUsd,policyRevision:value?.policyRevision,policyAvailableAt:value?.policyAvailableAt,
 calendarSourceSha256:value?.calendarSourceSha256,policySourceSha256:value?.policySourceSha256,
 events:value?.context?.eventWindows?.map(e=>e.id).sort()??[]});

// Noise-scale calibration and return validation are separate claims. This
// selector cannot change risk allocation, order execution or exit ownership.
export function selectCalendarThreshold({now,session,context,model}={}){
 const base=baseline[session];
 const result={version:calendarThresholdVersion,session,baseThresholdUsd:base??null,thresholdUsd:base??null,
  primaryType:context?.primaryType??'calendar_unknown',policyType:calendarPolicyType(context),context:context??null,
  policyRevision:model?.revision??null,policyAvailableAt:model?.availableAt??null,
  fitThrough:model?.fitThrough??null,validUntil:model?.validUntil??null,
  active:false,status:'inherited-baseline',calibration:'none',returnValidated:false,
  riskAllocationEffect:'none',support:null,candidateThresholdUsd:null,reason:'该日期类型尚无足够独立历史支持，沿用原时段门槛'};
 const fallback=(status,reason)=>({...result,status,reason});
 if(!Number.isFinite(base)||!Number.isFinite(now))return fallback('invalid-time-band','时间或时段未知');
 if(context?.known!==true)return fallback('calendar-unknown','日历覆盖或日期身份未核实，沿用原时段门槛');
 if(!model||model.version!=='ray-calendar-noise-policy-v1'||!Number.isFinite(model.fitThrough)||
  !Number.isFinite(model.availableAt)||model.availableAt<model.fitThrough||!Number.isFinite(model.validUntil)||
  model.validUntil<=model.availableAt||model.validUntil-model.availableAt>31*86400000)
  return fallback('policy-unavailable','日期门槛标定记录无效，沿用原时段门槛');
 if(now<model.availableAt)return fallback('policy-not-yet-available','此时尚无该标定结果，禁止使用未来历史参数');
 if(now>=model.validUntil)return fallback('policy-expired','日期门槛已到复核期限，沿用原时段门槛');
 if(model.calendarRevision!==context.calendarRevision)return fallback('calendar-policy-mismatch','日历与门槛来源版本不匹配，沿用原时段门槛');
 const cell=model.groups?.[result.policyType]?.[session];
 result.support=cell?.support??null;
 result.candidateThresholdUsd=Number.isFinite(cell?.trainingRatio)&&cell.trainingRatio>0&&cell.support?.trainingDates>0&&
  Number.isFinite(cell.thresholdUsd)?cell.thresholdUsd:null;
 if(!cell?.admitted){
  const codes=String(cell?.reason??'independent_date_support').split(';'),names={
   independent_date_support:'独立日期数量不足',bootstrap_interval_includes_one_or_missing:'日期差异的置信区间不足以支持调整',
   chronological_noise_ratio_unstable:'后段日期的波动比率与前段不够稳定',liquidity_deterioration:'有效双侧盘口覆盖下降'};
  return {...fallback('insufficient-date-support',context.primaryType==='regular_weekday'?'普通交易日沿用原时段门槛':
   `${codes.map(c=>names[c]??'尚未通过独立日期复核').join('；')}，沿用原时段门槛`),reasonCode:cell?.reason??'independent_date_support'};
 }
 if(cell.calibration!=='noise-scale-only'||!Number.isFinite(cell.thresholdUsd)||cell.thresholdUsd<base*.5||cell.thresholdUsd>base*2||
  !Number.isInteger(cell.support?.trainingDates)||!Number.isInteger(cell.support?.testDates)||
  cell.support.trainingDates<6||cell.support.testDates<3||!Number.isInteger(cell.support.baselineTrainingDates)||
  !Number.isInteger(cell.support.baselineTestDates)||cell.support.baselineTrainingDates<10||cell.support.baselineTestDates<5||
  !Number.isFinite(cell.trainingRatio)||cell.trainingRatio<=0||!Number.isFinite(cell.holdoutRatio)||cell.holdoutRatio<=0||
  Math.max(cell.trainingRatio/cell.holdoutRatio,cell.holdoutRatio/cell.trainingRatio)>1.25||
  (cell.trainingRatio<1)!==(cell.holdoutRatio<1)||!Array.isArray(cell.trainingRatioBootstrap95)||
  cell.trainingRatioBootstrap95.length!==2||!cell.trainingRatioBootstrap95.every(Number.isFinite)||
  cell.trainingRatioBootstrap95[0]<=0||cell.trainingRatioBootstrap95[0]>cell.trainingRatioBootstrap95[1]||
  !(cell.trainingRatio<1?cell.trainingRatioBootstrap95[1]<1:cell.trainingRatio>1&&cell.trainingRatioBootstrap95[0]>1)||
  ![cell.freshBookFraction?.group,cell.freshBookFraction?.baseline].every(v=>Number.isFinite(v)&&v>=0&&v<=1)||
  cell.freshBookFraction.baseline-cell.freshBookFraction.group>.2||
  cell.thresholdUsd!==Math.round(base*Math.min(1.5,Math.max(.5,cell.trainingRatio))/5)*5)
  return fallback('calibration-rejected','独立日期支持或波动标定边界不足，沿用原时段门槛');
 return {...result,thresholdUsd:cell.thresholdUsd,active:true,status:'calendar-noise-scale',
  calibration:'noise-scale-only',returnValidated:false,reason:cell.reason??'按日期噪声尺度设置准入门槛，收益有效性尚未验证'};
}
