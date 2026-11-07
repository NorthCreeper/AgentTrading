import { axisTimes, chartRows, chartWindow, e18ToPrice, segments, GAP_MS, canAnimate, revealRows, stableRange } from './chart-model.mjs';

const time = t => new Date(t).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false });
const dollars = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const plots = new Map();
const animations = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
// Match SVG coordinates to CSS pixels so text and endpoints never stretch with the panel.
const resizeObserver = new ResizeObserver(entries => {
  if (document.hidden) return;
  for (const {target} of entries) {
    const model = animations.get(target.id);
    if (!model) continue;
    const t = model.display;
    paint(target.id, t.rows, t.window, t.series, t.options, model.target.rows);
  }
});
for (const id of ['chart','price-chart']) resizeObserver.observe(document.getElementById(id));

// Preserve the visible SVG and tooltip nodes. Parsing happens offscreen; only changed
// attributes/text and added/removed segments are applied to the mounted chart.
function patchMarkup(node, markup) {
  const template=document.createElement('template'); template.innerHTML=markup;
  function sync(parent, incoming) {
    const wanted=[...incoming.childNodes];
    for (let i=0;i<wanted.length;i++) {
      const next=wanted[i]; let current=parent.childNodes[i];
      if (!current || current.nodeType!==next.nodeType || current.nodeName!==next.nodeName) {
        const replacement=next.cloneNode(true);
        if (current) parent.replaceChild(replacement,current); else parent.appendChild(replacement);
        continue;
      }
      if (next.nodeType===Node.TEXT_NODE) {
        if (current.nodeValue!==next.nodeValue) current.nodeValue=next.nodeValue;
      } else if (next.nodeType===Node.ELEMENT_NODE) {
        for (const attr of [...current.attributes]) if(!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of next.attributes) if(current.getAttribute(attr.name)!==attr.value) current.setAttribute(attr.name,attr.value);
        sync(current,next);
      }
    }
    while(parent.childNodes.length>wanted.length) parent.lastChild.remove();
  }
  sync(node,template.content);
}

function gapsFor(rows, window, keys) {
  const gaps=[]; let previous=window.start;
  for(const row of rows.filter(r=>keys.some(key=>Number.isFinite(r[key])))){if(row.time-previous>GAP_MS) gaps.push([previous,row.time]);previous=row.time;}
  const end=Math.max(window.start,Math.min(window.observedUntil,window.end));
  if(end-previous>GAP_MS) gaps.push([previous,end]);
  return gaps;
}

function draw(id, rows, window, series, options={}) {
  const old=animations.get(id), keys=series.map(s=>s.key);
  const sameView=old && old.target.options.context===options.context && old.target.window.slug===window.slug &&
    old.target.window.end-old.target.window.start===window.end-window.start &&
    Math.abs(window.end-old.target.window.end)<=GAP_MS;
  if(options.area) options={...options,...stableRange(sameView?old.target.options:null,options.low,options.high)};
  else options={low:0,high:1,...options};
  const target={rows,window,series,options};
  const signature=JSON.stringify([rows.map(r=>[r.time,r.slug,...keys.map(key=>r[key])]),window.start,window.end,
    options.low,options.high,options.reference,options.context,options.running]);
  if(old && old.signature===signature) {
    old.target=target;
    if(!document.hidden && !old.frame && Math.floor(window.observedUntil/1000)!==old.lastPaintSecond) {
      old.display=target; old.lastPaintSecond=Math.floor(window.observedUntil/1000);
      paint(id,rows,window,series,options);
    }
    return gapsFor(rows,window,keys);
  }
  if(old?.frame) cancelAnimationFrame(old.frame);
  const animate=sameView && options.running && !reducedMotion.matches && !document.hidden &&
    canAnimate(old.display.rows,rows,keys,!options.area);
  const model={target,signature,display:animate?old.display:target,frame:0,lastPaintSecond:Math.floor(window.observedUntil/1000)};
  animations.set(id,model);
  if(document.hidden) return gapsFor(rows,window,keys);
  if(!animate){paint(id,rows,window,series,options);return gapsFor(rows,window,keys);}
  const from=old.display, start=performance.now();
  const duration=Math.max(180,Math.min(900,(rows.at(-1).time-from.rows.at(-1).time)*.85||650));
  const tick=now=>{
    const p=Math.min(1,(now-start)/duration), eased=p*p*(3-2*p), target=model.target;
    const lerp=(a,b)=>a+(b-a)*eased;
    const animatedWindow={...target.window,start:lerp(from.window.start,target.window.start),end:lerp(from.window.end,target.window.end)};
    const animatedOptions={...target.options,low:lerp(from.options.low,target.options.low),high:lerp(from.options.high,target.options.high)};
    const animatedRows=revealRows(from.rows,target.rows,eased,keys,!options.area);
    model.display=p===1?target:{rows:animatedRows,window:animatedWindow,series,options:animatedOptions};
    paint(id,model.display.rows,model.display.window,series,model.display.options,target.rows);
    model.frame=p<1?requestAnimationFrame(tick):0;
  };
  model.frame=requestAnimationFrame(tick);
  return gapsFor(rows,window,keys);
}

function finishAnimations() {
  for(const [id,model] of animations) {
    if(model.frame) cancelAnimationFrame(model.frame);
    model.frame=0; model.display=model.target;
    const t=model.target; if(!document.hidden) paint(id,t.rows,t.window,t.series,t.options);
  }
}
document.addEventListener('visibilitychange',finishAnimations);
reducedMotion.addEventListener('change',finishAnimations);

function paint(id, rows, window, series, { low = 0, high = 1, format, reference = null, area = false } = {}, sourceRows=rows) {
  const node = document.getElementById(id), width = node.clientWidth, height = node.clientHeight;
  if (!width || !height) return [];
  const labelSize = Math.max(12, parseFloat(getComputedStyle(document.documentElement).fontSize) * .75);
  const left = 8, right = Math.ceil(labelSize * (area ? 8.3 : 4.5)), top = labelSize + 8, bottom = labelSize + 22;
  const x = t => left + (t - window.start) / Math.max(1, window.end - window.start) * (width - left - right);
  const y = p => top + (high - p) / Math.max(0.000001, high - low) * (height - top - bottom);
  const plotRight = width - right, plotBottom = height - bottom;
  const gaps = gapsFor(rows,window,series.map(s=>s.key));
  let svg = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${series[0].color}" stop-opacity=".14"/><stop offset="1" stop-color="${series[0].color}" stop-opacity="0"/></linearGradient></defs>`;
  for (let i = 0; i <= 4; i++) {
    const value = low + (high - low) * i/4;
    svg += `<line x1="${left}" x2="${plotRight}" y1="${y(value)}" y2="${y(value)}" class="chart-grid"/><text x="${plotRight+12}" y="${y(value)+4}" class="axis-label">${escape(format(value))}</text>`;
  }
  for (const [a,b] of gaps) svg += `<rect x="${x(a)}" y="${top}" width="${Math.max(0,x(b)-x(a))}" height="${plotBottom-top}" fill="#8fa1b8" fill-opacity=".065"/>`;
  const boundaries = rows.filter((r,i) => i > 0 && r.slug && r.slug !== rows[i-1].slug);
  for (const row of boundaries) svg += `<line x1="${x(row.time)}" x2="${x(row.time)}" y1="${top}" y2="${plotBottom}" stroke="#77869a" stroke-opacity=".5" stroke-dasharray="2 6"/>`;
  if (reference !== null) svg += `<line x1="${left}" x2="${plotRight}" y1="${y(reference)}" y2="${y(reference)}" stroke="#a8b6c8" stroke-dasharray="5 5"/><text x="${left+8}" y="${Math.max(top+labelSize,y(reference)-8)}" class="baseline-label">${width<500?'开盘基准':'开盘基准 · '+escape(dollars(reference))}</text>`;
  for (const s of series) {
    for (const group of segments(rows,s.key,{splitRounds: !area})) {
      const path = group.map((r,i) => `${i?'L':'M'}${x(r.time).toFixed(2)},${y(r[s.key]).toFixed(2)}`).join(' ');
      if (area && group.length > 1) svg += `<path d="${path} L${x(group.at(-1).time)},${plotBottom} L${x(group[0].time)},${plotBottom} Z" fill="url(#${id}-fill)"/>`;
      svg += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      if (group.length === 1) svg += `<circle cx="${x(group[0].time)}" cy="${y(group[0][s.key])}" r="2.5" fill="${s.color}"/>`;
    }
    const last = rows.findLast(r => Number.isFinite(r[s.key]));
    if (last) {
      svg += `<circle cx="${x(last.time)}" cy="${y(last[s.key])}" r="4" fill="${s.color}"/>`;
      if (area && window.observedUntil-last.time <= GAP_MS) svg += `<circle cx="${x(last.time)}" cy="${y(last[s.key])}" r="9" fill="${s.color}" fill-opacity=".15"/>`;
    }
  }
  const tickCount = Math.max(2,Math.min(5,Math.floor((plotRight-left)/(labelSize*7.5))+1));
  axisTimes(window,tickCount).forEach((t,i) => svg += `<text x="${x(t)}" y="${height-6}" text-anchor="${i===0?'start':i===tickCount-1?'end':'middle'}" class="axis-label">${time(t)}</text>`);
  svg += `<line class="chart-crosshair" y1="${top}" y2="${plotBottom}" stroke="#a8b6c8" stroke-dasharray="3 4" visibility="hidden"/></svg><div class="chart-tooltip" hidden></div>`;
  patchMarkup(node,svg);
  const old = plots.get(id);
  const plot = { rows,window,series,format,node,width,left,plotRight,ratio:old?.ratio };
  plots.set(id,plot);
  const show = ratio => {
    plot.ratio = ratio;
    const xx = ratio*width, at = window.start + (xx-left)/(plotRight-left)*(window.end-window.start);
    const line = node.querySelector('.chart-crosshair'), tooltip = node.querySelector('.chart-tooltip');
    if (xx < left || xx > plotRight) { line.setAttribute('visibility','hidden'); tooltip.hidden=true; return; }
    line.setAttribute('x1',xx); line.setAttribute('x2',xx); line.setAttribute('visibility','visible');
    const row = sourceRows.reduce((best,r) => !best || Math.abs(r.time-at)<Math.abs(best.time-at) ? r : best,null);
    tooltip.textContent = at > window.observedUntil ? `${time(at)} · 尚未到达` : !row || Math.abs(row.time-at)>GAP_MS ? `${time(at)} · 无采样记录` :
      `${time(row.time)} · ${series.map(s=>`${s.label} ${Number.isFinite(row[s.key])?format(row[s.key]):'暂无报价'}`).join(' · ')}`;
    tooltip.hidden=false;
    tooltip.style.left=`${Math.max(0,Math.min(width-tooltip.offsetWidth-8,xx+12))}px`;
  };
  node.onpointermove = event => { const rect=node.getBoundingClientRect(); show((event.clientX-rect.left)/rect.width); };
  node.onpointerleave = () => { plot.ratio=null; node.querySelector('.chart-crosshair').setAttribute('visibility','hidden'); node.querySelector('.chart-tooltip').hidden=true; };
  if (plot.ratio != null) show(plot.ratio);
  return gaps;
}

export function displayedOpeningReference(state,selection) {
  if(selection!=='round')return {value:null,note:'基准线仅在当前轮次显示'};
  const m=state.frame?.market,o=state.frame?.rayOpening;
  if(state.strategy?.config.model==='ray-twap-band'){
    const identity=m&&o&&o.slug===m.slug&&o.conditionId===m.conditionId;
    const timeKnown=Number.isFinite(o?.knownAt)&&o.knownAt<=state.now;
    const validSource=o?.windowSeconds===60&&o.referenceAt===m?.start&&o.referenceAt<=o.knownAt&&
      (o.source==='gamma-price-to-beat'||o.source==='rtds-twap-sixty-opening'&&e18ToPrice(o.valueE18)===o.value)&&
      o.status!=='conflict'&&!(o.conflicts?.length);
    return identity&&timeKnown&&validSource&&Number.isFinite(o.value)&&o.value>0
      ? {value:o.value,note:o.source==='gamma-price-to-beat'?'Ray 开盘参考 · 盘口 Price to Beat':'Ray 开盘参考 · Chainlink 开盘 60s TWAP'}
      : {value:null,note:o?.status==='conflict'?'开盘来源冲突，暂停本轮入场':'等待准确开盘 60s TWAP 或官方 Price to Beat'};
  }
  const value=state.priceReference?.time===m?.start?e18ToPrice(state.priceReference?.valueE18):null;
  return {value,note:value===null?'未采集到准确开盘时刻，基准暂缺':state.priceReference.source};
}

export function renderCharts(state, selection) {
  const window = chartWindow(state,selection), bookRows = chartRows(state.history,window);
  const motion={running:state.running,context:`${state.sessionId}:${selection}`};
  const gaps = draw('chart',bookRows,window,[{key:'up',color:'#52dfb1',label:'Up'},{key:'down',color:'#91b3ff',label:'Down'}],{...motion,format:p=>`${(p*100).toFixed(0)}¢`});
  document.getElementById('chart-range').textContent = selection==='round'?'当前 5 分钟盘口':'最近 10 分钟 · 换轮处分段';
  const validCount=bookRows.filter(r=>Number.isFinite(r.up)||Number.isFinite(r.down)).length;
  document.getElementById('chart-note').textContent = `${state.running?'':'已停止 · '}已记录 ${validCount} 个有效行情点${bookRows.length>validCount?` · ${bookRows.length-validCount} 次采样报价过期或缺失`:''}${gaps.length?' · 灰色区域无有效报价':''}。换轮及数据中断处分段显示。`;
  // BTC is a continuous asset: do not split its price series simply because the contract rolls.
  const prices = chartRows((state.priceHistory??[]).map(row=>({...row,slug:state.frame?.market.slug,price:e18ToPrice(row.valueE18)})),window);
  const displayedReference=displayedOpeningReference(state,selection),reference=displayedReference.value;
  const values = prices.map(r=>r.price).filter(Number.isFinite); if(reference!==null) values.push(reference);
  const minimum = values.length?Math.min(...values):0, maximum=values.length?Math.max(...values):1;
  const pad=Math.max(5,(maximum-minimum)*.18);
  if (prices.length) draw('price-chart',prices,window,[{key:'price',color:'#f5ae57',label:'BTC'}],{...motion,low:minimum-pad,high:maximum+pad,format:dollars,reference,area:true});
  else {
    const node=document.getElementById('price-chart');
    node.innerHTML='<div class="empty">本时间范围内尚无 BTC 价格采样<br>启动行情后自动绘制</div>';
    node.onpointermove=null; node.onpointerleave=null; plots.delete('price-chart');
    const animation=animations.get('price-chart'); if(animation?.frame) cancelAnimationFrame(animation.frame);
    animations.delete('price-chart');
  }
  const latest=prices.findLast(row=>Number.isFinite(row.price));
  document.getElementById('price-current').textContent=latest?dollars(latest.price):'—';
  document.getElementById('price-beat').textContent=reference===null?'—':dollars(reference);
  const delta=latest&&reference!==null?latest.price-reference:null;
  const change=document.getElementById('price-change');
  change.textContent=delta===null?'':`${delta>=0?'▲ +':'▼ −'}${dollars(Math.abs(delta))}`; change.className=delta===null?'muted':delta>=0?'up':'negative';
  document.getElementById('price-reference-note').textContent=displayedReference.note;
  document.getElementById('price-note').textContent = latest ? `Chainlink BTC/USD · 60s TWAP · ${time(latest.time)}${!state.running?' · 已停止':state.now-latest.time>GAP_MS?' · 数据过期':' · 实时'}。灰色区域表示未采样；悬停查看价格。` : '等待 Chainlink 价格采样。此图独立接收价格流，订单簿短暂中断不会停止价格记录。';
}
