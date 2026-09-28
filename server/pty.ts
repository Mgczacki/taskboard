// Live terminals: each browser terminal gets its own `tmux attach` running in a pseudo-terminal.
// Closing the browser terminal only ends that attach; the agent keeps running in tmux.
import { execFileSync } from 'node:child_process';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { TMUX_SOCKET } from './config.ts';
import { TMUX_BIN } from './tmux.ts';

// Attaching or resizing makes Codex redraw, which looks like new output. Ignore activity for a moment after those.
export const quietUntil = new Map<string, number>();
const quiet = (session: string) => quietUntil.set(session, Date.now() + 3000);

const tmuxSync = (...args: string[]) => { try { return execFileSync(TMUX_BIN, ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return ''; } };

export function attach(ws: WebSocket, session: string, cols: number, rows: number) {
  quiet(session);
  // also set here: a tmux server started by an earlier Taskboard version lacks these
  tmuxSync('set-option', '-g', 'mouse', 'on'); tmuxSync('set-option', '-g', 'set-clipboard', 'on');
  const p = pty.spawn(TMUX_BIN, ['-L', TMUX_SOCKET, 'attach-session', '-t', '=' + session], {
    name: 'xterm-256color', cols: Math.max(20, cols), rows: Math.max(5, rows),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
  });
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
        if (m.t === 'resize') { quiet(session); p.resize(Math.max(20, m.cols), Math.max(5, m.rows)); }
      } catch { /* ignore malformed control message */ }
      return;
    }
    p.write(s);
  });
  ws.on('close', () => { try { p.kill(); } catch { /* already gone */ } });
}
