import {createHash} from 'node:crypto';

export const rayEntryTimingVersion='ray-qualified-source-event-v1';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validAttempt=a=>a&&a.version===rayEntryTimingVersion&&typeof a.slug==='string'&&/^btc-updown-5m-\d+$/.test(a.slug)&&
 ['Up','Down'].includes(a.outcome)&&/^[a-f0-9]{64}$/.test(a.bookKey)&&/^[a-f0-9]{64}$/.test(a.decisionKey)&&Number.isFinite(a.at)&&a.at>=0;

// A fresh receipt of an unchanged source book is not new executable liquidity.
// The controller still evaluates every frame/reference event. Only an eligible
// submission consumes a source version, and a positive fill retains the existing
// durable per-market entry lock independently of this retry guard.
export class RayEntryTrigger {
 constructor(saved=null){
  this.lastAttempt=null;this.recentAttempts=[];this.lastEvaluation=null;this.attempts=0;this.suppressedSameSource=0;this.restoreError=null;
  if(saved){
   if(saved.version!==rayEntryTimingVersion||saved.lastAttempt!==null&&!validAttempt(saved.lastAttempt)||
    saved.recentAttempts!==undefined&&(!Array.isArray(saved.recentAttempts)||saved.recentAttempts.length>256||saved.recentAttempts.some(a=>!validAttempt(a))))
    this.restoreError='入场事件缓存无效，自动入场阻断，需核对恢复记录';
   else {this.lastAttempt=saved.lastAttempt?structuredClone(saved.lastAttempt):null;
    this.recentAttempts=structuredClone(saved.recentAttempts??(this.lastAttempt?[this.lastAttempt]:[]));
    this.attempts=Number.isSafeInteger(saved.attempts)&&saved.attempts>=0?saved.attempts:0;
    this.suppressedSameSource=Number.isSafeInteger(saved.suppressedSameSource)&&saved.suppressedSameSource>=0?saved.suppressedSameSource:0;}
  }
 }
 plan({frame,reference,candidate,now,triggerSource='frame'}={}){
  const m=frame?.market,side=candidate?.outcome;
  if(!m||!['Up','Down'].includes(side)||!Number.isFinite(now)||!candidate.eligible)return null;
  const books=['Up','Down'].map(outcome=>frame.books?.find(b=>b.tokenId===m.tokens?.[outcome]));
  if(books.some(b=>!b||!Number.isFinite(b.timestamp)||b.timestamp>now||!Array.isArray(b.bids)||!Array.isArray(b.asks)))return null;
  const bookKey=digest([m.slug,m.conditionId,m.tokens,side,books.map(b=>[b.tokenId,b.timestamp,b.sourceHash??null,b.bids,b.asks])]);
  const decisionKey=digest([bookKey,reference?.timestamp,reference?.valueE18,frame.rayOpening?.valueE18??frame.rayOpening?.value]);
  const plan={version:rayEntryTimingVersion,slug:m.slug,outcome:side,bookKey,decisionKey,at:now,triggerSource,
   frameAt:frame.now,referenceAt:reference?.timestamp??null,referenceKnownAt:reference?.receivedAt??null,
   books:books.map(b=>({tokenId:b.tokenId,timestamp:b.timestamp,receivedAt:b.receivedAt,sourceHash:b.sourceHash??null}))};
  this.recentAttempts=this.recentAttempts.filter(a=>a.slug===m.slug&&a.at>=now-60000);
  this.lastEvaluation={...plan,eligible:true,allowed:!this.restoreError&&!this.recentAttempts.some(a=>a.bookKey===bookKey)};
  if(this.restoreError)return {...plan,allowed:false,reason:'retry-cache-invalid'};
  if(!this.lastEvaluation.allowed){this.suppressedSameSource++;return {...plan,allowed:false,reason:'same-book-source-already-attempted'};}
  return {...plan,allowed:true};
 }
 remember(plan){
  if(plan?.allowed!==true||!validAttempt(plan))throw Error('Invalid eligible source attempt');
  this.lastAttempt=structuredClone(plan);this.recentAttempts.push(structuredClone(plan));
  if(this.recentAttempts.length>256)this.recentAttempts.shift();this.attempts++;
 }
 saved(){return {version:rayEntryTimingVersion,lastAttempt:this.lastAttempt?structuredClone(this.lastAttempt):null,recentAttempts:structuredClone(this.recentAttempts),
  attempts:this.attempts,suppressedSameSource:this.suppressedSameSource};}
 summary(){return {...this.saved(),mode:'event-driven',fixedDecisionSlotMs:null,restoreError:this.restoreError,
  lastEvaluation:this.lastEvaluation?structuredClone(this.lastEvaluation):null,
  semantics:'Eligible orders are checked on new data events; unchanged source liquidity is not retried after zero fill. Positive entry lock is separate.'};}
}
