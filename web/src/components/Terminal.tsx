// A live terminal: xterm.js attached to the task's tmux session through /ws/term.
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Terminal as XTerm } from '@xterm/xterm';
import type { IBufferRange, ILink } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { memo, useEffect, useRef, useState } from 'react';
import { terminalSocket } from '../terminalSocket';
import { taskboardKey } from '../keys';
import { currentTasks } from '../api';
import { openDocumentLink, type DocumentLink } from '../documentLinks';
import { continues, findPaths, joinRows, type Row } from '../terminalPaths';
import { commandAt, commandsFrom, type CellRow } from '../bangCommand';
import { beginHold } from '../holdRun';
import { readTerminalTheme } from '../terminalTheme';
import { sizeSender } from '../terminalSize';
import { drawText, liveScreen, paneText, saveScreen, savedScreen, serialize, type PaneScreen } from '../terminalSnapshot';

// Debug record: each terminal keeps its last 300 events (WebSocket messages with their size and first escape
// sequences, input lengths, connection changes, stalls, messages from the server). It holds no text the agent printed
// or you typed; OSC sequences keep only their number, because OSC 52 carries clipboard text. The tile header copies
// it (terminalDebugRecord), and window.taskboardTerminalDebug() in the browser console returns all of them.
const records = new Map<string, () => unknown>();
export const terminalDebugRecord = (id: string) => records.get(id)?.();
(window as unknown as { taskboardTerminalDebug: () => unknown }).taskboardTerminalDebug = () => [...records.values()].map(r => r());
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][0-9]*|[()#][0-9A-Za-z]|[@-_=>78c])/g;
function escapes(d: string) {
  const esc: string[] = []; let count = 0;
  for (const m of d.matchAll(ESCAPE)) { if (esc.length < 8) esc.push(m[0].replace('\x1b', 'ESC')); count++; }
  return { esc, escCount: count };
}

// what the server says about the tmux pane (server/pty.ts): copy mode, its scroll position and whether it hides output
interface PaneState { copy: boolean; scroll: number; selection: boolean; hidden: boolean }

// glass below 1 is the alpha of a see-through background (the controller view, controllerView.ts)
type Props = { taskId: string; session?: string; fontSize?: number; autoFocus?: boolean; onFocus?: () => void; glass?: number; tint?: 'panel' | 'page' };
// A terminal draws again only when one of its own values changes, not with each change of any task. onFocus is not
// compared: callers pass a new function on each draw, and the terminal calls the newest one.
export const Terminal = memo(TerminalView, (a, b) => a.taskId === b.taskId && a.session === b.session && a.fontSize === b.fontSize && a.autoFocus === b.autoFocus && a.glass === b.glass && a.tint === b.tint && !a.onFocus === !b.onFocus);
function TerminalView({ taskId, session, fontSize = 13, autoFocus = false, onFocus, glass = 1, tint = 'panel' }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const glassRef = useRef(glass);
  glassRef.current = glass;
  const tintRef = useRef(tint);
  tintRef.current = tint;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const [pane, setPane] = useState<PaneState | null>(null);
  // why the terminal is not connected (the close code), or '' while it is connected
  const [offline, setOffline] = useState<'' | 'away' | 'no-session' | 'no-terminal'>('');
  const [redrawn, setRedrawn] = useState(false);
  const actions = useRef({ live: () => {}, refresh: () => {} });

  useEffect(() => {
    // the times (performance.now(), ms) of the steps from mount to the first drawn output, for the debug record
    const timing: Record<string, number> = { mount: performance.now() };
    const mark = (k: string) => { if (timing[k] === undefined) timing[k] = performance.now(); };
    const el = box.current!;
    const { theme, minimumContrastRatio } = readTerminalTheme(glassRef.current, tintRef.current);
    const term = new XTerm({
      fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
      fontSize, lineHeight: 1.25, cursorBlink: true, allowProposedApi: true, scrollback: 10000,
      macOptionIsMeta: false, macOptionClickForcesSelection: true, theme, minimumContrastRatio,
      // only the canvas and WebGL renderers read this; the DOM renderer used here takes the alpha in theme.background
      allowTransparency: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
    term.open(el);
    mark('opened');
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
    // Hold to run (bangCommand.ts): a "! <command>" that the agent printed, typed into this task's agent prompt
    const holdable = () => !!taskId && !session && !taskId.includes('~') && currentTasks().some(t => t.id === taskId);
    // buffer rows first to last, with the character and the foreground color of each cell
    const cellRows = (first: number, last: number): CellRow[] => {
      const buffer = term.buffer.active, rows: CellRow[] = [];
      for (let i = first; i <= Math.min(last, buffer.length - 1); i++) {
        const line = buffer.getLine(i), chars: string[] = [], colors: string[] = [];
        for (let x = 0; x < term.cols; x++) {
          const cell = line?.getCell(x);
          chars.push(!cell ? ' ' : cell.getWidth() === 0 ? '' : cell.getChars() || ' ');
          colors.push(cell ? `${cell.getFgColorMode()}:${cell.getFgColor()}` : '');
        }
        rows.push({ chars, colors, wrapped: !!line?.isWrapped });
      }
      return rows;
    };
    const holdHint = `Hold the mouse button for 3 seconds to type this command into the agent prompt and run it`;
    const onHoldStart = (event: MouseEvent) => {
      if (event.button !== 0 || modified(event) || event.altKey || event.shiftKey || !holdable()) return;
      const screen = el.querySelector('.xterm-screen');
      if (!screen) return;
      const box = screen.getBoundingClientRect();
      const col = Math.floor((event.clientX - box.left) / (box.width / term.cols)), row = Math.floor((event.clientY - box.top) / (box.height / term.rows));
      if (col < 0 || col >= term.cols || row < 0 || row >= term.rows) return;
      const y = term.buffer.active.viewportY + row, first = Math.max(0, y - 30);
      const span = commandAt(cellRows(first, y + 30), y - first, col, term.cols);
      if (span) beginHold(event, taskId, span.command);
    };
    el.addEventListener('mousedown', onHoldStart, true);
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
        const task = currentTasks().find(t => t.num === num);
        if (!task) continue;
        refLinks.push({ range: range(ref.start, ref.start + ref.text.length), text: ref.text,
          activate: event => { if (modified(event)) dispatchEvent(new CustomEvent('taskboard:task-link', { detail: task.id })); },
          hover: () => { activeLink = () => dispatchEvent(new CustomEvent('taskboard:task-link', { detail: task.id })); drawUnderline(range(ref.start, ref.start + ref.text.length)); el.title = `${mac ? 'Command' : 'Control'}-click to open task #${num}`; },
          leave: () => { activeLink = null; underline.replaceChildren(); el.title = ''; },
        });
      }
      if (holdable()) {
        const here = y - 1, first = Math.max(0, here - 30), around = cellRows(first, here + 30);
        for (let r = 0; r <= here - first; r++) for (const span of commandsFrom(around, r, term.cols)) {
          if (span.end.row < here - first) continue;
          const where = { start: { x: span.start.col + 1, y: first + span.start.row + 1 }, end: { x: span.end.col + 1, y: first + span.end.row + 1 } };
          refLinks.push({ range: where, text: span.command, activate: () => {},
            hover: () => { drawUnderline(where); el.title = holdHint; },
            leave: () => { underline.replaceChildren(); el.title = ''; },
          });
        }
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
    const events: Record<string, unknown>[] = [];
    const log = (k: string, x: Record<string, unknown> = {}) => { events.push({ at: Date.now(), k, ...x }); if (events.length > 300) events.shift(); };
    // Use xterm's default renderer. A new WebGL context for each pane mount can leave a live terminal blank.
    const renderer = 'dom';
    // tmux sends copied text as OSC 52; this puts it on the system clipboard
    term.loadAddon(new ClipboardAddon());
    // a hidden terminal (a parent with display: none) has no size; fitting it would make the tmux window 20 x 5
    const refit = () => { if (!el.clientWidth || !el.clientHeight) return; try { fit.fit(); } catch { /* layout is not ready */ } };
    fitRef.current = refit;
    refit();
    mark('fitted');
    const id = taskId || session || '';
    // the last screen of this terminal, drawn before the socket opens (terminalSnapshot.ts)
    const saved = savedScreen(id);
    if (saved) term.write(drawText(saved, term.cols, term.rows), () => mark('snapshotParsed'));
    // none yet (a first visit, a new browser tab): ask the server for the pane's screen; an HTTP request answers in a
    // few ms, while sockets to one host open one after the other
    let gone = false;
    if (!saved && taskId && !session && !taskId.includes('~')) {
      void fetch(`/api/tasks/${encodeURIComponent(taskId)}/screen`, { cache: 'no-store' }).then(r => r.ok ? r.json() as Promise<PaneScreen> : null).then(p => {
        if (p && !gone && timing.firstOutput === undefined) term.write(paneText(p, term.rows), () => mark('snapshotParsed'));
      }).catch(() => { /* the live screen comes with the socket */ });
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: ReturnType<typeof terminalSocket> | null = null, lastState: unknown = null;
    const send = (m: object) => { if (ws && ws.readyState === 1) ws.send('\x00' + JSON.stringify(m)); };
    // the box height, the cell height and the pixel ratio with each change of rows: the debug record shows what changed the size
    const sizeLog = () => ({ box: +el.getBoundingClientRect().height.toFixed(2), cell: +((term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { height: number } } } } } })._core._renderService.dimensions.css.cell.height || 0).toFixed(3), dpr: devicePixelRatio });
    // terminalSize.ts: tell tmux a new size only once it settles, and only when tmux does not have it yet
    const sizes = sizeSender((cols, rows) => {
      if (!ws || ws.readyState !== 1) return false;
      log('resize', { cols, rows, ...sizeLog() });
      ws.send('\x00' + JSON.stringify({ t: 'resize', cols, rows }));
      return true;
    });
    let redrawnTimer: ReturnType<typeof setTimeout> | undefined;
    const showRedrawn = () => { setRedrawn(true); clearTimeout(redrawnTimer); redrawnTimer = setTimeout(() => setRedrawn(false), 6000); };
    // The live start from tmux comes in several messages: the first switches to the alternate screen and clears it,
    // then tmux asks the terminal what it supports and draws the screen once xterm.js answered (20-60 ms later). So the
    // live output is written at once, but a copy of the rows of the saved screen covers it until the live screen has
    // text and 30 ms passed without output (at most 300 ms after the first output, or at the first key you type).
    let cover: HTMLElement | null = null, liveReady = false, coverQuiet: ReturnType<typeof setTimeout> | undefined, coverMax: ReturnType<typeof setTimeout> | undefined;
    const rowsEl = () => el.querySelector<HTMLElement>('.xterm-rows');
    const putCover = () => {
      const rows = rowsEl();
      if (!rows || cover) return;
      cover = rows.cloneNode(true) as HTMLElement;
      cover.classList.add('term-saved-screen');
      cover.removeAttribute('aria-live');
      rows.after(cover);
      rows.style.visibility = 'hidden';
    };
    const uncover = () => {
      clearTimeout(coverQuiet); clearTimeout(coverMax);
      if (!cover) return;
      cover.remove(); cover = null;
      const rows = rowsEl(); if (rows) rows.style.visibility = '';
      mark('liveShown');
    };
    const liveHasText = () => { const b = term.buffer.active; for (let y = 0; y < term.rows; y++) if (b.getLine(b.baseY + y)?.translateToString(true).trim()) return true; return false; };
    const afterLive = () => {
      if (!cover) return;
      if (!coverMax) coverMax = setTimeout(uncover, 300);
      // the copy goes in the frame that draws the live rows (onRender below), so no blank frame shows between them
      clearTimeout(coverQuiet); coverQuiet = setTimeout(() => { if (liveHasText()) { liveReady = true; term.refresh(0, term.rows - 1); } }, 30);
    };
    ws = terminalSocket(() => (sizes.known(term.cols, term.rows), `${proto}://${location.host}/ws/term?${session ? 'session=' + encodeURIComponent(session) : 'task=' + encodeURIComponent(taskId)}&cols=${term.cols}&rows=${term.rows}`), {
      message: e => {
        const d = typeof e.data === 'string' ? e.data : '';
        // messages from the server start with a NUL byte, like the ones this page sends; everything else is output
        if (d.charCodeAt(0) === 0) {
          try {
            const m = JSON.parse(d.slice(1));
            log('server', m);
            if (m.t === 'state') { lastState = m; setPane(m.copy ? m : null); }
            if (m.t === 'redrawn') showRedrawn();
          } catch { /* ignore a malformed message */ }
          return;
        }
        mark('firstOutput');
        log('output', { bytes: typeof e.data === 'string' ? d.length : (e.data as ArrayBuffer).byteLength, ...escapes(d) });
        term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data), () => { mark('firstParsed'); afterLive(); });
      },
      // this terminal decides the tmux window size while it is the one you opened or typed in last
      open: () => { mark('socketOpen'); log('open'); setOffline(''); sendFocus(); sizes.flush(term.cols, term.rows); },
      close: ev => {
        log('close', { code: ev.code, reason: ev.reason });
        // the session is gone: do not leave its last screen on display
        if (ev.code === 4004 && timing.firstParsed === undefined) { uncover(); term.reset(); }
        setOffline(ev.code === 4004 ? '' : ev.code === 4001 ? 'no-session' : ev.code === 1013 && ev.reason === 'could not open a terminal' ? 'no-terminal' : 'away');
      },
    });
    // a key you type shows the live screen at once (answers to tmux's questions also arrive in onData, so not there)
    const keyed = term.onKey(() => uncover());
    const input = term.onData(d => { log('input', { bytes: d.length }); if (ws && ws.readyState === 1) ws.send(d); });
    // A terminal that got output but did not draw it for 2 s while it is visible is drawn again. This has not been
    // seen; it covers causes that could not be tested (a stalled renderer). xterm.js itself stops drawing while the
    // terminal is off the screen and draws everything when it comes back, so an invisible terminal is not a stall.
    let parsedSince = 0, lastRender = 0, renders = 0, onScreen = true;
    const parsed = term.onWriteParsed(() => { if (!parsedSince) parsedSince = Date.now(); });
    const rendered = term.onRender(() => {
      // the saved screen is in the rows now: copy them before live output can change them
      if (timing.snapshotParsed !== undefined && timing.snapshotDrawn === undefined && timing.firstParsed === undefined) putCover();
      if (timing.snapshotParsed !== undefined) mark('snapshotDrawn');
      if (timing.firstParsed !== undefined) mark('firstDrawn');
      if (liveReady) { liveReady = false; uncover(); }
      parsedSince = 0; lastRender = Date.now(); renders++;
    });
    const restoreDisplay = () => {
      if (document.visibilityState !== 'visible' || !el.clientWidth || !el.clientHeight) return;
      log('visible-refresh');
      refit();
      term.refresh(0, term.rows - 1);
      send({ t: 'refresh' });
    };
    const io = new IntersectionObserver(e => {
      const visible = e[e.length - 1].isIntersecting;
      if (visible && !onScreen) restoreDisplay();
      onScreen = visible;
    });
    document.addEventListener('visibilitychange', restoreDisplay);
    window.addEventListener('focus', restoreDisplay);
    io.observe(el);
    const stallCheck = setInterval(() => {
      if (!parsedSince || Date.now() - parsedSince < 2000 || document.visibilityState !== 'visible' || !onScreen || !el.offsetWidth) return;
      log('render-stall', { waitedMs: Date.now() - parsedSince });
      parsedSince = Date.now();
      term.refresh(0, term.rows - 1);
      showRedrawn();
    }, 1000);
    actions.current = {
      live: () => { log('back-to-live'); send({ t: 'live' }); },
      refresh: () => { log('refresh'); refit(); term.refresh(0, term.rows - 1); send({ t: 'refresh' }); },
    };
    const unlist = liveScreen(id, () => serialize(term));
    const record = () => {
      const b = term.buffer.active;
      return { terminal: id, at: new Date().toISOString(), page: { visibility: document.visibilityState, onScreen, width: el.clientWidth, height: el.clientHeight, userAgent: navigator.userAgent },
        socket: ws?.readyState, renderer, cols: term.cols, rows: term.rows, buffer: { type: b.type, cursorX: b.cursorX, cursorY: b.cursorY, baseY: b.baseY, viewportY: b.viewportY, length: b.length },
        modes: term.modes, timing: { ...timing }, renders, lastRender, waitingToDrawSince: parsedSince, paneState: lastState, events: [...events] };
    };
    records.set(id, record);
    // A paste event arrives before xterm.js sends its text. Tell tmux to leave copy mode first.
    const onPaste = () => { log('paste'); send({ t: 'paste' }); };
    el.addEventListener('paste', onPaste, true);
    // Shift+Enter: Claude Code and Codex treat ESC+CR as a newline in the prompt
    term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) { if (ws && ws.readyState === 1) ws.send('\x1b\r'); return false; }
      // ⌃⌥ keys and the ⌘ / ⌃ keys set on the Settings page belong to Taskboard, not the terminal (keys.ts)
      if (taskboardKey(e)) return false;
      return true;
    });
    // refit at once, but tell tmux only once the size settles. Every fit goes through onResize: the box, a font size, the
    // window coming back into view.
    const resized = term.onResize(({ cols, rows }) => { log('fit', { cols, rows, ...sizeLog() }); sizes.changed(cols, rows); });
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    const sendFocus = () => send({ t: 'focus' });
    const onF = () => { sendFocus(); onFocusRef.current?.(); };
    term.textarea?.addEventListener('focus', onF);
    if (autoFocus) setTimeout(() => term.focus(), 50);

    return () => { document.removeEventListener('visibilitychange', restoreDisplay); window.removeEventListener('focus', restoreDisplay); sizes.dispose(); resized.dispose(); clearTimeout(redrawnTimer); clearTimeout(coverQuiet); clearTimeout(coverMax); clearInterval(stallCheck); io.disconnect(); parsed.dispose(); rendered.dispose(); if (records.get(id) === record) records.delete(id); ro.disconnect(); input.dispose(); keyed.dispose(); provider?.dispose(); underline.remove(); for (const type of ['mousedown', 'mouseup', 'click'] as const) el.removeEventListener(type, onModifiedMouse, true); el.removeEventListener('paste', onPaste, true); el.removeEventListener('mousedown', onHoldStart, true); term.textarea?.removeEventListener('focus', onF); ws?.dispose(); termRef.current = null; fitRef.current = () => {};
      unlist(); gone = true;
      // keep the screen only once tmux drew it: before that, the terminal shows the saved one (or nothing)
      if (timing.firstParsed !== undefined) { try { saveScreen(id, serialize(term)); } catch { /* not readable */ } }
      term.dispose();
    };
  }, [taskId, session]);

  // a new font size changes the cell size but not the box, so the ResizeObserver does not see it: fit here
  useEffect(() => { if (termRef.current) { termRef.current.options.fontSize = fontSize; fitRef.current(); } }, [fontSize]);
  useEffect(() => {
    // a new theme object makes xterm.js repaint with the new colours; the buffer and the session stay as they are
    const on = () => { const t = termRef.current; if (!t) return; const { theme, minimumContrastRatio } = readTerminalTheme(glassRef.current, tintRef.current); t.options.theme = theme; t.options.minimumContrastRatio = minimumContrastRatio; };
    addEventListener('tb-theme', on); return () => removeEventListener('tb-theme', on);
  }, []);
  // a new see-through value or tint changes only the colours: the terminal is not opened again (a new renderer for each open
  // was the cause of the black terminal fixed in task 140)
  useEffect(() => { const t = termRef.current; if (!t) return; const { theme, minimumContrastRatio } = readTerminalTheme(glass, tint); t.options.theme = theme; t.options.minimumContrastRatio = minimumContrastRatio; }, [glass, tint]);
  useEffect(() => { if (autoFocus) termRef.current?.focus(); }, [autoFocus]);

  // The bar at the top right says when the terminal does not show the agent's newest output, and why.
  const message = offline === 'no-session' ? 'The tmux session is not running · trying again every 10 s'
    : offline === 'no-terminal' ? 'The server could not open a terminal · reconnecting'
    : offline ? 'Disconnected · reconnecting · typing is not sent'
    : pane ? `${pane.selection ? 'Text selected' : pane.scroll ? 'Scrolled back' : 'Copy mode'} · ${pane.hidden ? 'new output below' : 'output paused'}`
    : redrawn ? 'Display was stalled · redrawn' : '';
  return <div className="xterm-box" ref={box}>
    {/* null, not '': an empty string child makes React set the box's text, which removes xterm.js from it */}
    {message ? <div className="term-bar" onMouseDown={e => e.stopPropagation()}>
      <span>{message}</span>
      {pane && <button className="btn" onClick={() => actions.current.live()} title="Leave tmux copy mode and show the newest output. No key is sent to the agent.">Back to live</button>}
      {!offline && <button className="btn" onClick={() => actions.current.refresh()} title="Draw the whole terminal again">Refresh</button>}
    </div> : null}
  </div>;
}
