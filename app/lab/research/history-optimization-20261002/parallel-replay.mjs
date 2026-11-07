import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,createWriteStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {candidates,suiteProtocol,evidenceOnly} from './suite.mjs';
import {sourceRegistration,promotionScreen,chronologicalSplit} from './replay.mjs';

export const partitions=[['baseline','p3-bid','p3-consensus','p3-settlement','p3-btc-support','p3-btc-joint','p3-delay30-revalidate'],
 ['p3-market-value','p3-fixed-value','p3-adaptive-value','p4-aligned-cap','p4-twap-residual','p4-wait60','p4-wait120'],
 ['p5-retry','p5-reentry','p6-protection0','p6-protection1','p6-protection2']];
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function parallelReplay(catalogPath,out){
 if(existsSync(out))throw Error('New result directory required');mkdirSync(out,{recursive:true});
 const catalogBytes=readFileSync(catalogPath),catalog=JSON.parse(catalogBytes),sources=sourceRegistration(['parallel-replay.mjs']);
 const registration={version:suiteProtocol.version,declaredAt:Date.now(),catalogPath,catalogSha256:hash(catalogBytes),
  cutoff:catalog.cutoff,protocol:suiteProtocol,candidates,evidenceOnly,split:chronologicalSplit(catalog.rounds),sources,partitions,
  partitionMeaning:'Policy partition only. Each child replays every canonical round chronologically; independent account funds never reset by date except the separately declared new validation/test accounts.'};
 writeFileSync(join(out,'registration.json'),JSON.stringify(registration,null,2),{flag:'wx'});
 const jobs=partitions.map((ids,i)=>new Promise((ok,bad)=>{
  const path=join(out,'part-'+i),log=createWriteStream(join(out,'part-'+i+'.log'));
  const child=spawn(process.execPath,['--max-old-space-size=4096',fileURLToPath(new URL('./replay.mjs',import.meta.url)),catalogPath,path,ids.join(',')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log);child.stderr.pipe(log);child.on('error',bad);child.on('exit',code=>{log.end();code===0?ok(path):bad(Error('Partition '+i+' failed '+code));});
 }));
 const completed=await Promise.allSettled(jobs);for(const r of completed)if(r.status!=='fulfilled')throw r.reason;
 const reports=completed.map(r=>JSON.parse(readFileSync(join(r.value,'report.json'))));
 const first=reports[0];for(let i=1;i<reports.length;i++)for(const k of ['cutoff','frames','split','forecasts','updates','fixedTraining','causalSeed','pair','maker'])if(!isDeepStrictEqual(first[k],reports[i][k]))throw Error('Partition causal state differs: '+k);
 const accounts=reports.flatMap(r=>r.accounts),keys=accounts.map(a=>[a.scope,a.scenario,a.id].join(':'));
 if(new Set(keys).size!==keys.length||keys.length!==candidates.length*suiteProtocol.scenarios.length*suiteProtocol.scopes.length)throw Error('Duplicate/missing policy account');
 for(const path of completed.map(r=>r.value)){const reg=JSON.parse(readFileSync(join(path,'pre-registration.json')));
  for(const [p,h]of Object.entries(reg.sources))if(sources[p]!==h)throw Error('Child implementation registration differs '+p);
 }
 const report={...first,accounts,counts:Object.assign({},...reports.map(r=>r.counts)),catalogSummary:catalog.summary,
  partitionRuns:completed.map(r=>r.value),sources,catalogSha256:registration.catalogSha256};
 report.promotion=promotionScreen(report);
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});
 const now=sourceRegistration(['parallel-replay.mjs']);if(!isDeepStrictEqual(now,sources))throw Error('Implementation changed during historical replay');
 const certificate={version:suiteProtocol.version,completedAt:Date.now(),registrationSha256:hash(readFileSync(join(out,'registration.json'))),
  reportSha256:hash(readFileSync(join(out,'report.json'))),sources,eligible:report.promotion.eligible,realTrading:false};
 writeFileSync(join(out,'certificate.json'),JSON.stringify(certificate,null,2),{flag:'wx'});
 return {reportPath:join(out,'report.json'),registrationPath:join(out,'registration.json'),certificatePath:join(out,'certificate.json'),frames:report.frames,eligible:report.promotion.eligible};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await parallelReplay(resolve(process.argv[2]),resolve(process.argv[3]))));
