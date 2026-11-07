import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {managedCashflows} from '../../dashboard/managed-position-accounting.mjs';
import {candidates} from './suite.mjs';
const money=x=>Number.isFinite(x)?x.toFixed(4):'未知',percent=x=>Number.isFinite(x)?(x*100).toFixed(2)+'%':'—';
const sha=b=>createHash('sha256').update(b).digest('hex');
function entryKey(t){return JSON.stringify([t.market.conditionId,t.tokenId,t.signalAt,t.openedAt,t.size,t.cost,
 Object.values(t.orderReports).filter(r=>r.side==='buy').map(r=>[r.createdAt,r.price,r.filled,r.notional,r.fees])]);}
export function reconcileAccount(a){
 let cash=100,fees=0,net=0,wins=0,gross=0;const owned=[a.position,...a.pendingSettlements].filter(Boolean),ids=new Set(),reports=new Set();
 for(const t of [...a.closedTrades,...owned]){
  if(ids.has(t.id))throw Error('Duplicate owned trade');ids.add(t.id);const f=managedCashflows(t);if(!f)throw Error('Unexplained cashflow');
  for(const r of f.orderReports){if(reports.has(r.id))throw Error('Order assigned twice');reports.add(r.id);}
  cash+=f.sellNet+f.settlementPayout-f.buyCost;fees+=f.fees;
  if(t.closedAt!==null&&t.closedAt!==undefined){if(f.remaining!==0||Math.abs(f.net-t.net)>1e-7)throw Error('Invalid close');net+=f.net;gross+=f.net+f.fees;wins+=Number(f.net>0);}
 }
 if(Math.abs(cash-a.cash)>2e-6||Math.abs(net-a.realized)>2e-6||Math.abs(fees-a.fees)>2e-6||wins!==a.wins||a.completed!==a.closedTrades.length)throw Error('Independent reconciliation differs');
 return {cash,fees,net,gross,wins,completed:a.completed,owned:owned.length,uniqueReports:reports.size};
}
export function matchedPath(candidate,baseline){
 const controls=new Map(baseline.closedTrades.map(t=>[entryKey(t),t])),pairs=[],candidateOnly=[];
 for(const t of candidate.closedTrades){const b=controls.get(entryKey(t));if(b){pairs.push({slug:t.slug,candidateId:t.id,baselineId:b.id,entryAt:t.openedAt,netDifference:t.net-b.net,
   closeDifferenceMs:t.closedAt-b.closedAt,waitDifferenceMs:t.timing.waitMs-b.timing.waitMs});controls.delete(entryKey(t));}else candidateOnly.push(t);}
 const baselineOnly=[...controls.values()],sum=xs=>xs.reduce((s,t)=>s+t.net,0);
 const matchedNet=pairs.reduce((s,t)=>s+t.netDifference,0),candidateUnmatched=sum(candidateOnly),baselineUnmatched=sum(baselineOnly);
 return {pairs:pairs.length,matchedNet,candidateUnmatchedTrades:candidateOnly.length,candidateUnmatched,baselineUnmatchedTrades:baselineOnly.length,baselineUnmatched,
  totalIncrement:candidate.realized-baseline.realized,decomposition:matchedNet+candidateUnmatched-baselineUnmatched,pairedRows:pairs};
}
export function writeResults(directory){
 const report=JSON.parse(readFileSync(join(directory,'report.json'))),registration=JSON.parse(readFileSync(join(directory,'registration.json'))),certificate=JSON.parse(readFileSync(join(directory,'certificate.json')));
 if(certificate.reportSha256!==sha(readFileSync(join(directory,'report.json')))||certificate.registrationSha256!==sha(readFileSync(join(directory,'registration.json')))||!isDeepStrictEqual(report.sources,registration.sources))throw Error('Historical certificate mismatch');
 const all=new Map();for(const part of report.partitionRuns)for(const a of report.accounts){const id=[a.scope,a.scenario,a.id].join('__'),path=join(part,id+'.json');if(existsSync(path))all.set([a.scope,a.scenario,a.id].join(':'),JSON.parse(readFileSync(path)));}
 const audit=[],matched=[];
 for(const a of report.accounts){const own=all.get([a.scope,a.scenario,a.id].join(':'));if(!own)throw Error('Missing account snapshot');audit.push({scope:a.scope,scenario:a.scenario,id:a.id,...reconcileAccount(own)});
  if(a.id!=='baseline'){const base=all.get([a.scope,a.scenario,'baseline'].join(':'));matched.push({scope:a.scope,scenario:a.scenario,id:a.id,...matchedPath(own,base)});}}
 writeFileSync(join(directory,'independent-account-audit.json'),JSON.stringify({accounts:audit,checksPassed:audit.length,matchedPaths:matched},null,2));
 const find=(id,scope='continuous-full-history',scenario='base')=>report.accounts.find(a=>a.id===id&&a.scope===scope&&a.scenario===scenario);
 const rows=candidates.map(c=>{const f=find(c.id),v=find(c.id,'validation-new-independent-100'),t=find(c.id,'test-new-independent-100'),st=find(c.id,'test-new-independent-100','stress'),gate=report.promotion.checks.find(g=>g.id===c.id);
  const vg=gate?.parts['validation-new-independent-100'],tg=gate?.parts['test-new-independent-100'];
  return {id:c.id,label:c.label,phase:c.phase,fullTrades:f.completed,fullNet:f.net,fullFees:f.fees,fullWinRate:f.winRate,
   fullLower:f.accountNetRange.lower,fullUpper:f.accountNetRange.upper,fullUnresolved:f.unresolved,
   validationNet:vg?.net??report.split.validation.filter(d=>!report.split.partialBoundaryDates.includes(d)).reduce((s,d)=>s+(v.netByEntryDay[d]??0),0),
   validationTrades:vg?.completed??report.split.validation.filter(d=>!report.split.partialBoundaryDates.includes(d)).reduce((s,d)=>s+(v.dates[d]?.completed??0),0),
   testNet:tg?.net??report.split.test.filter(d=>!report.split.partialBoundaryDates.includes(d)).reduce((s,d)=>s+(t.netByEntryDay[d]??0),0),
   testTrades:tg?.completed??report.split.test.filter(d=>!report.split.partialBoundaryDates.includes(d)).reduce((s,d)=>s+(t.dates[d]?.completed??0),0),
   stressTestNet:tg?.stressNet??report.split.test.filter(d=>!report.split.partialBoundaryDates.includes(d)).reduce((s,d)=>s+(st.netByEntryDay[d]??0),0),
   testIncrement:tg?.increment??0,historicalPassed:gate?.pass??false,holdingSeconds:f.averageTradableHoldSeconds,
   secondEntries:f.secondEntries,blocked:f.counts.capitalBlockedSignals,busy:f.counts.busySignals,
   status:c.id==='baseline'?'对照':gate?.pass?'通过历史纸面筛选':'独立候选观察',reasons:gate?.reasons??[]};});
 writeFileSync(join(directory,'comparison.json'),JSON.stringify(rows,null,2));
 const columns=['id','label','phase','fullTrades','fullNet','fullFees','fullWinRate','fullLower','fullUpper','fullUnresolved','validationNet','validationTrades','testNet','testTrades','stressTestNet','testIncrement','historicalPassed','holdingSeconds','secondEntries','blocked','busy','status'];
 const csv=x=>'"'+String(x??'').replaceAll('"','""')+'"';writeFileSync(join(directory,'comparison.csv'),'\ufeff'+[columns.map(csv).join(','),...rows.map(r=>columns.map(k=>csv(r[k])).join(','))].join('\n')+'\n');
 const md=[`# P3–P6 全历史比较`, '',`冻结截止：${new Date(report.cutoff).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false})} 香港时间。`,
  '',`已回放 ${report.catalogSummary.distinctSlugs} 个不同盘口、${report.frames.toLocaleString('en-US')} 个去重且按时间接受的真实报价帧，${audit.length} 个独立账户逐笔现金/费用/剩余库存复算通过。`,
  '',`每账户初始 $100；全历史账户连续运行。验证/测试账户是事先单独定义的新 $100 对照，不能把它们拼成一个不断重注的账户。基准为 1 秒新源报价；压力为 2 秒和 1.25 倍费用。`,'',
  `训练日期：${report.split.train.join('、')}。`, `验证日期：${report.split.validation.join('、')}。`, `测试日期：${report.split.test.join('、')}（最后未完成日只显示，不用于晋升）。`,'',
  `历史筛选通过：${report.promotion.eligible.length?report.promotion.eligible.join('、'):'无'}。未通过的保留候选；实现通过和历史利润均不代表未来稳定盈利。`, '',
  '| 候选 | 全历史完成 | 全历史净收益 | 费用 | 验证主日期净收益 | 测试主日期净收益 | 测试压力净收益 | 状态 |',
  '|---|---:|---:|---:|---:|---:|---:|---|',...rows.map(r=>`| ${r.label} | ${r.fullTrades} | $${money(r.fullNet)} | $${money(r.fullFees)} | $${money(r.validationNet)} | $${money(r.testNet)} | $${money(r.stressTestNet)} | ${r.status} |`), '',
  '### 收益与执行分解','',
  '| 候选 | 胜率 | 可交易平均持有秒 | 第二笔已完成数量 | 资金阻断信号 | 未核实库存 | 全账户净收益范围 |',
  '|---|---:|---:|---:|---:|---:|---|',...rows.map(r=>`| ${r.label} | ${percent(r.fullWinRate)} | ${money(r.holdingSeconds)} | ${r.secondEntries} | ${r.blocked} | ${r.fullUnresolved} | $${money(r.fullLower)} 至 $${money(r.fullUpper)} |`),'',
  '资金阻断和占仓次数是信号计数，不是独立盘口。可交易持有与到期等待分开；未知库存不视作零收益，回撤仅在完整可估值帧显示，缺测另计。','',
  'P3 同入场路径分解与全部现金复算见 independent-account-audit.json。不同策略交易次数不同，不把只比较各自胜率或平均单笔当作退出的因果增益。','',
  `双边：${report.pair.opportunities} 个报价机会、${report.pair.slugs} 轮；这是同时收到的卖盘含费深度检查，不证明延迟两腿均可成交或已有合并到账，不能晋升为套利。`,
  '挂单：缺少自身队列位置与逐笔成交证据，收益未知、返佣不计，不能把碰价当成交。','',
  '已经查看过的旧历史只提供回溯筛选。23 个观测日期仍有中断；不存在“5000 全轮每秒均可执行”这一保证。具体 coverage/付款收到时刻和源码全部保留。','',
  '失败原因逐项保留在 report.json 的 promotion.checks；不得删掉亏损日后重新优化同一测试集。下一次增加候选须冻结新规则和新的比较证据。'];
 writeFileSync(join(directory,'完整比较报告.md'),md.join('\n')+'\n');return {accounts:audit.length,rows:rows.length,eligible:report.promotion.eligible};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(writeResults(resolve(process.argv[2]))));
