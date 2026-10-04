// What the dashboard says about its connection to the Taskboard server, and how fast it connects again.
// api.ts owns the events socket (/ws/events) and keeps a ServerLink; App.tsx shows linkText() next to the dot in the
// sidebar and restartBanner() at the top of the page. terminalSocket.ts uses retryDelay() for the terminal sockets.
// The server sends {type:'stopping', reason} just before a SIGTERM exit and {type:'hello', server} after each connect
// (server/server-life.ts), so the page can tell a restart from a server that does not answer.

export type EndKind = 'crash' | 'signal' | 'release' | 'rollback' | 'manual' | 'exit' | 'unknown';
export interface StartEnd { kind: EndKind; at?: string; detail?: string }
export interface StartRecord { pid: number; startedAt: string; release: string; end?: StartEnd }
export interface ServerHealth {
  pid: number; startedAt: string; uptimeSec: number; release: string; previous: StartEnd | null;
  starts: StartRecord[]; counts: Record<EndKind, number>; planned: number;
  recovered: { count: number; last?: { at: string; line: string } };
  // the login service of this server (server/login-service.ts); null when the server has no login service check
  loginService?: { label: string; startsAtLogin: boolean; loaded: boolean; runsThisServer: boolean } | null;
}
// connected: the events socket is open. restarting: the server said it stops. down: no answer. offline: the browser
// has no network (navigator.onLine is false).
export type LinkState = 'connected' | 'restarting' | 'down' | 'offline';
// closed: the server answered and then closed the events socket with a code and a reason (for example 1013 'event
// client is too slow', server/slow-client.ts). It is unset when the connection failed or dropped without a reason.
export interface ServerLink { state: LinkState; since: number; stopReason?: EndKind; stopDetail?: string; closed?: { code: number; reason: string } }

// 250 ms, 500 ms, 1 s, 2 s, then every 4 s. A launchd restart takes about 2-10 s, so the page connects within
// about 4 s of the new server answering.
export const retryDelay = (attempt: number, first = 250, max = 4000) => Math.min(max, first * 2 ** Math.max(0, attempt));

// The wait before the page connects to /ws/events again (api.ts), and the attempt number for the next close.
// openMs: how long the closed connection was open (null: it did not open). A connection that was open for 5 s or more
// starts the waits again at the first step. Code 1013 means that the server closed the page on purpose (too slow, too
// many windows): the waits start at 1 s and stop growing at 30 s, so a page that the server closes again and again
// does not connect in a loop that sends the whole task list each time.
export function eventRetry(attempt: number, openMs: number | null, code?: number): { attempt: number; delay: number } {
  const a = openMs !== null && openMs >= 5000 ? 0 : attempt;
  return { attempt: a + 1, delay: code === 1013 ? retryDelay(a, 1000, 30000) : retryDelay(a) };
}
const closedText = (c: { code: number; reason: string }) => `the server closed the connection: ${c.reason || 'no reason given'} (code ${c.code})`;

const REASON: Record<EndKind, string> = {
  crash: 'crash', signal: 'stop signal', release: 'release', rollback: 'rollback', manual: 'manual restart', exit: 'normal exit',
  unknown: 'unknown (no log entry)',
};
export const reasonText = (k?: EndKind) => (k && REASON[k]) || 'unknown';
const clock = (at: string | number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function linkText(l: ServerLink, now = Date.now()): string {
  const secs = Math.round((now - l.since) / 1000);
  const waited = secs >= 3 ? ` for ${secs} s` : '';
  if (l.state === 'connected') return 'server connected';
  if (l.state === 'offline') return 'no network: this computer is offline';
  if (l.state === 'restarting') return `server restarting (${reasonText(l.stopReason)})${waited}, reconnecting`;
  if (l.closed) return `${closedText(l.closed)}, reconnecting`;
  return `server not answering${waited}, reconnecting`;
}

// The banner after a reconnect to a server with another start time. null when the server did not restart.
export function restartBanner(before: ServerHealth | null, after: ServerHealth | null): string | null {
  if (!before || !after || before.startedAt === after.startedAt) return null;
  const p = after.previous;
  const detail = p?.kind === 'crash' && p.detail ? ` (${p.detail})` : '';
  return `Server restarted at ${clock(after.startedAt)}, reason: ${reasonText(p?.kind)}${detail}`;
}

// The banner while the server is away (a stop message was received, or no answer for 2 s or more).
export function awayBanner(l: ServerLink, now = Date.now()): string | null {
  if (l.state === 'restarting') return `Server stopped at ${clock(l.since)}, reason: ${reasonText(l.stopReason)}${l.stopDetail ? ` (${l.stopDetail})` : ''}, reconnecting. Terminals keep their last screen. Typing is not sent until they reconnect.`;
  if (l.state === 'down' && l.closed) return `At ${clock(l.since)} ${closedText(l.closed)}. Reconnecting. Terminals keep their last screen.`;
  if (l.state === 'down' && now - l.since >= 2000) return `Server not answering since ${clock(l.since)}, reconnecting. Terminals keep their last screen. Typing is not sent until they reconnect.`;
  if (l.state === 'offline') return 'No network. The page reconnects when the network is back.';
  return null;
}
