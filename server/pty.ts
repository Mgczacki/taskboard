// Live terminals: each browser terminal gets its own `tmux attach` running in a pseudo-terminal.
// Closing the browser terminal only ends that attach; the agent keeps running in tmux.
import { execFileSync } from 'node:child_process';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { TMUX_SOCKET } from './config.ts';
import { TMUX_BIN, loadCopyBindings } from './tmux.ts';
let bindingsLoaded = false;

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
interface Viewer { cols: number; rows: number; usedAt: number }
const viewers = new Map<string, Set<Viewer>>();
const sizedBy = new Map<string, Viewer>();
const clamp = (v: Viewer) => [String(Math.max(20, v.cols)), String(Math.max(5, v.rows))];
function sizeWindow(session: string) {
  const list = [...(viewers.get(session) || [])];
  if (!list.length) { sizedBy.delete(session); tmuxSync('set-option', '-w', '-t', '=' + session + ':', '-u', 'window-size'); return; }
  const v = list.reduce((a, b) => (b.usedAt > a.usedAt ? b : a));
  const prev = sizedBy.get(session);
  if (prev === v && (v as Viewer & { applied?: string }).applied === `${v.cols}x${v.rows}`) return; // nothing changed
  sizedBy.set(session, v); (v as Viewer & { applied?: string }).applied = `${v.cols}x${v.rows}`;
  const [x, y] = clamp(v);
  tmuxSync('resize-window', '-t', '=' + session + ':', '-x', x, '-y', y);
}
const use = (session: string, v: Viewer) => { v.usedAt = Date.now(); sizeWindow(session); };

export function attach(ws: WebSocket, session: string, cols: number, rows: number) {
  quiet(session);
  // also set here: a tmux server started by an earlier Taskboard version lacks these
  // mouse, clipboard and selection bindings (once per server process; the tmux server keeps them)
  if (!bindingsLoaded) { bindingsLoaded = true; loadCopyBindings().catch(() => { bindingsLoaded = false; }); }
  const p = pty.spawn(TMUX_BIN, ['-L', TMUX_SOCKET, 'attach-session', '-t', '=' + session], {
    name: 'xterm-256color', cols: Math.max(20, cols), rows: Math.max(5, rows),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
  });
  const me: Viewer = { cols, rows, usedAt: Date.now() };
  if (!viewers.has(session)) viewers.set(session, new Set());
  viewers.get(session)!.add(me);
  sizeWindow(session);
  // coalesce output: one WebSocket message per 8 ms instead of one per read from the pseudo-terminal
  let buf = '', timer: NodeJS.Timeout | null = null;
  const flush = () => { timer = null; if (buf && ws.readyState === ws.OPEN) ws.send(buf); buf = ''; };
  p.onData(d => { buf += d; if (buf.length > 65536) { if (timer) clearTimeout(timer); flush(); } else if (!timer) timer = setTimeout(flush, 8); });
  p.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(4000, 'detached'); });
  ws.on('message', (raw, isBinary) => {
    const s = raw.toString();
    // control messages start with a NUL byte followed by JSON; anything else is keyboard input
    if (!isBinary && s.charCodeAt(0) === 0) {
      try {
        const m = JSON.parse(s.slice(1));
        if (m.t === 'resize') { quiet(session); me.cols = m.cols; me.rows = m.rows; p.resize(Math.max(20, me.cols), Math.max(5, me.rows)); sizeWindow(session); }
        if (m.t === 'focus') use(session, me);
        if (m.t === 'paste' && tmuxSync('display-message', '-p', '-t', '=' + session + ':', '#{pane_mode}').trim() === 'copy-mode')
          tmuxSync('send-keys', '-X', '-t', '=' + session + ':', 'cancel');
      } catch { /* ignore malformed control message */ }
      return;
    }
    // typing counts as using this terminal (only a change of terminal resizes the window)
    if (sizedBy.get(session) !== me) use(session, me); else me.usedAt = Date.now();
    p.write(s);
  });
  ws.on('close', () => {
    try { p.kill(); } catch { /* already gone */ }
    viewers.get(session)?.delete(me);
    if (sizedBy.get(session) === me) sizedBy.delete(session);
    sizeWindow(session);
  });
}
