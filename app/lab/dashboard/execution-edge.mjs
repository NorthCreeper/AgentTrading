import { depthQuote, freshBook } from './strategy.mjs';
import { e18ToPrice } from './chart-model.mjs';

export const featureNames=['price','priceSquared','timeLeft','momentum5','momentum15','twap5Bps','twap30Bps','obi','microPremium','spread','volatility','priceTimeInteraction'];
export function edgeFeatures({frame,history,prices,config,now},outcome) {
  if(!frame || now<frame.market.start+30_000 || now>=frame.market.end-90_000) return null;
  const recent=history.filter(r=>r.slug===frame.market.slug&&r.time>=now-30_000&&r.time<=now);
  const ps=prices.filter(r=>r.time>=now-30_000&&r.time<=now);
  const continuous=rows=>rows.length>=10&&rows[0].time<=now-28_000&&now-rows.at(-1).time<=5000&&rows.every((r,i)=>!i||r.time>rows[i-1].time&&r.time-rows[i-1].time<=5000);
  if(!continuous(recent)||!continuous(ps)) return null;
  const last=ps.at(-1);
  if(!Number.isFinite(last.receivedAt)||now<last.receivedAt||now-last.receivedAt>5000)return null;
  const book=frame.books.find(b=>b.tokenId===frame.market.tokens[outcome]);
  if(!freshBook(book,now,config.staleMs)||!book.bids.length||!book.asks.length)return null;
  const key=outcome.toLowerCase();if(recent.some(r=>!Number.isFinite(r[key])))return null;
  const at=(rows,ms)=>rows.findLast(r=>r.time<=now-ms);
  const p5=at(recent,5000),p15=at(recent,15000),t5=at(ps,5000);
  if(!p5||!p15||!t5)return null;
  const btc=e18ToPrice(last.valueE18),btc5=e18ToPrice(t5.valueE18),btc30=e18ToPrice(ps[0].valueE18);
  if(!btc||!btc5||!btc30)return null;
  const bid=book.bids[0][0],ask=book.asks[0][0],mid=(bid+ask)/2,spread=ask-bid;
  const bd=book.bids.slice(0,5).reduce((s,l)=>s+l[1],0),ad=book.asks.slice(0,5).reduce((s,l)=>s+l[1],0);
  const obi=(bd-ad)/Math.max(1e-8,bd+ad),micro=(bid*book.asks[0][1]+ask*book.bids[0][1])/(book.asks[0][1]+book.bids[0][1]);
  const size=config.size,buy=depthQuote(book,'buy',size,frame.market),sell=depthQuote(book,'sell',size,frame.market);
  if(!buy?.complete||!sell?.complete||spread<=0)return null;
  const variance=recent.slice(1).reduce((s,r,i)=>s+(r[key]-recent[i][key])**2,0)/Math.max(1,recent.length-1);
  const remaining=(frame.market.end-now)/300_000,sign=outcome==='Up'?1:-1;
  return {x:[mid-.5,(mid-.5)**2,remaining,mid-p5[key],mid-p15[key],sign*(btc/btc5-1)*10000,
    sign*(btc/btc30-1)*10000,obi,micro-mid,spread,Math.sqrt(variance),(mid-.5)/Math.sqrt(remaining)],
    tokenId:book.tokenId,outcome,spread,obi,bidDepth:bd,askDepth:ad,mid,buy,sell,book};
}
export function fitRidge(samples,lambda=10) {
  if(samples.length<50)throw Error('Insufficient training observations');
  const n=featureNames.length,mean=Array(n).fill(0),scale=Array(n).fill(0);
  for(const s of samples)for(let j=0;j<n;j++)mean[j]+=s.x[j]/samples.length;
  for(const s of samples)for(let j=0;j<n;j++)scale[j]+=(s.x[j]-mean[j])**2/samples.length;
  for(let j=0;j<n;j++)scale[j]=Math.sqrt(scale[j])||1;
  const a=Array.from({length:n+1},()=>Array(n+2).fill(0));
  for(const s of samples){const x=[1,...s.x.map((v,j)=>(v-mean[j])/scale[j])];for(let i=0;i<=n;i++){for(let j=0;j<=n;j++)a[i][j]+=x[i]*x[j];a[i][n+1]+=x[i]*s.y;}}
  for(let i=1;i<=n;i++)a[i][i]+=lambda;
  for(let i=0;i<=n;i++){
    let pivot=i;for(let k=i+1;k<=n;k++)if(Math.abs(a[k][i])>Math.abs(a[pivot][i]))pivot=k;
    [a[i],a[pivot]]=[a[pivot],a[i]];
    const d=a[i][i];if(Math.abs(d)<1e-12)throw Error('Singular model');
    for(let j=i;j<=n+1;j++)a[i][j]/=d;
    for(let k=0;k<=n;k++)if(k!==i){const m=a[k][i];for(let j=i;j<=n+1;j++)a[k][j]-=m*a[i][j];}
  }
  return {mean,scale,weights:a.map(row=>row[n+1]),featureNames};
}
export function predictEdge(model,x) {
  if(model?.weights?.length!==x.length+1||model.mean?.length!==x.length||model.scale?.length!==x.length)return null;
  let value=model.weights[0];for(let j=0;j<x.length;j++){if(!Number.isFinite(x[j])||!Number.isFinite(model.scale[j])||model.scale[j]<=0)return null;value+=model.weights[j+1]*(x[j]-model.mean[j])/model.scale[j];}
  return Number.isFinite(value)?value:null;
}
export function evaluateExecutionEdge(input,artifact,{research=false}={}) {
  const {frame,config,strategy,now}=input;
  const result={version:'execution-edge-v2',time:now,calibrated:false,execution:strategy.execution,candidates:[],selected:null,
    reason:'执行收益模型未就绪',modelId:artifact?.id??null,promotionEligible:artifact?.promotion?.eligible===true};
  if(!artifact?.model||!artifact.fee||!Number.isFinite(artifact.safetyMargin)||artifact.safetyMargin<0||!Number.isFinite(artifact.threshold)||!frame)return result;
  if(config.holdMs!==artifact.horizonMs){result.reason='持有时间与模型预测窗口不一致';return result;}
  if(config.size!==artifact.size||frame.market.fee.rate!==artifact.fee.rate||frame.market.fee.exponent!==artifact.fee.exponent){result.reason='份额或费用与模型适用范围不同，禁止外推';return result;}
  for(const outcome of ['Up','Down']) {
    const f=edgeFeatures(input,outcome);if(!f)continue;
    const prediction=predictEdge(artifact.model,f.x);
    const c={outcome,tokenId:f.tokenId,version:result.version,modelId:artifact.id,horizonMs:artifact.horizonMs,reference:null,
      makerEdge:null,takerEdge:prediction===null?null:prediction-strategy.costBuffer-artifact.safetyMargin,
      predictedNet:prediction,obi:f.obi,bidDepth:f.bidDepth,askDepth:f.askDepth,spread:f.spread,
      mode:'taker',makerPrice:f.book.bids[0][0],limit:f.buy.worst,entryFeePerShare:f.buy.fees/config.size,
      eligible:false,reason:'预测净收益不足以覆盖缓冲与误差余量'};
    result.candidates.push(c);
    const outside=f.x.some((v,j)=>Math.abs((v-artifact.model.mean[j])/artifact.model.scale[j])>6);
    if(outside){c.reason='特征超出训练覆盖范围';continue;}
    if(f.spread>strategy.maxSpread){c.reason='价差超过上限';continue;}
    if(!research&&!result.promotionEligible){c.reason='诊断验证未通过：仅记录候选，不自动下单';continue;}
    if(c.takerEdge!==null&&c.takerEdge>=Math.max(strategy.minNetEdge,artifact.threshold)) {c.eligible=true;c.reason='执行收益预测超过费用、缓冲与误差门槛';}
  }
  result.selected=result.candidates.filter(c=>c.eligible).sort((a,b)=>b.takerEdge-a.takerEdge)[0]??null;
  result.reason=result.selected?`成本过滤候选：${result.selected.outcome}`:!result.candidates.length?'等待同轮连续数据或允许开仓时段':!research&&!result.promotionEligible?'新模型尚未通过诊断验证，自动开仓被阻止':'没有满足净收益门槛的候选';
  return result;
}
