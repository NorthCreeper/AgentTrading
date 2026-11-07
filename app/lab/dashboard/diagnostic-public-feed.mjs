import {PublicFeed} from './public-feed.mjs';
import {ClobMarketStream} from './clob-market-stream.mjs';
import {publicRequestError} from './gamma-market.mjs';
// Preserve the original source and all polling/validation behavior. Capture
// transport failures before callers reduce them to a generic status message.
export class DiagnosticPublicFeed extends PublicFeed {
  constructor(options){
    super(options);
    this.clobStream=new ClobMarketStream({clock:this.clock,onDiagnostic:row=>this.diagnostic(row),
      ...(options.clobSocketFactory?{socketFactory:options.clobSocketFactory}:{})});
  }
  stop(){this.clobStream.stop();super.stop();}
  async get(url){
    const started=performance.now(),requestStartedAt=this.clock(),rawWallRequestStartedAt=Date.now();
    let target;try{target=new URL(url);}catch{}
    const market=this.cache?.market,tokenId=target?.searchParams.get('token_id');
    const isBook=target?.origin==='https://clob.polymarket.com'&&target.pathname==='/book'&&
      market&&Object.values(market.tokens).includes(tokenId);
    if(isBook&&this.running&&this.clockStatus().ready)this.clobStream.ensureMarket(market);
    try{
      const result=await super.get(url);
      if(isBook&&this.running)this.clobStream.anchorRest(result.data,market,result.transportReceivedAt);
      return result;
    }
    catch(error){
      const causes=[error.cause,...(Array.isArray(error.cause?.errors)?error.cause.errors:[])];
      this.diagnostic({kind:'http-request-error',origin:target?.origin??null,path:target?.pathname??null,
        elapsedMs:Math.round(performance.now()-started),...publicRequestError(error),
        causeCodes:[...new Set(causes.map(c=>c?.code).filter(c=>typeof c==='string'))]});
      if(isBook&&this.running&&this.clockStatus().ready){
        const fallback=this.clobStream.fallback(tokenId,market);
        if(fallback){Object.assign(fallback,{requestStartedAt,rawWallRequestStartedAt,latency:this.clock()-requestStartedAt});
          this.diagnostic({kind:'clob-ws-rest-fallback',slug:market.slug,tokenId,
          sourceAt:Number(fallback.data.timestamp),transportReceivedAt:fallback.transportReceivedAt,
          rawBook:fallback.data,transport:'clob-market-websocket',
          parameterBasis:'recent-successful-rest-book',sourceTimestampSemantics:'unverified-server-timestamp'});return fallback;}
        this.diagnostic({kind:'clob-ws-fallback-unavailable',slug:market.slug,tokenId});
      }
      throw error;
    }
  }
}
