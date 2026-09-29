// A live terminal: xterm.js attached to the task's tmux session through /ws/term.
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { taskboardKey } from '../keys';

const cssVar = (n: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fallback;

export function Terminal({ taskId, session, fontSize = 13, autoFocus = false, onFocus }: { taskId: string; session?: string; fontSize?: number; autoFocus?: boolean; onFocus?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    const el = box.current!;
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
      fontSize, lineHeight: 1.25, cursorBlink: true, allowProposedApi: true, scrollback: 10000,
      macOptionIsMeta: false, macOptionClickForcesSelection: true,
      theme: { background: cssVar('--term-bg', '#0a0c0f'), foreground: '#d6dae0', cursor: '#e6edf3', selectionBackground: '#3a4a6a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
    term.open(el);
    termRef.current = term;
    // GPU renderer: much faster than the default DOM renderer for fast output. Browsers allow a limited number of
    // WebGL contexts; when one is lost the terminal falls back to the DOM renderer.
    try { const gl = new WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch { /* no WebGL */ }
    // tmux sends copied text as OSC 52; this puts it on the system clipboard
    term.loadAddon(new ClipboardAddon());
    try { fit.fit(); } catch { /* not visible yet */ }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket | null = null, closed = false;
    const open = () => {
      ws = new WebSocket(`${proto}://${location.host}/ws/term?${session ? 'session=' + encodeURIComponent(session) : 'task=' + encodeURIComponent(taskId)}&cols=${term.cols}&rows=${term.rows}`);
      ws.onmessage = e => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
      // this terminal decides the tmux window size while it is the one you opened or typed in last
      ws.onopen = () => sendFocus();
      ws.onclose = ev => { if (!closed && ev.code !== 4004) setTimeout(open, 1500); };
    };
    open();
    const input = term.onData(d => { if (ws && ws.readyState === 1) ws.send(d); });
    // Shift+Enter: Claude Code and Codex treat ESC+CR as a newline in the prompt
    term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) { if (ws && ws.readyState === 1) ws.send('\x1b\r'); return false; }
      // ⌃⌥ keys and the ⌘ / ⌃ keys set on the Settings page belong to Taskboard, not the terminal (keys.ts)
      if (taskboardKey(e)) return false;
      return true;
    });
    const sendSize = () => { if (ws && ws.readyState === 1) ws.send('\x00' + JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows })); };
    // refit at once, but tell tmux only once the size settles: a drag changes it every frame, and each resize redraws the agent's screen
    let sizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => { try { fit.fit(); clearTimeout(sizeTimer); sizeTimer = setTimeout(sendSize, 100); } catch { /* hidden */ } });
    ro.observe(el);
    const sendFocus = () => { if (ws && ws.readyState === 1) ws.send('\x00' + JSON.stringify({ t: 'focus' })); };
    const onF = () => { sendFocus(); if (onFocus) onFocus(); };
    term.textarea?.addEventListener('focus', onF);
    if (autoFocus) setTimeout(() => term.focus(), 50);

    return () => { closed = true; clearTimeout(sizeTimer); ro.disconnect(); input.dispose(); term.textarea?.removeEventListener('focus', onF); ws?.close(); term.dispose(); };
  }, [taskId, session]);

  useEffect(() => { if (termRef.current) termRef.current.options.fontSize = fontSize; }, [fontSize]);
  useEffect(() => {
    const on = () => { if (termRef.current) termRef.current.options.theme = { ...termRef.current.options.theme, background: cssVar('--term-bg', '#0a0c0f') }; };
    addEventListener('tb-theme', on); return () => removeEventListener('tb-theme', on);
  }, []);
  useEffect(() => { if (autoFocus) termRef.current?.focus(); }, [autoFocus]);

  return <div className="xterm-box" ref={box} />;
}
