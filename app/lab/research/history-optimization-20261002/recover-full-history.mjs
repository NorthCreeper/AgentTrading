// Recovery orchestration only; the original immutable full-suite registration remains authoritative.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import assert from 'node:assert/strict';
import {runReplay,sourceRegistration,promotionScreen,chronologicalSplit} from './replay.mjs';
import {partitions} from './parallel-replay.mjs';
import {candidates,suiteProtocol,evidenceOnly} from './suite.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
export async function recoverFullHistory(out){
  assert.ok(!existsSync(join(out,'report.json'))&&!existsSync(join(out,'certificate.json')),'Never overwrite completed evidence');
  const registration=read(join(out,'registration.json')),catalog=read(registration.catalogPath),sources=sourceRegistration(['parallel-replay.mjs']);
  assert.deepEqual(sources,registration.sources);assert.equal(sha(readFileSync(registration.catalogPath)),registration.catalogSha256);
  assert.deepEqual(registration.protocol,suiteProtocol);assert.deepEqual(registration.candidates,candidates);
  assert.deepEqual(registration.evidenceOnly,evidenceOnly);assert.deepEqual(registration.partitions,partitions);
  assert.deepEqual(registration.split,chronologicalSplit(catalog.rounds));assert.equal(registration.cutoff,catalog.cutoff);
  const at=Date.now(),paths=partitions.map((_,i)=>join(out,'part-'+i)),missing=paths.map((p,i)=>!existsSync(join(p,'completion.json'))?i:null).filter(i=>i!==null);
  assert.deepEqual(missing,[0],'This recovery is limited to the single interrupted first partition');
  const retry=join(out,'part-0-recovery-'+at),recovery={version:'mechanical-incomplete-partition-recovery-v1',at,
    originalRegistrationSha256:sha(readFileSync(join(out,'registration.json'))),sources,
    incompletePartition:0,originalIncompletePath:paths[0],replacementPath:retry,
    reason:'Original process is no longer alive and partition has no completion or final report. Completed other partitions retained.',
    unchangedCandidates:true,unchangedThresholds:true,unchangedFrozenInput:true,partialEconomicResultsUsed:false};
  writeFileSync(join(out,'recovery-'+at+'.json'),JSON.stringify(recovery,null,2),{flag:'wx'});
  await runReplay(registration.catalogPath,retry,{candidateIds:partitions[0]});paths[0]=retry;
  assert.deepEqual(sourceRegistration(['parallel-replay.mjs']),sources,'Frozen implementation must remain unchanged');
  const reports=paths.map((p,i)=>{
    const r=read(join(p,'report.json')),reg=read(join(p,'pre-registration.json')),done=read(join(p,'completion.json'));
    assert.equal(done.reportSha256,sha(readFileSync(join(p,'report.json'))));
    assert.equal(done.eventSha256,sha(readFileSync(join(p,'events.jsonl'))));
    assert.equal(done.rounds,catalog.summary.distinctSlugs);assert.equal(done.frames,r.frames);
    assert.deepEqual(reg.candidateIds,partitions[i]);assert.deepEqual(reg.protocol,registration.protocol);
    assert.deepEqual(reg.split,registration.split);assert.equal(reg.cutoff,registration.cutoff);
    assert.deepEqual(done.sources,reg.sources);
    for(const [path,h]of Object.entries(reg.sources))assert.equal(sources[path],h);
    return r;
  });
  const first=reports[0];for(const r of reports.slice(1))for(const k of ['cutoff','frames','split','forecasts','updates','fixedTraining','causalSeed','pair','maker'])
    assert.ok(isDeepStrictEqual(first[k],r[k]),'Partition causal state differs '+k);
  const accounts=reports.flatMap(r=>r.accounts),expected=candidates.length*suiteProtocol.scenarios.length*suiteProtocol.scopes.length,
    keys=accounts.map(a=>[a.scope,a.scenario,a.id].join(':'));
  assert.equal(keys.length,expected);assert.equal(new Set(keys).size,expected);
  const report={...first,accounts,counts:Object.assign({},...reports.map(r=>r.counts)),catalogSummary:catalog.summary,
    partitionRuns:paths,sources,catalogSha256:registration.catalogSha256};report.promotion=promotionScreen(report);
  assert.deepEqual(sourceRegistration(['parallel-replay.mjs']),sources);
  writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});
  const certificate={version:suiteProtocol.version,completedAt:Date.now(),registrationSha256:sha(readFileSync(join(out,'registration.json'))),
    reportSha256:sha(readFileSync(join(out,'report.json'))),sources,eligible:report.promotion.eligible,realTrading:false,
    mechanicalRecovery:{orchestrationSha256:sha(readFileSync(new URL(import.meta.url))),recordPath:'recovery-'+at+'.json',recordSha256:sha(readFileSync(join(out,'recovery-'+at+'.json')))}};
  writeFileSync(join(out,'certificate.json'),JSON.stringify(certificate,null,2),{flag:'wx'});
  return {frames:report.frames,accounts:expected,eligible:report.promotion.eligible,partitionRuns:paths};
}
console.log(JSON.stringify(await recoverFullHistory(resolve(process.argv[2]))));
