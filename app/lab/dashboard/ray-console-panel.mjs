const finite=Number.isFinite;
const amount=(n,d=2)=>finite(n)?n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const money=n=>finite(n)?`$${amount(n)}`:'—';
const cents=n=>Math.floor(n*100+1e-8)/100;
const close=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-7;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fresh=(row,now,max)=>row&&[row.timestamp,row.receivedAt].every(t=>finite(t)&&t<=now&&now-t<=max);
const price=value=>typeof value==='string'&&/^\d+$/.test(value)&&finite(Number(value)/1e18)&&Number(value)>0?Number(value)/1e18:null;
const labels={pass:'已满足',wait:'等待',fail:'未满足',unknown:'待核实'};
const clockText=at=>new Date(at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Hong_Kong',hour:'2-digit',minute:'2-digit',hour12:false});

// Display only. This view neither evaluates execution depth itself nor creates
// orders; a current backend sizing decision is required for the final gate.
export function rayConsoleView(state){
 const s=state?.strategy,p=s?.rayProtocol,d=s?.decision,frame=state?.frame,m=frame?.market,now=state?.now;
 const summary=s?.rayEntrySummary,account=state?.account,ray=s?.config?.model==='ray-twap-band';
 const singleEntry=p?.entryPolicy==='one-filled-entry-per-market-v1'||p?.version==='ray-twap-calendar-onetap-v6';
 const entryKnown=typeof summary?.roundEntryConsumed==='boolean',entryConsumed=summary?.roundEntryConsumed===true;
 const visible=s?.config?.model===undefined||ray;
 const clockReady=state?.clock?.ready===true&&finite(now);
 const marketKnown=clockReady&&m&&finite(m.start)&&finite(m.end)&&m.end>m.start&&
  finite(frame.now)&&frame.now<=now&&typeof m.tokens?.Up==='string'&&typeof m.tokens?.Down==='string';
 const remainingMs=marketKnown?m.end-now:null,late=marketKnown&&now>=m.start&&remainingMs>0&&remainingMs<=120000;
 const seconds=finite(remainingMs)?Math.max(0,Math.ceil(remainingMs/1000)):null;
 const remaining=seconds===null?'—':`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
 const decisionCurrent=Boolean(marketKnown&&p&&d?.version===p.version&&finite(d.time)&&d.time<=now&&
  now-d.time<=Math.min(5000,state?.config?.staleMs??3000));
 const hour=finite(now)?new Date(now+28800000).getUTCHours():null;
 const session=hour===null?null:hour>=6&&hour<12?'morning':hour>=12&&hour<22?'midday':'night';
 const thresholdUsd=decisionCurrent&&finite(d.thresholdUsd)?d.thresholdUsd:p?.thresholds?.[session];
 const o=frame?.rayOpening;
 const strictOpening=['ray-twap-calendar-onetap-v7','ray-twap-event-onetap-v8'].includes(p?.version);
 const openingKnown=Boolean(marketKnown&&o&&o.slug===m.slug&&o.conditionId===m.conditionId&&finite(o.value)&&o.value>0&&
  finite(o.knownAt)&&o.knownAt<=now&&o.referenceAt<=o.knownAt&&o.status!=='conflict'&&!o.conflicts?.length&&
  (strictOpening?o.windowSeconds===60&&o.referenceAt===m.start&&
    (o.source==='gamma-price-to-beat'||o.source==='rtds-twap-sixty-opening'&&price(o.valueE18)===o.value):
   o.source==='gamma-price-to-beat'&&o.referenceAt===m.start||
   o.source==='rtds-chainlink-spot'&&finite(o.referenceAt)&&Math.abs(o.referenceAt-m.start)<=2500));
 const twap=state?.reference?state.reference.price:frame?.twap,twapValue=price(twap?.valueE18);
 const twapFresh=Boolean(marketKnown&&twapValue!==null&&twap.windowSeconds===60&&fresh(twap,now,5000)&&
  (!state?.reference||state.reference.ready===true));
 const deviationUsd=openingKnown&&twapFresh?twapValue-o.value:null;
 const direction=deviationUsd>0?'Up':deviationUsd<0?'Down':null;
 const up=frame?.books?.find(b=>b.tokenId===m?.tokens?.Up),down=frame?.books?.find(b=>b.tokenId===m?.tokens?.Down);
 const staleMs=finite(state?.config?.staleMs)&&state.config.staleMs>0?state.config.staleMs:3000;
 const topValid=b=>[b?.bids?.[0],b?.asks?.[0]].every(x=>Array.isArray(x)&&finite(x[0])&&x[0]>0&&x[0]<1&&finite(x[1])&&x[1]>0)&&b.asks[0][0]>b.bids[0][0];
 const booksFresh=Boolean(marketKnown&&[up,down].every(b=>fresh(b,now,staleMs)&&topValid(b)));
 const selectedBook=direction==='Up'?up:direction==='Down'?down:null,otherBook=direction==='Up'?down:direction==='Down'?up:null;
 const ask=booksFresh?selectedBook?.asks[0][0]:null,otherAsk=booksFresh?otherBook?.asks[0][0]:null;
 const bandLow=Math.max(p?.minPrice??.55,p?.asymHigh??.8),bandHigh=p?.maxPrice??.85,otherMax=p?.asymLow??.2;
 const pricesPass=Boolean(direction&&booksFresh&&ask>=bandLow&&ask<=bandHigh&&otherAsk<=otherMax);
 const equityKnown=summary?.equityKnown===true&&finite(summary.equity)&&summary.equity>0;
 const pct=summary?.allocation?.pct??p?.equitySizePct;
 const pctKnown=finite(pct)&&pct>=.025&&pct<=.1;
 const planned=equityKnown&&pctKnown?cents(summary.equity*pct):null;
 const low=equityKnown?cents(summary.equity*.025):null,high=equityKnown?cents(summary.equity*.1):null;
 const used=summary?.roundUsedShares,available=summary?.roundRemainingShares,maximum=summary?.maximumSharesPerRound;
 const quotaKnown=finite(used)&&used>=0&&finite(available)&&available>=0&&maximum===100&&close(used+available,100);
 const sizing=decisionCurrent?(d?.selected?.sizing??d?.sizing):null;
 const cashKnown=finite(account?.cash)&&account.cash>=0;
 const cashPass=cashKnown&&planned!==null&&account.cash+1e-8>=planned;
 const minShares=finite(m?.minSize)?Math.max(5,m.minSize):null;
 const quotaBlocked=quotaKnown&&minShares!==null&&available<minShares;
 const fullRequest=Boolean(sizing?.ok===true&&sizing.quote?.allowed===true&&finite(sizing.finalShares)&&
  minShares!==null&&sizing.finalShares>=minShares&&quotaKnown&&sizing.finalShares<=available+1e-8&&sizing.finalShares<=100&&
  close(sizing.equity,summary?.equity)&&close(sizing.pct,pct)&&close(sizing.maxSpend,planned));
 const gates=[];
 const gate=(key,title,status,detail)=>gates.push({key,title,status,detail});
 gate('window','最后 120 秒',!marketKnown?'unknown':late?'pass':remainingMs<=0?'fail':'wait',
  !marketKnown?'等待当前轮次及时间核对':remainingMs<=0?'上一盘口已结束，等待换入新盘口；期间停止新入场':late?`本轮剩余 ${remaining}`:`本轮剩余 ${remaining}，尚未进入入场窗口`);
 if(singleEntry)gate('entry','本轮首次开仓',!entryKnown?'unknown':entryConsumed?'fail':'pass',
  !entryKnown?'等待本轮开仓记录核对':entryConsumed?'本盘口已有成交，本轮不再买入；部分成交也不补单':'本盘口尚未成交；只允许开仓一次，零成交请求可重试');
 gate('opening','开盘 60s TWAP / 官方基准',openingKnown?'pass':'unknown',openingKnown?`本轮开盘基准 ${money(o.value)}`:
  o?.status==='conflict'?'开盘来源数值冲突，本轮暂停入场':'等待本轮当时可知的开盘 60s TWAP 或官方基准');
 const deviationPass=finite(deviationUsd)&&finite(thresholdUsd)&&Math.abs(deviationUsd)>=thresholdUsd;
 gate('twap','TWAP 与偏离门槛',!twapFresh||!openingKnown||!finite(thresholdUsd)?'unknown':deviationPass?'pass':'fail',
  !twapFresh?'参考价格须在 5 秒内更新':!openingKnown?'参考价格新鲜，等待本轮开盘基准':
   `参考价格在 5 秒内更新；绝对偏离 ${money(Math.abs(deviationUsd))}，须达到 ${money(thresholdUsd)}`);
 gate('books','双侧盘口新鲜',booksFresh?'pass':'unknown',booksFresh?`Up / Down 买卖两侧齐全，更新时间均在 ${amount(staleMs/1000,1)} 秒内`:'等待 Up / Down 双侧有效新鲜盘口');
 gate('prices','80–85¢ 与对侧 ≤20¢',!direction||!booksFresh?'unknown':pricesPass?'pass':'fail',
  !direction||!booksFresh?'等待可核实的方向和盘口':`${direction} 买价 ${amount(ask*100,1)}¢，对侧 ${amount(otherAsk*100,1)}¢`);
 const budgetStatus=!equityKnown||!pctKnown||!cashKnown||!quotaKnown?'unknown':!cashPass||quotaBlocked?'fail':!sizing?'unknown':fullRequest?'pass':'fail';
 let budgetDetail=!equityKnown?`仓位净值暂不可核实：${summary?.equityReason??'等待持仓估值或官方核验'}`:
  !pctKnown?'等待已核实的仓位比例':!cashKnown?'等待可用现金记录':!quotaKnown?'等待本轮份额记录':
  !cashPass?`计划含费预算 ${money(planned)} 超出可用现金 ${money(account.cash)}`:
  quotaBlocked||sizing?.reasonCode==='round_share_cap'?'本轮剩余份额容不下完整比例请求，跳过本次，不缩小预算':
  !sizing?'现金及净值可核实；等待策略评估完整请求':fullRequest?`完整请求 ${amount(sizing.finalShares,2)} 份，含费上限 ${money(planned)}，现金足够`:
   '完整请求未通过最低份额、100 份上限或比例预算检查，不缩小预算凑单';
 gate('budget','净值、现金与完整请求',budgetStatus,budgetDetail);
 const managed=s?.managedPosition,managedRay=Boolean(managed&&(managed.parameters?.exitRevision==='ray-official-settlement-v1'||
  managed.entryDecision?.version?.startsWith('ray-twap')));
 const hasOwned=Boolean((s?.rayOwnedPositions??[]).some(t=>(account?.holdings?.[t.tokenId]??0)>0)||
  (s?.settlementQueue?.count??0)>0||managedRay);
 const halt=account?.halted||state?.status==='halted';
 let phase='等待数据',reason=d?.reason??'等待当前行情与策略判断';
 if(d&&!decisionCurrent&&marketKnown)reason=`等待本轮最新判断；上次记录：${reason}`;
 if(halt){phase='异常暂停';reason=account?.halted||'执行已暂停，请核对当前运行记录';}
 else if(state?.paused||state?.running===false){phase='已暂停';reason=`${state.running===false?'工作流已停止':'已暂停新开仓'}；已有持仓按原规则继续核对。${reason}`;}
 else if(!clockReady||!marketKnown){phase='等待数据';reason=!clockReady?'等待时间核对及当前行情':reason;}
 else if(remainingMs<=0){phase='正在换轮';reason='上一盘口已结束，等待新盘口及双侧新鲜数据；期间停止新入场。';}
 else if(managed&&!managedRay){phase='条件未满足';reason=`手动仓位按原退出规则管理，暂不新增自动入场。${reason}`;}
 else if(hasOwned){phase='持仓至官方核验';reason=`已有持仓或待结算仓位继续按原规则管理。${reason}`;}
 else if(singleEntry&&entryConsumed){phase='本轮已开仓';reason='本盘口已有成交，本轮不再买入；清仓、切换方向或重启后仍保留此限制。';}
 else if(!late){phase=remainingMs>0?'等待最后120秒':'条件未满足';}
 else if(account?.active){phase='条件未满足';reason=`当前订单正在核对，等待结束后再判断。${reason}`;}
 else if(!decisionCurrent||gates.some(g=>g.status==='unknown')){phase='等待数据';}
 else if(state?.mode==='auto'&&gates.every(g=>g.status==='pass')&&d?.selected?.eligible===true&&
  [m.tokens.Up,m.tokens.Down].includes(d.selected.tokenId)){phase='本轮信号可入场';}
 else{phase='条件未满足';if(state?.mode!=='auto')reason=`${state?.mode==='manual'?'当前为手动模拟':'当前为只读观察'}，策略不会自动下单。${reason}`;}
 return {visible,phase,reason,round:marketKnown?`${clockText(m.start)}–${clockText(m.end)} · 香港时间`:'等待当前轮次',remaining,
  deviation:finite(deviationUsd)?`${deviationUsd>0?'+':deviationUsd<0?'−':''}${money(Math.abs(deviationUsd))}${direction?' · '+direction:''}`:'—',
  threshold:`当前准入门槛 ${money(thresholdUsd)}`,budget:planned===null?'等待可核实净值':`${money(planned)} · ${amount(pct*100,1)}%`,
  range:equityKnown?`允许预算 ${money(low)}–${money(high)}（净值 2.5%–10%，含费）。未成交部分取消，部分成交可低于计划；${state?.config?.riskPolicy==='equity-per-order-v1'&&state.config.maxExposure===null?'无固定总成本上限':'继续遵守当前账户资金限制'}。`:
   '预算范围为可核实净值的 2.5%–10%，含费；净值缺失时等待。',
  quota:singleEntry?`${entryKnown?entryConsumed?'已开仓 1 / 1':'未开仓 0 / 1':'开仓记录待核实'}${quotaKnown?` · 已成交 ${amount(used,2)} 份`:''}`:
   quotaKnown?`已用 ${amount(used,2)} / 100 · 余 ${amount(available,2)}`:'等待本轮份额记录',
  gates};
}

export function renderRayConsole(state,get=id=>document.getElementById(id)){
 const view=rayConsoleView(state),section=get('ray-console');
 if(section)section.hidden=!view.visible;
 for(const key of ['phase','reason','round','remaining','deviation','threshold','budget','range','quota']){
  const node=get('ray-console-'+key);if(node)node.textContent=view[key];
 }
 const gates=get('ray-console-gates');
 if(gates)gates.innerHTML=view.gates.map(g=>`<article class="ray-gate ray-console-gate" data-state="${g.status}" data-status="${g.status}"><div><h3>${esc(g.title)}</h3><span>${labels[g.status]}</span></div><p>${esc(g.detail)}</p></article>`).join('');
 return view;
}
