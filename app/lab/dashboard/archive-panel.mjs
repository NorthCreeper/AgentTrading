const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=v=>{if(!Number.isFinite(v))return '—';const i=v>=1024**3?3:v>=1024**2?2:v>=1024?1:0;
 return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(v/(1024**i))+' '+['B','KiB','MiB','GiB'][i];};
const storageLabel=f=>f.compressed?'透明压缩，可直接读取':f.status?.includes('gzip')||f.status?.includes('container')?'已有压缩文件，原位保留':
 f.status?.includes('pending')?'等待压缩或校验':f.status?.includes('small')?'小型资料原位保留':'原路径保留';
const canPreview=path=>/\.(jsonl?|md|txt|log|csv|mjs|ps1)$/i.test(path);
export function createArchivePanel(get=id=>document.getElementById(id)){
 let offset=0,total=0,groups=[],pending=false,loaded=false;const limit=30;
 const status=message=>{get('archive-status').textContent=message;};
 async function json(route){const r=await fetch(route,{cache:'no-store',signal:AbortSignal.timeout(20000)});const body=await r.json();if(!r.ok)throw Error(body.error??'档案暂时无法读取');return body;}
 async function list(){
  if(pending)return;pending=true;get('archive-search').disabled=true;
  try{
   const params=new URLSearchParams({groupId:get('archive-group').value,q:get('archive-query').value,offset:String(offset),limit:String(limit)});
   const data=await json('/api/research-archive/files?'+params);total=data.total??0;
   get('archive-files').innerHTML=(data.files??[]).map(f=>`<tr><td><strong>${esc(f.path.split(/[\\/]/).at(-1))}</strong><small>${esc(groups.find(g=>g.id===f.groupId)?.label??f.groupId)}</small><small class="archive-path">${esc(f.path)}</small></td><td>${bytes(f.logicalBytes)}</td><td>${bytes(f.allocatedAfterBytes)}<small>${storageLabel(f)}</small></td><td>${f.access==='blocked'?'<small>保留原路径，请在本机直接读取</small>':`${canPreview(f.path)?`<button type="button" class="quote-button" data-archive-preview="${esc(f.id)}">预览</button>`:''}<a download href="/api/research-archive/file?id=${encodeURIComponent(f.id)}">读取完整文件 ↗</a>`}</td></tr>`).join('')||'<tr><td colspan="4">此分类或搜索条件下没有文件；正在记录的数据另行保留。</td></tr>';
   get('archive-page').textContent=total?`${offset+1}–${Math.min(offset+limit,total)} / ${total} 个文件`:'0 个文件';
   get('archive-prev').disabled=offset===0;get('archive-next').disabled=offset+limit>=total;
  }catch(error){status('目录读取失败：'+error.message);}finally{pending=false;get('archive-search').disabled=false;}
 }
 async function load(force=false){
  if(force)loaded=false;
  if(loaded)return;status('正在读取分类与压缩记录…');
  try{
   const s=await json('/api/research-archive');groups=s.groups??[];
   get('archive-group').innerHTML='<option value="">全部分类</option>'+groups.map(g=>`<option value="${esc(g.id)}">${esc(g.label)}（${g.fileCount??0}）</option>`).join('');
   const before=groups.reduce((a,g)=>a+(g.allocatedBeforeBytes??0),0),after=groups.reduce((a,g)=>a+(g.allocatedAfterBytes??0),0);
   get('archive-totals').innerHTML=`<article><span>分类文件</span><strong>${groups.reduce((a,g)=>a+(g.fileCount??0),0).toLocaleString('zh-CN')}</strong></article><article><span>处理前占用</span><strong>${bytes(before)}</strong></article><article><span>当前占用</span><strong>${bytes(after)}</strong></article><article><span>已释放空间</span><strong>${bytes(Math.max(0,before-after))}</strong></article>`;
   status(s.status==='waiting'?'分类目录正在准备；原路径仍可读取。':s.status==='error'?`分类目录暂不可读：${s.error??'等待核对'}`:`分类与压缩记录：${s.createdAt?new Date(s.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false})+' HKT':'时间待核实'}。${s.storage?.status==='complete'?'本批处理已完成。':'处理状态以目录记录为准，可刷新查看进展。'}原路径保持，可直接读取；预览只展示开头，完整文件可单独读取。`);
   loaded=Boolean(groups.length);await list();
  }catch(error){status('档案目录暂不可用：'+error.message+'。原研究路径仍保留。');}
 }
 get('research-archive').addEventListener('toggle',()=>{if(get('research-archive').open)void load();});
 get('archive-search').onclick=()=>{offset=0;void list();};get('archive-group').onchange=()=>{offset=0;void list();};
 get('archive-refresh').onclick=()=>{offset=0;void load(true);};
 get('archive-query').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();offset=0;void list();}};
 get('archive-prev').onclick=()=>{offset=Math.max(0,offset-limit);void list();};get('archive-next').onclick=()=>{if(offset+limit<total){offset+=limit;void list();}};
 get('archive-files').onclick=async e=>{
  const id=e.target.closest('[data-archive-preview]')?.dataset.archivePreview;if(!id)return;
  try{const data=await json('/api/research-archive/preview?id='+encodeURIComponent(id));get('archive-preview-title').textContent=data.path?.split(/[\\/]/).at(-1)??'档案预览';get('archive-preview-content').textContent=data.text??'';get('archive-preview-note').textContent=data.truncated?'仅预览文件开头，完整数据请使用“读取完整文件”。':'本文件已完整显示。';get('archive-preview').showModal();}catch(error){status('预览失败：'+error.message);}
 };
 return {load,open(){get('research-archive').open=true;void load();}};
}
