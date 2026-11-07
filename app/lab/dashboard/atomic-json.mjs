import { writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class PersistenceError extends Error {
  constructor(error, target, temporary) {
    super(`本地状态保存失败（${error.code ?? 'IO'}）：${target}`, { cause: error });
    this.target = target; this.temporary = temporary; this.code = error.code;
  }
}
const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Keep the last good destination intact. Never unlink it to bypass a Windows sharing lock.
// All callers serialize state changes. A rare contention retry blocks for at most 310 ms.
export function writeJsonAtomic(target, value, { rename = renameSync, write = writeFileSync, wait = pause } = {}) {
  const temporary = `${target}.${randomUUID()}.tmp`, delays = [10, 20, 40, 80, 160];
  try {
    // Flush the completed candidate before publishing it. Rename alone does
    // not ensure the data has left the OS write cache before a power loss.
    write(temporary, JSON.stringify(value), { flag: 'wx', flush: true });
    for (let attempt = 0; ; attempt++) {
      try { rename(temporary, target); return; }
      catch (error) {
        if (!transient.has(error.code) || attempt === delays.length) throw error;
        wait(delays[attempt]);
      }
    }
  } catch (error) {
    // Preserve the failed candidate snapshot for reconciliation; old target is untouched.
    throw new PersistenceError(error, target, temporary);
  }
}
