import { normalizeMarket, normalizeBookPair, normalizeTwap, roundSlug } from '../market.mjs';
import {bookSequenceIssue} from './book-sequence.mjs';
import {SpotFeed} from './spot-feed.mjs';
import {selectResolutionCheck} from './resolution-scheduling.mjs';
import {chainlinkSpot,chooseRayOpening,twapOpeningRow,gammaRayOpening,lockRayOpening} from './ray-opening.mjs';
import {getGammaMarketBySlug,publicRequestError} from './gamma-market.mjs';

export class PublicFeed {
  running = false;
  cache = null;
  twap = null;
  timers = new Set();
  metadataRequest = null;
  metadataRetryAt = 0;
  runGeneration = 0;
  constructor({ onFrame, onStatus, onPrice = () => {}, onDiagnostic = () => {}, onSpot = () => {}, onSpotStatus = () => {}, onSpotRaw = null, captureSpotDepthDiff = false, initialBooks = [], initialRayOpening = null, initialTwapRows = [], resolutionMarkets = [], onResolution = async () => false, priorityResolutionMarkets = () => [], clock = Date.now, clockStatus = () => ({ready:true}),twapSocketFactory=url=>new WebSocket(url) }) {
    this.clock = clock; this.clockStatus = clockStatus; this.onFrame = onFrame; this.onStatus = onStatus; this.onPrice = onPrice; this.onResolution = onResolution;this.twapSocketFactory=twapSocketFactory;
    this.chainlinkSpotRows=[];
    this.openingTwapRows=initialTwapRows.map(twapOpeningRow).filter(r=>r&&r.knownAt<=this.clock()&&r.referenceAt>=this.clock()-600000);
    this.savedRayOpening=initialRayOpening;
    this.onDiagnostic=onDiagnostic;
    this.spot=new SpotFeed({onData:onSpot,onStatus:onSpotStatus,onRaw:onSpotRaw,captureDepthDiff:captureSpotDepthDiff,clock});
    this.lastBooks=new Map(initialBooks.map(b=>[b.tokenId,b]));
    this.resolutionQueue = new Map(resolutionMarkets.map(m => [m.slug, { market: m, checkedAt: 0 }]));
    this.priorityResolutionMarkets = priorityResolutionMarkets; this.resolutionPriorityStreak = 0;
  }
  later(fn, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (this.running) fn(); }, ms);
    this.timers.add(timer); return timer;
  }
  async get(url) {
    const at = this.clock(), rawWallRequestStartedAt = Date.now();
    let response;
    try {
      response=await fetch(url, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(6000)]) });
      if (!response.ok) {
        const error=new Error(`HTTP ${response.status}`);
        error.httpStatus=response.status;error.failureType='http-status';
        error.responseHeaders=Object.fromEntries(['date','content-type','server','cf-ray','cf-cache-status','age','x-cache']
          .map(name=>[name,response.headers?.get(name)]).filter(([,value])=>value!=null));
        try{error.responseBodyExcerpt=(await response.text()).slice(0,512);}catch{/* The status is still evidence if its body is unavailable. */}
        throw error;
      }
      const data=await response.json(),receivedAt=this.clock();
      return { data, latency: receivedAt - at, requestStartedAt:at,transportReceivedAt:receivedAt,rawWallRequestStartedAt,rawWallTransportReceivedAt:Date.now() };
    } catch(error) {
      error.requestUrl=url;error.requestStartedAt=at;error.failedAt=this.clock();
      error.failureType??=response?'response-parse':'transport';
      throw error;
    }
  }
  getGammaMarket(slug) {
    return getGammaMarketBySlug(url=>this.get(url),slug,row=>this.diagnostic(row));
  }
  start() {
    this.runGeneration++;this.metadataRequest=null;this.metadataRetryAt=0;
    this.running = true; this.abort = new AbortController();
    this.connect(); void this.poll(); void this.pollResolutions();
    try{this.spot.start();}catch{/* External research must not stop the main feed. */}
  }
  stop() {
    this.runGeneration++;this.metadataRequest=null;
    this.running = false; this.abort?.abort();
    try{this.spot.stop();}catch{/* Optional research shutdown cannot block main shutdown. */}
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const socket=this.ws;this.ws=null;if(socket&&socket.readyState<WebSocket.CLOSING)socket.close();
    this.twap = null;
  }
  status(name, state, extra = {}) {
    if (this.running) this.onStatus({ name, state, now: this.clock(), ...extra });
  }
  diagnostic(row) {
    if(this.running)try{this.onDiagnostic({time:this.clock(),...row});}catch{/* Research must not stop the feed. */}
  }
  refreshMetadata(slug) {
    if(this.metadataRequest?.slug===slug)return this.metadataRequest.promise;
    const request={slug,generation:this.runGeneration,promise:null};
    this.metadataRequest=request;
    request.promise=(async()=>{
      try {
        const gamma=await this.getGammaMarket(slug);
        const clob=await this.get(`https://clob.polymarket.com/clob-markets/${gamma.data.conditionId}`);
        const now=this.clock();
        if(!this.running||request.generation!==this.runGeneration||this.metadataRequest!==request||
          roundSlug(now)!==slug||!this.clockStatus().ready)throw Error('Metadata response no longer belongs to the active clock/round');
        const market=normalizeMarket(gamma.data,clob.data,now);
        const openingMetadata=gamma.data.events?.find(e=>e.slug===market.slug)?.eventMetadata?.priceToBeat??null;
        this.cache={market,at:now,openingMetadata,openingEvidence:gammaRayOpening(market,gamma.data,gamma.transportReceivedAt??now)};
        this.metadataRetryAt=0;
        this.diagnostic({kind:'market-discovered',market,metadataReceivedAt:now,
          gammaLookupSource:gamma.lookupSource??'slug-path',openingMetadata,
          refreshPolicy:'overlap-at-5s-expire-at-10s-v1'});
        this.status('market','connected',{latency:gamma.latency+clob.latency,verifiedAt:now,
          refreshPolicy:'overlap-at-5s-expire-at-10s-v1'});
        return this.cache;
      } catch(error) {
        if(this.running&&request.generation===this.runGeneration&&this.metadataRequest===request){
          const transport=['transport','http-status'].includes(error.failureType)||
            (error.failureType==='metadata-lookup'&&error.lookupRequests?.length>0&&error.lookupRequests.every(r=>['transport','http-status'].includes(r.failureType)));
          // An explicit invalid/closed market is not a transient transport failure.
          if(!transport||this.cache?.market.slug!==roundSlug(this.clock()))this.cache=null;
          this.metadataRetryAt=this.clock()+1000;
          this.status('market','error',{stage:'market',...publicRequestError(error)});
          this.diagnostic({kind:'market-metadata-refresh-error',slug,cacheRetained:Boolean(this.cache),...publicRequestError(error)});
        }
        throw error;
      } finally {if(this.metadataRequest===request)this.metadataRequest=null;}
    })();
    return request.promise;
  }
  rememberOpeningTwap(normalized) {
    const row=twapOpeningRow(normalized);
    if(!row||row.knownAt>this.clock())return;
    if(!this.openingTwapRows.some(r=>r.referenceAt===row.referenceAt&&r.valueE18===row.valueE18))this.openingTwapRows.push(row);
    this.openingTwapRows=this.openingTwapRows.filter(r=>r.referenceAt>=this.clock()-600000&&r.knownAt<=this.clock()).slice(-3000);
  }
  updateRayOpening(market,now) {
    const observed=chooseRayOpening(market,this.openingTwapRows,this.cache.openingEvidence,now);
    const previous=this.savedRayOpening;
    const opening=lockRayOpening(market,previous,observed,now);
    const changed=JSON.stringify(previous)!==JSON.stringify(opening);
    if(changed&&opening)this.diagnostic({kind:opening.status==='conflict'?'ray-opening-conflict':'ray-opening-locked',
      slug:market.slug,conditionId:market.conditionId,opening,decisionKnownAt:now});
    this.savedRayOpening=opening;
    return opening;
  }
  connect() {
    if (!this.running) return;
    if(this.ws&&this.ws.readyState<WebSocket.CLOSING)return;
    const generation=this.runGeneration,runCurrent=()=>this.running&&generation===this.runGeneration;
    this.status('twap', 'connecting');
    const ws = this.twapSocketFactory('wss://ws-live-data.polymarket.com');
    this.ws = ws;
    const current=()=>runCurrent()&&this.ws===ws;
    let lastMessage = this.clock(),openedAt=null,lastTwapAt=null,firstStaleAt=null,staleUpdates=0,lastSourceAt=null;
    const watchdog = this.later(() => ws.close(), 15_000);
    const heartbeat = () => {
      if (!current()||ws.readyState !== WebSocket.OPEN) return;
      if (this.clock() - lastMessage > 15_000) { ws.close(); return; }
      const now=this.clock(),missing=openedAt!==null&&now-(lastTwapAt??openedAt)>20000;
      const delayed=firstStaleAt!==null&&now-firstStaleAt>=10000&&staleUpdates>=3&&lastSourceAt!==null&&now-lastSourceAt>15000;
      if(this.clockStatus().ready&&(missing||delayed)){
        this.diagnostic({kind:'twap-stream-stale-reconnect',reason:missing?'no-valid-twap-updates':'sustained-delayed-twap',
          lastSourceAt,lastTwapAt,sourceAgeMs:lastSourceAt===null?null:now-lastSourceAt,
          transportIdleMs:now-lastMessage,staleUpdates,sustainedMs:firstStaleAt===null?null:now-firstStaleAt,
          semantics:'Transport heartbeat is not proof of fresh market data; original timestamps and entry freshness limits are preserved.'});
        ws.close();return;
      }
      ws.send('PING'); this.later(heartbeat, 5000);
    };
    ws.addEventListener('open', () => {
      if (!current()) { ws.close(); return; }openedAt=this.clock();
      clearTimeout(watchdog); this.timers.delete(watchdog);
      this.status('twap', 'connected');
      ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_twap_sixty',
        type: 'update', filters: '{"symbol":"btc/usd"}' },{topic:'crypto_prices_chainlink',type:'update',filters:'{"symbol":"btc/usd"}'}] }));
      this.later(heartbeat, 5000);
    });
    ws.addEventListener('message', ({ data }) => {
      if (!current()) return;
      lastMessage = this.clock();
      if (typeof data !== 'string' || !data.trim() || data === 'PONG') return;
      try {
        if (!this.clockStatus().ready) { this.status('twap', 'clock-unavailable'); return; }
        const message=JSON.parse(data),spot=chainlinkSpot(message,this.clock());
        if(spot){this.chainlinkSpotRows.push(spot);this.chainlinkSpotRows=this.chainlinkSpotRows.filter(r=>r.knownAt>=this.clock()-600000).slice(-3000);
          this.diagnostic({kind:'chainlink-reference',...spot});return;}
        const normalized = normalizeTwap(message, this.clock());
        if (normalized) normalized.rawWallReceivedAt = Date.now();
        if (normalized) {
          const observed=this.clock(),age=observed-normalized.timestamp;lastTwapAt=observed;lastSourceAt=normalized.timestamp;
          if(age>15000){firstStaleAt??=observed;staleUpdates++;}
          else if(age>=0&&age<=5000){firstStaleAt=null;staleUpdates=0;}
          const publishedAt=Number(message.timestamp);
          normalized.publishedAt=Number.isFinite(publishedAt)?publishedAt:null;
          // Keep exact opening reports even if an out-of-order update cannot
          // replace the latest live TWAP after a reconnect.
          this.rememberOpeningTwap(normalized);
          this.onPrice(normalized);
        }
        if (normalized && (!this.twap || normalized.timestamp >= this.twap.timestamp)) {
          this.twap = normalized; this.status('twap', 'connected', { observedAt: normalized.timestamp });
        }
      } catch (error) { this.status('twap', 'error', { message: error.message }); }
    });
    ws.addEventListener('error', () => { if(!current())return;this.status('twap', 'error', { message: '价格流连接失败，正在重连' }); ws.close(); });
    ws.addEventListener('close', () => {
      if(!current())return;this.ws=null;this.twap = null;
      this.status('twap', 'disconnected'); this.later(() => {if(runCurrent()&&!this.ws)this.connect();}, 2000);
    });
  }
  async poll() {
    if (!this.running) return;
    const started = this.clock();
    const generation=this.runGeneration;
    let stage='clock';
    try {
      if (!this.clockStatus().ready) throw Error('UTC 时间尚未通过独立校验，等待校时');
      const slug=roundSlug(started);
      if (!this.cache || this.cache.market.slug !== slug || started-this.cache.at<0 || started-this.cache.at>10_000) {
        stage='market';await this.refreshMetadata(slug);
      } else if(started-this.cache.at>=5000&&started>=this.metadataRetryAt){
        // Refresh early while a still-valid identity can support independent book polls.
        // Failure never extends its ten-second validity or the quote freshness limit.
        void this.refreshMetadata(slug).catch(()=>{});
      }
      const metadata=this.cache;
      if(!this.running||!metadata||metadata.market.slug!==roundSlug(this.clock()))return;
      let market = metadata.market;
      stage='book';
      if (!this.resolutionQueue.has(market.slug)) this.resolutionQueue.set(market.slug, { market, checkedAt: 0 });
      const responses = await Promise.all(Object.values(market.tokens).map(async tokenId => {
        const result = await this.get(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        this.diagnostic({kind:'book-response',slug:market.slug,tokenId,requestStartedAt:result.requestStartedAt,
          transportReceivedAt:result.transportReceivedAt,sourceAt:Number(result.data.timestamp),sourceHash:result.data.hash??null,
          latencyMs:result.latency,sourceTimestampSemantics:'unverified-server-timestamp'});
        return result;
      }));
      const rawBooks=responses.map(r=>r.data);
      const now = this.clock();
      if(!this.running||generation!==this.runGeneration)return;
      if (!this.clockStatus().ready) throw Error('UTC 时间校验已失效，等待重新校时');
      if(this.cache!==metadata||now-metadata.at<0||now-metadata.at>10000){
        this.diagnostic({kind:'book-frame-discarded',slug:market.slug,reason:this.cache!==metadata?'metadata-replaced-during-book-poll':'metadata-validity-expired',metadataVerifiedAt:metadata.at});
        return;
      }
      const pair=normalizeBookPair(rawBooks,market,now,{allowStale:true}), books=pair.books;
      for(const book of books) {
        const previous=this.lastBooks.get(book.tokenId),issue=bookSequenceIssue(previous,book);
        if(issue) {
          this.diagnostic({kind:'book-sequence-rejected',slug:market.slug,tokenId:book.tokenId,
            sourceAt:book.timestamp,previousSourceAt:previous.timestamp,issue});
          throw Error('订单簿源时间倒退或同时间内容冲突，跳过异常快照并重新确认');
        }
      }
      for(let i=0;i<books.length;i++)Object.assign(books[i],{transportReceivedAt:responses[i].transportReceivedAt,
        rawWallReceivedAt:Date.now(),rawWallTransportReceivedAt:responses[i].rawWallTransportReceivedAt,
        requestStartedAt:responses[i].requestStartedAt,sourceHash:rawBooks[i].hash??null,
        receivedAtBasis:'paired-poll-completion',sourceTimestampSemantics:'unverified-server-timestamp'});
      market=pair.market;this.cache.market=market;
      if (roundSlug(now) !== market.slug) throw new Error('盘口正在换轮');
      if (this.running) {
        this.lastBooks=new Map(books.map(b=>[b.tokenId,b]));
        const sourceAgeMs=Math.max(...books.map(b=>now-b.timestamp));
        this.status('book', sourceAgeMs>3000?'stale':'connected', {
          latency: now - started, sourceAgeMs, receivedAt:now,
          ...(sourceAgeMs>3000?{message:'订单簿接口已响应，但源报价超过 3 秒未更新；保留快照供查看，交易需等待有效行情'}:{}) });
        const {version,ready,calibratedAt,uncertaintyMs}=this.clockStatus();
        const rayOpening=this.updateRayOpening(market,now);
        this.onFrame({ type: 'frame', now, rawWallNow:Date.now(), clock:{version,ready,calibratedAt,uncertaintyMs}, market, books, twap: this.twap,rayOpening,
          marketMetadata:{verifiedAt:metadata.at,maxAgeMs:10000,refreshAfterMs:5000,policy:'overlap-at-5s-expire-at-10s-v1'} });
      }
    } catch (error) {
      if(!this.running||generation!==this.runGeneration)return;
      const slug=this.cache?.market.slug??roundSlug(started);
      // A failed book transport does not invalidate previously verified market
      // identity. Expired identity and structural validation failures do.
      const cacheRetained=this.cache?.market.slug===roundSlug(this.clock())&&
        (stage==='market'||['http-status','transport'].includes(error.failureType));
      if(!cacheRetained)this.cache=null;
      this.diagnostic({kind:'book-poll-error',stage,pollStartedAt:started,slug,
        requestedSlug:roundSlug(started),cacheRetained:Boolean(cacheRetained),...publicRequestError(error)});
      if (this.running) this.status(stage==='market'?'market':'book', 'error', { stage,...publicRequestError(error) });
    } finally {
      if (this.running&&generation===this.runGeneration) this.later(() => void this.poll(), Math.max(100, 1000 - (this.clock() - started)));
    }
  }
  async pollResolutions() {
    if (!this.running || this.resolutionPolling) return;
    this.resolutionPolling = true;
    const now = this.clock();
    let next, selected;
    try {
      if (!this.clockStatus().ready) throw Error('UTC 时间尚未通过独立校验，等待校时');
      selected = selectResolutionCheck({ queue: this.resolutionQueue, now,
        ownedSlugs: this.priorityResolutionMarkets(), priorityStreak: this.resolutionPriorityStreak });
      next = selected.next; this.resolutionPriorityStreak = selected.priorityStreak;
      if (next) {
        next.checkedAt = now; next.lastCheckReason = selected.reason;
        this.diagnostic({kind:'resolution-check-start',slug:next.market.slug,marketEnd:next.market.end,
          queueLength:this.resolutionQueue.size,eligibleQueueLength:selected.eligible,
          eligibleOwned:selected.eligibleOwned,eligibleBackground:selected.eligibleBackground,schedulingReason:selected.reason,
          expiryAgeMs:now-next.market.end});
        const [g, c] = await Promise.all([
          this.getGammaMarket(next.market.slug),
          this.get(`https://clob.polymarket.com/markets/${next.market.conditionId}`),
        ]);
        if (this.running) {
          next.lastResultAt = this.clock();
          next.lastResult = { gammaResolved:g.data.umaResolutionStatus==='resolved',gammaClosed:g.data.closed===true,
            clobClosed:c.data.closed===true,researchVerified:null };
          const verified = await this.onResolution({ market: next.market, gamma: g.data, clob: c.data, observedAt: this.clock() });
          next.lastResult.researchVerified = verified; next.lastError = null;
          this.diagnostic({kind:'resolution-check-result',slug:next.market.slug,verified,
            checkedAt:now,gammaReceivedAt:g.transportReceivedAt,clobReceivedAt:c.transportReceivedAt,
            gammaResolved:g.data.umaResolutionStatus==='resolved',gammaClosed:g.data.closed===true,clobClosed:c.data.closed===true});
          if (verified) this.resolutionQueue.delete(next.market.slug);
          this.status('resolution', verified ? 'connected' : 'pending', { slug: next.market.slug,
            eligibleOwned:selected.eligibleOwned,eligibleBackground:selected.eligibleBackground,schedulingReason:selected.reason });
        }
      }
    } catch (error) { if (next) { next.lastError = error.message; next.lastErrorAt = this.clock(); }
      this.diagnostic({kind:'resolution-check-error',slug:next?.market.slug??null,message:error.message});
      if (this.running) this.status('resolution', 'error', { message: error.message }); }
    finally { this.resolutionPolling = false; if (this.running) this.later(() => void this.pollResolutions(), 15_000); }
  }
}
