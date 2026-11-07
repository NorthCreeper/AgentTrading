import {feeFor} from '../paper-broker.mjs';
const num=(n,d=2)=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const money=n=>Number.isFinite(n)?`$${num(n,4)}`:'—';
const clockLabel=v=>v.status==='ok'?(v.retrying?'校时重试中，原校准仍有效':'正常'):
 v.status==='degraded'?({'never-calibrated':'尚未取得可信校准','calibration-expired':'校准已过期，等待恢复',
 'forward-epoch-wait':'等待时间纠正完成','utc-catchup-wait':'等待UTC追平'}[v.reason]??'需检查'):null;
const shadowReason=reason=>({'outside-last-120-seconds':'等待最后120秒','past-180-second-volatility-warming':'过去180秒数据预热中',
 'utc-clock-not-ready':'等待可信时钟','accurate-opening-not-known-or-conflicting':'等待准确开盘基准',
 'past-volatility-zero-or-unknown':'近期波动无法估计','direction-unknown-at-opening':'当前方向尚不明确',
 'reference-not-fresh':'等待新鲜TWAP','book-source-unavailable':'等待新鲜盘口','no-supported-training-cell':'对应分组样本不足'}[reason]??'尚缺完整可用数据');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function rayEntryView(state){
 const s=state?.strategy,summary=s?.rayEntrySummary,decision=s?.decision,protocol=s?.rayProtocol;
 const positions=Array.isArray(s?.rayOwnedPositions)?s.rayOwnedPositions:[];
 const known=summary?.equityKnown===true&&Number.isFinite(summary.equity)&&summary.equity>=0;
 const pct=summary?.allocation?.pct??protocol?.equitySizePct??.025,budget=known?summary.equity*pct:null;
 let note=known?`仓位计算净值 ${money(summary.equity)}；每笔含费预算 ${num(pct*100,1)}% = ${money(budget)}。`:
  `仓位计算净值暂不可核实：${summary?.equityReason??'等待有效持仓估值'}；不会用本金或未知兑付补值。`;
 const fee=state?.frame?.market?.fee,min=Math.max(5,state?.frame?.market?.minSize??5),low=protocol?.asymHigh??.8;
 if(known&&Number.isFinite(fee?.rate)&&fee.rate>=0&&Number.isFinite(fee?.exponent)&&fee.exponent>=0){
  const floorCost=min*low+feeFor(min,low,fee);
  note+=` 以 ${num(low*100,0)}¢ 和当前费率计，最低 ${num(min,0)} 份约需 ${money(floorCost)}。`;
  if(budget<floorCost)note+=' 当前预算不足最低份额，按规则等待；不会自动补钱或向上凑份。';
 }
 note+=' 金额 FAK：本金与含费最高支出分别记录，未成交余量取消。仓位比例范围 2.5%–10%；当前强度映射未通过独立验证，采用 2.5% 基线。';
 if(protocol?.entryPolicy==='one-filled-entry-per-market-v1'||protocol?.version==='ray-twap-calendar-onetap-v6')
  note+=summary?.roundEntryConsumed===true?' 本盘口已有成交，本轮不再买入；部分成交后不补单。':
   summary?.roundEntryConsumed===false?' 每个盘口只开一次仓；完全未成交的请求可重试，部分成交后不补单。':' 每个盘口只开一次仓；等待本轮开仓记录核对。';
 const dynamic=decision?.dynamicTwap;
 if(dynamic)note+=dynamic.ready?` 动态门槛观察 ${money(dynamic.thresholdUsd)}，当前仍执行原时段门槛；未用于下单。`:
  ` 动态门槛观察：${dynamic.reason}；短/长窗口覆盖 ${num(dynamic.shortCoverage*100,1)}% / ${num(dynamic.longCoverage*100,1)}%，未用于下单。`;
 if(summary)note+=` 本轮已成交 ${num(summary.roundUsedShares??0,4)} / ${num(summary.maximumSharesPerRound??100,0)} 份，剩余 ${num(summary.roundRemainingShares??100,4)} 份。`;
 if(decision?.reasonCode==='size_below_min')note+=' 最近入场判断：预算不足最低份额或完整请求超过单次份额限制。';
 if(decision?.reasonCode==='round_share_cap')note+=' 本轮剩余额度容不下完整比例请求，跳过本次，不主动缩小预算。';
 const body=positions.length?positions.map(p=>{
  const held=state?.account?.holdings?.[p.tokenId],lots=Array.isArray(p.entryLots)?p.entryLots.filter(l=>l.filled>0).length:0;
  return `<tr><td>${esc(p.outcome)} · ${esc(p.slug)}</td><td>${num(held,4)} 份</td><td>${lots} 次成交</td><td>${state.now>=p.market?.end?'到期，等待官方核验':'持有至官方核验'}；尚未计入已实现收益</td></tr>`;
 }).join(''):'<tr><td colspan="4">当前没有 Ray 活跃持仓；到期待核实仓位在结算队列单列。</td></tr>';
 const cal=decision?.calendarThreshold,context=cal?.context;
 const kinds={weekend:'纽约周末',regular_weekday:'普通美股交易日',nyse_closed:'美股整日休市',nyse_early_close:'美股提前收市',
  federal_only_holiday:'美国联邦假日／美股照常',macro_release:'宏观公告窗口',crypto_expiry:'加密到期窗口',equity_expiry:'美股期权到期日',calendar_unknown:'日期来源未核实'};
 let calendarNote=cal?`纽约日期 ${context?.dateNy??'未知'}，${kinds[cal.primaryType]??cal.primaryType}；当前准入门槛 ${money(cal.thresholdUsd)}，原时段门槛 ${money(cal.baseThresholdUsd)}。${cal.reason}`:'等待日期门槛判断。';
 if(cal?.candidateThresholdUsd!==null&&cal?.candidateThresholdUsd!==undefined&&!cal.active)calendarNote+=` 未采用的研究候选 ${money(cal.candidateThresholdUsd)}。`;
 if(cal?.support)calendarNote+=` 独立日期：前段 ${cal.support.trainingDates??0} / 后段 ${cal.support.testDates??0}；未验证收益或扩大仓位。`;
 if(state?.config?.riskPolicy==='equity-per-order-v1'&&state.config.maxExposure===null)
  note+=' 固定总成本上限已取消；每笔含费预算仍须在净值 2.5%–10% 内并有足够现金。每轮份额限制不足时跳过，FAK 部分成交可低于计划预算。';
 else if(known&&Number.isFinite(state?.config?.maxExposure)&&Math.floor(budget*100+1e-8)/100>state.config.maxExposure)
  note+=` 本笔约 ${money(Math.floor(budget*100+1e-8)/100)} 的预算高于全账户 ${money(state.config.maxExposure)} 成本上限，风控将拒绝；日期门槛不会覆盖资金限制。`;
 const terminal=s?.terminalRisk;
 const terminalNote=terminal?`末段风险：影子观察，不自动卖出。${terminal.sampleAgeMs>5000?'观察已过期，等待新鲜数据；':
  terminal.status==='observation-write-error'?'记录异常，请核对日志；':`当前记录 ${terminal.ownedCount??0} 个实际持仓、${terminal.probeCount??0} 个无持仓方向观察；`}
  已确认候选 ${terminal.ownedCandidates??0} 个实际持仓 / ${terminal.hypotheticalCandidates??0} 个无持仓方向。仅最后60秒核对反向盘口、现货与连续确认；历史样本不足，收益未验证。`:'末段风险观察尚未启用。';
 const flow=s?.orderflowResearch,recorder=flow?.recording,counts=recorder?.counts,shadow=flow?.shadow;
 const observedWindows=[1,3,10,30].filter(n=>shadow?.latest?.windows?.[n]?.status==='observed');
 const flowNote=flow?`订单流：影子记录，不参与买卖或加码。已写 ${counts?.written??0} 条压缩记录，丢失 ${counts?.dropped??0} 条；${
  flow.error||flow.lifecycleError||recorder?.lastError?'记录异常，相关特征按未知处理':
  flow.clockQuality?.ready===false?'时间未核实，特征按未知处理':
  shadow?.latest&&state.now-shadow.latest.time>5000?'观察已过期，等待新鲜数据':
  `${shadow?.continuousDepth?.continuous?'深度增量连续':'等待连续深度'}；${observedWindows.length?`已具 ${observedWindows.join('/')} 秒成交窗口`:'成交窗口预热中或暂无新鲜观察'}`}。主动成交仅覆盖已观察的公开市场，不能识别大户身份，增量收益尚未验证。`:'订单流影子记录尚未启用。';
 return {note,body,calendarNote,terminalNote,flowNote,positionCount:positions.length};
}

export function renderRayEntry(state,get=id=>document.getElementById(id)){
 const section=get('ray-entry-details');if(!section)return;
 section.hidden=state?.strategy?.config?.model!=='ray-twap-band';
 if(section.hidden)return;
 const view=rayEntryView(state),note=get('ray-budget-note'),body=get('ray-owned-body'),calendar=get('ray-calendar-note'),terminal=get('ray-terminal-note'),flow=get('ray-orderflow-note');
 if(note)note.textContent=view.note;if(body)body.innerHTML=view.body;if(calendar)calendar.textContent=view.calendarNote;
 if(terminal)terminal.textContent=view.terminalNote;
 if(flow)flow.textContent=view.flowNote;
 const timing=get('ray-event-timing-note'),gate=state?.strategy?.rayEntryTiming;
 if(timing)timing.textContent=gate?.mode==='event-driven'?`入场按新盘口 / 新TWAP事件复核，不再等待五秒槽；已提交 ${gate.attempts??0} 次完整准入，同源重复抑制 ${gate.suppressedSameSource??0} 次。每盘口只开一次，零成交仅在源盘口更新后重试。`:'当前入场时机以后台版本为准。';
 const research=state?.strategy?.admissionResearch,terminalShadow=research?.terminal,current=terminalShadow?.current;
 const validation=research?.validation,comparison=get('ray-validation-note'),table=get('ray-validation-body');
 if(comparison)comparison.textContent=validation?`逐盘口对照已启用：累计观察 ${validation.counts.rounds} 轮，官方核验 ${validation.counts.completed} 轮；最近保留窗口内的纽约日期 ${validation.independentDates} 个。缺口保留未知。四组均为固定 $1000 参考净值、2.5%预算的独立机会，不计入账户。尚无经校准概率，不自动切换策略。`:'逐盘口对照尚未启用。';
 if(table)table.innerHTML=validation?Object.entries(validation.totals).map(([key,v])=>{const names={baseline:'原门槛',tail:'动态门槛','tail-quote':'动态 + 报价趋势','tail-quote-flow':'再加订单流'},s=v.scenarios?.['0ms-depth1'],delay=v.scenarios?.['2000ms-depth1'];return `<tr><td>${esc(names[key]??key)}</td><td>${v.signals}</td><td>${v.labeled}</td><td>${v.wins} / ${v.losses}</td><td>${s?.observed?money(s.net):'未知'}</td><td>${delay?.observed?money(delay.net):'未知'} · 缺 ${delay?.unknown??0}</td></tr>`;}).join(''):'';
 if(comparison&&validation?.paired){const g=validation.paired.groups.quote;
  comparison.textContent+=` 同时点配对：报价特征完整 ${g.observed} 个，缺失 ${g.unknown} 个；过滤掉盈利 ${g.blockedWins} 个、亏损 ${g.blockedLosses} 个。基于最近保留的 ${validation.paired.retainedCompletedRounds} 个已核验盘口，固定首次动态信号，不用后来的入场替代。`;}
 if(comparison&&state?.recoveryBaseline)comparison.textContent+=' 恢复后的累计机会与结果由有效日志重建；逐帧调用计数只保留已知下界，事故缺失轮次保持未知。';
 const terminalNode=get('ray-admission-shadow-note'),sizingNode=get('ray-sizing-shadow-note');
 const market=state?.frame?.market,currentMarket=Number.isFinite(market?.start)&&Number.isFinite(market?.end)&&market.start<=state.now&&state.now<market.end;
 if(terminalNode)terminalNode.textContent=research?.stage>=2?`结算方向门槛 · 影子验证：${Number.isFinite(current?.thresholdUsd)&&state.now-current.time<=5000?`当前候选 $${num(current.thresholdUsd,2)}，过去180秒覆盖 ${num(current.volatilityCoverage*100,1)}%；${current.selection?.pooled?'日期/特征样本不足，采用合并样本':'使用足够训练样本的分组'}；`:`${shadowReason(current?.reason)}；`}已核验官方结果 ${terminalShadow?.statistics?.officiallyLabeledRounds??0} 轮。${research.error||research.recording?.lastError?'影子记录异常，请核对健康记录；':''}当前仍执行原时段门槛，研究目标5%不代表实际反向概率。`:'结算方向门槛影子验证尚未启用。';
 if(sizingNode)sizingNode.textContent=research?.stage>=3?`动态仓位 · 影子诊断：${Number.isFinite(research.sizing?.probabilityLowerBound)?`胜率置信下界 ${num(research.sizing.probabilityLowerBound*100,1)}%；`:'尚无通过独立日期校准的胜率下界，候选比例未知；'}${Number.isFinite(research.sizing?.liquidityCapacityPct)?`当前现金/深度/份额上限可容纳净值约 ${num(research.sizing.liquidityCapacityPct*100,2)}%；`:''}实际自动单采用2.5%基线；2.5%–10%候选不会自动用于下单。`:'动态仓位诊断将在下一阶段启用；当前自动单仍采用2.5%基线。';
 if(terminalNode&&research?.stage>=2&&!currentMarket)terminalNode.textContent='结算方向门槛 · 影子验证：缺少当前盘口，等待取得本轮市场信息与盘口；旧轮观察不代表当前预测可用。当前策略和仓位规则未改变。';
}

export function renderRayRuntimeCheck(health,get=id=>document.getElementById(id)){
 const node=get('ray-check-note');if(!node)return;
 const check=health?.rayAudit;
 let text=check?.status==='verified'?'当前 Ray 源码与当前快照核对通过。':
  check?.status==='degraded'?'当前 Ray 版本核对发现差异，请查看健康状态与日志。':
  '当前 Ray 版本核对尚未完成登记或正在等待本版本启动。';
 text+=' 此检查仅覆盖当前版本与提供的持仓记录，不代表全历史或盈利验证。';
 const old=health?.automaticAudit,count=old?.fullHistory?.issueCount;
 if(Number.isInteger(count)&&count>0)text+=` 旧研究的 ${count} 项未核实记录继续保留。`;
 if(old?.message==='Registered diagnostic audit sources changed')text+=' 旧研究诊断因版本登记不匹配停止更新，新旧结果分别记录。';
 node.textContent=text;
 const business=get('ray-business-health');
 if(business){const h=health?.business,labels={process:'后台',clock:'时钟',metadata:'市场信息',books:'盘口',reference:'TWAP',model:'对照记录',prediction:'预测输入',recording:'落盘',settlement:'结算'},statuses={ok:'正常',degraded:'需检查',waiting:'等待核验',idle:'无待结算',stopped:'已停止',disabled:'未启用',unknown:'未知'};
  business.textContent=h?Object.entries(h.components).map(([k,v])=>`${labels[k]??k}：${k==='clock'&&clockLabel(v)?clockLabel(v):v.status==='degraded'&&v.reason==='no-current-market-frame'?'缺少当前盘口':v.status==='degraded'&&v.reason==='prediction-market-mismatch'?'预测仍属旧盘口':k==='prediction'&&v.status==='waiting'?'预热或数据不足':k==='prediction'&&v.status==='idle'?'等待最后120秒':statuses[v.status]??v.status}`).join('；')+`。最近 ${h.window?.samples??0} 次检查；报警不改变仓位或结算规则。`:'业务健康尚未读取。';
  const c=h?.components.clock,a=c?.lastAttempt;
  if(a?.result==='failed')business.textContent+=` 最近校时失败：${a.failures?.length?a.failures.map(f=>`${f.source} ${f.httpStatus?`HTTP ${f.httpStatus}`:f.causeCode??f.errorName}`).join('；'):a.reason??'测量未通过校验'}。具体测量保留在健康记录中。`;
 }
}
