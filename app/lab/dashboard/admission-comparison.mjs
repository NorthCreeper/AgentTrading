const finite=Number.isFinite;
const groups=['quote','quote-and-flow'];
const fresh=()=>({observed:0,unknown:0,kept:0,blocked:0,keptWins:0,keptLosses:0,blockedWins:0,blockedLosses:0,byDate:{},scenarios:{}});
// Reuses the first tail signal and its ORIGINAL execution scenarios. This
// isolates a contemporaneous veto; it never substitutes a later arm entry.
export function pairedAdmissionComparison(rounds=[]){
 const result={version:'first-tail-signal-paired-veto-v1',adopted:false,rounds:rounds.length,tailSignals:0,
  groups:Object.fromEntries(groups.map(g=>[g,fresh()])),marketReference:{samples:0,brier:null},
  limits:'Descriptive matched first-tail opportunities only; veto policies are post-hoc diagnostics, not a new registered strategy or calibrated probability. Unknown features/execution excluded and counted. No account compounding.'};
 let brier=0;
 for(const r of rounds){const s=r.arms?.tail;if(!s||typeof s.win!=='boolean')continue;result.tailSignals++;
  if(finite(s.marketProbability)){brier+=(s.marketProbability-Number(s.win))**2;result.marketReference.samples++;}
  for(const g of groups){const a=result.groups[g],f=s.features;
   const known=f?.quoteKnown===true&&typeof f.quoteSupports==='boolean'&&(g==='quote'||f.flowKnown===true&&typeof f.flowSupports==='boolean');
   if(!known){a.unknown++;continue;}const keep=f.quoteSupports&&(g==='quote'||f.flowSupports);
   const date=r.dateNy??'unknown-date',day=a.byDate[date]??={observed:0,kept:0,blocked:0,keptWins:0,keptLosses:0,blockedWins:0,blockedLosses:0};
   for(const target of [a,day]){target.observed++;target[keep?'kept':'blocked']++;target[(keep?'kept':'blocked')+(s.win?'Wins':'Losses')]++;}
   for(const [key,e]of Object.entries(s.scenarios??{})){const p=a.scenarios[key]??={matched:0,unknown:0,originalNet:0,vetoNet:0,delta:0,filled:0,zeroFill:0};
    if(!finite(e.net)||!finite(e.filled)){p.unknown++;continue;}p.matched++;p.filled+=Number(e.filled>0);p.zeroFill+=Number(e.filled===0);p.originalNet+=e.net;p.vetoNet+=keep?e.net:0;p.delta=p.vetoNet-p.originalNet;
   }
  }
 }
 if(result.marketReference.samples)result.marketReference.brier=brier/result.marketReference.samples;
 for(const g of groups){const a=result.groups[g];a.independentDates=Object.keys(a.byDate).filter(d=>d!=='unknown-date').length;
  for(const p of Object.values(a.scenarios))for(const k of ['originalNet','vetoNet','delta'])p[k]=p.matched?Math.round(p[k]*1e8)/1e8:null;
 }
 return result;
}
