// A live terminal: xterm.js attached to the task's tmux session through /ws/term.
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Terminal as XTerm } from '@xterm/xterm';
import type { IBufferRange, ILink } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { taskboardKey } from '../keys';
import { useStore } from '../api';
import { openDocumentLink, type DocumentLink } from '../documentLinks';
import { continues, findPaths, joinRows, type Row } from '../terminalPaths';

const cssVar = (n: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fallback;

export function Terminal({ taskId, session, fontSize = 13, autoFocus = false, onFocus }: { taskId: string; session?: string; fontSize?: number; autoFocus?: boolean; onFocus?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const tasks = useStore().tasks;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

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
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const modified = (e: MouseEvent) => mac ? e.metaKey : e.ctrlKey;
    let activeLink: (() => void) | null = null;
    const underline = document.createElement('div');
    underline.className = 'taskboard-link-underline';
    term.element?.querySelector('.xterm-screen')?.appendChild(underline);
    const drawUnderline = (range: IBufferRange) => {
      underline.replaceChildren();
      const screen = underline.parentElement;
      if (!screen) return;
      const cellWidth = screen.clientWidth / term.cols, cellHeight = screen.clientHeight / term.rows;
      for (let row = range.start.y; row <= range.end.y; row++) {
        const visible = row - term.buffer.active.viewportY - 1;
        if (visible < 0 || visible >= term.rows) continue;
        const start = row === range.start.y ? range.start.x - 1 : 0;
        const end = row === range.end.y ? range.end.x : term.cols;
        const segment = document.createElement('span');
        Object.assign(segment.style, { left: `${start * cellWidth}px`, top: `${(visible + 1) * cellHeight - 2}px`, width: `${(end - start) * cellWidth}px` });
        underline.appendChild(segment);
      }
    };
    const onModifiedMouse = (event: MouseEvent) => {
      if (!activeLink || !modified(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'click') activeLink();
    };
    for (const type of ['mousedown', 'mouseup', 'click'] as const) el.addEventListener(type, onModifiedMouse, true);
    const taskPattern = /(?:^|[\s(])(#\d+|task-\d+)(?=$|[\s),.;])/g;
    const linkCache = new Map<string, Promise<DocumentLink | null>>();
    const lookup = (path: string, fresh = false) => {
      if (fresh) linkCache.delete(path);
      if (!linkCache.has(path)) linkCache.set(path, fetch(`/api/tasks/${encodeURIComponent(taskId)}/document-link?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() as Promise<DocumentLink> : null).then(doc => {
          if (!doc) return null;
          if (taskId.includes('~')) { doc.task = taskId.split('~')[0] + '~' + doc.task; delete doc.reviewId; }
          return doc;
        }).catch(() => null));
      return linkCache.get(path)!;
    };
    const provider = taskId && !session ? term.registerLinkProvider({ provideLinks(y, callback) {
      const buffer = term.buffer.active;
      // the rows around y that one path can run over: soft wraps, and rows that Claude Code or tmux broke (terminalPaths.ts)
      const row = (i: number): Row | null => { const line = buffer.getLine(i); return line ? { text: line.translateToString(false), wrapped: line.isWrapped } : null; };
      let first = y - 1, last = y - 1;
      for (let above = row(first - 1), here = row(first); above && here && continues(above.text, here) && last - first < 30; here = above, above = row(--first - 1));
      for (let here = row(last), below = row(last + 1); here && below && continues(here.text, below) && last - first < 30; here = below, below = row(++last + 1));
      const joined = joinRows(Array.from({ length: last - first + 1 }, (_, i) => row(first + i)!));
      const content = joined.text;
      const cell = (offset: number) => ({ x: joined.cells[offset].col + 1, y: first + joined.cells[offset].row + 1 });
      const range = (start: number, end: number) => ({ start: cell(start), end: cell(end - 1) });
      const found = findPaths(joined);
      const refs = [...content.matchAll(taskPattern)].map(m => ({ text: m[1], start: m.index! + m[0].indexOf(m[1]) }));
      const refLinks: ILink[] = [];
      for (const ref of refs) {
        const num = Number(ref.text.replace(/\D/g, ''));
        const task = tasksRef.current.find(t => t.num === num);
        if (!task) continue;
        refLinks.push({ range: range(ref.start, ref.start + ref.text.length), text: ref.text,
          activate: event => { if (modified(event)) dispatchEvent(new CustomEvent('taskboard:task-link', { detail: task.id })); },
          hover: () => { activeLink = () => dispatchEvent(new CustomEvent('taskboard:task-link', { detail: task.id })); drawUnderline(range(ref.start, ref.start + ref.text.length)); el.title = `${mac ? 'Command' : 'Control'}-click to open task #${num}`; },
          leave: () => { activeLink = null; underline.replaceChildren(); el.title = ''; },
        });
      }
      if (!found.length) { callback(refLinks); return; }
      Promise.all(found.map(async match => {
        let path: { text: string; end: number } | null = null;
        for (const candidate of match.candidates) if (await lookup(candidate.text)) { path = candidate; break; }
        if (!path) return null;
        const text = path.text, where = range(match.start, path.end);
        return { range: where, text,
          activate: (event: MouseEvent) => { if (modified(event)) void lookup(text, true).then(now => now && openDocumentLink(now)); },
          hover: () => { activeLink = () => { void lookup(text, true).then(now => now && openDocumentLink(now)); }; drawUnderline(where); el.title = `${mac ? 'Command' : 'Control'}-click to open in Taskboard`; },
          leave: () => { activeLink = null; underline.replaceChildren(); el.title = ''; },
        } satisfies ILink;
      })).then(paths => {
        const links: ILink[] = [...refLinks];
        for (const path of paths) if (path) links.push(path);
        callback(links);
      }).catch(() => callback([]));
    } }) : null;
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
    // A paste event arrives before xterm.js sends its text. Tell tmux to leave copy mode first.
    const onPaste = () => { if (ws && ws.readyState === 1) ws.send('\x00' + JSON.stringify({ t: 'paste' })); };
    el.addEventListener('paste', onPaste, true);
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

    return () => { closed = true; clearTimeout(sizeTimer); ro.disconnect(); input.dispose(); provider?.dispose(); underline.remove(); for (const type of ['mousedown', 'mouseup', 'click'] as const) el.removeEventListener(type, onModifiedMouse, true); el.removeEventListener('paste', onPaste, true); term.textarea?.removeEventListener('focus', onF); ws?.close(); term.dispose(); };
  }, [taskId, session]);

  useEffect(() => { if (termRef.current) termRef.current.options.fontSize = fontSize; }, [fontSize]);
  useEffect(() => {
    const on = () => { if (termRef.current) termRef.current.options.theme = { ...termRef.current.options.theme, background: cssVar('--term-bg', '#0a0c0f') }; };
    addEventListener('tb-theme', on); return () => removeEventListener('tb-theme', on);
  }, []);
  useEffect(() => { if (autoFocus) termRef.current?.focus(); }, [autoFocus]);

  return <div className="xterm-box" ref={box} />;
}
