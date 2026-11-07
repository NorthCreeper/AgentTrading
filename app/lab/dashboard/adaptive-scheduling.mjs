import {adaptiveProtocol} from './adaptive-calibration.mjs';

// Probe references without cloning the growing raw-history checkpoint. The
// collector remains the authority on eligibility, evidence and learning.
export function adaptiveWorkAvailable(state,sources,labels,now) {
  if(Object.values(sources??{}).some(s=>s?.market?.slug&&!state.samples[s.market.slug]&&
    Number.isFinite(s.at)&&s.at>=state.createdAt&&s.at<=now&&now-s.at<=adaptiveProtocol.staleMs))return true;
  return Object.values(state.samples).some(s=>{
    const l=labels.get(s.market.slug),m=s.market;
    if(!l||l.slug!==m.slug||l.conditionId!==m.conditionId||l.start!==m.start||l.end!==m.end||
      !Number.isFinite(l.observedAt)||l.observedAt<m.end||l.observedAt>now||
      !Number.isFinite(l.opening)||!['Up','Down'].every(o=>l.tokens?.[o]===m.tokens[o]&&[0,1].includes(l.payouts?.[o]))||
      l.payouts.Up+l.payouts.Down!==1||!['Up','Down'].includes(l.winner)||l.payouts.Up!==Number(l.winner==='Up'))return false;
    return s.label ? l.winner!==s.label.winner||l.payouts.Up!==s.label.y||Math.abs(l.opening-s.label.opening)>.00001 :
      Math.abs(l.opening-s.opening)<=.00001;
  });
}
