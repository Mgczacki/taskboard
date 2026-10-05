// Live terminals: each browser terminal gets its own `tmux attach` running in a pseudo-terminal.
// Closing the browser terminal only ends that attach; the agent keeps running in tmux.
import { execFileSync } from 'node:child_process';
import type { IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import { TMUX_SOCKET } from './config.ts';
import { TMUX_BIN, ensureConfigured, tmux } from './tmux.ts';
import { spawnPty } from './pty-spawn.ts';
import { TERMINAL_LIMITS, sendChecked } from './slow-client.ts';
import * as input from './terminal-input.ts';

// Attaching or resizing makes Codex redraw, which looks like new output. Ignore activity for a moment after those.
export const quietUntil = new Map<string, number>();
const quiet = (session: string) => quietUntil.set(session, Date.now() + 3000);

const tmuxSync = (...args: string[]) => { try { return execFileSync(TMUX_BIN, ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return ''; } };

// One tmux window has one size, however many terminals show it. A terminal larger than the window shows dots in the
// unused area; a smaller one shows the window cut off (Codex draws at the bottom, so that part can even be empty).
// So the server keeps, per session, every browser terminal attached to it (task panel, canvas tile, other windows)
// with its size and when it was last used (opened, clicked or typed in), and gives the window the size of the most
// recently used one. When that terminal closes, the next most recent one takes over; when none is left, the window
// goes back to tmux's own sizing (window-size latest), so terminals attached from iTerm behave as before.
interface Viewer { cols: number; rows: number; usedAt: number; ws: WebSocket; pid: number; lastOut: number; healedAt: number; sent?: string }
const viewers = new Map<string, Set<Viewer>>();
export const terminalViewerCount = () => [...viewers.values()].reduce((sum, list) => sum + list.size, 0);
const sizedBy = new Map<string, Viewer>();
const clamp = (v: Viewer) => [String(Math.max(20, v.cols)), String(Math.max(5, v.rows))];
// The tmux commands run one after the other for each session, without blocking the server: a synchronous call took
// 7-20 ms, so terminals that open together (a Canvas page) waited for each other before their sockets opened.
const sizing = new Map<string, Promise<unknown>>();
function tmuxInOrder(session: string, ...args: string[]) {
  const next = (sizing.get(session) || Promise.resolve()).then(() => tmux(...args)).catch(() => { /* the session ended */ });
  sizing.set(session, next);
  void next.then(() => { if (sizing.get(session) === next) sizing.delete(session); });
}
function sizeWindow(session: string) {
  const list = [...(viewers.get(session) || [])];
  if (!list.length) { sizedBy.delete(session); tmuxInOrder(session, 'set-option', '-w', '-t', '=' + session + ':', '-u', 'window-size'); return; }
  const v = list.reduce((a, b) => (b.usedAt > a.usedAt ? b : a));
  const prev = sizedBy.get(session);
  if (prev === v && (v as Viewer & { applied?: string }).applied === `${v.cols}x${v.rows}`) return; // nothing changed
  sizedBy.set(session, v); (v as Viewer & { applied?: string }).applied = `${v.cols}x${v.rows}`;
  const [x, y] = clamp(v);
  tmuxInOrder(session, 'resize-window', '-t', '=' + session + ':', '-x', x, '-y', y);
}
const use = (session: string, v: Viewer) => { v.usedAt = Date.now(); sizeWindow(session); };

// Copy mode and terminals that stopped drawing. A mouse drag, a double-click or the wheel in a pane whose program does
// not read the mouse (Codex) puts the pane in tmux copy mode. Copy mode shows the screen from the time it started and
// no new output, for every terminal that shows the session; only a key or "Back to live" ends it. So once a second,
// while a browser terminal shows the session, the server reads the pane's mode and:
// - ends copy mode (a copy-mode command, no key reaches the agent) when it hides new output, its view is at the
//   bottom (the user is not reading older output), no text is selected and no terminal sent input in the last 3 s;
//   right after a terminal attaches, output of unknown age counts as new
// - tells each terminal the mode, so the page shows "Scrolled back" and "Back to live" (a NUL byte, then JSON)
// - asks tmux to redraw a terminal (refresh-client) that got nothing for 2 s before the pane's last output, outside
//   copy mode; this has not been seen, it covers causes that could not be tested (at most once in 10 s)
// One `tmux list-panes -a` each second reads the mode of every watched session. Before, each session had its own
// timer and its own `tmux display-message`: with 10 open terminals that was 10 new processes each second, and under
// heavy machine load the start of one process blocked the event loop for up to 480 ms (scripts/dashboard-load.mjs).
interface Watch { lastInput: number; modeActivity: number | null; copySeen: number; fresh: boolean; busy: boolean }
const watches = new Map<string, Watch>();
const control = (v: Viewer, m: object) => { if (v.ws.readyState === v.ws.OPEN) v.ws.send('\x00' + JSON.stringify(m)); };
const FIELDS = ['#{pane_mode}', '#{scroll_position}', '#{selection_present}', '#{window_activity}', '#{window_width}', '#{window_height}'];
const FORMAT = FIELDS.join('|');
const SEP = '|~|'; // as in tmux.ts listSessions: printable, so no locale changes it
const ALL_FORMAT = ['#{session_name}', '#{window_active}', '#{pane_active}', ...FIELDS].join(SEP);
let watchTimer: NodeJS.Timeout | null = null, watchBusy = false;
async function checkAll() {
  if (watchBusy) return;
  watchBusy = true;
  try {
    const rows = new Map<string, string[]>();
    for (const line of (await tmux('list-panes', '-a', '-F', ALL_FORMAT)).split('\n')) {
      const [name, windowActive, paneActive, ...f] = line.split(SEP);
      // the pane that display-message -t '=<session>:' reads: the active pane of the active window
      if (name && windowActive === '1' && paneActive === '1' && f.length === FIELDS.length) rows.set(name, f);
    }
    await Promise.all([...watches.keys()].filter(s => rows.has(s)).map(s => check(s, rows.get(s))));
  } catch { /* tmux did not answer; try again next second */ }
  finally { watchBusy = false; }
}
const startWatching = () => { if (!watchTimer) watchTimer = setInterval(() => void checkAll(), 1000); };
const stopWatching = () => { if (watchTimer && !watches.size) { clearInterval(watchTimer); watchTimer = null; } };

// fields: the values of FORMAT from checkAll; without them (the "Back to live" button) this session is read alone
async function check(session: string, fields?: string[]) {
  const w = watches.get(session);
  if (!w || w.busy) return;
  w.busy = true;
  try {
    const target = '=' + session + ':';
    const [mode, scrollText, sel, act, ww, wh] = fields || (await tmux('display-message', '-p', '-t', target, FORMAT)).trim().split('|');
    const activity = Number(act) * 1000, scroll = Number(scrollText) || 0, selection = sel === '1';
    let copy = mode === 'copy-mode', left = false;
    if (copy) {
      if (w.modeActivity === null) w.modeActivity = w.fresh ? -1 : activity;
      if (activity > w.modeActivity && scroll === 0 && !selection && Date.now() - w.lastInput >= 3000) {
        await tmux('send-keys', '-X', '-t', target, 'cancel');
        copy = false; left = true;
      }
    }
    if (!copy) w.modeActivity = null;
    if (copy || left) w.copySeen = Date.now();
    w.fresh = false;
    const state = JSON.stringify({ t: 'state', copy, scroll: copy ? scroll : 0, selection: copy && selection, hidden: copy && w.modeActivity !== null && activity > w.modeActivity });
    const list = [...(viewers.get(session) || [])];
    for (const v of list) {
      if (left) control(v, { t: 'left-copy-mode' });
      if (v.sent !== state) { v.sent = state; v.ws.readyState === v.ws.OPEN && v.ws.send('\x00' + state); }
    }
    // tmux sends nothing to the terminals while copy mode shows, so that gap is not a stall
    if (copy || Date.now() - w.copySeen < 3000) return;
    const now = Date.now(), stalled = list.filter(v => activity - v.lastOut > 2000 && now - v.healedAt > 10000);
    if (!stalled.length) return;
    const clients = (await tmux('list-clients', '-t', '=' + session, '-F', '#{client_pid}|#{client_name}|#{client_width}|#{client_height}')).trim().split('\n').map(l => l.split('|'));
    for (const v of stalled) {
      const c = clients.find(x => Number(x[0]) === v.pid);
      // a terminal smaller than the window shows only a part of it and gets nothing for changes outside that part
      if (!c || Number(c[2]) < Number(ww) || Number(c[3]) < Number(wh)) continue;
      v.healedAt = now;
      await tmux('refresh-client', '-t', c[1]);
      control(v, { t: 'redrawn', gapMs: activity - v.lastOut });
    }
  } catch { /* the session ended or tmux did not answer; try again next second */ }
  finally { w.busy = false; }
}

export function attach(ws: WebSocket, session: string, cols: number, rows: number) {
  quiet(session);
  // also here: a tmux server that an earlier Taskboard version or another program started lacks the mouse, clipboard
  // and selection settings (one tmux call when the marker on the tmux server matches; see ensureConfigured)
  void ensureConfigured().catch(() => {});
  let p: IPty;
  try {
    p = spawnPty(TMUX_BIN, ['-L', TMUX_SOCKET, 'attach-session', '-t', '=' + session], {
      name: 'xterm-256color', cols: Math.max(20, cols), rows: Math.max(5, rows),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
  } catch (e) {
    // node-pty throws when it cannot open a pseudo-terminal (all kern.tty.ptmx_max are in use, or no free file
    // descriptor) or cannot start its spawn-helper (no process slot or memory). 1.1.0 said "posix_spawnp failed." for
    // each of these; 1.2.0 names the step. This terminal tries again (code 1013, terminalSocket.ts); the server keeps running.
    console.error(`${new Date().toISOString()} could not attach a terminal to ${session}: ${(e as Error).message}`);
    control({ ws } as Viewer, { t: 'error', message: `The server could not open a terminal: ${(e as Error).message}`, retry: true });
    ws.close(1013, 'could not open a terminal');
    return;
  }
  const spawnedAt = Date.now();
  // true once the tmux attach ended or the browser terminal closed: no write or resize reaches the pseudo-terminal
  // after that. A write to a closed one fails with EIO or EBADF, which node-pty logs as "Unhandled pty write error".
  let ended = false;
  const me: Viewer = { cols, rows, usedAt: Date.now(), ws, pid: p.pid, lastOut: Date.now(), healedAt: 0 };
  if (!viewers.has(session)) viewers.set(session, new Set());
  viewers.get(session)!.add(me);
  sizeWindow(session);
  let watch = watches.get(session);
  if (!watch) { watch = { lastInput: 0, modeActivity: null, copySeen: 0, fresh: true, busy: false }; watches.set(session, watch); startWatching(); }
  watch.fresh = true;
  const w = watch;
  // coalesce output: one WebSocket message per 8 ms instead of one per read from the pseudo-terminal
  let buf = '', timer: NodeJS.Timeout | null = null;
  // a terminal that does not read its output is closed (server/slow-client.ts); it connects again and tmux draws its screen
  const flush = () => { timer = null; if (buf) sendChecked(ws, buf, TERMINAL_LIMITS, 'terminal client is too slow', 'terminal output'); buf = ''; };
  const onData = p.onData(d => { me.lastOut = Date.now(); buf += d; if (buf.length > 65536) { if (timer) clearTimeout(timer); flush(); } else if (!timer) timer = setTimeout(flush, 8); });
  const onExit = p.onExit(() => {
    ended = true;
    if (timer) { clearTimeout(timer); flush(); }
    if (ws.readyState !== ws.OPEN) return;
    // tmux attach ends at once when the session does not exist. Code 4001 makes the terminal wait 10 s before it tries
    // again. With 1.5 s between tries, one open tab for an ended session (task-25 on 2026-09-30) started about 485
    // attaches in 16 minutes, and each leaked a pseudo-terminal until the server crashed.
    if (Date.now() - spawnedAt < 2000) ws.close(4001, 'the tmux session is not running');
    else ws.close(4000, 'detached');
  });
  ws.on('message', (raw, isBinary) => {
    const s = raw.toString();
    // control messages start with a NUL byte followed by JSON; anything else is keyboard input
    if (!isBinary && s.charCodeAt(0) === 0) {
      try {
        const m = JSON.parse(s.slice(1));
        if (m.t === 'resize') { quiet(session); me.cols = m.cols; me.rows = m.rows; if (!ended) p.resize(Math.max(20, me.cols), Math.max(5, me.rows)); sizeWindow(session); }
        if (m.t === 'focus') use(session, me);
        if ((m.t === 'paste' || m.t === 'live') && tmuxSync('display-message', '-p', '-t', '=' + session + ':', '#{pane_mode}').trim() === 'copy-mode')
          tmuxSync('send-keys', '-X', '-t', '=' + session + ':', 'cancel');
        if (m.t === 'live') void check(session);
        // the "Refresh" button: tmux draws this terminal's whole screen again
        if (m.t === 'refresh') { const c = tmuxSync('list-clients', '-t', '=' + session, '-F', '#{client_pid} #{client_name}').split('\n').find(l => l.startsWith(p.pid + ' ')); if (c) tmuxSync('refresh-client', '-t', c.slice(c.indexOf(' ') + 1)); }
      } catch { /* ignore malformed control message */ }
      return;
    }
    // typing counts as using this terminal (only a change of terminal resizes the window); mouse events arrive here too
    w.lastInput = Date.now();
    input.noteKey(session);
    if (sizedBy.get(session) !== me) use(session, me); else me.usedAt = Date.now();
    // while Taskboard moves a draft and types a message (deliver-text.ts), keys wait and arrive after it
    input.write(session, () => { if (!ended) p.write(s); });
  });
  ws.on('close', () => {
    ended = true;
    if (timer) { clearTimeout(timer); timer = null; buf = ''; }
    onData.dispose(); onExit.dispose();
    try { p.kill(); } catch { /* already gone */ }
    viewers.get(session)?.delete(me);
    if (!viewers.get(session)?.size) { watches.delete(session); viewers.delete(session); quietUntil.delete(session); stopWatching(); }
    if (sizedBy.get(session) === me) sizedBy.delete(session);
    sizeWindow(session);
  });
}
