import {existsSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.mjs';
import {newPortfolio,stepPortfolio,p3Candidate} from './p3-portfolio.mjs';
import {BidHistory} from './bid-exit.mjs';
import {consensusExit,consensusExitProtocol} from './consensus-exit.mjs';
export const confirmationStudyVersion='p3-exit-confirmation-study-v1';
const categories=new Set(['hold','supported-hold','confirming-reversal','waiting-agreement','data-unavailable','execution-pending','retry-cooldown']);
export function holdingCategory(a,now){
 const t=a.position;if(!t)return 'closed';
 if(now>=t.market.end)return 'awaiting-resolution';
 if(t.pendingExit)return 'execution-pending';
 if(now<(t.nextExitAt??0))return 'retry-cooldown';
 const d=a.group==='consensus'?t.consensusDecision:t.holdingDecision;
 return d?.time<=now&&now-d.time<=2000&&categories.has(d.status)?d.status:'data-unavailable';
}
// Attribute only observed intervals; long gaps are unknown, not positive hold support.
export function observeHolding(t,now,category){
 const h=t.holdingEvidence??={version:'observed-holding-v1',startedAt:t.openedAt,lastAt:t.openedAt,lastCategory:'data-unavailable',ms:{}};
 if(now<=h.lastAt)return {changed:false,charge:{}};
 const previous=h.lastAt,dt=now-previous,charge={};
 const tradable=Math.max(0,Math.min(now,t.market.end)-Math.min(previous,t.market.end));
 const wait=Math.max(0,now-Math.max(previous,t.market.end));
 if(tradable)charge[dt<=3000?h.lastCategory:'unobserved-gap']=tradable;
 if(wait)charge['awaiting-resolution']=wait;
 for(const [k,v]of Object.entries(charge))h.ms[k]=(h.ms[k]??0)+v;
 const changed=category!==h.lastCategory||dt>3000;
 h.lastAt=now;h.lastCategory=category;
 return {changed,charge};
}
export class P3ConfirmationStudy {
 constructor(directory){
  this.path=join(directory,'p3-confirmation.json');this.journal=join(directory,'p3-confirmation.jsonl');this.history=new BidHistory();
  this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{version:confirmationStudyVersion,startedAt:null,lastAt:null,pending:[],
   accounts:[10,100].flatMap(capital=>['market','consensus'].map(group=>({...newPortfolio('market',capital),group,observedMs:{}})))};
  if(this.state.version!==confirmationStudyVersion)throw Error('Unknown P3 confirmation version');
  this.written=new Set(existsSync(this.journal)?readFileSync(this.journal,'utf8').split('\n').filter(Boolean).map(r=>JSON.parse(r).id):[]);
  this.flush();
  for(const a of this.state.accounts)if(a.position){delete a.position.marketReversal;delete a.position.bidReversal;
   if(a.position.holdingEvidence)a.position.holdingEvidence.lastCategory='data-unavailable';}
 }
 flush(){for(const e of this.state.pending)if(!this.written.has(e.id)){appendFileSync(this.journal,JSON.stringify(e)+'\n');this.written.add(e.id);}this.state.pending=[];}
 save(events=[]){this.state.pending.push(...events);writeJsonAtomic(this.path,this.state);this.flush();}
 observe(input,labels,allowEntry){
  if(!input.frame||input.now<=this.state.lastAt)return;
  this.state.startedAt??=input.now;this.state.lastAt=input.now;this.history.add(input.frame,input.now);
  input={...input,bidHistory:this.history.rows,config:{...input.config,buyUnits:1,staleMs:3000,maxExposure:10},
   strategy:{...input.strategy,execution:'paper',model:'forward-momentum',exitPolicy:'market',maxSpread:.04,minNetEdge:.005,costBuffer:.005,stopLossUsd:0}};
  const selected=allowEntry?p3Candidate(input):null,events=[];
  for(const a of this.state.accounts){
   const previous=a.position,es=stepPortfolio(a,input,labels,selected,allowEntry,a.group==='consensus'?consensusExit:null);
   // A close and a new entry can happen on the same observation. Attribute each owned inventory once.
   for(const t of new Set([previous,a.position].filter(Boolean))){
    const category=t.remaining===0?'closed':holdingCategory({...a,position:t},input.now),r=observeHolding(t,input.now,category);
    if(t.holdingEvidence&&input.now===t.openedAt)t.holdingEvidence.lastCategory=category;
    for(const [k,v]of Object.entries(r.charge))a.observedMs[k]=(a.observedMs[k]??0)+v;
    if(r.changed)es.push({kind:'holding-state',at:input.now,slug:t.slug,signalAt:t.signalAt,category,charge:r.charge,remaining:t.remaining,
     marketStatus:t.holdingDecision?.time===input.now?t.holdingDecision.status:null,bidStatus:t.bidDecision?.time===input.now?t.bidDecision.status:null});
    for(const e of es)if(e.kind==='closed'&&e.signalAt===t.signalAt)e.holdingEvidence=structuredClone(t.holdingEvidence);
   }
   for(const e of es)events.push({...e,id:`${this.state.startedAt}:${a.initialCapital}:${a.group}:${e.signalAt}:${e.kind}:${e.at??e.closedAt??e.openedAt}`,
    version:confirmationStudyVersion,initialCapital:a.initialCapital,policy:a.group});
  }
  this.save(events);
 }
 summary(now=this.state.lastAt){return {version:confirmationStudyVersion,startedAt:this.state.startedAt,lastAt:this.state.lastAt,accountIsolated:true,protocol:consensusExitProtocol,
  accounts:this.state.accounts.map(a=>({policy:a.group,initialCapital:a.initialCapital,cash:a.cash,realized:a.realized,fees:a.fees,completed:a.completed,
   occupiedMs:a.occupiedMs,waitMs:a.waitMs,observedMs:a.observedMs,capitalBlockedSignals:a.capitalBlockedSignals,unfilled:a.unfilled,pending:Boolean(a.pending),
   position:a.position?{slug:a.position.slug,outcome:a.position.outcome,remaining:a.position.remaining,cost:a.position.cost,marketEnd:a.position.market.end,
    category:holdingCategory(a,now),decision:a.group==='consensus'?a.position.consensusDecision:a.position.holdingDecision}:null}))};}
}
