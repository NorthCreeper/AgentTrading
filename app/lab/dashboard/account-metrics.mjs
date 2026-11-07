import {round} from '../paper-broker.mjs';
import {freshBook,depthQuote} from './strategy.mjs';
import {validManagedSettlement} from './managed-position-accounting.mjs';
import {isDeepStrictEqual} from 'node:util';

export const accountMetricsVersion='paper-account-nav-v1';
const groups=['all','automatic','manualOneTap','manualOther'];
const empty=()=>({completed:0,wins:0,losses:0,breakeven:0,net:0,fees:0});
const groupFor=origin=>origin==='manual-one-tap'?'manualOneTap':origin==='manual-other'?'manualOther':'automatic';

// A complete liquidation valuation, rather than best bid times inventory.
// Missing books or insufficient depth retain payout bounds and an unknown NAV.
export function accountValuation({account,frame,markets={},trade=null,ownedTrades=[],labels=new Map(),now,staleMs=3000}) {
 let known=true,inventoryNet=0,lower=0,upper=0;
 const positions=[];
 const owners=new Map();
 for(const position of [trade,...ownedTrades].filter(Boolean)) {
  const claims=owners.get(position.tokenId)??[];
  if(!claims.some(p=>p===position||p.id&&p.id===position.id&&isDeepStrictEqual(p,position)))claims.push(position);
  owners.set(position.tokenId,claims);
 }
 for(const [tokenId,size] of Object.entries(account.holdings)) {
  const claims=owners.get(tokenId)??[],owner=claims.length===1?claims[0]:null;
  const market=claims.length>1?null:owner?.market??(frame?.market?.tokens&&Object.values(frame.market.tokens).includes(tokenId)?frame.market:null);
  const outcome=market?Object.entries(market.tokens??{}).find(([,id])=>id===tokenId)?.[0]:markets[tokenId]?.outcome;
  const label=market?labels.get(market.slug):null;
  let value=null,reason='持仓缺少可核实的盘口身份',basis=null,fees=null;
  const labelTrade=owner??{slug:market?.slug,outcome,tokenId,market};
  const validLabel=market&&validManagedSettlement(labelTrade,label,now);
  if(validLabel){value=round(size*label.payouts[outcome]);basis='verified-settlement';fees=0;reason='已核实结算应收金额';}
  else if(market&&now<market.end){
   const book=frame?.market?.slug===market.slug&&frame.market.conditionId===market.conditionId&&
    frame.market.start===market.start&&frame.market.end===market.end&&
    ['Up','Down'].every(o=>frame.market.tokens?.[o]===market.tokens?.[o])?frame.books?.find(b=>b.tokenId===tokenId):null;
   const validLevels=book?.bids?.length&&book.bids.every(([p,q],i)=>Number.isFinite(p)&&p>0&&p<=1&&Number.isFinite(q)&&q>=0&&(!i||p<=book.bids[i-1][0]));
   if(!freshBook(book,now,staleMs)||!validLevels)reason='等待新鲜且匹配的可卖买盘';
   else if(!market.fee||!Number.isFinite(market.fee.rate)||market.fee.rate<0||!Number.isFinite(market.fee.exponent)||market.fee.exponent<0)reason='卖出费用规则未知';
   else {
    const quote=depthQuote(book,'sell',size,market,0);
    if(quote?.complete){value=round(quote.notional-quote.fees);basis='full-depth-net-liquidation';fees=quote.fees;reason='按全部剩余持仓和可卖深度扣费估值';}
    else reason='可卖深度不足，净值待核实';
   }
  }else if(market)reason='盘口已结束，等待官方结算核实';
  if(value===null){known=false;upper+=size;}
  else {inventoryNet+=value;lower+=value;upper+=value;}
  positions.push({tokenId,size,value,basis,fees,reason});
 }
 return {known,value:known?round(account.cash+inventoryNet):null,inventoryNet:known?round(inventoryNet):null,
  lower:round(account.cash+lower),upper:round(account.cash+upper),positions,
  reason:known?'现金加全部持仓的扣费可卖价值或已核实结算金额':positions.filter(p=>p.value===null).map(p=>p.reason).join('；')};
}

export class AccountMetrics {
 constructor({saved=null,now=Date.now()}={}) {
  if(saved&&saved.version!==accountMetricsVersion)throw Error('Unsupported account metrics state');
  this.state=saved?structuredClone(saved):{version:accountMetricsVersion,createdAt:now,cashFlows:[],baseline:null,baselinePendingAt:null,
   seenTrades:[],statistics:Object.fromEntries(groups.map(k=>[k,empty()])),unmanaged:{reports:{},positions:{}}};
 }
 saved(){return structuredClone(this.state);}
 addClose(trade) {
  if(!trade?.id||this.state.seenTrades.includes(trade.id))return false;
  const bought=Number.isFinite(trade.bought)?trade.bought:(trade.orderReports??[]).filter(o=>o.side==='buy').reduce((s,o)=>s+(o.filled??0),0);
  // No-fill attempts, open inventory and unverified outcomes are not wins.
  if(!(bought>0)||!Number.isFinite(trade.net)||!Number.isFinite(trade.closedAt)||!Number.isFinite(trade.openedAt)||trade.closedAt<trade.openedAt)return false;
  this.state.seenTrades.push(trade.id);
  for(const key of ['all',groupFor(trade.origin)]) {
   const stat=this.state.statistics[key];stat.completed++;
   stat[trade.net>1e-8?'wins':trade.net< -1e-8?'losses':'breakeven']++;
   stat.net=round(stat.net+trade.net);stat.fees=round(stat.fees+(Number.isFinite(trade.fees)?trade.fees:0));
  }
  return true;
 }
 seedUnmanaged(account,orders,managedTokenId) {
  const ownedTokens=new Set(Array.isArray(managedTokenId)?managedTokenId:[managedTokenId]);
  for(const o of orders)this.state.unmanaged.reports[o.id]={filled:o.filled,notional:o.notional,fees:o.fees};
  for(const [tokenId,held] of Object.entries(account.holdings))if(!ownedTokens.has(tokenId))this.state.unmanaged.positions[tokenId]={
   id:`legacy-open:${tokenId}`,held,bought:held,cost:account.inventoryCost?.[tokenId]??null,proceeds:0,fees:0,incompleteHistory:true};
 }
 report(report,{managed=false,now}={}) {
  const seen=this.state.unmanaged.reports,prior=seen[report.id]??{filled:0,notional:0,fees:0};
  const filled=round(report.filled-prior.filled),notional=round(report.notional-prior.notional),fees=round(report.fees-prior.fees);
  seen[report.id]={filled:report.filled,notional:report.notional,fees:report.fees};
  if(managed||filled<=0)return;
  const positions=this.state.unmanaged.positions;
  let p=positions[report.tokenId];
  if(report.side==='buy') {
   p??=positions[report.tokenId]={id:`manual-cycle:${report.id}`,held:0,bought:0,cost:0,proceeds:0,fees:0,openedAt:now};
   p.held=round(p.held+filled);p.bought=round(p.bought+filled);p.cost=round(p.cost+notional+fees);p.fees=round(p.fees+fees);
  }else if(p) {
   p.held=round(p.held-filled);p.proceeds=round(p.proceeds+notional-fees);p.fees=round(p.fees+fees);
   if(p.held<=1e-8){
    if(!p.incompleteHistory)this.addClose({id:p.id,origin:'manual-other',bought:p.bought,openedAt:p.openedAt,closedAt:now,net:round(p.proceeds-p.cost),fees:p.fees});
    delete positions[report.tokenId];
   }
  }
 }
 findDeposit(requestId){return this.state.cashFlows.find(f=>f.requestId===requestId)??null;}
 deposit({amount,requestId,now}) {
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw Error('缺少有效资金请求编号');
  if(!Number.isFinite(amount)||amount<.01||amount>1_000_000||Math.abs(amount*100-Math.round(amount*100))>1e-6)throw Error('模拟充值金额须为 $0.01–$1,000,000，最多两位小数');
  const prior=this.findDeposit(requestId);
  if(prior){if(prior.amount!==amount)throw Error('该请求编号已用于不同金额');return {flow:prior,duplicate:true};}
  if(this.state.cashFlows.reduce((s,f)=>s+f.amount,0)+amount>1e12)throw Error('模拟充值累计金额超出范围');
  const flow={id:`paper-funding:${requestId}`,requestId,time:now,amount,type:'deposit'};
  this.state.cashFlows.push(flow);
  if(!this.state.baseline)this.state.baselinePendingAt??=now;
  return {flow,duplicate:false};
 }
 observe(nav,now) {
  // Called by the serialized controller before saving; read-only snapshots never
  // start or move the funded performance baseline.
  if(!this.state.baseline&&this.state.cashFlows.length&&nav.known&&nav.value>0) {
   this.state.baseline={time:now,nav:nav.value,flowCount:this.state.cashFlows.length};this.state.baselinePendingAt=null;
  }
 }
 summary({account,nav,now}) {
  const flows=this.state.cashFlows,deposits=round(flows.reduce((s,f)=>s+f.amount,0)),base=this.state.baseline;
  const later=base?round(flows.slice(base.flowCount).reduce((s,f)=>s+f.amount,0)):0;
  const contributedCapital=base?round(base.nav+later):null;
  const netChange=base&&nav.known?round(nav.value-base.nav-later):null;
  const stats=Object.fromEntries(groups.map(k=>{const s=this.state.statistics[k];return [k,{...s,rate:s.completed?s.wins/s.completed:null}];}));
  return {version:accountMetricsVersion,mode:'paper',time:now,
   balance:{cash:account.cash,deposits,legacyUnfunded:true,funded:flows.length>0},nav,
   return:{method:'cash-flow-adjusted-nav-change',baselineAt:base?.time??null,baselineNav:base?.nav??null,baselinePendingAt:this.state.baselinePendingAt,
    netChange,contributedCapital,roi:netChange!==null&&contributedCapital>0?netChange/contributedCapital:null,
    legacyNet:nav.known?round(nav.value-deposits):null,
    reason:!flows.length?'历史模拟从零本金运行；充值建立正净值基准后显示净投资回报率':!base?'首笔充值后等待可核实的正净值建立基准；建立前收益不计入本期':!nav.known?'持仓净值未核实，本期回报率暂不可计算':'净值变化扣除后续充值，除以基准净值与后续充值总和'},
   winRate:{...stats,scope:'本会话已完成实际入场至清仓的扣费仓位；手动普通订单从看板上线起记录；部分卖出合并为一笔；零盈亏也计入分母'},
   cashFlows:{count:flows.length,total:deposits,last:flows.at(-1)??null}};
 }
}
