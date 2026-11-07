import {marketInformationExit} from './market-exit.mjs';
import {executableBidExit} from './bid-exit.mjs';
export const consensusExitVersion='market-bid-confirmation-v1';
export const consensusExitProtocol=Object.freeze({version:consensusExitVersion,
 rule:'both existing rules independently confirmed and valid at the current observation',
 marketVersion:'market-information-v1',bidVersion:'executable-bid-exit-v1',btcRole:'diagnostic-only',
 extraConfirmationMs:0,costOrHoldingTimeExit:false});
// Two measurements of the same book, not statistically independent sources.
export function consensusExit(t,held,b,market,now,config,history,prices,bidHistory){
 const m=marketInformationExit(t,held,b,market,now,config,history,prices);
 const v=executableBidExit(t,held,b,market,now,config,bidHistory);
 const md=t.holdingDecision,bd=t.bidDecision;
 const unavailable=md?.time!==now||bd?.time!==now||[md.status,bd.status].includes('data-unavailable');
 const awaiting=now>=t.market.end;
 const supported=!unavailable&&md.move30>=0&&md.move10>=0&&bd.move30>=0&&bd.move10>=0;
 const disagree=!unavailable&&([md.status,bd.status].includes('exit')||[md.status,bd.status].includes('confirming-reversal'));
 const status=awaiting?'awaiting-resolution':unavailable?'data-unavailable':m&&v?'exit':disagree?'waiting-agreement':supported?'supported-hold':'hold';
 const reason=awaiting?'到期，等待核实结算':unavailable?'信息不足，暂无法判断是否应退出':status==='exit'?'中间价与净卖出价值均已确认转弱':
  status==='waiting-agreement'?'两项退出条件尚未同时确认，继续观察':supported?'两项盘口价值均未走弱，继续观察':'尚无共同确认的退出信号';
 t.consensusDecision={version:consensusExitVersion,time:now,status,reason,marketStatus:md?.status,bidStatus:bd?.status,
  marketConfirmedMs:md?.confirmedMs??0,bidConfirmedMs:bd?.confirmedMs??0};
 return status==='exit'?{...v,reason}:null;
}
