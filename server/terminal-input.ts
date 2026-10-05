// Keys that people type into an agent through the dashboard terminals (pty.ts), for message delivery (deliver-text.ts).
// - lastKeyAt: when a dashboard terminal last sent input to a session. A draft that a person typed counts as finished
//   only after 3 s without a key, so Taskboard does not move it out of the box while the person types.
// - hold: while Taskboard moves a draft out of the box, types a message and puts the draft back, keys from the dashboard
//   wait in a list and reach the agent after that, in their order. Without the hold, a key typed in those 2 to 4 s would
//   land in the middle of the message or of the restored draft. A hold ends by itself after HOLD_MAX_MS.
export const HOLD_MAX_MS = 20_000;

const keyAt = new Map<string, number>();
export const noteKey = (session: string) => keyAt.set(session, Date.now());
export const lastKeyAt = (session: string) => keyAt.get(session) || 0;

interface Hold { writes: (() => void)[]; timer: NodeJS.Timeout }
const holds = new Map<string, Hold>();

// Runs the write now, or later when a hold is active for the session.
export function write(session: string, fn: () => void) {
  const h = holds.get(session);
  if (h) h.writes.push(fn); else fn();
}

// Starts a hold and returns the function that ends it. Ending it twice does nothing.
export function hold(session: string): () => void {
  const old = holds.get(session);
  if (old) return () => { /* an outer hold ends it */ };
  const h: Hold = { writes: [], timer: setTimeout(() => release(), HOLD_MAX_MS) };
  h.timer.unref?.();
  holds.set(session, h);
  let done = false;
  function release() {
    if (done) return; done = true;
    clearTimeout(h.timer);
    if (holds.get(session) === h) holds.delete(session);
    for (const fn of h.writes) { try { fn(); } catch { /* the terminal closed */ } }
  }
  return release;
}
export const held = (session: string) => holds.has(session);
