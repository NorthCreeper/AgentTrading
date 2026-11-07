// Read-only, fixed-anchor liquidation counterfactuals. No broker or controller dependency.
import {depthQuote} from '../dashboard/strategy.mjs';
import {round} from '../paper-broker.mjs';

export const targetVersion='p2-inventory-targets-v2';
const finite=Number.isFinite;
export function freshQuote(row){
 const p=row?.pm?.Up,now=row?.time;
 return Boolean(p?.ready&&finite(now)&&[row.frameAt,p.sourceAt,p.receivedAt].every(t=>finite(t)&&t<=now&&now-t<=3000)&&
  finite(p.bid)&&p.bid>0&&p.bid<1&&Array.isArray(p.bids));
}
export function eligibleAnchor(r){
 return freshQuote(r)&&r.time-r.marketStart>=120000&&r.time-r.marketStart<122000&&
  r.marketEnd===r.marketStart+300000&&r.time<r.marketEnd&&finite(r.tick)&&r.tick>0&&
  finite(r.pm.Up.buy?.size)&&r.pm.Up.buy.size>0&&finite(r.pm.Up.move30)&&r.reference?.ready&&
  finite(r.reference.twapOpeningOffset)&&[r.reference.sourceAt,r.reference.receivedAt].every(t=>finite(t)&&t<=r.time&&r.time-t<=5000);
}
function signal(row){return {at:row.time,sourceAt:row.pm.Up.sourceAt,limit:round(Math.max(row.tick,row.pm.Up.bid-.02))};}
export function createTarget(row,market){
 if(!eligibleAnchor(row))throw Error('Invalid anchor');
 if(!market||market.slug!==row.slug||market.conditionId!==row.conditionId||market.start!==row.marketStart||market.end!==row.marketEnd||
  !market.tokens?.Up||!market.tokens?.Down)throw Error('Missing or inconsistent market identity');
 const arm=(name,s=null)=>({name,signal:s,status:'pending',execution:null});
 return {version:targetVersion,id:row.id,slug:row.slug,at:row.time,market:structuredClone(market),size:row.pm.Up.buy.size,
  quotedAcquisitionCost:row.pm.Up.buy.cost,day:row.hongKongTime.slice(0,10),
  features:{base:[row.pm.Up.mid,row.remainingSeconds,row.pm.Up.spread,row.pm.Up.move30,row.reference.twapOpeningOffset],
   spotGapUsd:row.deviations.spotUsdMinusTwapUsd,spotReturn30Bps:row.windows.coinbase[30]?.returnBps??null,
   spotVol30Bps:row.windows.coinbase[30]?.realizedVolBps??null},
  arms:[arm('immediate',signal(row)),arm('delay30'),{...arm('settlement'),status:'hold-to-settlement'}]};
}
export function advanceTarget(t,row){
 if(row.slug!==t.slug||row.conditionId!==t.market.conditionId||row.marketStart!==t.market.start||row.marketEnd!==t.market.end||
  row.time<t.at||row.time>=t.market.end)return;
 for(const a of t.arms){
  if(a.name==='settlement'||a.status!=='pending')continue;
  if(!a.signal){
   if(row.time>t.at+32000){a.status='missing-decision';continue;}
   if(row.time>=t.at+30000&&freshQuote(row))a.signal=signal(row);
  }
  if(!a.signal)continue;
  if(row.time>a.signal.at+4000){a.status='missing-quote';continue;}
  if(row.time<a.signal.at+1000||!freshQuote(row)||row.pm.Up.sourceAt<=a.signal.sourceAt)continue;
  const p=row.pm.Up,q=depthQuote({bids:p.bids},'sell',t.size,{fee:row.fee},a.signal.limit);
  // P2 v1 logs only bids >= current best - .02. If price improved and the
  // logged depth is insufficient, omitted eligible levels make the fill unknowable.
  const coverageFloor=round(Math.max(row.tick,p.bid-.02));
  const censored=!q.complete&&a.signal.limit<coverageFloor-1e-8;
  a.status=censored?'depth-censored':q.complete?'filled':q.filled?'partial':'protection-unfilled';
  a.execution={at:row.time,sourceAt:p.sourceAt,receivedAt:p.receivedAt,limit:a.signal.limit,bid:p.bid,
   observedFilled:q.filled,notional:q.notional,fees:q.fees,netProceeds:round(q.notional-q.fees),
   remaining:censored?null:round(t.size-q.filled),coverageFloor};
 }
}
function validLabel(t,l,cutoff){
 return Boolean(l&&finite(l.observedAt)&&l.observedAt>=t.market.end&&l.observedAt<=cutoff&&l.slug===t.slug&&
  l.conditionId===t.market.conditionId&&l.start===t.market.start&&l.end===t.market.end&&
  ['Up','Down'].every(o=>l.tokens?.[o]===t.market.tokens[o]&&[0,1].includes(l.payouts?.[o]))&&l.payouts.Up+l.payouts.Down===1);
}
export function finishTarget(target,label,cutoff){
 const t=structuredClone(target),verified=validLabel(t,label,cutoff);
 t.cutoff=cutoff;t.labelObservedAt=verified?label.observedAt:null;t.payout=verified?label.payouts.Up:null;
 for(const a of t.arms){
  if(a.name!=='settlement'&&a.status==='pending'){
   const deadline=a.signal?a.signal.at+4000:t.at+32000;
   if(cutoff>deadline)a.status=a.signal?'missing-quote':'missing-decision';
  }
  const unknown=['depth-censored','missing-quote','missing-decision'].includes(a.status)||a.name!=='settlement'&&a.status==='pending';
  if(unknown){Object.assign(a,{complete:false,terminalValue:null,knownAt:null,remaining:null,inventoryShareSeconds:null,
   settlementWaitShareSeconds:null,reason:a.status});continue;}
  const e=a.execution,sold=e?.observedFilled??0,residual=round(t.size-sold),cash=e?.netProceeds??0;
  const complete=residual===0||verified,closedAt=residual===0?e.at:verified?label.observedAt:null;
  const until=closedAt??cutoff;
  Object.assign(a,{complete,terminalValue:complete?round(cash+residual*(t.payout??0)):null,
   knownAt:closedAt,remaining:complete?0:residual,remainingBeforeSettlement:residual,
   cashFromSale:cash,settlementProceeds:verified?round(residual*t.payout):0,
   valueBounds:complete?null:[cash,round(cash+residual)],
   inventoryShareSeconds:round((sold*((e?.at??t.at)-t.at)+residual*(until-t.at))/1000),
   settlementWaitShareSeconds:round(residual*Math.max(0,until-t.market.end)/1000),
   occupiedMs:until-t.at,reason:complete?null:'awaiting-verified-settlement'});
 }
 const first=t.arms[0];
 t.pairs=t.arms.slice(1).map(a=>({policy:a.name,complete:first.complete&&a.complete,
  perShareDifference:first.complete&&a.complete?round((a.terminalValue-first.terminalValue)/t.size):null,
  targetKnownAt:first.complete&&a.complete?Math.max(first.knownAt,a.knownAt):null}));
 return t;
}
