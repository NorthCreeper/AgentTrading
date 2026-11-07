import {existsSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.mjs';
import {valueDecision,valueProtocol} from './settlement-value.mjs';

export const quoteEvidenceRevision='quote-depth-and-fee-v1';

export class SettlementValueResearch {
  constructor(directory,artifact=null,historical=null) {
    this.path=join(directory,'p3-value-research.json');this.journal=join(directory,'p3-value-research.jsonl');
    this.artifact=artifact;this.historical=historical;this.decision=null;this.error=null;
    this.state=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{
      version:valueProtocol.version,modelId:artifact?.id??null,startedAt:null,samples:{},pending:[],
    };
    if(this.state.version!==valueProtocol.version||this.state.modelId!==(artifact?.id??null))
      throw Error('价值模型版本与研究账户不一致，请保留原研究');
    this.written=new Set(existsSync(this.journal)?readFileSync(this.journal,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s).id):[]);
    this.flush();
  }
  flush() {
    for(const e of this.state.pending)if(!this.written.has(e.id)){appendFileSync(this.journal,JSON.stringify(e)+'\n');this.written.add(e.id);}
    this.state.pending=[];
  }
  save(events) {this.state.pending.push(...events);writeJsonAtomic(this.path,this.state);this.flush();}
  observe(input,labels=new Map()) {
    if(this.error)return;
    this.decision=valueDecision({...input,artifact:this.artifact});
    const events=[];
    if(this.decision.pUp!==null&&!this.state.samples[input.frame.market.slug]) {
      const sample={id:this.artifact.id+':'+input.frame.market.slug+':forecast',modelId:this.artifact.id,
        at:input.now,market:structuredClone(input.frame.market),pUp:this.decision.pUp,
        marketProbability:this.decision.marketProbability,opening:this.decision.features.opening,
        x:this.decision.features.x,economics:structuredClone(this.decision.economics),
        sourceBookTimes:input.frame.books.map(b=>({tokenId:b.tokenId,sourceAt:b.timestamp,receivedAt:b.receivedAt})),
        evidenceRevision:quoteEvidenceRevision,
        quoteEvidence:{frame:structuredClone(input.frame),now:input.now,amountUsd:input.amountUsd??1},
        label:null};
      this.state.startedAt??=input.now;this.state.samples[sample.market.slug]=sample;
      events.push({kind:'forecast',...sample});
    }
    for(const s of Object.values(this.state.samples)) {
      if(s.label)continue;
      const l=labels.get(s.market.slug),m=s.market;
      const valid=l&&l.observedAt<=input.now&&l.observedAt>=m.end&&l.start===m.start&&l.end===m.end&&
        l.conditionId===m.conditionId&&['Up','Down'].every(o=>l.tokens?.[o]===m.tokens[o]&&[0,1].includes(l.payouts?.[o]))&&
        l.payouts.Up+l.payouts.Down===1&&['Up','Down'].includes(l.winner)&&
        l.payouts.Up===Number(l.winner==='Up')&&Math.abs(l.opening-s.opening)<=.00001;
      if(!valid)continue;
      s.label={winner:l.winner,y:l.payouts.Up,observedAt:l.observedAt};
      events.push({id:s.modelId+':'+m.slug+':resolved',kind:'resolved',slug:m.slug,
        forecastAt:s.at,pUp:s.pUp,marketProbability:s.marketProbability,...s.label});
    }
    if(events.length)this.save(events);
  }
  summary() {
    const xs=Object.values(this.state.samples),labeled=xs.filter(s=>s.label),n=labeled.length;
    const score=key=>n?labeled.reduce((sum,s)=>sum+(s[key]-s.label.y)**2,0)/n:null;
    return {version:valueProtocol.version,modelId:this.state.modelId,evidenceRevision:quoteEvidenceRevision,diagnosticOnly:true,autoTradingEnabled:false,
      startedAt:this.state.startedAt,error:this.error,forecasts:xs.length,labeled:n,pending:xs.length-n,
      brier:score('pUp'),marketBrier:score('marketProbability'),
      latest:xs.at(-1)??null,currentDecision:this.decision,
      historical:this.historical?{cutoff:this.historical.cutoff,usable:this.historical.usable,dates:this.historical.dates,
        validation:this.historical.validation,test:this.historical.test,promotion:this.historical.promotion}:null};
  }
}
