import {marketInformationExit} from '../../dashboard/market-exit.mjs';
import {quoteAmountExecution} from './execution-policies.mjs';
import {evaluateEntryPolicy} from './entry-policies.mjs';

const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export const suiteProtocol=freeze({version:'p3-p6-full-history-screen-v1',paperOnly:true,
 initialCapital:100,maxExposure:10,amountUsd:1,calendarTimezone:'Asia/Hong_Kong',
 split:'chronological whole observed HKT dates 60/20/20; partial first/last dates excluded from promotion',
 scenarios:[{id:'base',delayMs:1000,feeMultiplier:1},{id:'stress',delayMs:2000,feeMultiplier:1.25}],
 fixedModel:'fit exactly once using training-round 120s features and strict labels known >60s before validation boundary',
 adaptiveModel:'stored forecast updated only at later strict label receivedAt; no final parameters backfilled',
 payment:'earliest recorded independently verified official receipt; no assumed immediate expiry payout',
 missing:'no interpolation, no retrospective ideal-entry selection, unknown inventory retained',
 historicalPromotion:{minimumCompletedValidation:30,minimumCompletedTest:30,minimumDatesEach:3,
  positiveAbsoluteNetBoth:true,positiveIncrementBoth:true,stressPositiveAbsoluteAndIncrement:true,
  resolvedAccountRequired:true,dateBlockLowerBoundPositive:true,familywiseAlpha:.05,
  bestPositiveDateShareMaximum:.5},
 scopes:['continuous-full-history','validation-new-independent-100','test-new-independent-100'],
 limits:['History has already been inspected, so date holdouts are retrospective screens, not untouched prospective proof.',
 'Replay of displayed book depth is a counterfactual fill model; missing queue priority prevents maker verification.',
 'A finite declared suite cannot exhaust every possible strategy; no result-driven threshold search.',
 'Old registered P3 cohorts and main cash/history are never seeded or reset using replay profit.']});

export const candidates=freeze([
 {id:'baseline',phase:'control',label:'原动量／市场退出',entry:'forward-control',exit:'market'},
 {id:'p3-bid',phase:'P3',label:'净卖出价值退出',entry:'forward-control',exit:'bid'},
 {id:'p3-consensus',phase:'P3',label:'两项共同确认退出',entry:'forward-control',exit:'consensus'},
 {id:'p3-settlement',phase:'P3',label:'原动量持有核实结算',entry:'forward-control',exit:'settlement'},
 {id:'p3-btc-support',phase:'P3',label:'BTC支持时等待',entry:'forward-control',exit:'market',customExit:'support'},
 {id:'p3-btc-joint',phase:'P3',label:'BTC与盘口共同转弱',entry:'forward-control',exit:'market',customExit:'joint'},
 {id:'p3-delay30-revalidate',phase:'P3',label:'首次退出后延后30秒再验证',entry:'forward-control',exit:'market',customExit:'delay30'},
 {id:'p3-market-value',phase:'P3',label:'120秒盘口概率',entry:'p3-market-value-120',exit:'settlement'},
 {id:'p3-fixed-value',phase:'P3',label:'120秒因果固定校准',entry:'p3-fixed-value-120',exit:'settlement'},
 {id:'p3-adaptive-value',phase:'P3',label:'120秒延后在线校准',entry:'p3-adaptive-value-120',exit:'settlement'},
 {id:'p4-aligned-cap',phase:'P4',label:'同向且85¢以下',entry:'forward-aligned-capped',exit:'market'},
 {id:'p4-twap-residual',phase:'P4',label:'同向标准化TWAP偏离',entry:'forward-twap-residual',exit:'market'},
 {id:'p4-wait60',phase:'P4',label:'等到60秒再考虑原动量',entry:'forward-control',exit:'market',minimumAgeMs:60000},
 {id:'p4-wait120',phase:'P4',label:'等到120秒再考虑原动量',entry:'forward-control',exit:'market',minimumAgeMs:120000},
 {id:'p5-retry',phase:'P5',label:'零成交新源最多重试一次',entry:'forward-control',exit:'market',retry:true},
 {id:'p5-reentry',phase:'P5',label:'全部平仓后新信号最多二次入场',entry:'forward-control',exit:'market',reentry:true},
 {id:'p6-protection0',phase:'P6',label:'原动量0 tick买入保护',entry:'forward-control',exit:'market',protectionTicks:0},
 {id:'p6-protection1',phase:'P6',label:'原动量1 tick买入保护',entry:'forward-control',exit:'market',protectionTicks:1},
 {id:'p6-protection2',phase:'P6',label:'原动量2 tick买入保护',entry:'forward-control',exit:'market',protectionTicks:2},
]);
export const evidenceOnly=freeze([{id:'p6-equal-share-pair',phase:'P6',label:'等量双边组合',verifiability:'book-opportunity-and-delayed-leg-check'},
 {id:'p6-maker',phase:'P6',label:'挂单队列与返佣',verifiability:'missing-own-queue-evidence'}]);
export function candidateDecision(c,input,cache=new Map()){
 if(!cache.has(c.entry)){
  let prepared=input;
  if(c.entry.startsWith('forward-')&&c.entry!=='forward-control'){
   if(!cache.has('forward-control'))cache.set('forward-control',evaluateEntryPolicy('forward-control',input));
   const b=cache.get('forward-control');prepared={...input,forwardBase:{candidates:b.candidates,selected:b.selected,reason:b.reason,dataQuality:b.diagnostics.dataQuality}};
  }
  cache.set(c.entry,evaluateEntryPolicy(c.entry,prepared));
 }
 const result=cache.get(c.entry),selected=result.selected;
 if(!selected||c.minimumAgeMs&&input.now-input.frame.market.start<c.minimumAgeMs)return {selected:null,reason:result.skipCode??'waiting-age',result};
 if(c.protectionTicks===undefined)return {selected,reason:null,result};
 const q=quoteAmountExecution({frame:input.frame,outcome:selected.outcome,now:input.now,policy:{protectionTicks:c.protectionTicks,requireFullDepth:true}});
 return {selected:q.allowed&&q.complete?{...selected,limit:q.limit,executionCandidate:c.id}:null,reason:q.reason,result};
}
export function candidateExit(c){
 if(c.customExit==='support'||c.customExit==='joint')return (t,n,b,m,now,cfg,h,p)=>marketInformationExit(t,n,b,m,now,cfg,h,p,c.customExit==='joint'?'joint':'support');
 if(c.customExit==='delay30')return (t,n,b,m,now,cfg,h,p)=>{
  const e=marketInformationExit(t,n,b,m,now,cfg,h,p);
  if(!e){delete t.delayedMarketExit;return null;}
  t.delayedMarketExit??={since:now};
  return now-t.delayedMarketExit.since>=30000?e:null;
 };
 return null;
}
