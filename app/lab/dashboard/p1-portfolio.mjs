import {PaperBroker,round} from '../paper-broker.mjs';
import {amountQuote} from '../amount-order.mjs';
import {freshBook} from './strategy.mjs';
import {evaluateForward} from './forward-strategy.mjs';
import {marketInformationExit} from './market-exit.mjs';
import {referenceStatus} from './reference-price.mjs';

export const p1PortfolioVersion='p1-capital-occupancy-v1';
export function newPortfolio(policy,capital=10){
 if(!['market','settlement'].includes(policy)||!Number.isFinite(capital)||capital<1)throw Error('Invalid P1 portfolio');
 return {version:p1PortfolioVersion,policy,initialCapital:capital,cash:capital,realized:0,fees:0,completed:0,
  wins:0,attempted:null,pending:null,position:null,peak:0,maxRealizedDrawdown:0,occupiedMs:0,waitMs:0,
  blockedSignals:0,blockedRounds:0,lastBlockedRound:null,capitalBlockedSignals:0,unfilled:0,lastAt:null};
}
export function validLabel(label,t,now){
 return Boolean(label&&now>=label.observedAt&&now>=t.market.end&&label.conditionId===t.market.conditionId&&
  label.start===t.market.start&&label.end===t.market.end&&label.tokens?.[t.outcome]===t.tokenId&&[0,1].includes(label.payouts?.[t.outcome]));
}
function submit(book,market,side,size,limit,now,amountUsd){
 const broker=new PaperBroker();broker.setBook(book);
 return broker.submit({tokenId:book.tokenId,side,size,price:limit,orderType:'FAK',postOnly:false,...(amountUsd?{amountUsd}:{})},market,now);
}
// Independent shadow accounts only. No live controller, broker, or account reference is accepted.
// Original limits survive latency; every partial fill remains an owned residual.
export function stepPortfolio(a,input,labels,selected,allowEntry=true){
 const {frame,now,history,prices,config}=input,events=[];
 if(!frame||now<=a.lastAt)return events;
 const elapsed=a.lastAt===null?0:now-a.lastAt;
 if(a.position){a.occupiedMs+=elapsed;a.waitMs+=Math.max(0,now-Math.max(a.lastAt,a.position.market.end));}
 a.lastAt=now;
 let t=a.position;
 if(t){
  const label=labels.get(t.slug),same=t.slug===frame.market.slug,b=same?frame.books.find(b=>b.tokenId===t.tokenId):null;
  if(validLabel(label,t,now)){
   const proceeds=round(t.remaining*label.payouts[t.outcome]);t.proceeds=round(t.proceeds+proceeds);a.cash=round(a.cash+proceeds);t.remaining=0;t.closeMethod='verified-settlement';
  }else if(now<t.market.end&&freshBook(b,now,config.staleMs)){
   if(t.pendingExit&&now>=t.pendingExit.at){
    if(now<=t.pendingExit.at+3000&&b.timestamp>(t.lastSellBook??-1)){
     const r=submit(b,frame.market,'sell',t.remaining,t.pendingExit.limit,now);
     t.remaining=round(t.remaining-r.filled);t.proceeds=round(t.proceeds+r.notional-r.fees);t.fees=round(t.fees+r.fees);a.fees=round(a.fees+r.fees);a.cash=round(a.cash+r.notional-r.fees);t.lastSellBook=b.timestamp;
     if(r.filled)t.closeMethod='book-sale';
    }
    t.pendingExit=null;t.nextExitAt=now+2000;
   }
   if(t.remaining>0&&a.policy==='market'&&!t.pendingExit&&now>=(t.nextExitAt??0)){
    const exit=marketInformationExit(t,t.remaining,b,frame.market,now,config,history,prices);
    if(exit)t.pendingExit={at:now+1000,limit:exit.limit};
   }
  }else{delete t.marketReversal;}
  if(t.remaining===0){
   const net=round(t.proceeds-t.cost);a.realized=round(a.realized+net);a.completed++;a.wins+=Number(net>0);a.peak=Math.max(a.peak,a.realized);a.maxRealizedDrawdown=Math.max(a.maxRealizedDrawdown,a.peak-a.realized);
   events.push({kind:'closed',policy:a.policy,...t,closedAt:now,net});a.position=null;t=null;
  }
 }
 if(a.pending){
  const p=a.pending,same=p.slug===frame.market.slug,b=same?frame.books.find(b=>b.tokenId===p.tokenId):null;
  if(!allowEntry||!same||now>p.at+3000||now>=p.market.end-30000){a.pending=null;a.unfilled++;}
  else if(now>=p.at&&freshBook(b,now,config.staleMs)&&referenceStatus(frame.twap,now).ready){
   // Reserve worst-case fees over the protected budget, never spend future proceeds.
   const size=Math.floor(p.amountUsd/b.asks[0]?.[0]*1e8)/1e8;
   const reserve=p.amountUsd+size*p.market.fee.rate*.25**p.market.fee.exponent;
   if(!Number.isFinite(size)||reserve>a.cash+1e-8||reserve>config.maxExposure){a.unfilled++;a.pending=null;}
   else{
    const r=submit(b,frame.market,'buy',size,p.limit,now,p.amountUsd);a.pending=null;
    if(!r.filled)a.unfilled++;
    else{
     const cost=round(r.notional+r.fees);a.cash=round(a.cash-cost);a.fees=round(a.fees+r.fees);
     a.position={slug:p.slug,market:structuredClone(p.market),tokenId:p.tokenId,outcome:p.outcome,signalAt:p.signalAt,
      openedAt:now,size:r.filled,remaining:r.filled,cost,costPerShare:cost/r.filled,fees:r.fees,proceeds:0};
     events.push({kind:'opened',policy:a.policy,...a.position});
    }
   }
  }
 }
 if(!allowEntry||!selected)return events;
 if(a.position||a.pending){a.blockedSignals++;if(a.lastBlockedRound!==frame.market.slug){a.blockedRounds++;a.lastBlockedRound=frame.market.slug;}return events;}
 if(a.attempted===frame.market.slug)return events;
 const b=frame.books.find(b=>b.tokenId===selected.tokenId),q=amountQuote(b,frame.market,config.buyUnits??1);
 const reserve=q.amountUsd+q.size*frame.market.fee.rate*.25**frame.market.fee.exponent;
 if(reserve>a.cash+1e-8||reserve>config.maxExposure){a.capitalBlockedSignals++;return events;}
 a.attempted=frame.market.slug;a.pending={slug:frame.market.slug,market:structuredClone(frame.market),tokenId:selected.tokenId,outcome:selected.outcome,signalAt:now,at:now+1000,limit:q.limit,amountUsd:q.amountUsd};
 return events;
}
export function p1Candidate(input){return referenceStatus(input.frame?.twap,input.now).ready?evaluateForward(input).selected:null;}
