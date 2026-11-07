import {e18ToPrice} from './chart-model.mjs';

export const rayOpeningVersion='ray-opening-sixty-v2';
export const rayOpeningSource='rtds-twap-sixty-opening';
const basis='opening-60s-twap';
const resolutionSource='https://data.chain.link/streams/btc-usd-twap-60s-streams';

// Spot remains a separately labelled research observation. It is never an
// opening baseline for the 60-second TWAP strategy.
export function chainlinkSpot(message,receivedAt){
 const p=message?.payload;if(message?.topic!=='crypto_prices_chainlink'||message.type&&message.type!=='update'||p?.symbol!=='btc/usd')return null;
 const timestamp=Number(p.timestamp),value=typeof p.full_accuracy_value==='string'?Number(p.full_accuracy_value)/1e18:Number(p.value);
 if(!Number.isFinite(timestamp)||timestamp>receivedAt||receivedAt-timestamp>5000||!Number.isFinite(value)||value<=0)return null;
 return {value,referenceAt:timestamp,knownAt:receivedAt,source:'rtds-chainlink-spot'};
}
// Both live normalized reports and persisted price-history rows use their
// original receipt clock. A restart must not make historical data known sooner.
export function twapOpeningRow(row){
 const referenceAt=row?.timestamp??row?.time,knownAt=row?.receivedAt;
 const value=e18ToPrice(row?.valueE18);
 if(row?.windowSeconds!==60||!value||!Number.isFinite(referenceAt)||!Number.isFinite(knownAt)||referenceAt>knownAt)return null;
 return {openingVersion:rayOpeningVersion,basis,source:rayOpeningSource,windowSeconds:60,
  referenceAt,knownAt,receivedAt:knownAt,value,valueE18:row.valueE18,
  ...(typeof row.slug==='string'?{slug:row.slug}:{}),
  ...(typeof row.conditionId==='string'?{conditionId:row.conditionId}:{}),
  ...(Number.isFinite(row.publishedAt)?{publishedAt:row.publishedAt}:{}),
  ...(Number.isFinite(row.rawWallReceivedAt)?{rawWallReceivedAt:row.rawWallReceivedAt}:{})};
}

export function gammaRayOpening(m,gamma,knownAt){
 if(!m||gamma?.slug!==m.slug||gamma.conditionId!==m.conditionId||gamma.resolutionSource!==resolutionSource||!Number.isFinite(knownAt)||knownAt<m.start)return null;
 const event=gamma.events?.find(e=>e.slug===m.slug);
 const value=event?.eventMetadata?.priceToBeat;
 if(!['number','string'].includes(typeof value)||typeof value==='string'&&!value.trim()||!Number.isFinite(Number(value))||Number(value)<=0)return null;
 return {openingVersion:rayOpeningVersion,basis,source:'gamma-price-to-beat',windowSeconds:60,
  slug:m.slug,conditionId:m.conditionId,referenceAt:m.start,knownAt,value:Number(value),
  metadataPath:'events[matching slug].eventMetadata.priceToBeat',resolutionSource};
}

function knownOpeningEvidence(o,m,now){
 if(!o||!m||o.slug!==m.slug||o.conditionId!==m.conditionId||!Number.isFinite(now)||
  !Number.isFinite(o.value)||o.value<=0||o.windowSeconds!==60||o.referenceAt!==m.start||
  !Number.isFinite(o.knownAt)||o.knownAt<o.referenceAt||o.knownAt>now)return false;
 if(o.source==='gamma-price-to-beat')return true;
 return o.source===rayOpeningSource&&e18ToPrice(o.valueE18)===o.value;
}
export function validRayOpeningEvidence(o,m,now){
 return knownOpeningEvidence(o,m,now)&&o.status!=='conflict'&&!(Array.isArray(o.conflicts)&&o.conflicts.length);
}

export function chooseRayOpening(m,rows,metadata,knownAt){
 const candidates=rows.filter(r=>r.referenceAt===m.start&&r.knownAt<=knownAt&&
  (!r.slug||r.slug===m.slug)&&(!r.conditionId||r.conditionId===m.conditionId)&&
  validRayOpeningEvidence({...r,slug:m.slug,conditionId:m.conditionId},m,knownAt))
  .sort((a,b)=>a.knownAt-b.knownAt);
 if(validRayOpeningEvidence(metadata,m,knownAt)&&metadata.source==='gamma-price-to-beat')candidates.unshift(metadata);
 const first=candidates[0];
 if(!first)return null;
 const selected={...structuredClone(first),slug:m.slug,conditionId:m.conditionId};
 // Conflicting duplicate reports for the exact opening cannot be silently
 // resolved by array order or by selecting a more favourable price.
 return candidates.slice(1).reduce((locked,next)=>lockRayOpening(m,locked,{...next,slug:m.slug,conditionId:m.conditionId},knownAt),selected);
}

export function lockRayOpening(m,saved,observed,now){
 if(!knownOpeningEvidence(saved,m,now))return knownOpeningEvidence(observed,m,now)?structuredClone(observed):null;
 if(!knownOpeningEvidence(observed,m,now))return structuredClone(saved);
 const conflicts=[...(saved.conflicts??[])];
 const different=saved.value!==observed.value||saved.valueE18&&observed.valueE18&&saved.valueE18!==observed.valueE18;
 const incoming=[...(observed.conflicts??[]),...(different?[observed]:[])];
 for(const row of incoming)if(!conflicts.some(c=>c.source===row.source&&c.referenceAt===row.referenceAt&&c.value===row.value&&c.valueE18===row.valueE18))
  conflicts.push({source:row.source,referenceAt:row.referenceAt,knownAt:row.knownAt,value:row.value,
   ...(row.valueE18?{valueE18:row.valueE18}:{})});
 if(!conflicts.length)return structuredClone(saved);
 return {...structuredClone(saved),status:'conflict',conflictFirstKnownAt:saved.conflictFirstKnownAt??observed.knownAt,
  conflicts:conflicts.slice(0,8)};
}
