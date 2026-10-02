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
export interface ServerLink { state: LinkState; since: number; stopReason?: EndKind; stopDetail?: string }

// 250 ms, 500 ms, 1 s, 2 s, then every 4 s. A launchd restart takes about 2-10 s, so the page connects within
// about 4 s of the new server answering.
export const retryDelay = (attempt: number, first = 250, max = 4000) => Math.min(max, first * 2 ** Math.max(0, attempt));

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
  if (l.state === 'down' && now - l.since >= 2000) return `Server not answering since ${clock(l.since)}, reconnecting. Terminals keep their last screen. Typing is not sent until they reconnect.`;
  if (l.state === 'offline') return 'No network. The page reconnects when the network is back.';
  return null;
}
