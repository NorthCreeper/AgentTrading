import {normalizeBook,roundSlug} from '../market.mjs';
import {bookSequenceIssue} from './book-sequence.mjs';

export const CLOB_MARKET_WS='wss://ws-subscriptions-clob.polymarket.com/ws/market';
// Full snapshots only. The public stream has no contiguous sequence number:
// a delta invalidates our snapshot rather than inventing complete depth.
export class ClobMarketStream {
  constructor({clock=Date.now,rawClock=Date.now,onDiagnostic=()=>{},socketFactory=url=>new WebSocket(url),
    setTimer=setTimeout,clearTimer=clearTimeout}={}) {
    Object.assign(this,{clock,rawClock,onDiagnostic,socketFactory,setTimer,clearTimer});
    this.running=false;this.generation=0;this.timers=new Set();this.books=new Map();this.anchors=new Map();this.invalidatedAt=new Map();this.latestNormalized=new Map();
  }
  diagnostic(kind,extra={}){try{this.onDiagnostic({kind,...extra});}catch{/* optional transport cannot stop REST */}}
  later(fn,ms){const timer=this.setTimer(()=>{this.timers.delete(timer);fn();},ms);timer?.unref?.();this.timers.add(timer);return timer;}
  clearTimers(){for(const t of this.timers)this.clearTimer(t);this.timers.clear();}
  active(m=this.market){return this.running&&m&&this.market?.slug===m.slug&&this.market?.conditionId===m.conditionId&&
    JSON.stringify(this.market.tokens)===JSON.stringify(m.tokens)&&roundSlug(this.clock())===m.slug;}
  ensureMarket(m){
    if(!m||roundSlug(this.clock())!==m.slug)return;
    if(this.active(m))return;
    this.stop('market-switch');this.running=true;this.market=structuredClone(m);this.connect();
  }
  stop(reason='stopped'){
    this.running=false;this.generation++;this.clearTimers();this.books.clear();this.anchors.clear();this.invalidatedAt.clear();this.latestNormalized.clear();
    const ws=this.ws;this.ws=null;this.market=null;
    if(ws){this.diagnostic('clob-ws-closed',{reason});try{ws.close();}catch{}}
  }
  connect(){
    if(!this.active())return;
    const generation=++this.generation,market=this.market;
    let ws;try{ws=this.socketFactory(CLOB_MARKET_WS);}catch(error){
      this.diagnostic('clob-ws-error',{slug:market.slug,stage:'construct',message:error.message});
      this.later(()=>this.connect(),2000);return;
    }
    this.ws=ws;let lastMessage=this.clock();
    const current=()=>this.active(market)&&generation===this.generation&&this.ws===ws;
    const retire=reason=>{
      if(!current())return;
      this.generation++;this.clearTimers();this.books.clear();this.invalidatedAt.clear();this.latestNormalized.clear();this.ws=null;
      this.diagnostic('clob-ws-gap',{slug:market.slug,reason,observedAt:this.clock()});
      try{ws.close();}catch{}
      if(this.active(market))this.later(()=>this.connect(),2000);
    };
    const watchdog=this.later(()=>retire('connect-timeout'),10000);
    ws.addEventListener('open',()=>{
      if(!current()){try{ws.close();}catch{}return;}
      this.clearTimer(watchdog);this.timers.delete(watchdog);
      try{ws.send(JSON.stringify({assets_ids:Object.values(market.tokens),type:'market'}));}
      catch(error){this.diagnostic('clob-ws-error',{slug:market.slug,stage:'subscribe',message:error.message});retire('subscribe-failed');return;}
      this.diagnostic('clob-ws-subscribed',{slug:market.slug,conditionId:market.conditionId,tokens:market.tokens});
      const heartbeat=()=>{
        if(!current()){if(this.ws===ws&&generation===this.generation)this.stop('market-expired');return;}
        if(this.clock()-lastMessage>25000){retire('heartbeat-timeout');return;}
        try{ws.send('PING');}catch{retire('heartbeat-send-failed');return;}
        this.later(heartbeat,10000);
      };this.later(heartbeat,10000);
    });
    ws.addEventListener('message',({data})=>{
      if(!current())return;
      lastMessage=this.clock();
      if(data==='PONG'||data==='PING'||!String(data).trim())return;
      try{const msg=JSON.parse(data);for(const row of (Array.isArray(msg)?msg:[msg]))this.ingest(row);}
      catch(error){this.books.clear();this.diagnostic('clob-ws-rejected',{slug:market.slug,reason:'malformed-message',message:error.message});}
    });
    ws.addEventListener('error',()=>retire('socket-error'));
    ws.addEventListener('close',()=>retire('socket-close'));
  }
  ingest(row){
    if(!this.active()||!row||typeof row!=='object')return;
    const market=this.market,ids=Object.values(market.tokens);
    if(row.market!==market.conditionId){this.diagnostic('clob-ws-rejected',{slug:market.slug,reason:'market-identity'});return;}
    if(row.event_type==='price_change'){
      if(!Array.isArray(row.price_changes)){this.books.clear();return;}
      for(const change of row.price_changes)if(ids.includes(change.asset_id)){
        const ts=Number(row.timestamp);
        // An older full snapshot arriving after an observed delta must not
        // resurrect its superseded levels, including at the same millisecond.
        this.invalidatedAt.set(change.asset_id,Number.isFinite(ts)&&ts>0?Math.max(ts,this.invalidatedAt.get(change.asset_id)??0):Infinity);
        if(this.books.delete(change.asset_id))this.diagnostic('clob-ws-snapshot-invalidated',{slug:market.slug,tokenId:change.asset_id,reason:'delta-requires-full-book'});
      }
      return;
    }
    if(row.event_type==='tick_size_change'){
      if(ids.includes(row.asset_id)){this.books.delete(row.asset_id);this.anchors.delete(row.asset_id);
        const ts=Number(row.timestamp);this.invalidatedAt.set(row.asset_id,Number.isFinite(ts)&&ts>0?Math.max(ts,this.invalidatedAt.get(row.asset_id)??0):Infinity);
        this.diagnostic('clob-ws-snapshot-invalidated',{slug:market.slug,tokenId:row.asset_id,reason:'tick-change-requires-rest-metadata'});}
      return;
    }
    if(row.event_type!=='book')return;
    const tokenId=row.asset_id,receivedAt=this.clock(),rawWallTransportReceivedAt=this.rawClock();
    try{
      if(!ids.includes(tokenId))throw Error('token-identity');
      if(!/^\d+$/.test(String(row.timestamp??''))||Number(row.timestamp)<=0)throw Error('missing-source-time');
      if(Number(row.timestamp)<=(this.invalidatedAt.get(tokenId)??0))throw Error('snapshot-precedes-observed-change');
      // These parameters are solely for level validation here. Returning a book
      // to PublicFeed additionally requires its actual recent REST parameters.
      const data={...structuredClone(row),tick_size:market.tick,min_order_size:market.minSize};
      const normalized=normalizeBook(data,market,tokenId,receivedAt),previous=this.latestNormalized.get(tokenId);
      const issue=bookSequenceIssue(previous,normalized);if(issue)throw Error(issue);
      if(previous&&previous.timestamp===normalized.timestamp)return;
      this.latestNormalized.set(tokenId,normalized);
      this.books.set(tokenId,{data,normalized,transportReceivedAt:receivedAt,rawWallTransportReceivedAt});
      this.diagnostic('clob-ws-book',{slug:market.slug,tokenId,sourceAt:normalized.timestamp,transportReceivedAt:receivedAt,
        sourceHash:row.hash??null,bidLevels:normalized.bids.length,askLevels:normalized.asks.length,sourceTimestampSemantics:'unverified-server-timestamp'});
    }catch(error){this.books.delete(tokenId);this.diagnostic('clob-ws-rejected',{slug:market.slug,tokenId,reason:error.message});}
  }
  anchorRest(data,market,receivedAt){
    if(!this.active(market))return;
    try{normalizeBook(data,{...market,tick:Number(data.tick_size),minSize:Number(data.min_order_size)},data.asset_id,receivedAt);
      if(!Object.values(market.tokens).includes(data.asset_id)||![.1,.01,.005,.0025,.001,.0001].includes(Number(data.tick_size))||!(Number(data.min_order_size)>0))return;
      this.anchors.set(data.asset_id,{tick:data.tick_size,minSize:data.min_order_size,receivedAt});
    }catch{/* The original paired normalizer remains authoritative. */}
  }
  fallback(tokenId,market){
    if(!this.active(market))return null;
    const b=this.books.get(tokenId),a=this.anchors.get(tokenId),now=this.clock();
    if(!b||!a||now-a.receivedAt>10000||now<a.receivedAt||now-b.transportReceivedAt>3000||now<b.transportReceivedAt||
      now-b.normalized.timestamp>3000||b.normalized.timestamp>now+2000)return null;
    return {data:{...structuredClone(b.data),tick_size:a.tick,min_order_size:a.minSize},
      transportReceivedAt:b.transportReceivedAt,rawWallTransportReceivedAt:b.rawWallTransportReceivedAt};
  }
}
