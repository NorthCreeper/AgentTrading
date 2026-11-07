import {readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';import {writeJsonAtomic} from './atomic-json.mjs';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const checkpointVersion='btc5m-state-checkpoint-v2';
export const checkpointKeyVersion='btc5m-critical-financial-key-v2';
const legacyVersion='btc5m-state-checkpoint-v1',legacyKeyVersion='btc5m-financial-key-v1';
// This exact field order and algorithm belong to the original v1 envelopes.
// Never validate an old envelope with a newly expanded critical-state key.
const legacyFields=s=>({session:s.sessionId,account:s.account,orders:s.orders,applied:s.applied,usedIntents:s.usedIntents,
 brokerSequence:s.brokerSequence,sequence:s.sequence,locks:s.rayMarketEntries,roundFills:s.rayRoundFills,attempted:s.attempted,
 trade:s.strategyTrade,owners:s.rayOwnedPositions,pending:s.pendingSettlements,experiment:s.experiment,config:s.config,strategy:s.strategyConfig,
 intent:s.runIntent,hold:s.recoveryHold,evidence:s.recoveryEvidence,baseline:s.recoveryBaseline});
const legacyFinancialStateKey=s=>sha(legacyFields(s));
export function financialStateKey(s){
 const evolution=s.evolution;
 return sha({...legacyFields(s),mode:s.mode,portfolio:s.portfolio,requestIds:s.requestIds,entryAt:s.entryAt,
  entryPolicy:s.rayMarketEntryPolicy,alignment:s.rayAlignmentVersion,positionManagement:s.positionManagementVersion,
  entryTrigger:s.rayEntryTrigger?{version:s.rayEntryTrigger.version,lastAttempt:s.rayEntryTrigger.lastAttempt,recentAttempts:s.rayEntryTrigger.recentAttempts}:null,
  evolutionControl:evolution?{version:evolution.version,registeredAt:evolution.registeredAt,firstBatchStart:evolution.firstBatchStart,registryHash:evolution.registryHash,governance:evolution.governance}:null});
}
export function readCheckpoints(directory){return ['a','b'].flatMap(slot=>{const file=join(directory,`state-checkpoint-${slot}.json`);if(!existsSync(file))return[];
 try{const e=JSON.parse(readFileSync(file,'utf8'));if(!Number.isSafeInteger(e.generation)||e.generation<1||!e.state||e.state.realTrading!==false||sha(e.state)!==e.sha256)return[];
  let expected,keyVersion;if(e.version===legacyVersion){expected=legacyFinancialStateKey(e.state);keyVersion=legacyKeyVersion;}
  else if(e.version===checkpointVersion&&e.keyVersion===checkpointKeyVersion){expected=financialStateKey(e.state);keyVersion=checkpointKeyVersion;}else return[];
  if(expected!==e.financialKey)return[];
  // Callers compare .financialKey to financialStateKey(mainState). Normalize
  // that comparison only AFTER validating the envelope's original algorithm.
  // Preserve both original version tags and digest, so legacy markers still
  // require a real v2 publication and original payload hashes stay unchanged.
  return[{...e,keyVersion,storedKeyVersion:keyVersion,storedFinancialKey:e.financialKey,financialKey:financialStateKey(e.state),normalizedKeyVersion:checkpointKeyVersion,file}];}catch{return[];}}).sort((a,b)=>b.generation-a.generation);}
export function writeStateCheckpoint(directory,state,marker=null,{write=writeJsonAtomic}={}){
 const prior=marker??readCheckpoints(directory)[0]??{generation:0,financialKey:null},key=financialStateKey(state);
 // Old or untagged in-memory markers must publish one v2 checkpoint even if
 // their digest happens to match. A marker alone cannot claim v2 coverage.
 if(prior.version===checkpointVersion&&prior.keyVersion===checkpointKeyVersion&&key===prior.financialKey)return {version:checkpointVersion,keyVersion:checkpointKeyVersion,generation:prior.generation,financialKey:key};
 const generation=prior.generation+1,envelope={version:checkpointVersion,keyVersion:checkpointKeyVersion,generation,createdAt:Date.now(),financialKey:key,sha256:sha(state),state};
 write(join(directory,`state-checkpoint-${generation%2?'a':'b'}.json`),envelope);
 return {version:checkpointVersion,keyVersion:checkpointKeyVersion,generation,financialKey:key};
}
