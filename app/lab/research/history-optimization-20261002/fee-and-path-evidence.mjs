import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p));
const close=(a,b,msg)=>{if(Math.abs(a-b)>1e-5)throw Error(msg);};
const entryKey=t=>JSON.stringify([t.market.conditionId,t.tokenId,t.signalAt,t.openedAt,t.size,t.cost,
 Object.values(t.orderReports).filter(r=>r.side==='buy').map(r=>[r.createdAt,r.price,r.filled,r.notional,r.fees])]);
export function feeAndPathEvidence(directory){
 const reportBytes=readFileSync(join(directory,'report.json')),report=JSON.parse(reportBytes),registrations=report.partitionRuns.map(p=>read(join(p,'pre-registration.json')));
 const locate=s=>{const index=registrations.findIndex(r=>r.candidateIds.includes(s.id));if(index<0)throw Error('No account partition');
  const path=join(report.partitionRuns[index],[s.scope,s.scenario,s.id].join('__')+'.json');return {path,bytes:readFileSync(path)};};
 const baselineCache=new Map(),fees=[],matched=[];
 for(const s of report.accounts){
  const f=locate(s),a=JSON.parse(f.bytes),ts=a.closedTrades;let closedFees=0,closedNet=0,winningNet=0,losingNet=0,wins=0,losses=0;
  for(const t of ts){closedFees+=Object.values(t.orderReports).reduce((n,r)=>n+r.fees,0);closedNet+=t.net;if(t.net>0){wins++;winningNet+=t.net;}else if(t.net<0){losses++;losingNet+=t.net;}}
  close(closedNet,s.net,'Closed PnL differs');
  fees.push({scope:s.scope,scenario:s.scenario,id:s.id,accountPath:f.path,accountSha256:sha(f.bytes),completed:ts.length,closedNet,closedFees,
   closedBeforeFee:closedNet+closedFees,ownedEntryFees:s.fees-closedFees,averageWin:wins?winningNet/wins:null,averageLoss:losses?losingNet/losses:null,
   wins,losses,winRate:s.winRate,secondEntries:s.secondEntries,unresolved:s.unresolved,accountNetRange:s.accountNetRange,cashExhausted:s.cashExhausted});
  if(s.id==='baseline')continue;
  const baseKey=s.scope+':'+s.scenario;if(!baselineCache.has(baseKey)){const bf=locate({...s,id:'baseline'});baselineCache.set(baseKey,JSON.parse(bf.bytes));}
  const b=baselineCache.get(baseKey),controls=new Map(b.closedTrades.map(t=>[entryKey(t),t]));let matchedNet=0,candidateOnlyNet=0,pairs=0,only=0;
  for(const t of ts){const key=entryKey(t),control=controls.get(key);if(control){matchedNet+=t.net-control.net;pairs++;controls.delete(key);}else{candidateOnlyNet+=t.net;only++;}}
  const baselineOnlyNet=[...controls.values()].reduce((n,t)=>n+t.net,0),decomposition=matchedNet+candidateOnlyNet-baselineOnlyNet;
  close(decomposition,a.realized-b.realized,'Path decomposition differs');
  matched.push({scope:s.scope,scenario:s.scenario,id:s.id,sameEntryPairs:pairs,sameEntryIncrement:matchedNet,
   candidateOnlyTrades:only,candidateOnlyNet,baselineOnlyTrades:controls.size,baselineOnlyNet,totalIncrement:a.realized-b.realized,decomposition});
 }
 const result={version:'independent-fee-and-exact-entry-path-evidence-v1',createdAt:Date.now(),cutoff:report.cutoff,
  reportSha256:sha(reportBytes),certificateSha256:sha(readFileSync(join(directory,'certificate.json'))),sourceSha256:sha(readFileSync(fileURLToPath(import.meta.url))),fees,matched,
  notes:['Before-fee terminal PnL still includes executable spread and delayed buy/sell paths. It is not frictionless theoretical alpha.',
   'Fees on unresolved positions are excluded from closed-before-fee PnL and separately reported. Unknown inventory retains cash/payout bounds.',
   'Same-entry pairs require identical condition/token/signal/open/fill/buy-price/cost/fees; total path difference includes unequal opportunities due to funding and occupied inventory.',
   'No fee/threshold parameter or strategy is changed by this descriptive analysis. Wins alone are not expected-value evidence.']};
 writeFileSync(join(directory,'fee-and-path-evidence.json'),JSON.stringify(result,null,2)+'\n');
 return {accounts:fees.length,matched:matched.length,fullBase:fees.filter(f=>f.scope==='continuous-full-history'&&f.scenario==='base').map(f=>({id:f.id,net:f.closedNet,beforeFee:f.closedBeforeFee,fees:f.closedFees,pairs:matched.find(m=>m.scope===f.scope&&m.scenario===f.scenario&&m.id===f.id)?.sameEntryPairs??null}))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(feeAndPathEvidence(resolve(process.argv[2]))));
