import {eligibleAnchor,createTarget as createV2,finishTarget} from './p2-targets.mjs';
import {depthQuote} from '../dashboard/strategy.mjs';
import {round} from '../paper-broker.mjs';
export {eligibleAnchor,finishTarget};
export const targetVersion='p2-inventory-targets-v3';
export function createTarget(row,market){return {...createV2(row,market),version:targetVersion};}
function observed(row,t){
 const p=row.pm?.Up;
 return Boolean(p?.bookObserved&&p.tokenId===t.market.tokens.Up&&p.bidDepthCoverage==='full-received-book'&&
  [row.frameAt,p.sourceAt,p.receivedAt].every(t=>Number.isFinite(t)&&t<=row.time&&row.time-t<=3000)&&
  Array.isArray(p.bids)&&(p.bids.length===0||p.bidReady&&p.bid===p.bids[0][0]));
}
export function advanceTarget(t,row){
 if(row.slug!==t.slug||row.conditionId!==t.market.conditionId||row.marketStart!==t.market.start||row.marketEnd!==t.market.end||
  row.time<t.at||row.time>=t.market.end)return;
 const p=row.pm.Up;
 for(const a of t.arms){
  if(a.name==='settlement'||a.status!=='pending')continue;
  if(!a.signal){
   if(row.time>t.at+32000){a.status='missing-decision';continue;}
   if(row.time>=t.at+30000&&observed(row,t)){
    if(!p.bids.length){a.status='no-bid-at-decision';a.observedAt=row.time;continue;}
    a.signal={at:row.time,sourceAt:p.sourceAt,limit:round(Math.max(row.tick,p.bid-.02))};
   }
  }
  if(!a.signal)continue;
  if(row.time>a.signal.at+4000){a.status='missing-quote';continue;}
  if(row.time<a.signal.at+1000||!observed(row,t)||p.sourceAt<=a.signal.sourceAt)continue;
  const q=depthQuote({bids:p.bids},'sell',t.size,{fee:row.fee},a.signal.limit);
  a.status=q.complete?'filled':q.filled?'partial':p.bids.length?'protection-unfilled':'no-bid-at-execution';
  a.execution={at:row.time,sourceAt:p.sourceAt,receivedAt:p.receivedAt,limit:a.signal.limit,bid:p.bid,
   observedFilled:q.filled,notional:q.notional,fees:q.fees,netProceeds:round(q.notional-q.fees),
   remaining:round(t.size-q.filled),coverageFloor:row.tick,bidDepthCoverage:p.bidDepthCoverage};
 }
}
