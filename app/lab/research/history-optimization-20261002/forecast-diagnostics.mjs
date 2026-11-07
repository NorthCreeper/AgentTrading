// Diagnostics only. No trade selection, threshold fitting, or deployment change.
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {probability} from '../../dashboard/settlement-model.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function forecastDiagnostics(part){
 const reportBytes=readFileSync(join(part,'report.json')),forecastBytes=readFileSync(join(part,'forecasts.json'));
 const report=JSON.parse(reportBytes),forecasts=JSON.parse(forecastBytes),fixed=report.causalSeed.fixed;
 const registration=JSON.parse(readFileSync(join(part,'pre-registration.json'))),modelSource=readFileSync(new URL('../../dashboard/settlement-model.mjs',import.meta.url));
 if(hash(modelSource)!==registration.sources['dashboard/settlement-model.mjs'])throw Error('Probability implementation differs from historical registration');
 const metrics=[];
 for(const scope of ['validation','test']){
  const dates=report.split[scope].filter(d=>!report.split.partialBoundaryDates.includes(d));
  const samples=forecasts.filter(f=>f.updated&&dates.includes(f.day)).map(f=>({f,qs:{market:f.marketProbability,adaptive:f.q,
   fixed:f.at>=fixed?.artifact.fittedAt?probability(fixed.artifact.model,f):null}}));
  const common=samples.filter(s=>Object.values(s.qs).every(q=>Number.isFinite(q)&&q>0&&q<1));
  for(const model of ['market','fixed','adaptive']){
   let brier=0,logLoss=0,predicted=0,actual=0;const bins=Array.from({length:10},(_,i)=>({lower:i/10,upper:(i+1)/10,n:0,predicted:0,actual:0}));
   for(const {f,qs}of common){const q=qs[model],y=f.y;brier+=(q-y)**2;logLoss-=y*Math.log(q)+(1-y)*Math.log(1-q);predicted+=q;actual+=y;
    const b=bins[Math.min(9,Math.floor(q*10))];b.n++;b.predicted+=q;b.actual+=y;}
   metrics.push({scope,model,n:common.length,strictForecasts:samples.length,domainExcluded:samples.length-common.length,
    brier:common.length?brier/common.length:null,logLoss:common.length?logLoss/common.length:null,
    meanProbability:common.length?predicted/common.length:null,meanOutcome:common.length?actual/common.length:null,
    bins:bins.map(b=>({...b,meanProbability:b.n?b.predicted/b.n:null,meanOutcome:b.n?b.actual/b.n:null}))});
  }
 }
 const result={version:'stored-forecast-diagnostics-v1',createdAt:Date.now(),cutoff:report.cutoff,
  reportSha256:hash(reportBytes),forecastsSha256:hash(forecastBytes),fixedArtifactSha256:hash(JSON.stringify(fixed)),
  modelSourceSha256:hash(modelSource),diagnosticSourceSha256:hash(readFileSync(fileURLToPath(import.meta.url))),metrics,
  note:'The same strict-labeled 120s forecasts within the fixed model domain are compared. Fixed predictions are applied only after original fittedAt. These untraded scoring diagnostics are retrospective, do not establish executable profit, and do not alter the registered thresholds or promotion decisions.'};
 writeFileSync(join(part,'forecast-diagnostics.json'),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=forecastDiagnostics(resolve(process.argv[2]));console.log(JSON.stringify(r.metrics.map(({bins,...x})=>x)));}
