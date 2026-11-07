// Public, unauthenticated market data only. This feed has no trading methods.
export const spotEndpoints=Object.freeze({
 binance:'wss://data-stream.binance.vision/stream?streams=btcusdt@aggTrade/btcusdt@depth5',
 coinbase:'wss://ws-feed.exchange.coinbase.com'
});
export const spotDepthSnapshotUrl='https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=5000';
const positive=x=>Number.isFinite(Number(x))&&Number(x)>0;
function levels(raw,bids){
 if(!Array.isArray(raw)||raw.length<1||raw.length>5)throw Error('Invalid depth length');
 const xs=raw.map(r=>{if(!Array.isArray(r)||r.length!==2||!r.every(positive))throw Error('Invalid depth level');return r.map(Number);});
 if(xs.some((r,i)=>i&&(bids?r[0]>=xs[i-1][0]:r[0]<=xs[i-1][0])))throw Error('Depth order invalid');return xs;
}
export function normalizeSpot(venue,raw,receivedAt,connectionId){
 const base={venue,receivedAt,connectionId};
 if(venue==='binance'){
  const d=raw.data;
  if(raw.stream==='btcusdt@aggTrade'&&d?.e==='aggTrade'&&d.s==='BTCUSDT'){
   if(!positive(d.p)||!positive(d.q)||![d.a,d.f,d.l,d.T,d.E].every(Number.isSafeInteger)||d.l<d.f||typeof d.m!=='boolean'||d.E<d.T)throw Error('Invalid aggregate trade');
   return {...base,kind:'trade',symbol:'BTCUSDT',quote:'USDT',sequence:d.a,sourceAt:d.T,publishedAt:d.E,
    price:Number(d.p),quantity:Number(d.q),tradeCount:d.l-d.f+1,takerSide:d.m?'sell':'buy'};
  }
  if(raw.stream==='btcusdt@depth5'&&d){
   const bids=levels(d.bids,true),asks=levels(d.asks,false);
   if(!Number.isSafeInteger(d.lastUpdateId)||bids[0][0]>=asks[0][0])throw Error('Invalid depth identity or crossing');
   return {...base,kind:'depth',symbol:'BTCUSDT',quote:'USDT',sequence:d.lastUpdateId,sourceAt:null,publishedAt:null,
    sourceTimeBasis:'not-provided-by-partial-depth-stream',bids,asks};
  }
 }else if(venue==='coinbase'&&raw.type==='ticker'&&raw.product_id==='BTC-USD'){
  const sourceAt=Date.parse(raw.time),bid=Number(raw.best_bid),ask=Number(raw.best_ask);
  if(!positive(raw.price)||!positive(bid)||!positive(ask)||bid>=ask||!Number.isFinite(sourceAt)||!Number.isSafeInteger(raw.sequence))throw Error('Invalid Coinbase ticker');
  return {...base,kind:'ticker',symbol:'BTC-USD',quote:'USD',sequence:raw.sequence,sourceAt,publishedAt:null,
   price:Number(raw.price),bid,ask,bidSize:positive(raw.best_bid_size)?Number(raw.best_bid_size):null,
   askSize:positive(raw.best_ask_size)?Number(raw.best_ask_size):null,sourceTimeBasis:'last-match-time',volumeCompleteness:'ticker-batches-matches-not-total-trade-flow'};
 }
 return null;
}
export class SpotFeed {
 constructor({onData=()=>{},onStatus=()=>{},onRaw=null,captureDepthDiff=false,clock=Date.now,wallClock=Date.now,socketFactory=url=>new WebSocket(url),fetchSnapshot=fetch,snapshotRetryMs=15000 }={}){
  this.onData=onData;this.onStatus=onStatus;this.onRaw=onRaw;this.captureDepthDiff=captureDepthDiff;this.clock=clock;this.wallClock=wallClock;this.fetchSnapshot=fetchSnapshot;this.snapshotRetryMs=Math.max(1000,snapshotRetryMs);this.socketFactory=socketFactory;this.running=false;this.states={};this.timers=new Set();this.serial=0;
 }
 later(fn,ms){const t=setTimeout(()=>{this.timers.delete(t);if(this.running)fn();},ms);this.timers.add(t);return t;}
 emitRaw(row){if(typeof this.onRaw==='function')try{this.onRaw({schema:'btc-orderflow-raw-v1',...row});}catch{/* Raw research cannot affect the established P2 or trading feeds. */}}
 status(venue,state,extra={}){const time=this.clock();this.emitRaw({kind:'feed-status',venue,state,time,receivedAt:time,rawWallReceivedAt:this.wallClock(),...extra});try{this.onStatus({venue,state,time,...extra});}catch{/* Optional research is isolated. */}}
 start(){if(this.running)return;this.running=true;for(const venue of Object.keys(spotEndpoints))this.connect(venue);}
 stop(){this.running=false;for(const t of this.timers)clearTimeout(t);this.timers.clear();for(const [v,s] of Object.entries(this.states)){s.snapshotAbort?.abort();if(s.ws.readyState<2)s.ws.close();this.status(v,'stopped',{connectionId:s.connectionId});}this.states={};}
 requestDepthSnapshot(reason='requested'){
  const state=this.states.binance;
  if(!this.running||!this.captureDepthDiff||!state?.opened)return false;
  if(state.snapshotPending){state.snapshotAgain=reason;return true;}if(state.snapshotScheduled)return false;
  const wait=Math.max(0,(state.snapshotRequestedAt??-Infinity)+this.snapshotRetryMs-this.clock());
  if(wait){state.snapshotScheduled=true;this.later(()=>{state.snapshotScheduled=false;if(this.states.binance===state)this.requestDepthSnapshot(reason);},wait);return true;}
  state.snapshotPending=true;state.snapshotRequestedAt=this.clock();state.snapshotAbort=new AbortController();
  const requestStartedAt=this.clock(),rawWallRequestStartedAt=this.wallClock();
  this.emitRaw({kind:'snapshot-request',venue:'binance',connectionId:state.connectionId,url:spotDepthSnapshotUrl,reason,requestStartedAt,receivedAt:requestStartedAt,rawWallRequestStartedAt});
  void (async()=>{
   try{
    const response=await this.fetchSnapshot(spotDepthSnapshotUrl,{signal:AbortSignal.any([state.snapshotAbort.signal,AbortSignal.timeout(6000)])});
    const rawText=await response.text();
    if(!this.running||this.states.binance!==state)return;
    if(rawText.length>2*1024*1024)throw Error('Depth snapshot body exceeds 2 MiB safety bound');
    const receivedAt=this.clock();
    this.emitRaw({kind:'depth-snapshot',venue:'binance',symbol:'BTCUSDT',quote:'USDT',connectionId:state.connectionId,url:spotDepthSnapshotUrl,reason,requestStartedAt,rawWallRequestStartedAt,receivedAt,rawWallReceivedAt:this.wallClock(),httpStatus:response.status,rawText,sourceAt:null,sourceTimeBasis:'snapshot-has-update-id-no-source-time'});
    if(!response.ok)throw Error(`Depth snapshot HTTP ${response.status}`);
   }catch(error){if(this.running&&this.states.binance===state){this.status('binance','snapshot-error',{connectionId:state.connectionId,message:error.message});this.later(()=>this.requestDepthSnapshot('snapshot-error-retry'),this.snapshotRetryMs);}}
   finally{state.snapshotPending=false;if(state.snapshotAgain&&this.running&&this.states.binance===state){const again=state.snapshotAgain;state.snapshotAgain=null;this.requestDepthSnapshot(again);}}
  })();return true;
 }
 connect(venue){
  if(!this.running)return;
  const previous=this.states[venue],attempt=(previous?.attempt??0)+1,connectionId=`${venue}:${this.clock()}:${++this.serial}`;
  const endpoint=spotEndpoints[venue]+(venue==='binance'&&this.captureDepthDiff?'/btcusdt@depth@100ms':'');
  let ws;try{ws=this.socketFactory(endpoint);}catch(e){this.status(venue,'error',{message:e.message});this.later(()=>this.connect(venue),5000);return;}
  const state=this.states[venue]={ws,attempt,connectionId,lastMessage:this.clock(),lastData:this.clock(),opened:false};
  this.status(venue,'connecting',{connectionId});
  const current=()=>this.running&&this.states[venue]===state;
  ws.addEventListener('open',()=>{if(!current()){ws.close();return;}state.opened=true;this.status(venue,'connected',{connectionId});if(venue==='coinbase')ws.send(JSON.stringify({type:'subscribe',product_ids:['BTC-USD'],channels:['ticker','heartbeat']}));if(venue==='binance'&&this.captureDepthDiff)this.requestDepthSnapshot('connection-open');});
  ws.addEventListener('message',({data})=>{
   if(!current())return;state.lastMessage=this.clock();const receivedAt=state.lastMessage,rawWallReceivedAt=this.wallClock(),rawText=typeof data==='string'?data:String(data);
   try{
    let raw;try{raw=JSON.parse(data);}catch(error){this.emitRaw({kind:'ws-raw',venue,connectionId,receivedAt,rawWallReceivedAt,rawText,parseError:error.message});throw error;}
    const payload=raw.data??raw,sourceAt=venue==='binance'?(payload.T??payload.E??null):(typeof raw.time==='string'?Date.parse(raw.time):null);
    this.emitRaw({kind:'ws-raw',venue,connectionId,receivedAt,rawWallReceivedAt,rawText,stream:raw.stream??raw.type??null,sourceAt:Number.isFinite(sourceAt)?sourceAt:null,publishedAt:venue==='binance'?(payload.E??null):null,sourceTimeBasis:payload.e==='aggTrade'?'venue-match-time':payload.e==='depthUpdate'?'venue-event-time':venue==='coinbase'?'last-match-time':'not-provided'});
    if(raw.type==='error'||raw.data?.e==='serverShutdown'){this.status(venue,'error',{message:raw.message??'server shutdown',connectionId});ws.close();return;}
    const row=normalizeSpot(venue,raw,receivedAt,connectionId);if(row){state.lastData=this.clock();state.attempt=0;this.onData(row);}
   }catch(e){this.status(venue,'rejected',{message:e.message,connectionId});}
  });
  ws.addEventListener('error',()=>{if(current()){this.status(venue,'error',{connectionId,message:'Public spot socket error'});ws.close();}});
  ws.addEventListener('close',()=>{state.snapshotAbort?.abort();if(current()){this.status(venue,'disconnected',{connectionId});this.later(()=>this.connect(venue),Math.min(30000,2000*2**Math.min(state.attempt,4)));}});
  const watch=()=>{if(!current())return;if(!state.opened||this.clock()-state.lastMessage>15000||this.clock()-state.lastData>30000){this.status(venue,'stale',{connectionId});ws.close();}else this.later(watch,5000);};
  this.later(watch,10000);
 }
}
