export const referenceMaxAgeMs=5000;

// Observation age and delivery age are different clocks. Neither a replayed
// timestamp nor a recently received old value may make a stale price fresh.
export function referenceStatus(price,now) {
 const valid=price && Number.isFinite(price.timestamp) && Number.isFinite(price.receivedAt);
 const sourceAgeMs=valid?now-price.timestamp:null,receiptAgeMs=valid?now-price.receivedAt:null;
 const ready=Boolean(valid && sourceAgeMs>=0 && receiptAgeMs>=0 && sourceAgeMs<=referenceMaxAgeMs && receiptAgeMs<=referenceMaxAgeMs);
 let reason=null;
 if(!valid)reason='Chainlink 参考价格尚未就绪，等待价格流更新';
 else if(sourceAgeMs<0 || receiptAgeMs<0)reason='Chainlink 价格时间戳超前，请检查时间同步';
 else if(!ready)reason=`Chainlink 参考价格已过期：源价格已过去 ${(sourceAgeMs/1000).toFixed(1)} 秒，最近接收于 ${(receiptAgeMs/1000).toFixed(1)} 秒前；有效期 ${referenceMaxAgeMs/1000} 秒`;
 return {ready,reason,price:price??null,sourceAgeMs,receiptAgeMs,
  deliveryDelayMs:valid?price.receivedAt-price.timestamp:null,maxAgeMs:referenceMaxAgeMs};
}
