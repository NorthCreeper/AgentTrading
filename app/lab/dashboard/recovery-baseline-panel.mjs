export function recoveryBaselineView(state){const b=state?.recoveryBaseline;if(!b)return null;
 const value=state.portfolio?.nav?.value??state.equity,net=Number.isFinite(value)?value-b.cash:null;
 const fees=Number.isFinite(state.account?.fees)?state.account.fees-b.fees:null;
 return {net,fees,startedAt:b.startedAt,cash:b.cash,unresolvedBytes:b.unresolvedBytes};}
export function renderRecoveryBaseline(state,get=id=>document.getElementById(id)){
 const el=get('recovery-baseline-note');if(!el)return;const v=recoveryBaselineView(state);el.hidden=!v;if(!v)return;
 const money=n=>Number.isFinite(n)?`${n<0?'−':''}$${Math.abs(n).toFixed(4)}`:'待核实';
 const at=new Date(v.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false});
 el.textContent=`恢复后模拟净值变化：${money(v.net)}（含持仓估值），新增费用 ${money(v.fees)}。起点：${at} HKT，已核实余额 ${money(v.cash)}。事故区间仍有未恢复记录；此后收益从该起点单独计算，历史记录继续保留。`;
}
