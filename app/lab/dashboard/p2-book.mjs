import {freshBook,depthQuote} from './strategy.mjs';
import {amountQuote} from '../amount-order.mjs';
import {round} from '../paper-broker.mjs';

// Research data only: executable bids are independent of the presence of asks.
// Empty but fresh, valid snapshots are observations, not missing transport data.
export function researchBook(book,market,outcome,now,move30=null){
 const identity=Boolean(book&&book.tokenId===market.tokens[outcome]);
 const levels=(xs,sign)=>Array.isArray(xs)&&xs.every((l,i)=>Array.isArray(l)&&l.length===2&&
  Number.isFinite(l[0])&&l[0]>0&&l[0]<1&&Number.isFinite(l[1])&&l[1]>0&&(!i||sign*(l[0]-xs[i-1][0])>0));
 const shape=identity&&levels(book.bids,-1)&&levels(book.asks,1)&&
  (!book.bids.length||!book.asks.length||book.bids[0][0]<book.asks[0][0]);
 const clockReady=identity&&freshBook(book,now,3000),observed=Boolean(shape&&clockReady);
 const bidReady=observed&&book.bids.length>0,askReady=observed&&book.asks.length>0,ready=bidReady&&askReady;
 const status=!identity?'identity-missing':!shape?'invalid-book':!clockReady?'stale-or-future':
  ready?'two-sided':bidReady?'bid-only':askReady?'ask-only':'empty';
 let buy=null,sell=null;
 if(askReady)try{buy=amountQuote(book,market,1);}catch{}
 if(bidReady&&buy?.complete)sell=depthQuote(book,'sell',buy.filled,market,round(Math.max(market.tick,book.bids[0][0]-.02)));
 return {ready,bidReady,askReady,clockReady,bookObserved:observed,bookStatus:status,
  tokenId:book?.tokenId??null,mid:ready?round((book.bids[0][0]+book.asks[0][0])/2):null,
  spread:ready?round(book.asks[0][0]-book.bids[0][0]):null,bid:bidReady?book.bids[0][0]:null,ask:askReady?book.asks[0][0]:null,
  sourceAt:book?.timestamp??null,receivedAt:book?.receivedAt??null,
  bidLevels:Array.isArray(book?.bids)?book.bids.length:null,askLevels:Array.isArray(book?.asks)?book.asks.length:null,
  // Full received snapshot, not synthetic liquidity or a guarantee of future execution.
  bidDepthCoverage:observed?'full-received-book':'unavailable',bids:observed?book.bids.map(l=>[...l]):[],
  buy:buy?.complete?{size:buy.filled,cost:round(buy.notional+buy.fees),fees:buy.fees,limit:buy.limit}:null,
  sell:sell?.complete?{size:sell.filled,netProceeds:round(sell.notional-sell.fees)}:null,move30};
}
