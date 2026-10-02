// When a browser terminal tells the server its size (Terminal.tsx). The server resizes the tmux window to it, and the
// agent draws its whole screen again. So a size goes to the server only when it stayed the same for `delay` ms (a drag
// changes it every frame), and only when it differs from the size that the server already has. A size that changes
// and comes back within the delay sends nothing.
export interface Timers { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: h => clearTimeout(h as ReturnType<typeof setTimeout>) };

export function sizeSender(send: (cols: number, rows: number) => boolean, delay = 100, timers: Timers = realTimers) {
  let known = '', timer: unknown;
  const flush = (cols: number, rows: number) => {
    timers.clear(timer); timer = undefined;
    if (`${cols}x${rows}` === known) return false;
    // a closed socket sends nothing; the size goes with the next connection (known) or the next change
    if (send(cols, rows)) known = `${cols}x${rows}`;
    return true;
  };
  return {
    // the server has this size: a new connection carries it in its URL
    known(cols: number, rows: number) { known = `${cols}x${rows}`; },
    changed(cols: number, rows: number) { timers.clear(timer); timer = timers.set(() => flush(cols, rows), delay); },
    flush,
    dispose() { timers.clear(timer); },
  };
}
