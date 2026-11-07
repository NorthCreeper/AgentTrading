import {marketWindowFor,formatMarketWindow,formatRecordedTime} from './market-time.mjs';

const version='btc5m-trade-record-display-v1';
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function annotateExperiment(value){
 if(!record(value))return value;
 return {...value,...(Array.isArray(value.recentTrades)?{recentTrades:value.recentTrades.map(annotateTradeRecord)}:{}),
  ...(record(value.lastTrade)?{lastTrade:annotateTradeRecord(value.lastTrade)}:{})};
}
function annotatePositions(value){
 const result={...value};
 for(const key of ['managedPosition','openPosition'])if(record(value[key]))result[key]=annotateTradeRecord(value[key]);
 for(const key of ['rayOwnedPositions','pendingSettlements'])if(Array.isArray(value[key]))result[key]=value[key].map(annotateTradeRecord);
 if(record(value.settlementQueue))result.settlementQueue=annotateSettlementQueue(value.settlementQueue);
 return result;
}
export function annotateSettlementQueue(value){
 return record(value)&&Array.isArray(value.positions)?{...value,positions:value.positions.map(annotateTradeRecord)}:value;
}
export function annotateTradeRecord(value){
 if(!record(value))return value;
 const window=marketWindowFor(value);
 return {...value,marketWindow:{...window,displayHkt:formatMarketWindow(window)},recordTimes:{
  version,timezone:'Asia/Hong_Kong',openedRecordedHkt:formatRecordedTime(value.openedAt),
  closedRecordedHkt:formatRecordedTime(value.closedAt),
  semantics:'Local paper position observation and accounting times; not exchange matching or on-chain confirmation times.'}};
}
export function annotateOrderRecord(value){
 if(!record(value))return value;
 const window=marketWindowFor(value);
 return {...value,marketWindow:{...window,displayHkt:formatMarketWindow(window)},recordTimes:{
  version,timezone:'Asia/Hong_Kong',submittedRecordedHkt:formatRecordedTime(value.createdAt),
  semantics:'Order creation time is not proof of a fill. Market window identifies the contract, not the quote timestamp.'}};
}
export function annotateTradingSnapshot(value){
 if(!record(value))return value;
 const result={...value,tradeRecordDisplay:{version,timezone:'Asia/Hong_Kong',mode:'read-only-annotation',historicalLedgerRewritten:false}};
 if(Array.isArray(value.orders))result.orders=value.orders.map(annotateOrderRecord);
 if(record(value.strategy)){
  result.strategy=annotatePositions(value.strategy);
  const exp=value.strategy.experiment;
  if(record(exp))result.strategy.experiment=annotateExperiment(exp);
 }
 return result;
}
export function annotateTradesExport(value){
 if(!record(value))return value;
 return {...annotatePositions(value),...(record(value.experiment)?{experiment:annotateExperiment(value.experiment)}:{}),
  tradeRecordDisplay:{version,timezone:'Asia/Hong_Kong',mode:'read-only-annotation',historicalLedgerRewritten:false},
  ...(Array.isArray(value.trades)?{trades:value.trades.map(annotateTradeRecord)}:{})};
}
