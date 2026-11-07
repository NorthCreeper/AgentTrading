import {formatRecordedTime} from './market-time.mjs';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,d=4)=>Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
const money=v=>Number.isFinite(v)?`${v<0?'−':''}$${Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4})}`:'—';
const tone=v=>Number.isFinite(v)?v>0?'positive':v<0?'negative':'':'';
const originLabel=v=>({'automatic':'自动策略','manual-one-tap':'手动 One-Tap','manual-other':'手动普通订单','unknown':'来源未记录'}[v]??v??'来源未记录');
const timeBasisLabel=v=>({'journal-report-observed':'本地成交回报观测','unknown-position-cumulative-fallback':'仅有持仓累计成交，时间未知','unknown-state-cumulative-fallback':'仅有订单累计成交，时间未知'}[v]??'成交观测时间待核实');
const statusLabel=v=>({'closed':'已平仓','open':'持有中','pending':'待官方结算','unknown':'资料待核实','filled':'已成交','deposit':'模拟充值'}[v]??v??'资料待核实');
const textCell=(v,sub='')=>`<td><span>${esc(v)}</span>${sub?`<small>${esc(sub)}</small>`:''}</td>`;
const amountCell=(v,sub='',color=false)=>`<td class="ledger-number ${color?tone(v):''}"><span>${money(v)}</span>${sub?`<small>${esc(sub)}</small>`:''}</td>`;
const date=v=>Number.isFinite(v)&&v>0?formatRecordedTime(v):'时间未记录';
const marketCell=r=>textCell(r.marketWindow?.displayHkt??'盘口时间未核实',r.slug??'盘口标识未记录');
const headers={positions:['开仓 / 平仓记录 · HKT','对应盘口 · HKT','方向 / 来源','状态 / 份额','买入 / 卖出均价','含费买入 / 收回','费用','已实现净盈亏',''],
 fills:['成交观测时间 · HKT','对应盘口 · HKT','买卖 / 来源','份额 / 均价','成交名义金额','费用','现金变动','订单 / 归属',''],
 cashFlows:['记录时间 · HKT','资金类型','金额','会话 / 请求编号','']};

export function ledgerRowHtml(r,view='positions',index=0){
 const detail=`<td><button type="button" class="quote-button ledger-detail-button" data-ledger-detail="${index}" aria-label="查看${esc(r.slug??r.id)}的账本详情">明细 ↗</button></td>`;
 if(view==='cashFlows')return `<tr>${textCell(date(r.time))}${textCell(r.type==='deposit'?'模拟充值':r.type??'资金流水')}${amountCell(r.amount,'不计入交易盈亏')}${textCell(r.sessionId,r.requestId??r.id)}${detail}</tr>`;
 const direction=`<span class="ledger-outcome ${r.outcome==='Up'?'up':r.outcome==='Down'?'down':''}">${esc(r.outcome??'方向未记录')}</span>`;
 if(view==='fills')return `<tr>${textCell(date(r.time),timeBasisLabel(r.timeBasis))}${marketCell(r)}<td>${direction}<span>${r.side==='buy'?'买入':r.side==='sell'?'卖出':'买卖未记录'}</span><small>${esc(originLabel(r.origin))}</small></td>${textCell(num(r.filled)+' 份',Number.isFinite(r.price)?num(r.price*100,3)+' ¢':'均价未记录')}${amountCell(r.notional)}${amountCell(r.fees)}${amountCell(r.cashChange,'',true)}${textCell(r.orderId??'订单未记录',r.tradeId&&!r.tradeId.startsWith('order-only:')?'已关联持仓':'持仓归属待核实')}${detail}</tr>`;
 return `<tr>${textCell(date(r.openedAt),r.closedAt?'平仓 '+date(r.closedAt):'尚未平仓')}${marketCell(r)}<td>${direction}<small>${esc(originLabel(r.origin))}</small></td>${textCell(statusLabel(r.status),'买入 '+num(r.bought)+' / 剩余 '+num(r.remaining)+' 份')}${textCell(Number.isFinite(r.entryAverage)?num(r.entryAverage*100,3)+' ¢':'—',Number.isFinite(r.exitAverage)?'卖出 '+num(r.exitAverage*100,3)+' ¢':r.closeMethod==='verified-paper-settlement'?'官方兑付结算':'卖出均价 —')}${amountCell(r.buyCost,'净收回 '+money(r.proceeds))}${amountCell(r.fees)}${amountCell(r.net,r.status==='closed'?'已扣交易费用':'未计已实现盈亏',true)}${detail}</tr>`;
}

function detailsHtml(r,view){
 const field=(label,value)=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
 if(view==='cashFlows')return `<div class="ledger-detail-banner"><span class="pill">模拟资金流水</span><span>${money(r.amount)}</span></div><dl class="ledger-detail-grid">${field('类型',r.type==='deposit'?'模拟充值':r.type??'未记录')}${field('资金记录时间',date(r.time))}${field('会话编号',r.sessionId??'未记录')}${field('请求编号',r.requestId??r.id)}</dl><p class="footnote">此金额计入模拟资金，不计作交易盈利。</p><details class="ledger-raw"><summary>完整原始资金记录</summary><pre>${esc(JSON.stringify(r,null,2))}</pre></details>`;
 const lots=Array.isArray(r.entryLots)?r.entryLots:[];
 const lotBudget=lots.length&&lots.every(l=>Number.isFinite(l.maxSpend))?lots.reduce((sum,l)=>sum+l.maxSpend,0):null;
 const headline=view==='fills'?`本次成交现金变动 ${money(r.cashChange)}`:r.net===null||r.net===undefined?'净盈亏待核实':money(r.net);
 const reports=Array.isArray(r.orderReports)?r.orderReports:r.report?[r.report]:[];
 const levels=view==='fills'?[]:reports.flatMap(o=>(o.fills??[]).map(f=>({orderId:o.id,side:o.side,...f}))); 
 return `<div class="ledger-detail-banner"><span class="pill">本地模拟记录</span><span>${esc(statusLabel(r.status))}</span><span class="${tone(r.net)}">${headline}</span></div>
 <dl class="ledger-detail-grid">${field('对应盘口',r.marketWindow?.displayHkt??'未核实')}${field('盘口标识',r.slug??'未记录')}${field('入场来源',originLabel(r.origin))}${field('方向',r.outcome??'未记录')}${field('开仓记录时间',date(r.openedAt))}${field('平仓 / 归账时间',date(r.closedAt))}${field('买入名义金额',money(r.buyNotional))}${field('卖出名义金额',money(r.sellNotional))}${field('交易费用',money(r.fees))}${field('官方兑付收入',money(r.payout))}${field('已实现净盈亏',money(r.net))}${field('现金变动',money(r.cashChange))}${field('会话编号',r.sessionId??'未记录')}${field('实验编号',r.experimentId??'未记录')}${field('策略版本',r.protocolVersion??'历史版本未记录')}${field('退出 / 结算依据',r.exitReason??'未记录')}${field('开仓含费预算上限合计',money(r.maxSpend??r.riskBudget?.maxSpend??lotBudget))}${field('入场信号时间',date(r.signalAt))}${field('官方结算方向',r.settlement?.winner??'未记录')}${field('官方结果观测时间',date(r.settlement?.observedAt))}${field('兑付归账时间',date(r.settlement?.creditedAt))}${field('记账依据',({'verified-position-order-cashflows':'逐仓订单现金流已复算','legacy-recorded-result':'旧版原记录净额，现金流证据不足','incomplete-or-open':'持仓未完成或资料不完整'}[r.accountingSource]??'原始资金流水'))}</dl>
 <p class="footnote">费用只扣一次；官方兑付与卖出分开记录。时间是本地模拟记录时间，不代表交易所撮合或链上到账时刻。</p>
 ${(r.integrityWarnings??[]).length?`<div class="ledger-integrity warning">${r.integrityWarnings.map(x=>esc(typeof x==='string'?x:x.message??JSON.stringify(x))).join('<br>')}</div>`:''}
 ${view==='fills'?`<h3>本次增量成交</h3><dl class="ledger-detail-grid">${field('成交观测时间',date(r.time))}${field('时间依据',timeBasisLabel(r.timeBasis))}${field('成交数量',num(r.filled)+' 份')}${field('成交均价',Number.isFinite(r.price)?num(r.price*100,3)+' ¢':'未记录')}${field('名义金额',money(r.notional))}${field('费用',money(r.fees))}</dl><p class="footnote">完整原始记录中的 report 与 fills 可能是该订单的累计汇报；上方金额为本次新增成交，不能重复相加。</p>`:''}
 ${levels.length?`<h3>成交价格与数量</h3><div class="table-wrap"><table><thead><tr><th>订单</th><th>买卖</th><th>价格</th><th>份额</th><th>名义金额</th><th>费用</th></tr></thead><tbody>${levels.map(f=>`<tr>${textCell(f.orderId)}${textCell(f.side==='buy'?'买入':'卖出')}${textCell(num(f.price*100,3)+' ¢')}${textCell(num(f.size))}${amountCell(f.notional)}${amountCell(f.fee)}</tr>`).join('')}</tbody></table></div>`:''}
 ${lots.length?`<h3>开仓批次</h3><div class="table-wrap"><table><thead><tr><th>批次</th><th>信号记录时间 · HKT</th><th>含费预算上限</th><th>实际成交份额</th><th>状态</th></tr></thead><tbody>${lots.map((l,i)=>`<tr>${textCell(String(i+1))}${textCell(date(l.signalAt))}${amountCell(l.maxSpend)}${textCell(num(l.filled))}${textCell(l.status??'未记录')}</tr>`).join('')}</tbody></table></div>`:''}
 <details class="ledger-raw"><summary>完整原始记录与开仓批次</summary><pre>${esc(JSON.stringify(r,null,2))}</pre></details>`;
}

export function createLedgerPanel(get=id=>document.getElementById(id)){
 let view='positions',offset=0,total=0,rows=[],pending=false,active=false,lastRefresh=0,rerun=false;const limit=25;
 const filters=['scope','status','outcome','origin','session','experiment'];
 const params=()=>new URLSearchParams({scope:get('ledger-scope').value,view,status:get('ledger-status-filter').value,outcome:get('ledger-outcome-filter').value,
  origin:get('ledger-origin-filter').value,sessionId:get('ledger-session-filter').value,experimentId:get('ledger-experiment-filter').value,q:get('ledger-query').value.trim()});
 const exports=()=>{for(const format of ['csv','json'])get('ledger-export-'+format).href='/api/trade-ledger/export?'+params()+'&format='+format;};
 function updateSummary(s){
  get('ledger-net-label').textContent=view==='cashFlows'?'模拟充值合计 · 不计入盈亏':'已平仓净盈亏 · 已扣费用';
  get('ledger-net').textContent=money(view==='cashFlows'?s.funding:s.netKnownClosed===0&&s.closed>0?null:s.net);get('ledger-net').className=view==='cashFlows'?'':tone(s.net);
  get('ledger-closed').textContent=view==='cashFlows'?num(total,0)+' 条资金流水':num(s.closed,0)+' 笔已完成'+(s.recordedOnlyClosed?' · 含 '+s.recordedOnlyClosed+' 笔旧账净额':'');
  const known=s.netKnownClosed??s.closed;
  get('ledger-rate').textContent=known?num(100*s.wins/known,2)+'%':'—';
  get('ledger-rate-note').textContent=`${num(s.wins,0)} 盈 / ${num(s.losses,0)} 亏 / ${num(s.breakeven,0)} 平${s.netUnknownClosed?' · '+s.netUnknownClosed+' 笔未知未计入':''}`;
  get('ledger-fees').textContent=view==='cashFlows'?'—':money(s.fees);
  get('ledger-open').textContent=`${num(s.open,0)} / ${num(s.pending,0)}`;
  get('ledger-unknown').textContent=`${num(s.unknown,0)} 条资料待核实`;
  get('ledger-count').textContent=num(s.fillCount,0)+' 条成交记录';
 }
 function updateOptions(data){
  for(const [id,key] of [['ledger-session-filter','sessions'],['ledger-experiment-filter','experiments']]){
   const node=get(id),old=node.value,items=data.options?.[key]??[];
   node.innerHTML=`<option value="">全部${key==='sessions'?'会话':'实验'}</option>`+items.map(item=>{
    const value=typeof item==='string'?item:item.id??item.sessionId??item.experimentId;
    const label=typeof item==='string'?item:item.label??item.name??value;
    return `<option value="${esc(value)}">${esc(label)}</option>`;}).join('');
   if([...node.options].some(x=>x.value===old))node.value=old;
  }
 }
 async function load(){
  if(pending){rerun=true;return;}pending=true;lastRefresh=Date.now();
  get('ledger-refresh').disabled=true;get('ledger-table').setAttribute('aria-busy','true');
  const query=params().toString(),requestedView=view,requestedOffset=offset;
  exports();get('ledger-load-status').textContent='正在核对历史账本…';
  try{
   const response=await fetch('/api/trade-ledger?'+query+`&offset=${offset}&limit=${limit}`,{cache:'no-store',signal:AbortSignal.timeout(60000)});
   const data=await response.json();if(!response.ok)throw Error(data.error??'账本暂时无法读取');
   if(query!==params().toString()||requestedView!==view||requestedOffset!==offset){rerun=true;return;}
   rows=data.rows??[];total=data.total??0;updateSummary(data.summary??{});updateOptions(data);
   get('ledger-head').innerHTML='<tr>'+headers[view].map(x=>`<th>${esc(x)}</th>`).join('')+'</tr>';
   get('ledger-rows').innerHTML=rows.map((r,i)=>ledgerRowHtml(r,view,i)).join('')||`<tr><td colspan="${headers[view].length}" class="empty">此范围与筛选条件下没有记录。</td></tr>`;
   get('ledger-page').textContent=total?`${offset+1}–${Math.min(offset+limit,total)} / ${total.toLocaleString('zh-CN')} 条`:'0 条记录';
   get('ledger-prev').disabled=offset===0;get('ledger-next').disabled=offset+limit>=total;
   get('ledger-load-status').textContent=`更新于 ${date(data.generatedAt)} · ${view==='fills'?'费用统计筛选成交；盈亏与胜率统计其关联的完整持仓。':'仅统计当前筛选范围，汇总包含全部分页。'}`;
   const warnings=data.integrity?.warnings??[];
   get('ledger-integrity').hidden=!warnings.length;
   get('ledger-integrity').innerHTML=warnings.length?`<strong>全历史来源完整性说明</strong><span>${warnings.slice(0,6).map(w=>esc(typeof w==='string'?w:w.message??JSON.stringify(w))).join('；')}</span>`:'';
  }catch(error){
   get('ledger-load-status').textContent='账本读取未完成：'+(error.name==='TimeoutError'?'历史记录较多，请稍后刷新':error.message)+'。已显示内容可能不是最新。';
  }finally{
   pending=false;get('ledger-refresh').disabled=false;get('ledger-table').setAttribute('aria-busy','false');
   if(rerun){rerun=false;void load();}
  }
 }
 function change(){offset=0;exports();void load();}
 for(const key of filters){const node=get(key==='scope'?'ledger-scope':`ledger-${key}-filter`);node.addEventListener('change',change);}
 get('ledger-search').addEventListener('submit',e=>{e.preventDefault();change();});
 get('ledger-refresh').addEventListener('click',()=>void load());
 get('ledger-clear').addEventListener('click',()=>{get('ledger-query').value='';get('ledger-scope').value=view==='cashFlows'?'current-session':'current-strategy';for(const key of filters.filter(x=>x!=='scope'))get(`ledger-${key}-filter`).value='';change();});
 get('ledger-prev').addEventListener('click',()=>{offset=Math.max(0,offset-limit);void load();});
 get('ledger-next').addEventListener('click',()=>{if(offset+limit<total){offset+=limit;void load();}});
 const tabs=[...get('ledger').querySelectorAll('[data-ledger-view]')];
 tabs.forEach((button,index)=>{
  button.addEventListener('click',()=>{view=button.dataset.ledgerView;if(view==='cashFlows'){if(get('ledger-scope').value==='current-strategy')get('ledger-scope').value='current-session';for(const key of ['status','outcome','origin'])get(`ledger-${key}-filter`).value='';}for(const key of ['status','outcome','origin'])get(`ledger-${key}-filter`).disabled=view==='cashFlows';for(const b of tabs){b.setAttribute('aria-selected',String(b===button));b.tabIndex=b===button?0:-1;}get('ledger-table').setAttribute('aria-labelledby',button.id);change();});
  button.addEventListener('keydown',event=>{const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;if(next!==null){event.preventDefault();tabs[next].focus();tabs[next].click();}});
 });
 get('ledger-rows').addEventListener('click',event=>{const button=event.target.closest('[data-ledger-detail]');if(!button)return;const r=rows[Number(button.dataset.ledgerDetail)];if(!r)return;get('ledger-detail-title').textContent=view==='cashFlows'?'资金流水详情':`${r.outcome??''} · ${r.slug??'成交详情'}`;get('ledger-detail-content').innerHTML=detailsHtml(r,view);get('ledger-detail').showModal();});
 get('ledger-detail-close').addEventListener('click',()=>get('ledger-detail').close());
 const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{active=entries.some(e=>e.isIntersecting)||location.hash==='#ledger';if(active&&Date.now()-lastRefresh>=15000)void load();},{rootMargin:'150px'});
 observer?.observe(get('ledger'));
 const timer=setInterval(()=>{if(active&&!document.hidden&&Date.now()-lastRefresh>=15000)void load();},15000);
 return {open(){active=true;if(Date.now()-lastRefresh>5000)void load();},close(){active=false;},stop(){clearInterval(timer);observer?.disconnect();},refresh:load};
}
