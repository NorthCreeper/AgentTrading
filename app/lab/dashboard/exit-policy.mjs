import {marketInformationExit,marketExitRevision} from './market-exit.mjs';
import {consensusExit,consensusExitVersion} from './consensus-exit.mjs';

export const exitPolicies=Object.freeze({market:marketExitRevision,consensus:consensusExitVersion});
export function exitPolicyRevision(policy){
  const revision=exitPolicies[policy];if(!revision)throw Error('Unknown registered exit policy');return revision;
}
export const isManagedExitRevision=revision=>Object.values(exitPolicies).includes(revision);
export function resetManagedConfirmation(trade){
  if(!trade)return;
  for(const key of ['marketReversal','bidReversal','reversalObservation','consensusDecision','marketHoldingDecision'])delete trade[key];
  trade.holdingDecision=null;
}
// Dispatch only immutable, registered market rules. Never route a new policy
// through a legacy timer or dollar-loss exit.
export function runManagedExit({trade,held,book,market,now,config,history,prices=[],bidHistory=[]}){
  const revision=trade.parameters?.exitRevision;
  if(revision===marketExitRevision)return marketInformationExit(trade,held,book,market,now,config,history,prices);
  if(revision!==consensusExitVersion)throw Error('Unknown managed exit revision');
  if(!Number.isFinite(trade.costPerShare)||!Number.isFinite(held)||held<=0)throw Error('Invalid owned cost for registered exit');
  const previousCost=trade.cost,hadCost=Object.hasOwn(trade,'cost');
  trade.cost=held*trade.costPerShare;
  try {
    const exit=consensusExit(trade,held,book,market,now,config,history,prices,bidHistory);
    trade.marketHoldingDecision=trade.holdingDecision;
    trade.holdingDecision={...trade.marketHoldingDecision,...trade.consensusDecision,revision:consensusExitVersion,
      holdLimitMs:null,marketConfirmedMs:trade.consensusDecision?.marketConfirmedMs??0,bidConfirmedMs:trade.consensusDecision?.bidConfirmedMs??0};
    if(exit&&!Number.isFinite(exit.net))throw Error('Registered exit returned invalid net value');
    return exit;
  }finally{if(hadCost)trade.cost=previousCost;else delete trade.cost;}
}
