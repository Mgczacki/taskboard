// Sends on a WebSocket and closes a client that does not read. A client does not read when the bytes that wait to be
// sent (ws bufferedAmount) stay above `limit` and do not fall for `graceMs`, or when they go above `hardLimit` (the
// memory that one client may hold on the server). A client that receives a large message (the task list of
// /ws/events after a connect, or a burst of terminal output) is above `limit` for a short time while it reads, and its
// bufferedAmount falls: that client stays open.
//
// Before 2026-10-04 the server closed a client when bufferedAmount was above 1 MiB at the moment of a send. With 240
// tasks the task list was about 0.99 MB, so each new dashboard was closed with 1013 right after its first messages and
// connected again, in a loop (server/index.ts sendEvent).
import type { WebSocket } from 'ws';

export interface SlowLimits { limit: number; hardLimit: number; graceMs: number }
export const EVENT_LIMITS: SlowLimits = { limit: 1_048_576, hardLimit: 16 * 1_048_576, graceMs: 10_000 };
export const TERMINAL_LIMITS: SlowLimits = { limit: 1_048_576, hardLimit: 8 * 1_048_576, graceMs: 10_000 };

// since: when bufferedAmount went above the limit, or last fell. low: the lowest bufferedAmount seen since then.
const over = new WeakMap<WebSocket, { since: number; low: number }>();
// the origin header of the upgrade request (server/index.ts), for the log line
export const clientOrigin = new WeakMap<WebSocket, string>();

export type SlowVerdict = { slow: false } | { slow: true; why: string };
export function checkSlow(ws: WebSocket, l: SlowLimits, now = Date.now()): SlowVerdict {
  const n = ws.bufferedAmount;
  if (n <= l.limit) { over.delete(ws); return { slow: false }; }
  if (n > l.hardLimit) return { slow: true, why: `buffer ${n} bytes is above ${l.hardLimit}` };
  const o = over.get(ws);
  // the first send above the limit, or the client read part of the buffer since the last check: wait again
  if (!o || n < o.low) { over.set(ws, { since: now, low: n }); return { slow: false }; }
  if (now - o.since >= l.graceMs) return { slow: true, why: `buffer ${n} bytes, above ${l.limit} and not falling for ${Math.round((now - o.since) / 1000)} s` };
  return { slow: false };
}

// Sends `data`, or closes the client with 1013 and `reason` and logs one line. Returns false when nothing was sent.
// what: the message type, or "terminal output". unchecked: send without the check (the first messages after a connect).
export function sendChecked(ws: WebSocket, data: string, l: SlowLimits, reason: string, what: string, unchecked = false): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  const v = unchecked ? { slow: false as const } : checkSlow(ws, l);
  if (v.slow) {
    console.error(`${new Date().toISOString()} closed a client: ${reason}; ${v.why}; origin ${clientOrigin.get(ws) || 'none (token)'}; message ${what}`);
    over.delete(ws);
    ws.close(1013, reason);
    return false;
  }
  ws.send(data);
  return true;
}
