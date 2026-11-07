import {evaluateRayTerminalRisk,deferredTerminalQuoteEligibility,rayTerminalRiskProtocol} from './ray-terminal-risk.mjs';

const finite=Number.isFinite;
const copy=value=>structuredClone(value);
export class RayTerminalObserver {
  constructor({write,clock=Date.now}={}){
    this.write=typeof write==='function'?write:null;this.clock=clock;this.connectionEpoch=0;
    this.spotRows=[];this.states=new Map();this.latest=new Map();this.latches=new Map();this.written=new Map();
    this.marketKey=null;this.lastFrameAt=null;this.lastReset=null;this.unverifiedOwners=[];
    this.statistics={sampled:0,writeAttempts:0,writesAccepted:0,writeFailures:0,pendingWrites:0,
      ignoredDiagnostics:0,spotBufferTruncations:0};this.writeError=null;
  }
  _emit(record){
    this.statistics.writeAttempts++;
    if(!this.write){this.statistics.writeFailures++;this.writeError='observer-write-unconfigured';return;}
    const failed=e=>{this.statistics.writeFailures++;this.writeError=String(e?.message??e);};
    try{
      const result=this.write(copy(record));
      if(result&&typeof result.then==='function'){
        this.statistics.pendingWrites++;
        Promise.resolve(result).then(value=>{if(value===false)failed('observer-write-rejected');else this.statistics.writesAccepted++;},failed)
          .finally(()=>{this.statistics.pendingWrites--;});
      }else if(result===false)failed('observer-write-rejected');else this.statistics.writesAccepted++;
    }catch(e){failed(e);}
  }
  ingestDiagnostic(row){
    const now=this.clock();
    if(row?.kind!=='chainlink-reference'||row.source!=='rtds-chainlink-spot'||!finite(row.value)||row.value<=0||
      !finite(row.referenceAt)||!finite(row.knownAt)||row.referenceAt>row.knownAt||row.knownAt>now||row.referenceAt<now-120000){
      this.statistics.ignoredDiagnostics++;return false;
    }
    if(!this.spotRows.some(r=>r.referenceAt===row.referenceAt&&r.knownAt===row.knownAt&&r.value===row.value))
      this.spotRows.push(copy(row));
    this.spotRows=this.spotRows.filter(r=>r.referenceAt>=now-120000&&r.knownAt<=now)
      .sort((a,b)=>a.knownAt-b.knownAt||a.referenceAt-b.referenceAt);
    if(this.spotRows.length>2048){this.statistics.spotBufferTruncations+=this.spotRows.length-2048;this.spotRows=this.spotRows.slice(-2048);}
    return true;
  }
  reset(reason='explicit-reset'){
    this.connectionEpoch++;this.states.clear();this.latest.clear();this.latches.clear();this.written.clear();
    this.spotRows=[];this.lastFrameAt=null;this.marketKey=null;this.unverifiedOwners=[];
    this.lastReset={time:this.clock(),reason:String(reason),connectionEpoch:this.connectionEpoch};
    this._emit({type:'ray-terminal-observer-reset',version:rayTerminalRiskProtocol.version,mode:'shadow',...this.lastReset});
  }
  sample({frame,now=frame?.now,owners=[],account}={}){
    if(!frame?.market||!finite(now))return [];
    const m=frame.market,key=[m.slug,m.conditionId,m.tokens?.Up,m.tokens?.Down].join('|');
    if(this.marketKey!==null&&this.marketKey!==key){
      // Market identity is a hard observation boundary; rolling spot history can be retained.
      this.states.clear();this.latest.clear();this.latches.clear();this.written.clear();this.lastFrameAt=null;
      this.lastReset={time:now,reason:'market-changed',connectionEpoch:++this.connectionEpoch};
      this._emit({type:'ray-terminal-observer-reset',version:rayTerminalRiskProtocol.version,mode:'shadow',...this.lastReset});
    }
    this.marketKey=key;
    const gap=this.lastFrameAt!==null&&(now<=this.lastFrameAt||now-this.lastFrameAt>3000);this.lastFrameAt=now;
    if(gap){
      this.states.clear();this.latches.clear();this.lastReset={time:now,reason:'frame-gap-or-regression',connectionEpoch:++this.connectionEpoch};
      this._emit({type:'ray-terminal-observer-reset',version:rayTerminalRiskProtocol.version,mode:'shadow',...this.lastReset});
    }
    // A diagnostic may be received after this snapshot but before sample() runs.
    // Keep it for the next snapshot; contemporaneous selection below excludes it.
    this.spotRows=this.spotRows.filter(r=>r.referenceAt>=now-120000);
    const spot=this.spotRows.filter(r=>r.knownAt<=now).at(-1)??null;
    const sameMarket=owners.filter(o=>o?.slug===m.slug&&['Up','Down'].includes(o.outcome)&&o.tokenId===m.tokens?.[o.outcome]);
    const tokenCounts=new Map();for(const o of sameMarket)tokenCounts.set(o.tokenId,(tokenCounts.get(o.tokenId)??0)+1);
    this.unverifiedOwners=[];const observed=[];
    for(const owner of sameMarket){
      const size=account?.holdings?.[owner.tokenId];
      if(!finite(size)||size<0||tokenCounts.get(owner.tokenId)!==1){
        this.unverifiedOwners.push({ownerId:owner.id??null,tokenId:owner.tokenId,reason:tokenCounts.get(owner.tokenId)!==1?'ambiguous-token-ownership':'account-quantity-unavailable'});continue;
      }
      if(size<=0)continue;
      observed.push({key:'owned:'+String(owner.id??owner.tokenId),kind:'owned-position',ownerId:String(owner.id??owner.tokenId),
        isHolding:true,hypothetical:false,heldSize:size,trade:owner});
    }
    for(const outcome of ['Up','Down'])observed.push({key:'probe:'+m.slug+':'+outcome,kind:'hypothetical-probe',
      ownerId:null,isHolding:false,hypothetical:true,heldSize:null,
      trade:{slug:m.slug,outcome,tokenId:m.tokens[outcome],market:m}});
    const activeKeys=new Set(observed.map(o=>o.key));
    for(const map of [this.states,this.latest,this.latches,this.written])for(const k of map.keys())if(!activeKeys.has(k))map.delete(k);
    const records=[];
    for(const owner of observed){
      const step=evaluateRayTerminalRisk({frame,trade:owner.trade,opening:frame.rayOpening,spot,spotRows:this.spotRows,
        now,prior:this.states.get(owner.key)??null,connectionEpoch:this.connectionEpoch,dataGap:gap});
      if(step.state)this.states.set(owner.key,step.state);else this.states.delete(owner.key);
      if(['data-unavailable','awaiting-resolution','outside-window'].includes(step.decision.status))this.latches.delete(owner.key);
      if(step.decision.candidateExit&&!this.latches.has(owner.key))this.latches.set(owner.key,{signal:copy(step.decision),quote:null});
      const latch=this.latches.get(owner.key);
      if(latch&&!latch.quote){
        const eligibility=deferredTerminalQuoteEligibility({signal:latch.signal,frame,trade:owner.trade,now});
        if(eligibility.eligible){
          const book=frame.books.find(b=>b.tokenId===owner.trade.tokenId);
          latch.quote={...eligibility,time:now,signalAt:latch.signal.signalAt,
            status:owner.hypothetical?'hypothetical-price-observation':'owned-price-observation',
            bestBid:book.bids[0][0],bestBidVisibleSize:book.bids[0][1],requestStartedAt:book.requestStartedAt??null,
            notAnExecutedTrade:true,quantityNotEvaluated:true,profitCalculated:false};
        }
      }
      const record={type:'ray-terminal-risk-observation',version:rayTerminalRiskProtocol.version,mode:'shadow',
        time:now,connectionEpoch:this.connectionEpoch,observerKey:owner.key,kind:owner.kind,ownerId:owner.ownerId,
        isHolding:owner.isHolding,hypothetical:owner.hypothetical,heldSize:owner.heldSize,
        slug:m.slug,conditionId:m.conditionId,tokenId:owner.trade.tokenId,outcome:owner.trade.outcome,
        sourceFrameAt:frame.now,decision:step.decision,confirmationState:step.state,
        firstSignalAt:latch?.signal.signalAt??null,delayedQuote:latch?.quote??null,
        realTrading:false,tradesExecuted:0,profitCalculated:false};
      this.latest.set(owner.key,copy(record));records.push(record);this.statistics.sampled++;
      const signature=JSON.stringify([record.kind,record.heldSize,step.decision.status,step.decision.reasonCode,
        step.decision.candidateExit,record.firstSignalAt,record.delayedQuote?.time??null,this.connectionEpoch]);
      const written=this.written.get(owner.key);
      if(!written||signature!==written.signature||now-written.time>=1000){
        this._emit(record);this.written.set(owner.key,{time:now,signature});
      }
    }
    return records.map(copy);
  }
  summary(now=this.clock()){
    const rows=[...this.latest.values()].map(copy);
    return {version:rayTerminalRiskProtocol.version,mode:'shadow',returnValidated:false,allocationEffect:'none',
      realTrading:false,tradesExecuted:0,profitCalculated:false,
      status:this.writeError?'observation-write-error':!rows.length?'awaiting-observation':'observing',
      time:now,lastSampleAt:this.lastFrameAt,sampleAgeMs:this.lastFrameAt===null?null:Math.max(0,now-this.lastFrameAt),
      connectionEpoch:this.connectionEpoch,lastReset:copy(this.lastReset),spotRows:this.spotRows.length,
      ownedCount:rows.filter(r=>r.isHolding).length,probeCount:rows.filter(r=>r.hypothetical).length,
      ownedCandidates:rows.filter(r=>r.isHolding&&r.decision.candidateExit).length,
      hypotheticalCandidates:rows.filter(r=>r.hypothetical&&r.decision.candidateExit).length,
      unverifiedOwners:copy(this.unverifiedOwners),statistics:copy(this.statistics),writeError:this.writeError,rows};
  }
}
