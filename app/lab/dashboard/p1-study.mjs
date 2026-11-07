import {existsSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.mjs';
import {newPortfolio,stepPortfolio,p1Candidate,p1PortfolioVersion,validLabel} from './p1-portfolio.mjs';
import {freshBook,depthQuote} from './strategy.mjs';
import {round} from '../paper-broker.mjs';

export const p1StudyVersion='p1-exit-evidence-v1';
export class P1Study {
 constructor(directory){
  this.path=join(directory,'p1-study.json');this.journal=join(directory,'p1-study.jsonl');
  this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{version:p1StudyVersion,startedAt:null,lastAt:null,accounts:[10,100].flatMap(c=>['market','settlement'].map(p=>newPortfolio(p,c))),watchers:[],closedIds:[],pending:[],recoveryCompleted:0};
  if(this.state.version!==p1StudyVersion)throw Error('Unknown P1 study version');
  this.written=new Set(existsSync(this.journal)?readFileSync(this.journal,'utf8').split('\n').filter(Boolean).map(r=>JSON.parse(r).id):[]);
  this.flush();
  // Restart time is not continuous reversal evidence.
  for(const a of this.state.accounts)if(a.position)delete a.position.marketReversal;
  for(const w of this.state.watchers){w.last=null;w.runStart=null;}
 }
 flush(){
  for(const e of this.state.pending)if(!this.written.has(e.id)){appendFileSync(this.journal,JSON.stringify(e)+'\n');this.written.add(e.id);}
  this.state.pending=[];
 }
 save(events=[]){
  this.state.pending.push(...events);writeJsonAtomic(this.path,this.state);this.flush();
 }
 addClose(t){
  if(t.closeMethod!=='book-sale'||this.state.closedIds.includes(t.id))return;
  const buys=t.orderReports.filter(r=>r.side==='buy'&&r.filled>0),sells=t.orderReports.filter(r=>r.side==='sell'&&r.filled>0);
  this.state.closedIds.push(t.id);this.state.closedIds=this.state.closedIds.slice(-1000);
  // Several partial-sale times cannot be represented as one deferred whole-position exit.
  if(sells.length!==1||Math.abs(t.bought-t.sold)>1e-8){this.save([{id:'unsupported:'+t.id,kind:'post-exit-unsupported',reason:'multiple-sale-times',tradeId:t.id}]);return;}
  this.state.watchers.push({id:'post-exit:'+t.id,kind:'post-exit',tradeId:t.id,experimentId:t.experimentId,origin:t.origin,
   slug:t.slug,market:structuredClone(t.market),outcome:t.outcome,tokenId:t.entryDecision.tokenId,size:t.bought,
   cost:round(buys.reduce((s,r)=>s+r.notional+r.fees,0)),actualNet:t.net,closedAt:t.closedAt,
   points:{},samples:0,transitions:0,recoveryRuns:0,maxRecoveryRunMs:0,observedRecoveryMs:0,gaps:0,last:null,runStart:null});
  this.save();
 }
 observe(input,labels,allowEntry){
  const {frame,now}=input;if(!frame||now<=this.state.lastAt)return;
  this.state.startedAt??=now;this.state.lastAt=now;
  // Freeze research settings; later UI edits do not silently change a comparison cohort.
  input={...input,config:{...input.config,buyUnits:1,staleMs:3000,maxExposure:10},
   strategy:{...input.strategy,execution:'paper',model:'forward-momentum',exitPolicy:'market',maxSpread:.04,minNetEdge:.005,costBuffer:.005,stopLossUsd:0}};
  const selected=allowEntry?p1Candidate(input):null,events=[];
  for(const a of this.state.accounts)for(const e of stepPortfolio(a,input,labels,selected,allowEntry))events.push({...e,
   id:`${p1PortfolioVersion}:${this.state.startedAt}:${a.initialCapital}:${a.policy}:${e.signalAt}:${e.kind}`,initialCapital:a.initialCapital,studyStartedAt:this.state.startedAt,version:p1StudyVersion});
  for(const w of this.state.watchers){
   const same=frame.market.slug===w.slug,b=same?frame.books.find(b=>b.tokenId===w.tokenId):null;
   const q=now<w.market.end&&freshBook(b,now,3000)&&b.bids.length?depthQuote(b,'sell',w.size,frame.market,round(Math.max(frame.market.tick,b.bids[0][0]-.02))):null;
   const net=q?.complete?round(q.notional-q.fees-w.cost):null;
   for(const s of [10,30,60])if(!w.points[s]&&now>=w.closedAt+s*1000){
    const target=w.closedAt+s*1000;
    if(target>=w.market.end)w.points[s]={status:'after-expiry',net:null};
    else if(now>target+3000||now>=w.market.end)w.points[s]={status:'missing',net:null};
    else if(net!==null)w.points[s]={status:'quoted',time:now,sourceAt:b.timestamp,net,delta:round(net-w.actualNet)};
   }
   if(now>w.closedAt&&now<w.market.end){
    if(net===null){w.last=null;w.runStart=null;w.gaps++;}
    else{
     const better=net>w.actualNet,cont=w.last&&now>w.last.time&&now-w.last.time<=3000;w.samples++;
     if(better){if(!cont||!w.last.better){w.recoveryRuns++;w.runStart=now;}if(cont&&w.last.better)w.observedRecoveryMs+=now-w.last.time;w.maxRecoveryRunMs=Math.max(w.maxRecoveryRunMs,now-w.runStart);}
     else w.runStart=null;
     if(cont&&better!==w.last.better)w.transitions++;if(w.last&&!cont)w.gaps++;
     w.last={time:now,better};
    }
   }
   const label=labels.get(w.slug);
   if(validLabel(label,w,now)&&Object.keys(w.points).length===3){
    events.push({...w,version:p1StudyVersion,holdNet:round(w.size*label.payouts[w.outcome]-w.cost),labelObservedAt:label.observedAt,last:undefined,runStart:undefined});w.done=true;this.state.recoveryCompleted++;
   }
  }
  this.state.watchers=this.state.watchers.filter(w=>!w.done);this.save(events);
 }
 summary(){return {version:p1StudyVersion,startedAt:this.state.startedAt,lastAt:this.state.lastAt,accountIsolated:true,
  description:'独立有限资金对照：市场信息退出 / 持有到核实结算；每次 $1，单仓位，同轮一次，统一 1 秒执行延迟。研究亏损或资金不足不影响主账户。',
  recoveryCompleted:this.state.recoveryCompleted,pendingRecovery:this.state.watchers.length,
  accounts:this.state.accounts.map(a=>({policy:a.policy,initialCapital:a.initialCapital,cash:a.cash,realized:a.realized,fees:a.fees,completed:a.completed,
   wins:a.wins,maxRealizedDrawdown:a.maxRealizedDrawdown,occupiedMs:a.occupiedMs,waitMs:a.waitMs,blockedRounds:a.blockedRounds,
   capitalBlockedSignals:a.capitalBlockedSignals,unfilled:a.unfilled,position:a.position?{slug:a.position.slug,outcome:a.position.outcome,remaining:a.position.remaining,cost:a.position.cost,marketEnd:a.position.market.end}:null}))};}
}
