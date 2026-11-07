// Display diagnostics only; the broker independently checks execution freshness.
export function bookStatus(frame, now, staleMs = 3000) {
  const market=frame?.market, books=frame?.books??[];
  const pair=market?Object.values(market.tokens).map(id=>books.find(b=>b.tokenId===id)):[];
  if(pair.length!==2 || pair.some(b=>!b || !Number.isFinite(b.timestamp) || !Number.isFinite(b.receivedAt)))
    return {fresh:false,reason:'等待 Up / Down 订单簿',sourceAgeMs:null,receivedAgeMs:null};
  const sourceAgeMs=Math.max(...pair.map(b=>now-b.timestamp));
  const receivedAgeMs=Math.max(...pair.map(b=>now-b.receivedAt));
  const result={fresh:false,sourceAgeMs,receivedAgeMs};
  if(now<market.start || now>=market.end)return {...result,reason:'非当前轮报价，等待换轮'};
  if(pair.some(b=>b.timestamp>now || b.receivedAt>now))return {...result,reason:'报价时间异常'};
  if(receivedAgeMs>staleMs)return {...result,reason:'行情接收中断，显示上次快照'};
  if(sourceAgeMs>staleMs)return {...result,reason:'接口已响应，源报价未更新'};
  return {...result,fresh:true,reason:'报价有效'};
}
