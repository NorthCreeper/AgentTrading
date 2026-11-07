const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=x=>Number.isFinite(x)?`${x<0?'−':''}$${Math.abs(x).toFixed(4)}`:'—';
const date=x=>Number.isFinite(x)?new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false}):'—';
const phases={primary:'首批验证',confirmation:'第二批确认',adopted:'已采用候选 · 持续复核',monitoring:'持续复核',rejected:'本版本未通过', 'rolled-back':'已回退原规则','source-mismatch':'登记版本待重新核对'};
const policy=x=>x==='consensus'?'中间价与净卖出价值共同确认':'原市场信息退出';
export function renderEvolution(v,byId=id=>document.getElementById(id)){
  if(!byId('evolution-status'))return;
  const g=v?.governance??{},b=v?.firstBatch,history=v?.historyPrerequisite;
  if(v?.status==='archived-after-explicit-ray-replacement'){
    byId('evolution-status').textContent='主策略已按用户指定替换为 Ray；旧自动采用流程已归档，后续不会切换 Ray 的规则。旧批次原始记录保留。';
    byId('evolution-policy').textContent='Ray · 持有至官方结算';byId('evolution-phase').textContent='已归档';
    byId('evolution-generation').textContent='—';byId('evolution-review').textContent='—';byId('evolution-window').textContent='旧固定日期批次已封存。';
    byId('evolution-accounts').innerHTML='<tr><td colspan="5">旧账户原始数据保留，本区不计作 Ray 的收益。</td></tr>';
    byId('evolution-decision').textContent='已关闭自动采用；Ray 由用户明确指定。';byId('evolution-gates').innerHTML='<tr><td colspan="3">Ray 的历史收益另见本次完整回放报告。</td></tr>';return;
  }
  byId('evolution-status').textContent=v?.error?`自动采用暂不可用：${v.error}。当前合法模拟和既有仓管理继续。`:
    history?.approved===false?'完整历史筛选未通过，候选继续独立观察。主自动模拟按原市场规则运行；未来批次结果不能绕过历史前置检查。已有仓位及手动 One-Tap 继续按各自规则自动管理。':
    '候选使用独立模拟资金并行验证；完整历史与两批前向验证均通过后仅改变后来的自动新仓，之后按固定批次复核。已有仓位保留原退出版本；手动 One-Tap 继续由原市场规则自动管理。';
  byId('evolution-policy').textContent=policy(history?.approved===false?'market':g.effectivePolicy);
  byId('evolution-phase').textContent=phases[g.phase]??'等待登记';
  byId('evolution-generation').textContent=String(g.generation??0);
  byId('evolution-review').textContent=date(b?.labelCutoff);
  byId('evolution-window').textContent=b?`首批 ${date(b.start)} 至 ${date(b.end)}；固定标签截止 ${date(b.labelCutoff)}。第二批为随后七个完整日期，合计十四日。`:'等待登记新的固定日期批次。';
  const cohorts=v?.cohorts??[];
  byId('evolution-accounts').innerHTML=cohorts.flatMap(c=>(c.accounts??[]).map(a=>`<tr><td>${esc(c.batchId)}<br><small>${policy(a.policy)} · ${a.executionDelayMs? '1秒执行压力':'即时模拟'}</small></td><td>${money(a.cash)}</td><td>${money(a.realized)}<br><small>费用 ${money(a.fees)}</small></td><td>${a.completed??0}<br><small>活跃 ${a.active?1:0} · 待结算 ${a.pendingCount??0}</small></td><td>${money(a.lockedCost)}</td></tr>`)).join('')||'<tr><td colspan="5">新批次尚未开始；旧交易不会回填为候选成绩。</td></tr>';
  const latest=g.lastDecision;
  byId('evolution-decision').textContent=latest?`最近验证：${date(latest.at??latest.decidedAt)} · ${latest.reason??latest.kind??latest.type??'结果已记录'}`:'尚未达到固定评审时点；不会根据实时排名切换。';
  const rows=v?.lastEvaluation?.gates??[];
  byId('evolution-gates').innerHTML=rows.length?rows.map(r=>`<tr><td>${esc(r.name??r.id)}</td><td>${r.passed?'通过':'未通过'}</td><td>${esc(r.reason??r.detail??'')}</td></tr>`).join(''):'<tr><td colspan="3">尚未达到固定评审时点。</td></tr>';
}
