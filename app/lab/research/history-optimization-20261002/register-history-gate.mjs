import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {evolutionRegistry,evolutionVersion,nextHktDay} from '../../dashboard/evolution-coordinator.mjs';
import {newEvolutionGovernance,evolutionProtocol as governanceProtocol} from '../../dashboard/evolution-governance.mjs';
import {writeJsonAtomic} from '../../dashboard/atomic-json.mjs';
import {HistoryApprovalGate} from '../../dashboard/history-approval.mjs';
import {historyApprovalBindingPinned} from '../../dashboard/history-approval-binding.mjs';
import {evolutionProtocol as cohortProtocol,evolutionImplementation} from '../../dashboard/evolution-study.mjs';
import {newEvolutionPortfolio} from '../../dashboard/evolution-portfolio.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
export function validateUnstartedLegacyCohort(cohort,old,now){
  assert.equal(old.version,'strategy-evolution-runtime-v1');
  assert.deepEqual(old.protocol,governanceProtocol);
  assert.equal(hash(JSON.stringify(old.protocol)),old.protocolHash);
  assert.equal(hash(JSON.stringify(old.codeHashes)),old.implementationHash);
  assert.equal(hash(JSON.stringify({version:old.version,protocolHash:old.protocolHash,implementationHash:old.implementationHash})),old.registryHash);
  assert.ok(Number.isFinite(now)&&now<old.firstBatchStart,'Old economic batch must not have started');
  assert.equal(cohort.version,'strategy-evolution-cohort-v1');
  assert.equal(cohort.createdAt,old.registeredAt);
  assert.equal(cohort.registryHash,old.registryHash);
  const day=86400000;
  assert.deepEqual(cohort.batch,{id:old.registryHash.slice(0,12)+'-0',start:old.firstBatchStart,
    end:old.firstBatchStart+7*day,labelCutoff:old.firstBatchStart+8*day});
  assert.deepEqual(cohort.protocol,cohortProtocol);
  assert.deepEqual(cohort.implementation,evolutionImplementation(),'Legacy study implementation must still be unchanged');
  for(const [source,expected]of Object.entries(cohort.implementation.implementationCodeHashes))
    assert.equal(old.codeHashes[source.replace(/^\.\//,'')],expected,'Cohort implementation must match its original registry');
  assert.equal(cohort.closedAt,null);assert.deepEqual(cohort.pending,[]);assert.equal(cohort.eventSequence,0);
  assert.deepEqual(cohort.daily,{});
  for(const key of ['startedAt','lastAt'])assert.ok(cohort[key]===null||Number.isFinite(cohort[key])&&cohort[key]<=now);
  assert.ok(Array.isArray(cohort.accounts));assert.equal(cohort.accounts.length,4);
  const expected=['market-0','market-1000','consensus-0','consensus-1000'];
  assert.deepEqual(cohort.accounts.map(a=>a.id).sort(),expected.sort(),'Four unique policy and delay accounts are required');
  for(const a of cohort.accounts){
    assert.equal(a.version,cohort.version);
    assert.ok(['market','consensus'].includes(a.policy));assert.ok([0,1000].includes(a.executionDelayMs));
    assert.equal(a.id,a.policy+'-'+a.executionDelayMs,'Account ID must bind its policy and execution delay');
    assert.equal(a.cash,100);assert.equal(a.initialCapital,100);assert.equal(a.completed,0);assert.equal(a.wins,0);
    assert.equal(a.fees,0);assert.equal(a.realized,0);assert.equal(a.peak,0);assert.equal(a.maxRealizedDrawdown,0);
    assert.deepEqual(a.closedTrades,[]);assert.deepEqual(a.pendingSettlements,[]);assert.deepEqual(a.settlementIntents,[]);
    assert.equal(a.position,null);assert.equal(a.pendingBuy,null);assert.equal(a.executionSequence,0);
    assert.deepEqual(a.attemptedRounds,[]);assert.deepEqual(a.lastConsumedSources,{});assert.deepEqual(a.daily,{});
    assert.deepEqual(a.dispositions,{});assert.ok(a.lastAt===null||Number.isFinite(a.lastAt)&&a.lastAt<=now);
    assert.deepEqual(a.counts,{unfilled:0,capitalBlockedSignals:0,busySignals:0,pausedPendingBuys:0});
    assert.deepEqual({...a,lastAt:null},newEvolutionPortfolio(a.policy,a.executionDelayMs),
      'An untouched cohort cannot contain unrecognized assets or prior execution state');
  }
  return true;
}
export function replaceHistoricalGovernance(saved,registry,now){
  assert.equal(saved.realTrading,false);assert.equal(saved.account.halted,null);
  assert.equal(saved.account.active,null,'Reconcile active orders before maintenance');
  assert.equal(saved.evolution.version,'strategy-evolution-runtime-v1');
  assert.equal(registry.version,'strategy-evolution-runtime-v2-history');
  assert.equal(saved.evolution.governance.effectivePolicy,'market');
  assert.equal(saved.evolution.governance.phase,'primary');
  assert.deepEqual(saved.evolution.governance.history,[]);
  assert.deepEqual(saved.evolution.governance.processedBatches,{});
  assert.deepEqual(saved.evolution.governance.processedResults,{});
  assert.equal(saved.evolution.governance.adoptionId,null);
  assert.equal(saved.evolution.governance.confirmationOf,null);
  assert.deepEqual(saved.evolution.governance,newEvolutionGovernance({createdAt:saved.evolution.registeredAt,
    registryHash:saved.evolution.registryHash}),'Only untouched initial governance may be retired');
  assert.ok(Number.isFinite(now)&&now>saved.evolution.registeredAt);
  assert.ok(now<saved.evolution.firstBatchStart,'One-time migration cannot retire an already started economic batch');
  assert.notEqual(saved.evolution.registryHash,registry.registryHash);
  const corrected=structuredClone(saved),retired=structuredClone(saved.evolution);
  corrected.evolution={version:registry.version,registeredAt:now,firstBatchStart:nextHktDay(now),registryHash:registry.registryHash,
    governance:newEvolutionGovernance({createdAt:now,registryHash:registry.registryHash})};
  const {evolution:old,...before}=saved,{evolution:replacement,...after}=corrected;
  assert.deepEqual(after,before,'Only candidate governance may change; main economic state is immutable');
  return {corrected,retired};
}
export function registerHistoryGate(directory,lab){
  const runtime=join(lab,'dashboard/runtime'),path=join(runtime,'state.json');
  const pid=Number(readFileSync(join(runtime,'server.pid'),'utf8').trim());
  assert.ok(Number.isInteger(pid)&&pid>0);
  try{process.kill(pid,0);throw Error('Main process must exit before migration');}catch(error){if(error.code!=='ESRCH')throw error;}
  const bytes=readFileSync(path),saved=read(path),old=read(join(runtime,'evolution-cohorts',saved.evolution.registryHash+'.json')),
    now=Date.now(),approval=new HistoryApprovalGate({approvalPath:join(runtime,'history-approval.json'),binding:historyApprovalBindingPinned}).check(now),
    registry=evolutionRegistry(historyApprovalBindingPinned,approval.approved);
  assert.ok(['independently-verified','independent-history-screen-failed'].includes(approval.code),'Historical certificate must verify even when economic screening fails');
  assert.equal(old.version,'strategy-evolution-runtime-v1');
  assert.equal(old.registeredAt,saved.evolution.registeredAt);
  assert.equal(old.firstBatchStart,saved.evolution.firstBatchStart);
  assert.equal(old.registryHash,saved.evolution.registryHash);
  const legacyCohort=read(join(runtime,'evolution-cohorts',saved.evolution.registryHash.slice(0,12),saved.evolution.registryHash.slice(0,12)+'-0','evolution-study.json'));
  validateUnstartedLegacyCohort(legacyCohort,old,now);
  const changed=Object.keys(old.codeHashes).filter(p=>old.codeHashes[p]!==registry.codeHashes[p]).sort();
  assert.deepEqual(changed,['evolution-coordinator.mjs'],'Existing execution and exit implementation must remain unchanged');
  const {corrected,retired}=replaceHistoricalGovernance(saved,registry,now),archive=join(directory,'retired-v1.5-governance');
  mkdirSync(archive,{recursive:true});cpSync(join(runtime,'evolution-cohorts',retired.registryHash+'.json'),join(archive,'registration.json'));
  cpSync(join(runtime,'evolution-cohorts',retired.registryHash.slice(0,12)),join(archive,'cohorts'),{recursive:true,errorOnExist:true,force:false});
  writeFileSync(join(archive,'controller-evolution-state.json'),JSON.stringify(retired,null,2)+'\n',{flag:'wx'});
  const pre={version:'historical-prerequisite-registration-v1',createdAt:now,reason:'User requires all P3–P6 candidate changes to pass full historical comparison before adoption.',
    historicalApproval:approval,changedSources:changed,oldRegistryHash:retired.registryHash,registry,
    firstStartRule:'Next actual HKT midnight. No backfill or earlier-window stitching.',
    plannedBatches:[0,1].map(i=>({index:i,start:corrected.evolution.firstBatchStart+i*7*86400000,end:corrected.evolution.firstBatchStart+(i+1)*7*86400000,
      labelCutoff:corrected.evolution.firstBatchStart+(i+1)*7*86400000+86400000})),
    mainFundsReset:false,legacyStudiesMutated:false,economicFailureRetry:false,originalSixAccountWindowChanged:false,
    retiredBatch:{eligibleForAdoption:false,reason:'Superseded user-requested governance; preserved intact without reclassifying its performance.',
      futureEntriesStopped:true,remainingAssets:'Preserved with original inventory and payout ranges, never credited to a new account.'},profitClaim:false,realTrading:false};
  writeFileSync(join(directory,'pre-registration.json'),JSON.stringify(pre,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(directory,'before-migration-state.json'),JSON.stringify(saved),{flag:'wx'});
  assert.equal(hash(readFileSync(path)),hash(bytes),'Checkpoint changed while archiving');
  writeJsonAtomic(path,corrected);assert.deepEqual(read(path),corrected);
  const result={registeredAt:now,oldRegistryHash:retired.registryHash,registryHash:registry.registryHash,firstBatchStart:corrected.evolution.firstBatchStart,
    historicalApproval:approval,onlyEvolutionChanged:true,serviceExitedBeforeRead:true,mainAndOwnedStateHash:hash(JSON.stringify((({evolution,...x})=>x)(saved))),
    plannedBatches:pre.plannedBatches};
  writeFileSync(join(directory,'registration-migration.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [directory,lab]=process.argv.slice(2);assert.ok(directory&&lab);console.log(JSON.stringify(registerHistoryGate(resolve(directory),resolve(lab))));
}
