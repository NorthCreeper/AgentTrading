import { performance } from 'node:perf_hooks';

export const runtimeClockVersion = 'verified-utc-monotonic-v2';
const endpoints = [
  { name: 'binance', url: 'https://api.binance.com/api/v3/time', parse: x => x.serverTime, precisionMs: 1 },
  { name: 'coinbase', url: 'https://api.exchange.coinbase.com/time', parse: x => x.epoch * 1000, precisionMs: 1000 },
];

export function clockInterval(samples, { driftMs = 100, maxWidthMs = 1000 } = {}) {
  if (!Array.isArray(samples) || !endpoints.every(e => samples.filter(s => s.name === e.name).length >= 2))
    throw Error('Two fresh measurements from each independent UTC clock are required');
  const bounds = samples.map(s => {
    if (![s.wallStart, s.wallEnd, s.serverMs, s.elapsedMs, s.precisionMs].every(Number.isFinite) ||
        s.wallEnd < s.wallStart || s.elapsedMs < 0 || s.elapsedMs > 2000 ||
        Math.abs(s.wallEnd - s.wallStart - s.elapsedMs) > 50 || s.precisionMs < 1 ||
        s.cached || s.serverMs <= 0) throw Error('Unusable UTC clock measurement');
    return { lower: s.serverMs - s.wallEnd, upper: s.serverMs + s.precisionMs - s.wallStart };
  });
  const lower = Math.max(...bounds.map(s => s.lower)) - driftMs;
  const upper = Math.min(...bounds.map(s => s.upper)) + driftMs;
  if (lower > upper || upper - lower > maxWidthMs || Math.abs(lower) > 60000 || Math.abs(upper) > 60000)
    throw Error('UTC clock measurements disagree or uncertainty is too large');
  return { lower, upper, widthMs: upper - lower };
}

export class RuntimeClock {
  constructor({ wall = Date.now, mono = () => performance.now(), fetcher = fetch,
    validityMs = 900000, refreshMs = 60000, transitionQuietMs = 120000 } = {}) {
    this.wall = wall; this.mono = mono; this.fetcher = fetcher;
    this.validityMs = validityMs; this.refreshMs = refreshMs;
    this.transitionQuietMs=transitionQuietMs;this.pendingForward=null;
    this.anchorMono = mono(); this.anchorUtc = wall(); this.last = this.anchorUtc;
    this.calibration = null; this.error = null; this.timer = null;
    this.attemptSequence=0;this.lastAttempt=null;
    this.now = this.now.bind(this); this.status = this.status.bind(this);
  }
  now() {
    this.finishForwardTransition();
    const projected = this.anchorUtc + this.mono() - this.anchorMono;
    this.last = Math.max(this.last, projected);
    return Math.floor(this.last);
  }
  status() {
    this.finishForwardTransition();
    const ageMs = this.calibration ? this.mono() - this.calibration.monoAt : null;
    const catchupMs = this.calibration ? Math.max(0, this.calibration.waitUntilMono - this.mono()) : 0;
    const readinessReason=!this.calibration?'never-calibrated':this.pendingForward?'forward-epoch-wait':
      catchupMs>0?'utc-catchup-wait':ageMs>this.validityMs?'calibration-expired':'verified';
    return { version: runtimeClockVersion, ready: Boolean(this.calibration && ageMs <= this.validityMs && catchupMs === 0 && !this.pendingForward),
      waitingForUtcCatchup:catchupMs>0,catchupMs,
      forwardReanchorPending:Boolean(this.pendingForward),
      transitionRemainingMs:this.pendingForward?Math.max(0,this.pendingForward.quietUntilMono-this.mono()):0,
      calibratedAt: this.calibration?.utcAt ?? null, calibrationAgeMs: ageMs,
      uncertaintyMs: this.calibration?.interval.widthMs ?? null,
      localWallOffsetMs: this.now() - this.wall(), error: this.error,
      readinessReason,validityMs:this.validityMs,lastAttempt:this.lastAttempt?structuredClone(this.lastAttempt):null,
      semantics: 'Verified UTC interval with a continuous monotonic anchor; source timestamps unchanged; large forward changes require a quiet epoch',
      samples: this.calibration?.samples ?? [], systemClockChanged: false };
  }
  finishForwardTransition(){
    const p=this.pendingForward;if(!p||this.mono()<p.quietUntilMono||this.mono()-p.monoAt>this.validityMs)return;
    const at=this.mono(),target=p.utcAt+at-p.monoAt;
    this.last=Math.max(this.last,target);this.anchorUtc=this.last;this.anchorMono=at;
    this.calibration={...p,utcAt:Math.floor(target),waitUntilMono:at};this.pendingForward=null;this.error=null;
  }
  async sample(endpoint,attempt=null) {
    const wallStart = this.wall(), monoStart = this.mono();
    let stage='transport',httpStatus=null;
    try {
    const response = await this.fetcher(endpoint.url, { headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(5000) });
    httpStatus=response.status??null;stage='http-status';
    if (!response.ok) throw Error(`${endpoint.name} UTC clock HTTP ${response.status}`);
    stage='response-parse';
    const data = await response.json(), wallEnd = this.wall(), monoEnd = this.mono();
    const age = response.headers.get('age'), cache = response.headers.get('cf-cache-status');
    const sample={ name: endpoint.name, wallStart, wallEnd, monoEnd, elapsedMs: monoEnd - monoStart,
      serverMs: endpoint.parse(data), precisionMs: endpoint.precisionMs,
      cached: age !== null && Number(age) > 0 || /^(HIT|STALE|UPDATING|REVALIDATED)$/i.test(cache ?? '') };
    attempt?.samples.push(sample);return sample;
    } catch(error) {
      attempt?.failures.push({source:endpoint.name,stage,httpStatus,elapsedMs:this.mono()-monoStart,
        errorName:String(error.name??'Error').slice(0,80),message:String(error.message??error).slice(0,240),
        causeCode:typeof error.cause?.code==='string'?error.cause.code.slice(0,80):null});
      throw error;
    }
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const attempt={id:++this.attemptSequence,rawWallStartedAt:this.wall(),rawWallFinishedAt:null,durationMs:null,
        result:'pending',stage:'measurements',reason:null,samples:[],failures:[],interval:null,
        semantics:'Diagnostic wall times are unverified; failed samples never replace the accepted calibration'};
      const attemptMono=this.mono();
      try {
        const batchWall = this.wall(), batchMono = this.mono();
        // Wait for both bounded groups so a fast failure does not hide the other
        // source's result or let an unfinished batch overlap the next refresh.
        const groups = await Promise.allSettled(endpoints.map(async endpoint => [await this.sample(endpoint,attempt), await this.sample(endpoint,attempt)]));
        const failed=groups.find(g=>g.status==='rejected');if(failed)throw failed.reason;
        attempt.stage='interval-validation';
        const samples = groups.flatMap(g=>g.value), interval = clockInterval(samples), monoAt = this.mono();
        attempt.interval=interval;attempt.stage='wall-stability';
        if (Math.abs(this.wall() - batchWall - (monoAt - batchMono)) > 50)
          throw Error('System clock changed during UTC calibration');
        const lastSample = samples.reduce((a, b) => a.monoEnd > b.monoEnd ? a : b);
        const utcAt = lastSample.wallEnd + interval.upper + monoAt - lastSample.monoEnd;
        const utcLower=lastSample.wallEnd+interval.lower+monoAt-lastSample.monoEnd;
        // Initial local-wall readings are never accepted as UTC observations.
        const previous = this.calibration ? this.now() : -Infinity;
        attempt.stage='anchor';
        if(this.pendingForward||this.calibration&&previous<utcLower){
          // Never advance a committed maker/confirmation/research timer by a
          // positive calibration step. Pause new processing for the maximum
          // supported relative timer lifetime before establishing a fresh epoch.
          const quietUntilMono=this.pendingForward?.quietUntilMono??monoAt+this.transitionQuietMs;
          this.pendingForward={interval,samples,monoAt,utcAt,quietUntilMono};
          this.error='UTC forward correction: waiting for a clean timing epoch';
          attempt.result='forward-epoch-wait';attempt.reason=this.error;
        } else {
        const correction = Math.max(0, previous - utcAt);
        // Keep observations monotonic without preserving a permanent fast-clock
        // bias. During a large correction, disable trading until UTC catches up.
        const anchoredUtc=Number.isFinite(previous)&&previous>=utcLower&&previous<=utcAt?previous:utcAt;
        this.anchorMono = monoAt; this.anchorUtc = anchoredUtc; this.last = Math.max(previous,anchoredUtc);
        this.calibration = { interval, samples, monoAt, utcAt: Math.floor(utcAt),
          waitUntilMono:monoAt+(correction>1000?correction:0) };
        this.error = null;
        attempt.result=correction>1000?'utc-catchup-wait':'accepted';
        }
      } catch (error) { this.error = error.message;attempt.result='failed';attempt.reason=String(error.message??error).slice(0,240); }
      attempt.rawWallFinishedAt=this.wall();attempt.durationMs=this.mono()-attemptMono;this.lastAttempt=attempt;
      return this.status();
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  start() { this.timer ??= setInterval(() => void this.refresh(), this.refreshMs); this.timer.unref(); }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

export async function createRuntimeClock(options = {}) {
  const clock = new RuntimeClock(options);
  await clock.refresh(); clock.start(); return clock;
}
