// A slow/background browser must not accumulate an unbounded queue of full
// account snapshots. Keep only the newest unsent UI state; trading journals
// are written independently and never dropped here.
export function snapshotWriter(response) {
  let blocked = false, latest = null, closed = false;
  const send = state => {
    if (closed || response.destroyed) return;
    if (blocked) { latest = state; return; }
    blocked = !response.write(`data: ${JSON.stringify(state)}\n\n`);
  };
  const drain = () => {
    if (closed) return;
    blocked = false;
    const state = latest; latest = null;
    if (state !== null) send(state);
  };
  response.on('drain', drain);
  return { send, close() { closed = true; latest = null; response.off('drain', drain); } };
}
