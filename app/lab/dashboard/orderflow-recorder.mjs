import {appendFile,mkdir,statfs} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';

const zip=promisify(gzip);
const diskFree=async directory=>{const s=await statfs(directory,{bigint:true});return Number(s.bavail*s.bsize);};

// Optional evidence only: bounded memory, asynchronous compression and writes, no
// deletion or trading halt. Each file is an ordered sequence of gzip members.
export class OrderflowRecorder {
 constructor({directory,clock=Date.now,onGap=()=>{},maxQueueBytes=8*1024*1024,maxQueueRows=20000,batchBytes=256*1024,
  rotationMs=300000,minFreeBytes=5*1024**3,diskCheckMs=30000,flushMs=250,freeBytes=diskFree,append=appendFile,compress=zip}={}){
  if(!directory)throw Error('Orderflow recording directory required');
  Object.assign(this,{directory:resolve(directory),clock,onGap,maxQueueBytes,maxQueueRows,batchBytes,rotationMs,minFreeBytes,diskCheckMs,flushMs,freeBytes,append,compress});
  this.runId=randomUUID();this.queue=[];this.queuedBytes=0;this.inFlightBytes=0;this.closed=false;this.writing=false;this.timer=null;this.sequence=0;this.lastWrittenSequence=0;
  this.counts={accepted:0,written:0,dropped:0,gapEvents:0,uncompressedBytes:0,compressedBytes:0,files:0};this.pendingGap=null;this.lastError=null;this.lastDiskCheckAt=null;this.availableBytes=null;this.files=new Set();this.waiters=[];
  this.record({kind:'recorder-start',schema:'btc-orderflow-recorder-v1',receivedAt:clock(),continuity:'new-run-no-cross-run-completeness'});
 }
 noteGap(reason,row,extra={}){
  const time=this.clock();this.counts.dropped++;
  if(!this.pendingGap){this.pendingGap={kind:'recording-gap',schema:'btc-orderflow-recorder-v1',reason,receivedAt:time,firstLostAt:row?.receivedAt??time,lastLostAt:row?.receivedAt??time,count:0,...extra};this.counts.gapEvents++;}
  this.pendingGap.count++;this.pendingGap.lastLostAt=row?.receivedAt??time;this.pendingGap.lastReason=reason;this.lastError=reason;
  try{this.onGap({...this.pendingGap});}catch{/* A research callback is isolated. */}
 }
 line(row){const data={...row,recordingRunId:this.runId,recordingSequence:++this.sequence};const text=JSON.stringify(data)+'\n';return {text,bytes:Buffer.byteLength(text),sequence:data.recordingSequence,time:Number.isFinite(row.receivedAt)?row.receivedAt:this.clock()};}
 push(item){this.queue.push(item);this.queuedBytes+=item.bytes;this.counts.accepted++;}
 record(row,allowClosed=false){
  if(this.closed&&!allowClosed)return false;
  let item,gap;try{if(this.pendingGap)gap=this.line(this.pendingGap);item=this.line(row);}catch(error){this.noteGap('serialization-failed',row,{message:error.message});return false;}
  if(item.bytes>this.maxQueueBytes||this.queuedBytes+this.inFlightBytes+item.bytes>this.maxQueueBytes||this.queue.length>=this.maxQueueRows){this.noteGap('bounded-queue-overflow',row);this.schedule();return false;}
  if(this.pendingGap){
   if(this.queuedBytes+this.inFlightBytes+gap.bytes+item.bytes>this.maxQueueBytes||this.queue.length+2>this.maxQueueRows){this.noteGap('bounded-queue-overflow',row);this.schedule();return false;}
   this.push(gap);this.pendingGap=null;
  }
  this.push(item);this.schedule();return true;
 }
 schedule(){if(!this.timer&&!this.writing&&this.queue.length){this.timer=setTimeout(()=>{this.timer=null;void this.drain();},this.flushMs);this.timer.unref?.();}}
 async drain(){
  if(this.writing)return;this.writing=true;
  try{
   await mkdir(this.directory,{recursive:true});
   while(this.queue.length){
    const now=this.clock();
    if(this.lastDiskCheckAt===null||now-this.lastDiskCheckAt>=this.diskCheckMs){this.availableBytes=await this.freeBytes(this.directory);this.lastDiskCheckAt=now;}
    if(!Number.isFinite(this.availableBytes)||this.availableBytes<this.minFreeBytes){
     const dropped=this.queue.splice(0);this.queuedBytes=0;this.lastDiskCheckAt=null;
     for(const item of dropped)this.noteGap('disk-free-space-below-floor',{receivedAt:item.time},{availableBytes:this.availableBytes,minFreeBytes:this.minFreeBytes});break;
    }
    const first=this.queue[0],bucket=Math.floor(first.time/this.rotationMs),items=[];let bytes=0;
    while(this.queue.length&&Math.floor(this.queue[0].time/this.rotationMs)===bucket&&(bytes<this.batchBytes||!items.length)){
     const item=this.queue.shift();items.push(item);bytes+=item.bytes;this.queuedBytes-=item.bytes;
    }
    this.inFlightBytes=bytes;
    try{
     const data=Buffer.from(items.map(x=>x.text).join('')),compressed=await this.compress(data,{level:3});
     if(this.availableBytes-compressed.length<this.minFreeBytes)throw Error('disk-free-space-budget-exhausted');
     const stamp=new Date(bucket*this.rotationMs).toISOString().replace(/[:.]/g,'-'),path=join(this.directory,`btc-orderflow-${stamp}-${this.runId}.jsonl.gz`);
     await this.append(path,compressed);this.availableBytes-=compressed.length;
     if(!this.files.has(path)){this.files.add(path);this.counts.files++;}
     this.lastWrittenSequence=items.at(-1).sequence;this.counts.written+=items.length;this.counts.uncompressedBytes+=bytes;this.counts.compressedBytes+=compressed.length;this.lastError=null;
    }catch(error){this.lastDiskCheckAt=null;for(const item of items)this.noteGap('asynchronous-write-failed',{receivedAt:item.time},{message:error.message});}
    this.inFlightBytes=0;
   }
  }catch(error){const dropped=this.queue.splice(0);this.queuedBytes=0;for(const item of dropped)this.noteGap('recorder-unavailable',{receivedAt:item.time},{message:error.message});}
  finally{this.inFlightBytes=0;this.writing=false;for(const resolve of this.waiters.splice(0))resolve();if(this.queue.length)this.schedule();}
 }
 async flush(){if(this.timer){clearTimeout(this.timer);this.timer=null;}if(this.writing)await new Promise(resolve=>this.waiters.push(resolve));if(this.queue.length)await this.drain();}
 close(){
  if(this.closePromise)return this.closePromise;
  this.closed=true;
  this.closePromise=(async()=>{await this.flush();this.record({kind:'recorder-stop',schema:'btc-orderflow-recorder-v1',receivedAt:this.clock()},true);await this.flush();})();
  return this.closePromise;
 }
 summary(){return {version:'btc-orderflow-recorder-v1',directory:this.directory,runId:this.runId,closed:this.closed,status:this.pendingGap?'gap':this.queuedBytes||this.inFlightBytes?'pending-write':'written',
  counts:{...this.counts},queuedRows:this.queue.length,queuedBytes:this.queuedBytes,inFlightBytes:this.inFlightBytes,lastWrittenSequence:this.lastWrittenSequence,
  availableBytes:this.availableBytes,minFreeBytes:this.minFreeBytes,maxQueueBytes:this.maxQueueBytes,maxQueueRows:this.maxQueueRows,lastError:this.lastError,pendingGap:this.pendingGap?{...this.pendingGap}:null,
  retention:'append-only-no-auto-delete',format:'UTF-8 JSONL in concatenated gzip members; abrupt termination may leave final member incomplete',durability:'write completion only; no fsync or external authenticity claim'};}
}
