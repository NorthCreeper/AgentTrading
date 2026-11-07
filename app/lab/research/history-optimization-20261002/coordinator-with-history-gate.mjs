import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {writeJsonAtomic} from '../../dashboard/atomic-json.mjs';
import {EvolutionStudy} from '../../dashboard/evolution-study.mjs';
import {evolutionProtocol,evaluateEvolutionBatch,newEvolutionGovernance,planEvolutionDecision} from '../../dashboard/evolution-governance.mjs';
import {exitPolicyRevision} from '../../dashboard/exit-policy.mjs';
import {HistoryApprovalGate,historyApprovalProtocol,historyGatedEvolutionPlan} from '../../dashboard/history-approval.mjs';
import {historyApprovalBindingPinned} from '../../dashboard/history-approval-binding.mjs';
import {sourceRegistration} from './replay.mjs';

// Staged copy only. Deployment must rewrite dashboard-relative imports / URLs
// and create a fresh registry, retiring the prior registration without changing
// its cohort cash or any previously bound main position.

export const evolutionVersion='strategy-evolution-runtime-v2-history';
const day=86400000,week=7*day,digest=x=>createHash('sha256').update(x).digest('hex');
export function nextHktDay(now){return (Math.floor((now+8*3600000)/day)+1)*day-8*3600000;}
export function evolutionRegistry(historyBinding=historyApprovalBindingPinned,historyQualified=false){
  const files=['evolution-coordinator.mjs','evolution-study.mjs','evolution-portfolio.mjs','evolution-governance.mjs','exit-policy.mjs',
    'controller.mjs','forward-strategy.mjs','strategy.mjs','market-exit.mjs','consensus-exit.mjs','bid-exit.mjs',
    'reference-price.mjs','managed-position-accounting.mjs','payout-resolution.mjs','atomic-json.mjs','p2-book.mjs',
    'chart-model.mjs','entry-context.mjs','settlement.mjs','../amount-order.mjs','../paper-broker.mjs'];
  const dashboard=new URL('../../dashboard/',import.meta.url);
  const codeHashes=Object.fromEntries(files.map(p=>[p,digest(readFileSync(new URL(p,dashboard)))]));
  codeHashes['history-approval.mjs']=digest(readFileSync(new URL('history-approval.mjs',dashboard)));
  codeHashes['history-approval-binding.mjs']=digest(readFileSync(new URL('history-approval-binding.mjs',dashboard)));
  codeHashes['../research/history-optimization-20261002/coordinator-with-history-gate.mjs']=digest(readFileSync(new URL('./coordinator-with-history-gate.mjs',import.meta.url)));
  for(const [p,h]of Object.entries(sourceRegistration(historyApprovalProtocol.sourceRoots)))codeHashes['../'+p]=h;
  const protocol={version:'strategy-evolution-governance-with-history-v1',forwardRules:evolutionProtocol,
    historyPrerequisite:historyApprovalProtocol,historyBinding:structuredClone(historyBinding),
    historicalDecision:{candidateId:historyApprovalProtocol.candidateId,approved:historyQualified===true}};
  const protocolHash=digest(JSON.stringify(protocol)),implementationHash=digest(JSON.stringify(codeHashes));
  const registryHash=digest(JSON.stringify({version:evolutionVersion,protocolHash,implementationHash}));
  return {version:evolutionVersion,protocol,protocolHash,implementationHash,codeHashes,registryHash};
}
export function compatibleEvolutionConfig(config,strategy){
  return strategy?.execution==='paper'&&strategy.model==='forward-momentum'&&strategy.exitPolicy==='market'&&
    strategy.maxSpread===.04&&strategy.minNetEdge===.005&&strategy.costBuffer===.005&&strategy.stopLossUsd===0&&
    config?.buyUnits===1&&config.staleMs===3000&&config.maxExposure===10&&config.maxLoss===0;
}
// Only the controller's atomic main checkpoint owns adoption state. Cohort files
// own isolated experimental cash; decision evidence is immutable and separate.
export class EvolutionCoordinator {
  constructor(directory,{createdAt, saved=null, historyApprovalPath=join(directory,'history-approval.json'), historyApprovalBinding=historyApprovalBindingPinned}){
    this.directory=join(directory,'evolution-cohorts');this.studies=new Map();this.error=null;
    this.historyGate=new HistoryApprovalGate({approvalPath:historyApprovalPath,binding:historyApprovalBinding});
    this.historyApproval=this.historyGate.check(createdAt);this.lastHistoryBlock=null;
    this.registry=evolutionRegistry(historyApprovalBinding,this.historyApproval.approved);
    this.state=saved?structuredClone(saved):{version:evolutionVersion,registeredAt:createdAt,firstBatchStart:nextHktDay(createdAt),
      registryHash:this.registry.registryHash,governance:newEvolutionGovernance({createdAt,registryHash:this.registry.registryHash})};
    if(this.state.version!==evolutionVersion)throw Error('Unknown evolution state version');
    if(!Number.isFinite(this.state.registeredAt)||this.state.firstBatchStart!==nextHktDay(this.state.registeredAt)||
      this.state.governance?.registryHash!==this.state.registryHash)throw Error('Invalid evolution registration checkpoint');
    if(this.state.registryHash!==this.registry.registryHash){
      this.error='候选登记源码已改变，自动采用已禁用；新仓使用原市场退出';
      this.state.governance={...this.state.governance,effectivePolicy:'market',phase:'source-mismatch'};
      return;
    }
    if(!['market','consensus'].includes(this.state.governance.effectivePolicy))throw Error('Unknown effective policy');
    mkdirSync(this.directory,{recursive:true});
    this.registrationPath=join(this.directory,this.state.registryHash+'.json');
    const registration={...this.registry,registeredAt:this.state.registeredAt,firstBatchStart:this.state.firstBatchStart,
      scope:'Paper experimental selection; not proven positive expectation'};
    if(existsSync(this.registrationPath)){
      if(!isDeepStrictEqual(JSON.parse(readFileSync(this.registrationPath,'utf8')),registration))throw Error('Immutable evolution registration differs');
    }else writeJsonAtomic(this.registrationPath,registration);
    const g=this.state.governance;
    if(g.version!==evolutionProtocol.version||g.createdAt!==this.state.registeredAt||g.realTrading!==false)
      throw Error('Invalid evolution governance checkpoint');
    if(g.phase!=='primary'||g.history?.length||Object.keys(g.processedBatches??{}).length||
      Object.keys(g.processedResults??{}).length||g.effectivePolicy!=='market')this.verifyAdoption();
    else if(!isDeepStrictEqual(g,newEvolutionGovernance({createdAt:this.state.registeredAt,registryHash:this.state.registryHash})))
      throw Error('Initial evolution governance differs');
  }
  verifyAdoption(){
    let rebuilt=newEvolutionGovernance({createdAt:this.state.registeredAt,registryHash:this.state.registryHash});
    const indices=this.state.governance.history?.map(h=>h.batchIndex)??[];
    if(!indices.length||indices.some((n,i)=>n!==i))throw Error('Adoption or confirmation lacks contiguous fixed decisions');
    for(const index of indices){
      const b=this.batch(index),study=this.getStudy(b),path=join(this.directory,this.state.registryHash.slice(0,12),b.batchId,'gate-result.json');
      if(!study.state.closedAt||!existsSync(path))throw Error('Adoption lacks sealed forward evidence');
      const frozen=JSON.parse(readFileSync(path,'utf8'));
      if(frozen.cohortStateHash!==digest(JSON.stringify(study.state)))throw Error('Sealed adoption cohort differs');
      const reviewed=evaluateEvolutionBatch({batch:b,accounts:study.state.accounts,daily:study.state.daily,
        now:frozen.evaluatedAt,registryHash:this.registry.registryHash});
      const {cohortStateHash,...recorded}=frozen;
      if(!isDeepStrictEqual(reviewed,recorded))throw Error('Adoption evidence failed independent recalculation');
      const decision=this.state.governance.history[index];
      rebuilt=planEvolutionDecision(rebuilt,frozen,{now:decision.at});
    }
    const g=this.state.governance;
    const localFallback=g.phase==='rolled-back'&&g.effectivePolicy==='market'&&rebuilt.effectivePolicy==='consensus'&&
      ['configuration-fallback','integrity-fallback'].includes(g.lastDecision?.kind);
    if(localFallback)rebuilt={...rebuilt,effectivePolicy:'market',phase:'rolled-back',generation:rebuilt.generation+1,lastDecision:g.lastDecision};
    if(!isDeepStrictEqual(rebuilt,g))throw Error('Saved adoption or confirmation is not bound to verified fixed batches');
  }
  batch(index){const start=this.state.firstBatchStart+index*week;return {
    batchId:`${this.state.registryHash.slice(0,12)}-${index}`,index,start,end:start+week,labelCutoff:start+week+day,
    registeredAt:this.state.registeredAt,registryHash:this.state.registryHash};}
  getStudy(batch){
    if(this.studies.has(batch.batchId))return this.studies.get(batch.batchId);
    const path=join(this.directory,this.state.registryHash.slice(0,12),batch.batchId);mkdirSync(path,{recursive:true});
    const study=new EvolutionStudy(path,{createdAt:this.state.registeredAt,registryHash:this.state.registryHash,
      batchId:batch.batchId,batchStart:batch.start,batchEnd:batch.end,labelCutoff:batch.labelCutoff});
    this.studies.set(batch.batchId,study);return study;
  }
  observe(input,financialLabels,{allowEntry}){
    this.historyApproval=this.historyGate.check(input.now);
    if(this.error)return [];
    const index=Math.max(0,Math.floor((input.now-this.state.firstBatchStart)/week)),plans=[];
    // Two initial fixed cohorts. Later ones monitor an adopted rule; rejected
    // candidates are never retried until a fresh registered implementation exists.
    const phase=this.state.governance.phase,retired=['rejected','rolled-back'].includes(phase),
      maximum=retired||['adopted','monitoring'].includes(phase)?index:1;
    const pendingIndexes=[];
    for(let i=0;i<=maximum;i++){
      const b=this.batch(i),already=this.state.governance.processedBatches?.[b.batchId];
      if(retired&&!existsSync(join(this.directory,this.state.registryHash.slice(0,12),b.batchId,'evolution-study.json')))continue;
      if(!already&&input.now>=b.start-week)pendingIndexes.push(i);
    }
    for(const i of pendingIndexes){
      const b=this.batch(i);if(input.now<b.start&&i>0)continue;
      const study=this.getStudy(b);if(retired&&study.state.closedAt)continue;
      const labels=new Map([...financialLabels].filter(([,l])=>l?.observedAt<=Math.min(input.now,b.labelCutoff)));
      study.observe(input,labels,{allowEntry:!retired&&allowEntry&&input.now>=b.start&&input.now<b.end,batchStart:b.start,batchEnd:b.end,labelCutoff:b.labelCutoff});
      if(input.now>=b.labelCutoff){
        study.closeBatch(input.now);
        const evaluation=evaluateEvolutionBatch({batch:b,accounts:study.state.accounts,daily:study.state.daily,now:input.now,registryHash:this.registry.registryHash});
        const evidencePath=join(study.directory??join(this.directory,this.state.registryHash.slice(0,12),b.batchId),'gate-result.json');
        let frozen=evaluation;
        if(existsSync(evidencePath)){
          frozen=JSON.parse(readFileSync(evidencePath,'utf8'));
          const reviewed=evaluateEvolutionBatch({batch:b,accounts:study.state.accounts,daily:study.state.daily,
            now:frozen.evaluatedAt,registryHash:this.registry.registryHash}),{cohortStateHash,...recorded}=frozen;
          if(!Number.isFinite(frozen.evaluatedAt)||frozen.evaluatedAt>input.now||
            cohortStateHash!==digest(JSON.stringify(study.state))||!isDeepStrictEqual(reviewed,recorded))
            throw Error('Frozen evolution evidence differs');
        }
        else writeJsonAtomic(evidencePath,{...evaluation,cohortStateHash:digest(JSON.stringify(study.state))});
        if(retired)continue;
        const proposed=planEvolutionDecision(this.state.governance,frozen,{now:input.now});
        const next=historyGatedEvolutionPlan(this.state.governance,proposed,this.historyApproval);
        if(proposed!==next)this.lastHistoryBlock={at:input.now,candidateId:historyApprovalProtocol.candidateId,reason:this.historyApproval.reason};
        if(!isDeepStrictEqual(next,this.state.governance)){
          // Sequential plans use the already committed state on the next frame.
          plans.push({governance:next,evaluation:frozen,evidencePath});break;
        }
      }
    }
    return plans;
  }
  binding(now,config,strategy,origin){
    this.historyApproval=this.historyGate.check(now);
    const manual=origin==='manual-one-tap',compatible=!this.error&&!manual&&compatibleEvolutionConfig(config,strategy),
      policy=!this.error&&compatible&&this.historyApproval.approved?this.state.governance.effectivePolicy:'market';
    return {version:evolutionVersion,policy,exitRevision:exitPolicyRevision(policy),registryHash:this.registry.registryHash,
      candidateRegistryHash:this.state.registryHash,currentRegistryHash:this.registry.registryHash,sourceCompatible:!this.error,
      protocolHash:this.registry.protocolHash,implementationHash:this.registry.implementationHash,
      generation:this.state.governance.generation??0,adoptionId:this.state.governance.adoptionId??null,
      boundAt:now,origin,scope:'paper-only',compatible,historyApproved:this.historyApproval.approved,
      historyApproval:this.historyApproval,reason:this.error??(manual?'手动入场尚未进入本候选验证；继续原市场退出自动管理':
        !compatible?'当前配置与候选验证协议不同，使用原市场退出':!this.historyApproval.approved?this.historyApproval.reason:null)};
  }
  save(){for(const study of this.studies.values())study.save([]);}
  summary(now){
    this.historyApproval=this.historyGate.check(now);
    const current=Math.max(0,Math.floor((now-this.state.firstBatchStart)/week)),b=this.batch(current);
    const studies=[...this.studies.values()].slice(-2).map(s=>{
      const v=s.summary(now);return {batchId:v.batchId,batchStart:v.batchStart,batchEnd:v.batchEnd,labelCutoff:v.labelCutoff,
        coverage:v.coverage,accounts:v.accounts?.map(a=>({id:a.id,policy:a.policy,executionDelayMs:a.executionDelayMs,
          initialCapital:a.initialCapital,cash:a.cash,realized:a.realized,fees:a.fees,completed:a.completed,
          lockedCost:a.lockedCost,active:Boolean(a.active??a.position),pendingCount:a.pendingSettlements?.length??a.pendingCount??0,
          lower:a.payoutRange?.lower,upper:a.payoutRange?.upper}))};
    });
    return {version:evolutionVersion,error:this.error,registeredAt:this.state.registeredAt,registryHash:this.state.registryHash,
      governance:this.state.governance,historyPrerequisite:this.historyApproval,lastHistoryBlock:this.lastHistoryBlock,lastEvaluation:this.state.lastEvaluation??null,protocol:this.registry.protocol,firstBatch:this.batch(0),currentBatch:b,cohorts:studies,
      scope:'独立模拟候选验证；完整历史与两未来批次均通过后只应用于自动新仓，手动及既有仓位保留原退出版本'};
  }
}
