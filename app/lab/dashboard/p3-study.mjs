import {existsSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.mjs';
import {newPortfolio,stepPortfolio,p3Candidate} from './p3-portfolio.mjs';
import {BidHistory,bidExitProtocol} from './bid-exit.mjs';
export const p3StudyVersion='p3-executable-exit-study-v1';
export class P3Study {
 constructor(directory){
  this.path=join(directory,'p3-study.json');this.journal=join(directory,'p3-study.jsonl');this.history=new BidHistory();
  this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{version:p3StudyVersion,startedAt:null,lastAt:null,
   accounts:[10,100].flatMap(c=>['market','bid'].map(p=>newPortfolio(p,c))),pending:[]};
  if(this.state.version!==p3StudyVersion)throw Error('Unknown P3 study version');
  this.written=new Set(existsSync(this.journal)?readFileSync(this.journal,'utf8').split('\n').filter(Boolean).map(r=>JSON.parse(r).id):[]);
  this.flush();
  for(const a of this.state.accounts)if(a.position){delete a.position.marketReversal;delete a.position.bidReversal;}
 }
 flush(){for(const e of this.state.pending)if(!this.written.has(e.id)){appendFileSync(this.journal,JSON.stringify(e)+'\n');this.written.add(e.id);}this.state.pending=[];}
 save(events=[]){this.state.pending.push(...events);writeJsonAtomic(this.path,this.state);this.flush();}
 observe(input,labels,allowEntry){
  if(!input.frame||input.now<=this.state.lastAt)return;
  this.state.startedAt??=input.now;this.state.lastAt=input.now;
  this.history.add(input.frame,input.now);
  input={...input,bidHistory:this.history.rows,config:{...input.config,buyUnits:1,staleMs:3000,maxExposure:10},
   strategy:{...input.strategy,execution:'paper',model:'forward-momentum',exitPolicy:'market',maxSpread:.04,minNetEdge:.005,costBuffer:.005,stopLossUsd:0}};
  const selected=allowEntry?p3Candidate(input):null,events=[];
  for(const a of this.state.accounts)for(const e of stepPortfolio(a,input,labels,selected,allowEntry))events.push({...e,
   id:`${this.state.startedAt}:${a.initialCapital}:${a.policy}:${e.signalAt}:${e.kind}:${e.at??e.closedAt??e.openedAt}`,
   version:p3StudyVersion,initialCapital:a.initialCapital,policy:a.policy});
  this.save(events);
 }
 summary(){return {version:p3StudyVersion,startedAt:this.state.startedAt,lastAt:this.state.lastAt,accountIsolated:true,protocol:bidExitProtocol,
  description:'新起点独立对照：原中间价退出 / 足额净卖出价值退出；$10与$100账户，每次$1，单仓位，同轮一次，1秒延迟与新源报价。',
  accounts:this.state.accounts.map(a=>({policy:a.policy,initialCapital:a.initialCapital,cash:a.cash,realized:a.realized,fees:a.fees,completed:a.completed,
   wins:a.wins,maxRealizedDrawdown:a.maxRealizedDrawdown,occupiedMs:a.occupiedMs,waitMs:a.waitMs,blockedRounds:a.blockedRounds,
   capitalBlockedSignals:a.capitalBlockedSignals,unfilled:a.unfilled,pending:Boolean(a.pending),
   position:a.position?{slug:a.position.slug,outcome:a.position.outcome,remaining:a.position.remaining,cost:a.position.cost,marketEnd:a.position.market.end,
    decision:a.policy==='bid'?a.position.bidDecision:a.position.holdingDecision}:null}))};}
}
