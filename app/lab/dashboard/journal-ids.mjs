import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// Constructors need a synchronous recovery barrier before flushing their outbox.
// Bound the decoded text to one record rather than the append-only file's size.
export function readJournalIds(path, { chunkBytes = 64 * 1024, maxLineBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 ||
      !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw Error('Invalid journal read limits');
  const ids = new Set();
  if (!existsSync(path)) return ids;
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(Math.min(chunkBytes, maxLineBytes + 1));
  const decoder = new StringDecoder('utf8');
  let pending = '', lineNumber = 0;
  const fail = reason => Error(`${reason} at journal line ${lineNumber + 1}: ${path}; preserve original evidence`);
  const accept = line => {
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) throw fail('Journal record exceeds recovery limit');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line) {
      let row;
      try { row = JSON.parse(line); } catch { throw fail('Invalid journal JSON'); }
      if (!row || Array.isArray(row) || typeof row.id !== 'string' || !row.id)
        throw fail('Journal record has no durable ID');
      ids.add(row.id);
    }
    lineNumber++;
  };
  try {
    let size;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      pending += decoder.write(buffer.subarray(0, size));
      let start = 0, newline;
      while ((newline = pending.indexOf('\n', start)) !== -1) {
        accept(pending.slice(start, newline)); start = newline + 1;
      }
      pending = pending.slice(start);
      if (Buffer.byteLength(pending, 'utf8') > maxLineBytes) throw fail('Journal record exceeds recovery limit');
    }
    pending += decoder.end();
    // Appending after even a valid JSON record without its newline corrupts the
    // journal. Recovery must stop before an outbox flush can append anything.
    if (pending) throw fail('Incomplete journal tail (missing newline)');
    return ids;
  } finally { closeSync(fd); }
}
