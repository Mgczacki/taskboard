// The browser of a task (or the template browser): a screencast of one tab over /ws/browser, with its controls, and
// mouse and key input sent back to the page (server/task-browser.ts). The view can pop out into its own window; only
// one view of a browser streams at a time, so the panel shows a note meanwhile.
// Controls: in Canvas, the task panel and Settings, one 34 px row (back, forward, reload, the address with the page
// title, the tab count that opens the tab list, new tab, sound, stop, and a More menu). The pop-out window and the
// floating panel keep two rows: the tab strip and the address bar with its chips.
// A tab whose page waits for an answer (tab.dialog: alert, confirm, prompt, beforeunload) has an orange dot. Headless
// Chrome draws no box for it, so the view shows the question of the shown tab in a bar with OK and Cancel.
// The sound switch (SoundSwitch) is in both views: a browser starts muted until the user turns its sound on.
// The server sends the shown tab's loading state and history ("nav"), so back, forward and reload work like Chrome's.
// New tabs and popups (server/tab-switch.ts): the server switches the view to a popup or a tab that an agent opened, and
// says so ('active' with auto). The view then shows one line with a Go back button, moves the keys and the mouse to
// the new tab, and keeps a half typed address with the old tab (drafts). A popup that closes takes the view back. A
// background tab (middle or Cmd click), and every new tab while the switch is off, comes as an 'offer': a badge and a
// button. The switch is on the Settings page, and the More menu overrides it for one browser.
// Shared sign-ins (BrowserSignins.tsx): a line when the template has none or this browser opted out, and in the More
// menu and the card of a stopped browser: save as the template, sync from the template, the opt-out, and Reset.
// Keys with Cmd: L focuses the address, R reloads, [ and ] go back and forward, V pastes, C and X copy. The other keys
// go to the page, except Cmd pressed alone. Copy: after a mouse-up or a selection key the view asks the page for its selection ("copy" with
// peek, answered by "copied") and keeps it, so the browser's own copy event can put it on the clipboard at once.
// The wheel scrolls the page under the pointer: pixels, lines and pages, Shift for sideways (browserWheel.ts).
// Keys: the view carries data-tb-browser (keys.ts BROWSER_AREA), so no Taskboard key runs while the focus is in it and
// every key goes to the page. The one exception is browserLeave (⌃⌥Esc by default), which moves the focus back to
// Taskboard: to the terminal of the same Canvas window or task panel when there is one.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { BrowserStatus, BrowserTab } from '../api';
import { api } from '../api';
import { mb } from '../runtimeText';
import { countMessage } from '../perfStats';
import { hit, keyLabel, keysText, useKeymap } from '../keys';
import { wheelBatch } from '../browserWheel';
import { SigninDialog, SigninNote, useSharing, type SigninMode } from './BrowserSignins';
import { isApp, useAppWindow } from '../appWindow';
import { clampFloat, keepOnScreen, startFloatDrag } from '../floatWindow';

// ---------- which browsers are popped out ----------
// Pop out opens the view in its own window (/?browser=<id>, BrowserWindowPage below; an app window in the desktop app).
// The windows of this browser tell each other on the BroadcastChannel 'tb-browser-windows' which browsers have a
// window: 'open' and 'closed' from the browser window, 'who' from a page that starts, 'close' to ask a window to close.
// When the browser blocks the window, the view opens in a floating panel inside the page instead.
const popped = new Map<string, () => void>();
const subs = new Set<() => void>();
const notify = () => subs.forEach(f => f());
const usePopped = (id: string) => useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => popped.has(id));
type WinMsg = { type: 'open' | 'closed' | 'close'; id: string } | { type: 'who' };
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tb-browser-windows') : null;
const post = (m: WinMsg) => channel?.postMessage(m);
const BROWSER_PAGE = new URLSearchParams(location.search).get('browser');
// Put it back here: ask the window to close, and show the view here at once. A window that closes itself with
// window.close() in the desktop app sends no 'closed' (its pagehide message does not arrive), so this page does not wait.
const askClose = (id: string) => () => { post({ type: 'close', id }); if (popped.delete(id)) notify(); };
channel?.addEventListener('message', (e: MessageEvent<WinMsg>) => {
  const m = e.data;
  if (m.type === 'open' && !popped.has(m.id)) { popped.set(m.id, askClose(m.id)); notify(); }
  else if (m.type === 'closed' && popped.delete(m.id)) notify();
  else if (m.type === 'close' && m.id === BROWSER_PAGE) window.close();
  else if (m.type === 'who' && BROWSER_PAGE) post({ type: 'open', id: BROWSER_PAGE });
});
if (!BROWSER_PAGE) post({ type: 'who' });

export function popOutBrowser(id: string, title: string, sub = '', autostart = false) {
  if (popped.has(id)) return;
  const q = new URLSearchParams({ browser: id, title, ...(sub ? { sub } : {}), ...(autostart ? { start: '1' } : {}) });
  const w = window.open(`/?${q}`, `tb-browser-${id}`, `popup,width=${Math.min(1280, screen.availWidth)},height=${Math.min(900, screen.availHeight)}`);
  // the desktop app opens its own window and window.open returns null; a plain browser returns null when it blocks the window
  if (w || isApp()) { popped.set(id, askClose(id)); notify(); return; }
  floatInPage(id, title, sub, autostart);
}

// The page of a browser window: only the view, with the task as the window title.
// In the Mac app the window has no title bar: the header .bw-window-h is the drag area (app.css), with room on the
// left for the window buttons. A double click on it zooms the window, as on a title bar.
export function BrowserWindowPage() {
  const q = new URLSearchParams(location.search);
  const id = q.get('browser') || '', title = q.get('title') || 'Task browser', sub = q.get('sub') || '';
  useAppWindow();
  useEffect(() => {
    document.title = title;
    post({ type: 'open', id });
    const gone = () => post({ type: 'closed', id });
    addEventListener('pagehide', gone); return () => { removeEventListener('pagehide', gone); gone(); };
  }, []);
  return (
    <div className="bw-window">
      <div className="bw-window-h"><b>{title}</b>{sub && <span className="sub">{sub}</span>}</div>
      <BrowserView id={id} autostart={q.get('start') === '1'} floating />
    </div>
  );
}

let z = 300, n = 0;
function floatInPage(id: string, title: string, sub: string, autostart: boolean) {
  const host = document.createElement('div'); host.className = 'floatwin bw-float'; host.style.zIndex = String(++z);
  const k = n++ % 6;
  const at = clampFloat(Math.max(20, innerWidth - 1040 - k * 28), 70 + k * 28, 980, 40, innerWidth, innerHeight);
  Object.assign(host.style, { left: at.left + 'px', top: at.top + 'px', width: '980px', height: Math.min(720, innerHeight - 120) + 'px' });
  document.body.appendChild(host);
  const root = createRoot(host);
  const fit = () => keepOnScreen(host);
  addEventListener('resize', fit);
  const close = () => { removeEventListener('resize', fit); root.unmount(); host.remove(); popped.delete(id); notify(); };
  popped.set(id, close); notify();
  root.render(<FloatBrowser id={id} title={title} sub={sub} close={close} host={host} autostart={autostart} />);
}
function FloatBrowser({ id, title, sub, close, host, autostart }: { id: string; title: string; sub: string; close: () => void; host: HTMLElement; autostart: boolean }) {
  const [big, setBig] = useState(false);
  const toggle = () => { host.classList.toggle('big'); setBig(host.classList.contains('big')); };
  return (
    <>
      <div className="fw-h" onPointerDown={e => startFloatDrag(e, host)} onDoubleClick={toggle} onMouseDown={() => { host.style.zIndex = String(++z); }}>
        <div className="fw-t"><b>{title}</b><span>{sub}</span></div>
        <button className="bw-ib" onClick={toggle} aria-label={big ? 'Smaller window' : 'Larger window'} title="Make the window larger or smaller (double-click the title bar)">{big ? <Icon d={I.shrink} /> : <Icon d={I.grow} />}</button>
        <button className="bw-ib" onClick={close} aria-label="Put the browser back" title="Put the browser back in the task panel"><Icon d={I.close} /></button>
      </div>
      <div className="fw-b"><BrowserView id={id} autostart={autostart} floating /></div>
    </>
  );
}

// ---------- icons (24 x 24 paths, drawn with the text colour) ----------
const I = {
  back: 'M15 6l-6 6 6 6', forward: 'M9 6l6 6-6 6', reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6', stop: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14', close: 'M7 7l10 10M17 7L7 17', lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z', info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9M12 3C9.5 5.6 8.2 8.6 8.2 12s1.3 6.4 3.8 9',
  sound: 'M5 9v6h4l5 4V5L9 9H5zM17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11', muted: 'M5 9v6h4l5 4V5L9 9H5zM17 9l5 6M22 9l-5 6',
  popout: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5', power: 'M12 3v8M7.1 6.3a7 7 0 1 0 9.8 0',
  more: 'M5 12h.5M12 12h.5M19 12h.5', down: 'M6 9l6 6 6-6', canvas: 'M4 5h16v14H4zM4 13h16',
  grow: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5', copy: 'M9 9h10v11H9zM5 15V4h10',
};
function Icon({ d, size = 16, weight = 2 }: { d: string; size?: number; weight?: number }) {
  return <svg className="bw-svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

// The page icon from Chrome's tab list, or the first letter of the site when the page has none or it fails to load.
function Favicon({ tab }: { tab: BrowserTab }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [tab.faviconUrl]);
  const host = siteOf(tab.url);
  if (tab.faviconUrl && !bad) return <img className="bw-fav" src={tab.faviconUrl} alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} />;
  return host ? <span className="bw-fav letter">{host[0].toUpperCase()}</span> : <span className="bw-fav"><Icon d={I.globe} size={14} /></span>;
}
const siteOf = (url: string) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : ''; } catch { return ''; } };

// The address as Chrome shows it when the field is not focused: the host in full colour, the rest dimmed.
function urlParts(url: string): { scheme: string; host: string; rest: string; secure: boolean | null } {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { scheme: '', host: '', rest: url, secure: null };
    return { scheme: u.protocol === 'http:' ? 'http://' : '', host: u.host, rest: (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash, secure: u.protocol === 'https:' };
  } catch { return { scheme: '', host: '', rest: url, secure: null }; }
}

// ---------- the view ----------
const MOD = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTON = ['left', 'middle', 'right'] as const;
// the copy, cut and paste keys of this computer: Cmd on a Mac, Ctrl elsewhere
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const clipKey = (e: React.KeyboardEvent) => (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && ['v', 'c', 'x'].includes(e.key.toLowerCase());
// the CSS cursor keywords that the page can report ('cursor' from the server); other values show the arrow
const CURSORS = new Set(['default', 'pointer', 'text', 'vertical-text', 'move', 'grab', 'grabbing', 'crosshair', 'help', 'wait', 'progress', 'not-allowed', 'no-drop', 'copy', 'alias', 'cell', 'context-menu', 'zoom-in', 'zoom-out', 'none', 'all-scroll', 'col-resize', 'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize']);

// onCanvas: the task panel passes it, so the More menu can show the browser in the task's Canvas window
// remote: the name of the machine that runs the task, for the browser of a task on another machine (browser-forward.ts)
export function BrowserView({ id, title = '', autostart = false, floating = false, archived = false, isTemplate = false, onCanvas, remote }: { id: string; title?: string; autostart?: boolean; floating?: boolean; archived?: boolean; isTemplate?: boolean; onCanvas?: () => void; remote?: string }) {
  const isPopped = usePopped(id);
  if (isPopped && !floating) return (
    <div className="bw-empty"><div className="bw-card">
      <div className="bw-card-icon"><Icon d={I.popout} size={28} /></div>
      <h3>This browser is in its own window</h3>
      <div className="bw-actions"><button className="btn primary" onClick={() => popped.get(id)?.()}>Put it back here</button></div>
    </div></div>
  );
  return <Live id={id} title={title} autostart={autostart} floating={floating} archived={archived} isTemplate={isTemplate} onCanvas={onCanvas} remote={remote} />;
}

function Live({ id, title, autostart, floating, archived, isTemplate, onCanvas, remote }: { id: string; title: string; autostart: boolean; floating: boolean; archived: boolean; isTemplate: boolean; onCanvas?: () => void; remote?: string }) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [active, setActive] = useState('');
  const [state, setState] = useState<BrowserStatus | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [agents, setAgents] = useState(0);
  const [muted, setMuted] = useState<boolean | null>(null);
  const [nav, setNav] = useState({ loading: false, canBack: false, canForward: false });
  const [err, setErr] = useState('');
  const [flash, setFlash] = useState('');
  const [addr, setAddr] = useState('');
  const [editing, setEditing] = useState(false);
  const [framed, setFramed] = useState(false);
  const [pop, setPop] = useState<'tabs' | 'menu' | null>(null);
  const [promptText, setPromptText] = useState('');
  const [cursor, setCursor] = useState('default');
  const [signin, setSignin] = useState<SigninMode | null>(null);
  const [told, setTold] = useState('');
  // autoNote: the last switch that the server made by itself. offers: new tabs that did not take the view.
  const [autoNote, setAutoNote] = useState<{ id: string; from: string; reason: string } | null>(null);
  const [offers, setOffers] = useState<string[]>([]);
  // What the agent did last ('agent' from the server, AgentEvent in server/task-browser.ts), and its request for help.
  // userAt: the time of the user's last input in this view, so the strip can say that both act on the page.
  const [agentEvt, setAgentEvt] = useState<AgentEvt | null>(null);
  const [ask, setAsk] = useState<{ reason: string; at: string } | null>(null);
  const [askNote, setAskNote] = useState('');
  const userAt = useRef(0);
  // the pixels for each point of the running browser (scale) and the ones that a start would use now (wantScale)
  const [scale, setScale] = useState({ now: 1, want: 1 });
  // Open in a window (server/task-browser.ts setWindow): inWindow while the browser is a normal Chrome window on this
  // computer; switching while a change runs; unsent when the pages have text that a change would lose (the view asks).
  const [inWindow, setInWindow] = useState(false);
  const [switching, setSwitching] = useState<boolean | null>(null);
  const [unsent, setUnsent] = useState<{ on: boolean; fields: number } | null>(null);
  const windowable = !remote && !isTemplate && id !== 'template' && !archived;
  // The parts of the page that headless Chrome does not draw (WIDGETS in server/task-browser.ts): the view draws a
  // select list (widget kind 'select'), opens a picker of its own browser (kind 'input'), shows a context menu (menu),
  // asks for files for the page's file chooser (chooser), and lists downloads.
  const [widget, setWidget] = useState<Widget | null>(null);
  const [menu, setMenu] = useState<PageMenu | null>(null);
  const [chooser, setChooser] = useState<{ multiple: boolean } | null>(null);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // tip: the title of the element under the mouse ('title' from the server), shown after TIP_MS like a tooltip
  const [tip, setTip] = useState<{ text: string; x: number; y: number; at: number } | null>(null);
  // Zoom (Cmd or Ctrl with +, - and 0): the page gets a viewport of the view's size divided by the zoom, as with
  // Chrome's page zoom, and the view draws the frames to its own size. zoomRef is read by sendSize.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const toWindow = (on: boolean, force = false) => { setPop(null); setUnsent(null); send({ type: 'window', on, force }); };
  const [autoSwitch, setAutoSwitch] = useState({ on: true, own: false });
  const [sharing, reloadSharing] = useSharing(id, isTemplate || archived, running);
  const setShared = (on: boolean) => api.signinShared(id, on).then(() => { reloadSharing(); setTold(on ? 'This browser gets shared sign-ins again.' : 'This browser gets no shared sign-ins now. It keeps the sign-ins it has: Reset gives an empty profile.'); }).catch(e => setErr(String(e.message || e)));
  const signinParts = !isTemplate && !archived && <>
    <SigninNote status={sharing} onMode={setSignin} onShared={on => void setShared(on)} />
    {told && <div className="banner bw-signins">{told} <button className="btn ghost" onClick={() => setTold('')}>OK</button></div>}
    {signin && <SigninDialog id={id} mode={signin} onClose={() => setSignin(null)} onDone={text => { setSignin(null); setTold(text); reloadSharing(); }} />}
  </>;
  const canvas = useRef<HTMLCanvasElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  // Keys: a hidden text field in the view has the focus, so the system's IME, dead keys, the emoji picker and dictation
  // have a text field to work in. A key that one of them takes (composition) is left to the field, and its text goes to
  // the page as a composition ('ime') and then as committed text ('text'). Every other key goes as a key event.
  const kb = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [kbAt, setKbAt] = useState({ x: 0, y: 0 });
  const urlInput = useRef<HTMLInputElement>(null);
  const frameSize = useRef({ w: 1280, h: 800 });
  const ws = useRef<WebSocket | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoNoteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  // drafts: an address that the user typed into the address bar and did not go to, for each tab (with the tab's address
  // at that time). backTo: the tab that Go back returns to, so the view can give its draft the focus again.
  const drafts = useRef(new Map<string, { text: string; url: string }>());
  const backTo = useRef('');
  const onActive = useRef<(id: string, auto?: { from: string; reason: string }) => void>(() => {});
  const selection = useRef(''), peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const peek = () => { clearTimeout(peekTimer.current); peekTimer.current = setTimeout(() => send({ type: 'copy', peek: true }), 120); };
  // Frames: createImageBitmap decodes one JPEG at a time off the main thread. A frame that comes during a decode waits
  // (next), and a newer frame replaces it. The canvas draws the newest decoded frame once in each animation frame.
  // Each frame is reported ('drawn') when its decode ends or when a newer frame replaces it: the server sends at most
  // two frames that the view did not report, so frames never queue up here while the main thread is busy (back
  // pressure in server/task-browser.ts). gen: clearFrames() makes the frames that are still in a decode old.
  const frames = useRef({ shown: false, decoding: false, next: null as Blob | null, bitmap: null as ImageBitmap | null, raf: 0, gen: 0 });
  const drawn = () => send({ type: 'drawn' });
  const decode = (b: Blob) => {
    const f = frames.current, gen = f.gen;
    f.decoding = true;
    const done = (bm: ImageBitmap | null) => {
      f.decoding = false;
      drawn();
      if (bm && gen === f.gen) {
        f.bitmap?.close();
        f.bitmap = bm;
        if (!f.raf) f.raf = requestAnimationFrame(paint);
      } else bm?.close(); // a frame that does not decode: the next one replaces it
      const n = f.next; f.next = null;
      if (n) decode(n);
    };
    createImageBitmap(b).then(done, () => done(null));
  };
  const paint = () => {
    const f = frames.current, c = canvas.current, bm = f.bitmap;
    f.raf = 0; f.bitmap = null;
    if (!bm) return;
    if (c) {
      if (c.width !== bm.width || c.height !== bm.height) { c.width = bm.width; c.height = bm.height; }
      c.getContext('2d')?.drawImage(bm, 0, 0);
    }
    bm.close();
    if (c && !f.shown) { f.shown = true; setFramed(true); setRunning(true); }
  };
  const showFrame = (b: Blob) => {
    const f = frames.current;
    if (!f.decoding) decode(b);
    else { if (f.next) drawn(); f.next = b; }
  };
  const clearFrames = () => {
    const f = frames.current;
    f.shown = false; f.gen++;
    if (f.next) { f.next = null; drawn(); }
    f.bitmap?.close(); f.bitmap = null;
    const c = canvas.current; c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  };
  useEffect(() => () => { const f = frames.current; cancelAnimationFrame(f.raf); f.bitmap?.close(); }, []);
  const send = (m: object) => { if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m)); };
  const note = (text: string) => { setFlash(text); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(''), 1600); };

  useEffect(() => {
    let closed = false, retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/browser?id=${encodeURIComponent(id)}${autostart ? '&start=1' : ''}`);
      ws.current = s;
      s.binaryType = 'blob';
      s.onmessage = ev => {
        countMessage(ev.data);
        // a binary message is one JPEG frame of the page
        if (ev.data instanceof Blob) { showFrame(ev.data); return; }
        const m = JSON.parse(ev.data);
        if (m.type === 'frameSize') frameSize.current = { w: m.w, h: m.h };
        // the server sends the tabs every second: an unchanged list keeps the old array, so the view does not draw again
        else if (m.type === 'agent') setAgentEvt({ ...m, seen: Date.now() });
        else if (m.type === 'ask') setAsk(m.ask || null);
        else if (m.type === 'widget') { setMenu(null); setWidget(m); }
        else if (m.type === 'menu') { setWidget(null); setMenu(m); }
        else if (m.type === 'fileChooser') setChooser({ multiple: !!m.multiple });
        else if (m.type === 'download') setDownloads(prev => [...prev.filter(d => d.guid !== m.guid), m].slice(-20));
        else if (m.type === 'windowUnsent') setUnsent({ on: !!m.on, fields: m.fields || 0 });
        else if (m.type === 'windowSwitching') { setSwitching(!!m.on); setTimeout(() => setSwitching(null), 20000); }
        else if (m.type === 'tabs') { setInWindow(prev => { const w = !!m.window; if (w !== prev) setSwitching(null); return w; }); if (typeof m.scale === 'number') setScale(prev => prev.now === m.scale && prev.want === m.wantScale ? prev : { now: m.scale, want: m.wantScale || 1 }); setAsk(prev => JSON.stringify(prev) === JSON.stringify(m.ask || null) ? prev : m.ask || null); setTabs(prev => JSON.stringify(prev) === JSON.stringify(m.tabs) ? prev : m.tabs); setRunning(true); setAgents(m.agents || 0); setMuted(m.muted ?? null); setErr(''); setAutoSwitch(prev => prev.on === (m.autoSwitch !== false) && prev.own === !!m.autoSwitchOwn ? prev : { on: m.autoSwitch !== false, own: !!m.autoSwitchOwn }); }
        else if (m.type === 'active') onActive.current(m.id, m.auto);
        else if (m.type === 'offer') setOffers(prev => [...prev.filter(x => x !== m.id), m.id]);
        else if (m.type === 'title') setTip(m.title ? { text: m.title, x: m.x, y: m.y, at: Date.now() } : null);
        else if (m.type === 'cursor') setCursor(CURSORS.has(m.cursor) ? m.cursor : 'default');
        else if (m.type === 'nav') setNav({ loading: !!m.loading, canBack: !!m.canBack, canForward: !!m.canForward });
        else if (m.type === 'copied') {
          const text = typeof m.text === 'string' ? m.text : '';
          // a copy that came before the kept selection was fresh: write the fresh text (the key press still allows it)
          if (!m.peek && text && text !== selection.current) navigator.clipboard?.writeText(text).then(() => note('Copied'), () => {});
          selection.current = text;
        }
        else if (m.type === 'state') { setRunning(m.running); setState(m); setMuted(m.muted ?? null); if (!m.running) { setTabs([]); setActive(''); setFramed(false); clearFrames(); } }
        else if (m.type === 'error') setErr(m.message);
      };
      s.onopen = () => { send({ type: 'hello', acks: true, dpr: devicePixelRatio }); send({ type: 'visible', on: shown.current }); sendSize(); };
      s.onclose = () => { if (!closed) retry = setTimeout(connect, 2000); };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); clearTimeout(flashTimer.current); clearTimeout(autoNoteTimer.current); clearTimeout(peekTimer.current); ws.current?.close(); };
  }, [id]);

  // The server streams frames only while the view is on the screen: the page is visible (not a background tab, not a
  // minimized window) and the view intersects the viewport (not display: none, not scrolled out of a Canvas).
  const shown = useRef(true);
  useEffect(() => {
    const el = screen.current; if (!el) return;
    let inView = true;
    const report = () => { const on = inView && document.visibilityState === 'visible'; if (on !== shown.current) { shown.current = on; send({ type: 'visible', on }); } };
    const io = new IntersectionObserver(es => { inView = es[es.length - 1].isIntersecting; report(); });
    io.observe(el);
    document.addEventListener('visibilitychange', report);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', report); };
  }, [running]);

  // the page's viewport is the size of this view, so a frame fills it without bars
  const sendSize = () => { const r = screen.current?.getBoundingClientRect(), z = zoomRef.current; if (r && r.width > 100 && r.height > 100) send({ type: 'size', w: r.width / z, h: r.height / z }); };
  const setZoomTo = (z: number) => { const n = Math.round(Math.min(3, Math.max(0.5, z)) * 100) / 100; zoomRef.current = n; setZoom(n); sendSize(); note(`Zoom ${Math.round(n * 100)}%`); };
  const zoomStep = (d: number) => { const i = ZOOMS.findIndex(x => x >= zoomRef.current - 0.001); setZoomTo(d === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + d))]); };
  useEffect(() => {
    if (!screen.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(sendSize, 200); });
    ro.observe(screen.current);
    return () => { ro.disconnect(); clearTimeout(timer); };
  }, [running]);

  const activeTab = tabs.find(t => t.id === active);
  // The view shows another tab. A half typed address stays with the old tab. After a switch by the server, the keys and
  // the mouse go to the new tab: the focus moves from the address bar to the page, but only when it was in this view.
  onActive.current = (next, auto) => {
    if (next !== active) {
      const input = urlInput.current;
      if (active && input && document.activeElement === input && addr.trim() && addr !== activeTab?.url) drafts.current.set(active, { text: addr, url: activeTab?.url || '' });
      if (auto && root.current?.contains(document.activeElement)) screen.current?.focus();
      // Go back to a tab with a draft: the draft and the focus return to the address bar (the text is set here, because
      // the focus can come before the effect below runs, and that effect does not change the field while it has focus)
      const draft = drafts.current.get(next);
      if (next === backTo.current && draft) { setAddr(draft.text); setTimeout(() => { const el = urlInput.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 0); }
      backTo.current = '';
    }
    setActive(next);
    setOffers(prev => prev.includes(next) ? prev.filter(x => x !== next) : prev);
    if (auto) {
      setAutoNote({ id: next, ...auto });
      clearTimeout(autoNoteTimer.current); autoNoteTimer.current = setTimeout(() => setAutoNote(null), 10000);
    }
  };
  // the address of the shown tab, or the draft that the user left in this tab (while the tab is still at that address)
  useEffect(() => {
    if (editing) return;
    const d = drafts.current.get(active);
    if (d && d.url !== (activeTab?.url || '')) drafts.current.delete(active);
    setAddr(drafts.current.get(active)?.text ?? (activeTab?.url === 'about:blank' ? '' : activeTab?.url || ''));
  }, [active, activeTab?.url, editing]);
  const dialog = activeTab?.dialog;
  useEffect(() => { setPromptText(dialog?.defaultPrompt || ''); }, [active, dialog?.type, dialog?.message]);
  const answer = (accept: boolean) => send({ type: 'dialog', id: active, accept, ...(dialog?.type === 'prompt' ? { text: promptText } : {}) });
  // the page's select list, picker and context menu close on a click outside them, and when the tab changes
  useEffect(() => {
    if (!widget && !menu) return;
    const down = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.('.bw-list-pop, .bw-picker, .bw-pagemenu')) { setWidget(null); setMenu(null); } };
    addEventListener('pointerdown', down, true); return () => removeEventListener('pointerdown', down, true);
  }, [widget, menu]);
  useEffect(() => { setWidget(null); setMenu(null); setChooser(null); }, [active]);
  // the tab list and the More menu close on a click outside them
  useEffect(() => {
    if (!pop) return;
    const down = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.('.bw-pop, .bw-popbtn')) setPop(null); };
    addEventListener('pointerdown', down, true); return () => removeEventListener('pointerdown', down, true);
  }, [pop]);
  const copyAddress = () => { const u = activeTab?.url; if (u) navigator.clipboard?.writeText(u).then(() => note('Copied the address'), () => note('Could not copy')); };

  // mouse and keys
  const point = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * frameSize.current.w / r.width), y: Math.round((e.clientY - r.top) * frameSize.current.h / r.height) };
  };
  // Moves go out at most once for each animation frame (the newest position). A press, a release or the wheel first
  // sends the waiting move (and a press or a release the waiting wheel), so the page gets the events in the order the
  // user made them.
  const pendingMove = useRef<{ msg: object; raf: number } | null>(null);
  const flushMove = () => { const p = pendingMove.current; if (!p) return; cancelAnimationFrame(p.raf); pendingMove.current = null; send(p.msg); };
  const mouse = (event: string, e: React.MouseEvent, clickCount = 0) => {
    if (!canvas.current) return;
    if (event !== 'mouseMoved') userAt.current = Date.now();
    const msg = { type: 'mouse', event, ...point(e), button: event === 'mouseMoved' ? (e.buttons ? 'left' : 'none') : BUTTON[e.button] || 'left', buttons: e.buttons, clickCount, modifiers: MOD(e) };
    if (event === 'mouseMoved') {
      if (pendingMove.current) pendingMove.current.msg = msg;
      else pendingMove.current = { msg, raf: requestAnimationFrame(flushMove) };
      return;
    }
    wheel.flush(); flushMove(); send(msg);
  };
  // The wheel: one message for each animation frame with the sum of the deltas in pixels (browserWheel.ts).
  const wheelRef = useRef<ReturnType<typeof wheelBatch> | null>(null);
  const wheel = wheelRef.current ??= wheelBatch(m => { flushMove(); send(m); });
  useEffect(() => () => { if (pendingMove.current) cancelAnimationFrame(pendingMove.current.raf); wheel.stop(); }, []);
  // The wheel listener is not passive (React's onWheel is), so it can stop the dashboard from scrolling. A callback ref
  // puts it on each bw-screen element that React creates, whatever made React create it. (It was an effect that ran
  // again only when `running` changed.)
  const onWheel = useRef<(e: WheelEvent) => void>(() => {});
  onWheel.current = e => { e.preventDefault(); if (canvas.current) wheel.add(e, point(e), MOD(e), frameSize.current); };
  const [wheelListener] = useState(() => (e: WheelEvent) => onWheel.current(e));
  const screenRef = useCallback((el: HTMLDivElement | null) => {
    screen.current?.removeEventListener('wheel', wheelListener);
    screen.current = el;
    el?.addEventListener('wheel', wheelListener, { passive: false });
  }, [wheelListener]);
  const back = () => send({ type: 'nav', action: 'back' });
  const forward = () => send({ type: 'nav', action: 'forward' });
  const reload = () => send({ type: 'nav', action: nav.loading ? 'stop' : 'reload' });
  const focusAddress = () => { urlInput.current?.focus(); urlInput.current?.select(); };
  // Cmd shortcuts of the browser itself; returns true when the key is handled here and must not reach the page
  const shortcut = (e: React.KeyboardEvent) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return false;
    const k = e.key.toLowerCase();
    if (k === 'l') focusAddress();
    else if (k === 'r') reload();
    else if (e.key === '[') back();
    else if (e.key === ']') forward();
    else return false;
    return true;
  };
  const key = (e: React.KeyboardEvent, down: boolean) => {
    if (widget?.kind === 'select' && listKey(e, down)) return;
    if (clipKey(e)) return; // these go through the paste, copy and cut events
    if ((IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && ['=', '+', '-', '_', '0'].includes(e.key)) { e.preventDefault(); if (down) zoomStep(e.key === '0' ? 0 : e.key === '-' || e.key === '_' ? -1 : 1); return; }
    // a key that the IME or a dead key takes stays in the hidden field; its text comes with the composition events
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229 || e.key === 'Dead' || e.key === 'Process') return;
    if (down && shortcut(e)) { e.preventDefault(); return; }
    if (e.metaKey && ['l', 'r', '[', ']'].includes(e.key.toLowerCase())) { e.preventDefault(); return; } // the key up of a shortcut
    // Cmd alone does not go to the page. Its key down reached Chrome as a stuck key (see keyEvent in
    // server/task-browser.ts). The Cmd shortcuts that go to the page carry the Meta bit in their modifiers.
    if (e.key === 'Meta') return;
    e.preventDefault();
    userAt.current = Date.now();
    send({ type: 'key', down, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: MOD(e), ...(e.getModifierState('AltGraph') ? { altGraph: true } : {}) });
    if (!down && (e.shiftKey || e.metaKey || e.altKey)) peek(); // Shift+Arrow, Cmd+A and the like change the selection
  };
  // The keys of an open select list: Up and Down move, Enter chooses, Escape closes. listAt is the marked row.
  const [listAt, setListAt] = useState(-1);
  useEffect(() => { setListAt(widget?.kind === 'select' ? widget.selectedIndex : -1); }, [widget]);
  const choose = (value: string | number) => { send({ type: 'widgetSet', value }); setWidget(null); kb.current?.focus({ preventScroll: true }); };
  const listKey = (e: React.KeyboardEvent, down: boolean) => {
    if (!widget || widget.kind !== 'select' || !['ArrowDown', 'ArrowUp', 'Enter', 'Escape', ' '].includes(e.key)) return false;
    e.preventDefault();
    if (!down) return true;
    const opts = widget.options, step = (d: number) => { let i = listAt; for (let k = 0; k < opts.length; k++) { i = Math.max(0, Math.min(opts.length - 1, i + d)); if (!opts[i].disabled) break; } setListAt(i); };
    if (e.key === 'ArrowDown') step(1); else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Escape') setWidget(null);
    else if (listAt >= 0 && !opts[listAt]?.disabled) choose(listAt);
    return true;
  };
  // a point or a box of the page (CSS pixels, like frameSize) in pixels of the view
  const toView = (x: number, y: number) => { const r = screen.current?.getBoundingClientRect(), f = frameSize.current; return r && f.w ? { x: x * r.width / f.w, y: y * r.height / f.h } : { x, y }; };
  // files for the page's file chooser, or dropped on the view: posted first (api.browserUpload), then named by their ids
  const sendFiles = async (list: File[], drop?: { x: number; y: number }) => {
    if (!list.length) return;
    try {
      const uploads = [];
      for (const f of list.slice(0, 20)) uploads.push((await api.browserUpload(id, f, f.name)).id);
      send({ type: 'files', uploads, ...(drop ? { drop: true, ...drop } : {}) });
      note(list.length === 1 ? `Sent ${list[0].name}` : `Sent ${list.length} files`);
    } catch (e) { setErr(`The file did not reach the page: ${(e as Error).message || e}`); }
  };
  const menuAction = async (what: string) => {
    const m = menu; setMenu(null); if (!m) return;
    if (what === 'open' && m.href) send({ type: 'openLink', url: m.href });
    else if (what === 'openImage' && m.src) send({ type: 'openLink', url: m.src });
    else if (what === 'copyLink' && m.href) navigator.clipboard?.writeText(m.href).then(() => note('Copied the link address'), () => note('Could not copy'));
    else if (what === 'copyImage' && m.src) navigator.clipboard?.writeText(m.src).then(() => note('Copied the image address'), () => note('Could not copy'));
    else if (what === 'copy') { if (selection.current) navigator.clipboard?.writeText(selection.current).then(() => note('Copied'), () => note('Could not copy')); }
    else if (what === 'paste') {
      try { const t = await navigator.clipboard.readText(); if (t) send({ type: 'paste', text: t.slice(0, 300000), html: '', image: '' }); }
      catch { note('Press the paste key: this browser did not allow reading the clipboard'); }
    }
    else if (what === 'back') back(); else if (what === 'forward') forward(); else if (what === 'reload') reload();
    kb.current?.focus({ preventScroll: true });
  };
  // The hidden field follows the last click, so the IME shows its candidate list near the place that the user types in.
  const moveKb = (e: React.MouseEvent) => { const r = screen.current?.getBoundingClientRect(); if (r) setKbAt({ x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) }); };
  // A paste: plain text, HTML and the first image, which the server puts on the page's clipboard and pastes there, so the
  // page gets a real paste event (server/task-browser.ts paste). The image goes as a PNG upload first.
  const pasteFrom = async (dt: DataTransfer) => {
    const text = dt.getData('text/plain'), html = dt.getData('text/html');
    const file = [...dt.files].find(f => f.type.startsWith('image/'));
    let image = '';
    if (file) {
      try {
        const bm = await createImageBitmap(file), c = document.createElement('canvas');
        c.width = bm.width; c.height = bm.height; c.getContext('2d')?.drawImage(bm, 0, 0); bm.close();
        const png = await new Promise<Blob | null>(r => c.toBlob(r, 'image/png'));
        if (png) image = (await api.browserUpload(id, png, 'pasted.png')).id;
      } catch (e) { note(`Could not paste the image: ${(e as Error).message || e}`); }
    }
    // the socket takes messages up to 1 MB
    if (text || html || image) send({ type: 'paste', text: text.slice(0, 300000), html: html.slice(0, 400000), image });
  };
  const copy = (e: React.ClipboardEvent, cut: boolean) => {
    e.preventDefault();
    e.clipboardData.setData('text/plain', selection.current);
    note(selection.current ? (cut ? 'Cut' : 'Copied') : 'Nothing selected');
    send({ type: 'copy', cut });
  };

  // browserLeave: the page got the keydown of ⌃ and ⌥ before the key, so release them there, then move the focus out
  const [inside, setInside] = useState(false);
  useKeymap();
  const leave = (e: React.KeyboardEvent) => {
    if (!hit(e.nativeEvent, 'browserLeave')) return;
    e.preventDefault(); e.stopPropagation();
    for (const [key, code, keyCode] of [['Control', 'ControlLeft', 17], ['Alt', 'AltLeft', 18], ['Shift', 'ShiftLeft', 16]] as const) send({ type: 'key', down: false, key, code, keyCode, modifiers: 0 });
    leaveBrowser(e.currentTarget as HTMLElement);
  };
  const go = () => { drafts.current.delete(active); setEditing(false); if (addr.trim()) send({ type: 'nav', action: 'go', url: addr.trim() }); screen.current?.focus(); };
  const select = (tab: string) => send({ type: 'select', id: tab });
  const goBack = () => { if (!autoNote) return; backTo.current = autoNote.from; setAutoNote(null); select(autoNote.from); };
  const startNow = () => { setErr(''); send({ type: 'start' }); };

  // A start that runs (state.starting): its time, and after 15 s a note that the computer is slow. A start can take up to
  // starting.limitSeconds; it fails earlier only when Chrome exits.
  const starting = state?.starting;
  const lowMemory = state?.systemMemory?.low ? state.systemMemory : null;
  const memoryNote = lowMemory && <div className="banner bw-warn">Little memory is free: {lowMemory.availablePct}% of {mb(lowMemory.totalMb)} ({mb(lowMemory.availableMb)}). A task browser uses about 450 MB, and Chrome starts slowly when memory is low. Stop browsers or test servers that you do not need.</div>;
  if (running === false && starting) return (
    <div className="bw-empty"><div className="bw-card">
      <div className="bw-card-icon"><span className="bw-spin bw-spin-l" /></div>
      <h3>{isTemplate ? 'The template browser is starting' : 'The browser is starting'} ({starting.seconds} s)</h3>
      <p>{starting.seconds < 15 ? 'Chrome usually starts in about 1 s.'
        : `Chrome is slow to start. This happens when the computer is busy or has little free memory. Taskboard waits up to ${starting.limitSeconds} s while the Chrome process runs, and starts no second Chrome.`}</p>
      {memoryNote}
    </div></div>
  );
  // the last start failed (error), or Chrome ended by itself after its start (exited)
  const failed = !!state?.error && !archived;
  if (running === false) return (
    <div className="bw-empty"><div className="bw-card">
      <div className="bw-card-icon"><Icon d={I.globe} size={28} /></div>
      <h3>{archived ? 'The browser is closed' : failed ? (state?.exited ? 'Chrome stopped by itself' : 'The browser did not start') : isTemplate ? 'The template browser is closed' : state?.suspended ? 'The browser is closed while the task is suspended' : state?.idleStopped ? 'The browser stopped because nobody used it' : 'The browser is not running'}</h3>
      <p>{archived ? 'The task is archived. The profile is kept until the task is removed.'
        : failed ? (state?.exited ? 'It starts again when the agent uses it, or when you start it.' : 'An agent that called a browser tool got the same reason. Retry starts Chrome again.')
        : isTemplate ? 'Sign in here once. New task browsers copy this profile.'
        : state?.suspended ? 'It opens again when the task resumes.'
        : state?.idleStopped ? `No agent used it and no one viewed it for ${state.idleStopMinutes} minutes${state.stoppedAt ? `, so it stopped at ${new Date(state.stoppedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}. It starts again when the agent uses it, or when you start it.`
        : 'Opening this tab does not start it. It starts when the agent uses it, or when you start it.'}</p>
      {!archived && <div className="bw-actions">
        <button className="btn primary" onClick={startNow}>{failed && !state?.exited ? 'Retry' : isTemplate ? 'Open the template browser' : 'Start the browser'}</button>
        <SoundSwitch id={id} muted={muted} labeled onChange={setMuted} onDone={s => { setState(s); setMuted(s.muted); }} onError={setErr} />
      </div>}
      {!!state?.tabs.length && <div className="bw-saved">
        <div className="bw-saved-h">Opens at the next start</div>
        {state.tabs.map(t => <div key={t.id} className="bw-saved-row" title={t.url}><Favicon tab={t} /><span>{t.url}</span></div>)}
      </div>}
      {failed && <div className="banner">{state!.error}{state!.errorAt && !state!.exited && <span className="bw-when"> ({new Date(state!.errorAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })})</span>}</div>}
      {failed && !!state?.errorLines?.length && <div className="bw-saved">
        <div className="bw-saved-h">Last lines of chrome.log</div>
        <pre className="bw-log">{state.errorLines.join('\n')}</pre>
      </div>}
      {!archived && memoryNote}
      {err && err !== state?.error && <div className="banner">{err}</div>}
      {signinParts}
      {!isTemplate && state && <div className="bw-card-foot">
        <span>{state.profile ? `Profile ${state.copiedFromTemplate ? `copied from the template on ${new Date(state.copiedFromTemplate).toLocaleDateString()}` : 'without a template copy'}${state.syncedAt ? `, synced on ${new Date(state.syncedAt).toLocaleDateString()}` : ''}.` : state.noShared ? 'The first start makes an empty profile.' : 'The first start copies the template profile.'}</span>
        {!archived && <label className="bw-share" title="Off: this browser does not copy the template, cannot sync, and is not part of live sharing. Use this for tasks that open untrusted pages."><input type="checkbox" checked={!state.noShared} onChange={e => void setShared(e.target.checked)} /> Shared sign-ins</label>}
      </div>}
      {!isTemplate && state?.profile && !archived && <div className="bw-actions bw-signin-actions">
        {!state.noShared && <button className="btn ghost" onClick={() => setSignin('sync')} title="Add the template's cookies of the sites you choose. This browser keeps its own state.">Sync sign-ins from the template</button>}
        <button className="btn ghost" onClick={() => setSignin('save')} title="Copy the sign-ins and site data of this browser into the template, for new tasks">Use this browser's sign-ins for new tasks</button>
        <button className="btn ghost danger" onClick={() => setSignin('reset')} title={state.noShared ? 'Delete the profile of this task browser. The next start makes an empty profile.' : "Delete this task's profile and copy the template again. The task loses its own sign-ins."}>{state.noShared ? 'Reset to an empty profile' : 'Reset from template'}</button>
      </div>}
    </div></div>
  );

  const parts = urlParts(addr);
  const compact = !floating;
  const pageTitle = activeTab && activeTab.title && activeTab.title !== activeTab.url ? activeTab.title : '';
  const waiting = tabs.some(t => t.dialog);
  const tabName = (t: BrowserTab) => t.title && t.title !== t.url ? t.title : siteOf(t.url) || (t.url === 'about:blank' ? 'New tab' : t.url);
  const navButtons = <>
    <button className="bw-ib" onClick={back} disabled={!nav.canBack} aria-label="Back" title="Back (⌘[)"><Icon d={I.back} /></button>
    <button className="bw-ib" onClick={forward} disabled={!nav.canForward} aria-label="Forward" title="Forward (⌘])"><Icon d={I.forward} /></button>
    <button className="bw-ib" onClick={reload} aria-label={nav.loading ? 'Stop loading' : 'Reload'} title={nav.loading ? 'Stop loading' : 'Reload (⌘R)'}><Icon d={nav.loading ? I.stop : I.reload} /></button>
  </>;
  // In the compact row the address shows the page title and the host until the field has the focus.
  const address = (
    <div className={`bw-addr ${editing ? 'editing' : ''}`} onClick={() => !editing && focusAddress()}>
      <span className={`bw-site ${parts.secure ? 'secure' : ''}`} title={parts.secure === null ? '' : parts.secure ? 'The connection uses HTTPS' : 'The connection is not secure'}>
        <Icon d={parts.secure === false ? I.info : parts.secure ? I.lock : I.globe} size={14} />
      </span>
      <input ref={urlInput} className="bw-url" value={addr} placeholder="Search or type an address" aria-label="Address"
        onFocus={e => { setEditing(true); setPop(null); e.target.select(); }} onBlur={() => setEditing(false)} onChange={e => setAddr(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { drafts.current.delete(active); setEditing(false); setAddr(activeTab?.url || ''); screen.current?.focus(); } }} spellCheck={false} />
      {!editing && addr && (compact && pageTitle
        ? <span className="bw-urlview" aria-hidden="true" title={addr}><span className="bw-ttl">{pageTitle}</span>{parts.host && <span className="dim">{parts.host}</span>}</span>
        : <span className="bw-urlview" aria-hidden="true"><span className="dim">{parts.scheme}</span>{parts.host}<span className="dim">{parts.rest}</span></span>)}
      {compact && !editing && addr && <button className="bw-cp" onMouseDown={e => e.preventDefault()} onClick={e => { e.stopPropagation(); copyAddress(); }} aria-label="Copy the address" title="Copy the address"><Icon d={I.copy} size={13} /></button>}
    </div>
  );
  const popOut = () => { setPop(null); popOutBrowser(id, title || (isTemplate ? 'Template browser' : 'Task browser'), isTemplate ? 'Sign in here. New task browsers copy this profile.' : ''); };
  const stopButton = <button className="bw-ib danger" onClick={() => send({ type: 'stop' })} aria-label={isTemplate ? 'Close the template browser' : 'Stop the browser'} title={isTemplate ? 'Close the template browser. New task browsers can copy it only when it is closed.' : 'Stop the browser. Its pages open again at the next start.'}><Icon d={I.power} /></button>;
  const sound = <SoundSwitch id={id} muted={muted} onChange={setMuted} onDone={s => setMuted(s.muted)} onError={setErr} />;
  // new tabs that did not take the view: a button that shows the newest one, with the number of them
  const offered = offers.filter(o => o !== active && tabs.some(t => t.id === o));
  const newest = tabs.find(t => t.id === offered[offered.length - 1]);
  const offerButton = newest && <button className="bw-chip bw-offer" onClick={() => { setOffers([]); select(newest.id); }} title={`Show the new tab: ${newest.url}${offered.length > 1 ? `. ${offered.length} new tabs are waiting.` : ''}`}>
    <i className="bw-new" />New tab: <span className="bw-offer-t">{tabName(newest)}</span>{offered.length > 1 && <b>+{offered.length - 1}</b>}
  </button>;
  const noteTab = autoNote && tabs.find(t => t.id === autoNote.id);
  const fromTab = autoNote && tabs.find(t => t.id === autoNote.from);
  const windowLine = (unsent || switching !== null) && <div className="bw-agentline both" role="status">
    {switching !== null ? <span className="bw-what"><span className="bw-spin" /> {switching ? 'Opening the browser in its own window. The pages load again.' : 'Moving the browser back here. The pages load again.'}</span>
      : <><span className="bw-what">{unsent!.fields} {unsent!.fields === 1 ? 'field has' : 'fields have'} text that is not sent yet. The pages load again, and that text is lost.</span>
        <button className="btn" onClick={() => toWindow(unsent!.on, true)}>{unsent!.on ? 'Open in a window anyway' : 'Move back anyway'}</button>
        <button className="btn ghost" onClick={() => setUnsent(null)}>Cancel</button></>}
  </div>;
  const agentLine = <AgentStrip evt={agentEvt} ask={ask} note={askNote} setNote={setAskNote} userAt={userAt} onWindow={windowable && !inWindow ? () => toWindow(true) : undefined}
    onDone={() => { send({ type: 'askDone', note: askNote.trim() }); setAsk(null); setAskNote(''); note('The agent got your answer'); }} />;
  const switchedLine = autoNote && autoNote.id === active && <div className="bw-switched" role="status">
    <span className="bw-switched-t">{autoNote.reason === 'back' ? <>The tab closed. Back to <b>{noteTab ? tabName(noteTab) : 'the earlier tab'}</b>.</> : <>Switched to the new tab: <b>{noteTab ? tabName(noteTab) : 'loading…'}</b></>}</span>
    {autoNote.reason !== 'back' && fromTab && <button className="btn ghost" onClick={goBack} title={`Show ${tabName(fromTab)} again`}>Go back</button>}
    <button className="bw-ib" onClick={() => setAutoNote(null)} aria-label="Hide this line" title="Hide this line"><Icon d={I.close} size={13} /></button>
  </div>;
  // a restart gives a sharp picture when the browser runs with fewer pixels than this screen has (the pages reopen)
  const rescale = Math.abs(scale.want - scale.now) > 0.1 && !isTemplate;
  const restartScale = () => { setPop(null); send({ type: 'restartScale' }); };
  const autoSwitchItem = <button className="bw-mi" role="menuitemcheckbox" aria-checked={autoSwitch.on} onClick={() => { setPop(null); send({ type: 'autoSwitch', on: !autoSwitch.on }); }}>
    <Icon d={autoSwitch.on ? I.popout : I.close} size={15} /><span>Switch to new tabs and popups: {autoSwitch.on ? 'on' : 'off'}<small>{autoSwitch.own ? 'Set for this browser. Click to change.' : 'From Settings. Click to change for this browser.'}</small></span>
  </button>;
  return (
    <div ref={root} className={`bw ${inside ? 'kb' : ''} ${compact ? 'compact' : ''}`} data-tb-browser="" onKeyDownCapture={leave} onFocus={() => setInside(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setInside(false); }}>
      {compact ? (
        <div className="bw-bar bw-row">
          {navButtons}
          {address}
          {flash && <span className="bw-chip flash">{flash}</span>}
          {zoom !== 1 && <button className="bw-chip" onClick={() => setZoomTo(1)} title="Zoom of this view. Click for 100%.">{Math.round(zoom * 100)}%</button>}
          <button className={`bw-tabsbtn bw-popbtn ${pop === 'tabs' ? 'on' : ''}`} onClick={() => setPop(p => p === 'tabs' ? null : 'tabs')} aria-expanded={pop === 'tabs'} aria-label={`All ${tabs.length} tabs`} title={`All ${tabs.length} tabs${waiting ? '. A page waits for an answer.' : ''}`}>
            <b>{tabs.length}</b><Icon d={I.down} size={12} />{waiting ? <i className="bw-ask" /> : offered.length > 0 && <i className="bw-new" />}
          </button>
          {offerButton}
          <button className="bw-ib" onClick={() => send({ type: 'new', url: 'about:blank' })} aria-label="New tab" title="New tab"><Icon d={I.plus} /></button>
          {sound}
          {stopButton}
          <button className={`bw-ib bw-popbtn bw-more ${pop === 'menu' ? 'on' : ''}`} onClick={() => setPop(p => p === 'menu' ? null : 'menu')} aria-expanded={pop === 'menu'} aria-label="More" title="More: copy the address, pop out, memory, keys">
            <Icon d={I.more} weight={3} />{agents > 0 && <i className="bw-agent" />}
          </button>
          {nav.loading && <div className="bw-progress" />}
          {pop === 'tabs' && <TabList tabs={tabs} active={active} name={tabName} offered={offered}
            onSelect={t => { setPop(null); select(t); screen.current?.focus(); }}
            onClose={t => send({ type: 'close', id: t })} onNew={() => { setPop(null); send({ type: 'new', url: 'about:blank' }); }}
            onDone={() => { setPop(null); screen.current?.focus(); }} />}
          {pop === 'menu' && <div className="bw-pop bw-menu" role="menu">
            {activeTab?.url && activeTab.url !== 'about:blank' && <button className="bw-mi" role="menuitem" onClick={() => { setPop(null); copyAddress(); }}><Icon d={I.copy} size={15} /><span>Copy the address</span></button>}
            <button className="bw-mi" role="menuitem" onClick={popOut}><Icon d={I.popout} size={15} /><span>Pop out<small>Show the browser in its own window</small></span></button>
            {onCanvas && <button className="bw-mi" role="menuitem" onClick={() => { setPop(null); onCanvas(); }}><Icon d={I.canvas} size={15} /><span>Show on Canvas<small>Above the terminal of this task</small></span></button>}
            {autoSwitchItem}
            {windowable && !inWindow && <button className="bw-mi" role="menuitem" onClick={() => toWindow(true)}><Icon d={I.popout} size={15} /><span>Open in a window<small>A normal Chrome window on this computer, with the same profile and tabs. For passkeys, password managers and hard sign-ins. The pages load again.</small></span></button>}
            {rescale && <button className="bw-mi" role="menuitem" onClick={restartScale}><Icon d={I.reload} size={15} /><span>Restart for a sharp picture<small>The browser runs with {scale.now} pixel{scale.now === 1 ? '' : 's'} for each point; this screen wants {scale.want}. The pages open again.</small></span></button>}
            <div className="bw-msep" />
            {!isTemplate && !archived && <>
              {!sharing?.noShared && <button className="bw-mi" role="menuitem" onClick={() => { setPop(null); setSignin('sync'); }}><Icon d={I.reload} size={15} /><span>Sync sign-ins from the template<small>Adds its cookies for the sites you choose</small></span></button>}
              <button className="bw-mi" role="menuitem" onClick={() => { setPop(null); setSignin('save'); }}><Icon d={I.copy} size={15} /><span>Use this browser's sign-ins for new tasks<small>Copies them into the template</small></span></button>
              <button className="bw-mi" role="menuitemcheckbox" aria-checked={!sharing?.noShared} onClick={() => { setPop(null); void setShared(!!sharing?.noShared); }}><Icon d={sharing?.noShared ? I.close : I.lock} size={15} /><span>Shared sign-ins: {sharing?.noShared ? 'off' : 'on'}<small>{sharing?.noShared ? 'Click to get the template and live sign-ins' : 'Click to turn off, for untrusted pages'}</small></span></button>
              <button className="bw-mi danger" role="menuitem" onClick={() => { setPop(null); setSignin('reset'); }}><Icon d={I.stop} size={15} /><span>{sharing?.noShared ? 'Reset to an empty profile' : 'Reset from template'}<small>Deletes this browser's own sign-ins</small></span></button>
              <div className="bw-msep" />
            </>}
            {!isTemplate && !remote && <BrowserMemory id={id} row />}
            {remote && <div className="bw-minfo" title="The Chrome of this task runs on the other machine. Its picture and your input go through this Taskboard.">This browser runs on {remote}</div>}
            {agents > 0 && <div className="bw-minfo"><i className="bw-agent in" />An agent is connected to this browser</div>}
            {keyLabel('browserLeave') && <div className="bw-minfo" title="While the focus is in this browser, every key goes to the page, also ⌘ and ⌃ keys."><kbd>{keyLabel('browserLeave')}</kbd> gives the keys back to Taskboard</div>}
          </div>}
        </div>
      ) : <>
        <div className="bw-tabs" onDoubleClick={e => { if (e.target === e.currentTarget) send({ type: 'new', url: 'about:blank' }); }}>
          {tabs.map(t => (
            <div key={t.id} className={`bw-tab ${t.id === active ? 'on' : ''} ${offered.includes(t.id) ? 'new' : ''}`} onClick={() => select(t.id)}
              onAuxClick={e => { if (e.button === 1) { e.preventDefault(); send({ type: 'close', id: t.id }); } }} title={t.title ? `${t.title}\n${t.url}` : t.url}>
              {t.id === active && nav.loading ? <span className="bw-spin" aria-label="Loading" /> : <Favicon tab={t} />}
              {t.dialog ? <i className="bw-ask" title="This page waits for an answer" /> : offered.includes(t.id) && <i className="bw-new" title="A new tab" />}
              <span className="t">{tabName(t)}</span>
              <button className="bw-x" onClick={e => { e.stopPropagation(); send({ type: 'close', id: t.id }); }} aria-label="Close this tab" title="Close this tab (middle-click)"><Icon d={I.close} size={12} /></button>
            </div>
          ))}
          <button className="bw-ib bw-newtab" onClick={() => send({ type: 'new', url: 'about:blank' })} aria-label="New tab" title="New tab"><Icon d={I.plus} /></button>
          {offerButton}
          <button className={`bw-ib bw-auto ${autoSwitch.on ? 'on' : ''}`} onClick={() => send({ type: 'autoSwitch', on: !autoSwitch.on })} aria-pressed={autoSwitch.on} aria-label="Switch to new tabs and popups" title={`Switch to new tabs and popups: ${autoSwitch.on ? 'on' : 'off'} (${autoSwitch.own ? 'set for this browser' : 'from Settings'}). Click to change for this browser.`}><Icon d={I.popout} size={14} /></button>
        </div>
        <div className="bw-bar">
          {navButtons}
          {address}
          <div className="bw-side">
            {flash && <span className="bw-chip flash">{flash}</span>}
            {zoom !== 1 && <button className="bw-chip" onClick={() => setZoomTo(1)} title="Zoom of this view. Click for 100%.">{Math.round(zoom * 100)}%</button>}
            {keyLabel('browserLeave') && <span className="bw-chip bw-leave" title={`While the focus is in this browser, every key goes to the page, also ⌘ and ⌃ keys. Press ${keysText('browserLeave')} to give the keys back to Taskboard.`}><kbd>{keyLabel('browserLeave')}</kbd> leaves</span>}
            {remote && <span className="bw-chip" title="The Chrome of this task runs on the other machine. Its picture and your input go through this Taskboard.">On {remote}</span>}
            {agents > 0 && <span className="bw-chip agent" title="An agent is connected to this browser through its task-browser tools"><i />Agent</span>}
            {!isTemplate && !remote && <BrowserMemory id={id} />}
            {rescale && <button className="bw-chip" onClick={restartScale} title={`The browser runs with ${scale.now} pixel(s) for each point; this screen wants ${scale.want}. A restart opens the pages again.`}>Restart for a sharp picture</button>}
            {sound}
            {windowable && !inWindow && <button className="btn ghost" onClick={() => toWindow(true)} title="A normal Chrome window on this computer, with the same profile and tabs. For passkeys, password managers and hard sign-ins. The pages load again.">Open in a window</button>}
            {!floating && <button className="bw-ib" onClick={popOut} aria-label="Pop out" title="Show the browser in its own window"><Icon d={I.popout} /></button>}
            {stopButton}
          </div>
          {nav.loading && <div className="bw-progress" />}
        </div>
      </>}
      {switchedLine}
      {windowLine}
      {agentLine}
      {chooser && <div className="bw-agentline both" role="status">
        <span className="bw-what">The page asks for {chooser.multiple ? 'files' : 'a file'}.</span>
        <button className="btn primary" onClick={() => fileInput.current?.click()}>Choose {chooser.multiple ? 'files' : 'a file'}…</button>
        <button className="btn ghost" onClick={() => setChooser(null)}>Cancel</button>
        <input ref={fileInput} type="file" multiple={chooser.multiple} hidden onChange={e => { const list = [...(e.target.files || [])]; e.target.value = ''; setChooser(null); void sendFiles(list); }} />
      </div>}
      {downloads.some(d => !d.old && !d.hidden) && <div className="bw-downloads" role="status">
        {downloads.filter(d => !d.old && !d.hidden).slice(-3).map(d => <span key={d.guid} className="bw-dl">
          <Icon d={I.down} size={13} /><span className="bw-dl-n" title={d.url}>{d.name}</span>
          {d.state === 'completed' ? <a className="btn ghost" href={`/api/tasks/${encodeURIComponent(id)}/browser/downloads/${encodeURIComponent(d.guid)}`} download={d.name}>Save</a> : <span className="dim">{d.state === 'canceled' ? 'canceled' : 'downloading…'}</span>}
          <button className="bw-ib" onClick={() => setDownloads(prev => prev.map(x => x.guid === d.guid ? { ...x, hidden: true } : x))} aria-label="Hide this download" title="Hide this download"><Icon d={I.close} size={12} /></button>
        </span>)}
      </div>}
      {dialog && <div className="bw-dialog" role="alertdialog" aria-label="The page waits for an answer">
        <i className="bw-ask in" />
        <span className="bw-dialog-t"><b>{dialog.type === 'beforeunload' ? 'Leave this page?' : dialog.type === 'alert' ? 'The page says:' : 'The page asks:'}</b> {dialog.message}</span>
        {dialog.type === 'prompt' && <input className="bw-dialog-in" value={promptText} onChange={e => setPromptText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') answer(true); if (e.key === 'Escape') answer(false); }} aria-label="Answer" />}
        <button className="btn primary" onClick={() => answer(true)}>{dialog.type === 'beforeunload' ? 'Leave' : 'OK'}</button>
        {dialog.type !== 'alert' && <button className="btn" onClick={() => answer(false)}>{dialog.type === 'beforeunload' ? 'Stay' : 'Cancel'}</button>}
      </div>}
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      {signinParts}
      <div className={`bw-screen ${framed ? 'framed' : ''} ${inWindow ? 'inwin' : ''} ${dropping ? 'dropping' : ''}`} ref={screenRef} tabIndex={0}
        onFocus={e => { if (e.target === e.currentTarget) kb.current?.focus({ preventScroll: true }); }}
        onMouseDown={e => { e.preventDefault(); kb.current?.focus({ preventScroll: true }); moveKb(e); mouse('mousePressed', e, e.detail || 1); }}
        onMouseUp={e => { mouse('mouseReleased', e, e.detail || 1); peek(); }}
        onMouseMove={e => mouse('mouseMoved', e)}
        onMouseLeave={() => setTip(null)}
        onContextMenu={e => e.preventDefault()} style={{ cursor }}
        onKeyDown={e => key(e, true)} onKeyUp={e => key(e, false)}
        onPaste={e => { e.preventDefault(); void pasteFrom(e.clipboardData); }}
        onDragOver={e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropping(true); } }}
        onDragLeave={() => setDropping(false)}
        onDrop={e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDropping(false); void sendFiles([...e.dataTransfer.files], point(e)); }}
        onCopy={e => copy(e, false)} onCut={e => copy(e, true)}>
        <canvas ref={canvas} />
        {agentEvt && <AgentPointer evt={agentEvt} frame={frameSize.current} active={active} />}
        {tip && <Tooltip tip={tip} at={toView(tip.x, tip.y)} />}
        {widget?.kind === 'select' && (() => { const p = toView(widget.rect.x, widget.rect.y + widget.rect.h), w = toView(widget.rect.w, 0).x; return (
          <div className="bw-list-pop" role="listbox" aria-label="Choices of the select box" style={{ left: p.x, top: p.y, minWidth: Math.max(120, w) }} onMouseDown={e => e.stopPropagation()}>
            {widget.options.map((o, i) => <div key={i} role="option" aria-selected={i === widget.selectedIndex} aria-disabled={o.disabled}
              className={`bw-opt ${i === listAt ? 'sel' : ''} ${o.disabled ? 'off' : ''} ${i === widget.selectedIndex ? 'on' : ''}`}
              onMouseEnter={() => !o.disabled && setListAt(i)} onClick={() => !o.disabled && choose(i)}>
              {o.group && (i === 0 || widget.options[i - 1].group !== o.group) && <div className="bw-optgroup">{o.group}</div>}{o.text || ' '}</div>)}
          </div>); })()}
        {widget?.kind === 'input' && (() => { const p = toView(widget.rect.x, widget.rect.y); return (
          <input className="bw-picker" type={widget.inputType} defaultValue={widget.value} min={widget.min || undefined} max={widget.max || undefined} step={widget.step || undefined} style={{ left: p.x, top: p.y }}
            ref={el => { if (el && !el.dataset.opened) { el.dataset.opened = '1'; el.focus(); try { el.showPicker(); } catch { /* the view shows the field itself */ } } }}
            onMouseDown={e => e.stopPropagation()} onChange={e => { if (widget.inputType === 'color' || e.target.value) choose(e.target.value); }}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setWidget(null); if (e.key === 'Enter') choose((e.target as HTMLInputElement).value); }} onBlur={() => setTimeout(() => setWidget(w => w?.kind === 'input' ? null : w), 300)} />); })()}
        {menu && (() => { const p = toView(menu.x, menu.y); return (
          <div className="bw-pop bw-menu bw-pagemenu" role="menu" style={{ left: p.x, top: p.y }} onMouseDown={e => e.stopPropagation()}>
            {menu.href && <><button className="bw-mi" role="menuitem" onClick={() => void menuAction('open')}><span>Open the link in a new tab</span></button><button className="bw-mi" role="menuitem" onClick={() => void menuAction('copyLink')}><span>Copy the link address</span></button><div className="bw-msep" /></>}
            {menu.src && <><button className="bw-mi" role="menuitem" onClick={() => void menuAction('openImage')}><span>Open the image in a new tab</span></button><button className="bw-mi" role="menuitem" onClick={() => void menuAction('copyImage')}><span>Copy the image address</span></button><div className="bw-msep" /></>}
            {menu.selection && <button className="bw-mi" role="menuitem" onClick={() => void menuAction('copy')}><span>Copy</span></button>}
            <button className="bw-mi" role="menuitem" onClick={() => void menuAction('paste')}><span>Paste</span></button>
            <div className="bw-msep" />
            <button className="bw-mi" role="menuitem" disabled={!nav.canBack} onClick={() => void menuAction('back')}><span>Back</span></button>
            <button className="bw-mi" role="menuitem" disabled={!nav.canForward} onClick={() => void menuAction('forward')}><span>Forward</span></button>
            <button className="bw-mi" role="menuitem" onClick={() => void menuAction('reload')}><span>Reload</span></button>
          </div>); })()}
        {inWindow && <div className="bw-wincover" onMouseDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}><div className="bw-card">
          <h3>The browser is in its own window</h3>
          <p>Use it there, on this computer. The agent works in the same window. Back to the panel, or closing the window, brings the browser back here with the same tabs and sign-ins.</p>
          <div className="bw-actions"><button className="btn" onClick={() => send({ type: 'showWindow' })}>Show the window</button><button className="btn primary" onClick={() => toWindow(false)}>Back to the panel</button></div>
        </div></div>}
        <textarea ref={kb} className="bw-kb" style={{ left: kbAt.x, top: kbAt.y }} aria-label="Keyboard input for the page" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} tabIndex={-1}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionUpdate={e => send({ type: 'ime', text: e.data || '' })}
          onCompositionEnd={e => { composing.current = false; send({ type: 'text', text: e.data || '' }); e.currentTarget.value = ''; }}
          onInput={e => { const ne = e.nativeEvent as InputEvent; if (!composing.current && !ne.isComposing && ne.data) send({ type: 'text', text: ne.data }); if (!composing.current) e.currentTarget.value = ''; }} />
        {!framed && <div className="bw-wait"><span className="bw-spin" />{running === null ? 'Connecting…' : 'Waiting for the page…'}</div>}
      </div>
    </div>
  );
}

// The tab list of the compact row: one row for each tab, with a find field from 8 tabs. Up and Down move the
// selection, Enter shows the selected tab, Escape closes the list.
function TabList({ tabs, active, name, offered, onSelect, onClose, onNew, onDone }: { tabs: BrowserTab[]; active: string; name: (t: BrowserTab) => string; offered: string[]; onSelect: (id: string) => void; onClose: (id: string) => void; onNew: () => void; onDone: () => void }) {
  const [find, setFind] = useState('');
  const [sel, setSel] = useState(-1);
  const box = useRef<HTMLDivElement>(null), field = useRef<HTMLInputElement>(null);
  const q = find.trim().toLowerCase();
  const shown = q ? tabs.filter(t => (t.title + ' ' + t.url).toLowerCase().includes(q)) : tabs;
  const at = sel >= 0 ? Math.min(sel, shown.length - 1) : Math.max(0, shown.findIndex(t => t.id === active));
  useEffect(() => { (field.current || box.current)?.focus(); }, []);
  useEffect(() => { box.current?.querySelector('.bw-li.sel')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(shown.length - 1, at + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, at - 1)); }
    else if (e.key === 'Enter' && shown[at]) { e.preventDefault(); onSelect(shown[at].id); }
    else if (e.key === 'Escape') { e.preventDefault(); onDone(); }
  };
  return (
    <div className="bw-pop bw-list" ref={box} tabIndex={-1} onKeyDown={keys} role="listbox" aria-label="Tabs">
      <div className="bw-lh"><b>{tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}</b><span>↑ ↓ · Enter</span></div>
      {tabs.length >= 8 && <input ref={field} className="bw-lf" value={find} onChange={e => { setFind(e.target.value); setSel(0); }} placeholder="Find a tab" aria-label="Find a tab" spellCheck={false} />}
      <div className="bw-lb">
        {shown.map((t, i) => (
          <div key={t.id} role="option" aria-selected={t.id === active} className={`bw-li ${t.id === active ? 'on' : ''} ${i === at ? 'sel' : ''}`} onClick={() => onSelect(t.id)} onMouseMove={() => { if (i !== at) setSel(i); }} title={t.url}>
            <span className="bw-li-f"><Favicon tab={t} />{t.dialog ? <i className="bw-ask" /> : offered.includes(t.id) && <i className="bw-new" />}</span>
            <span className="t">{name(t)}<small>{siteOf(t.url) || t.url}</small></span>
            {t.dialog && <span className="bw-tag" title={t.dialog.message}>waits for an answer</span>}
            <button className="bw-x" onClick={e => { e.stopPropagation(); onClose(t.id); }} aria-label="Close this tab" title="Close this tab"><Icon d={I.close} size={12} /></button>
          </div>
        ))}
        {!shown.length && <div className="bw-lempty">No tab matches</div>}
      </div>
      <button className="bw-li add" onClick={onNew}><Icon d={I.plus} size={15} /><span className="t">New tab</span></button>
    </div>
  );
}

// Move the focus out of a browser view: to the terminal of the same Canvas window or task panel, or else to nothing.
export function leaveBrowser(from: HTMLElement) {
  (document.activeElement as HTMLElement | null)?.blur?.();
  const term = from.closest('[data-win], .drawer')?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
  term?.focus();
}
// The memory of a task browser (its footprint, from GET /api/runtime), read every 4 s while the view is open.
function BrowserMemory({ id, row = false }: { id: string; row?: boolean }) {
  const [memMb, setMemMb] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => api.runtime([id]).then(r => { if (live) setMemMb(r.items.find(i => i.kind === 'browser')?.memMb ?? null); }).catch(() => {});
    void read(); const timer = setInterval(read, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [id]);
  if (memMb !== null && row) return <div className="bw-minfo" title="Memory of all Chrome processes of this browser, counted like Activity Monitor does (footprint)">Memory {mb(memMb)}</div>;
  return memMb === null ? null : <span className="bw-chip" title="Memory of all Chrome processes of this browser, counted like Activity Monitor does (footprint). The server reads it at most every 15 s.">{mb(memMb)}</span>;
}

// Sound on or off for this browser (setSound in server/task-browser.ts). A running browser changes at once and keeps
// its tabs; a stopped browser gets the choice at its next start. The switch shows the new state at the click, and
// the server's answer (or an error) sets the state it really has.
function SoundSwitch({ id, muted, labeled = false, onChange, onDone, onError }: { id: string; muted: boolean | null; labeled?: boolean; onChange: (muted: boolean) => void; onDone: (s: BrowserStatus) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (muted === null) return null;
  const toggle = async () => {
    const on = muted; // the click turns the sound on when it is off
    onChange(!on); setBusy(true);
    try { onDone(await api.browserSound(id, on)); }
    catch (e) { onChange(on); onError(String((e as Error).message || e)); } finally { setBusy(false); }
  };
  const title = muted ? 'Sound is off. Click to turn the sound on.' : 'Sound is on. Click to turn the sound off.';
  const label = muted ? 'Sound off' : 'Sound on';
  return (
    <button className={`${labeled ? 'btn' : 'bw-ib'} bw-sound ${muted ? '' : 'on'}`} onClick={toggle} disabled={busy} aria-pressed={!muted} aria-label={label} title={title}>
      <Icon d={muted ? I.muted : I.sound} />{labeled && <span>{label}</span>}
    </button>
  );
}

// ---------- what the agent does ----------
// AgentEvt: one action of the agent (server/task-browser.ts agentWatch), with the label of the element it hit and the
// time this view got it (seen).
interface AgentEvt { kind: 'click' | 'type' | 'key' | 'scroll' | 'navigate' | 'newTab' | 'upload' | 'look' | 'drag'; target?: string; x?: number; y?: number; url?: string; chars?: number; label?: string; shown?: boolean; seen: number }
const STRIP_MS = 30000, BOTH_MS = 4000, POINTER_MS = 3000;
function agentText(e: AgentEvt): string {
  const on = e.label ? ` “${e.label}”` : '';
  const where = e.shown === false ? ' in another tab' : '';
  switch (e.kind) {
    case 'click': return (on ? `Clicked${on}` : 'Clicked the page') + where;
    case 'type': return `Typed ${e.chars || 0} ${e.chars === 1 ? 'character' : 'characters'}${on ? ` into${on}` : ''}${where}`;
    case 'key': return `Pressed ${e.url || 'a key'}${where}`;
    case 'scroll': return 'Scrolled the page' + where;
    case 'navigate': { if (!e.url) return 'Reloaded the page' + where; try { return `Opened ${new URL(e.url).host || e.url}${where}`; } catch { return `Opened ${e.url}${where}`; } }
    case 'newTab': return 'Opened a new tab';
    case 'upload': return `Chose ${e.chars || 0} ${e.chars === 1 ? 'file' : 'files'} for an upload${where}`;
    case 'drag': return 'Dragged on the page' + where;
    default: return 'Looked at the page' + where;
  }
}
const ago = (ms: number) => ms < 1500 ? 'now' : ms < 60000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60000)} min ago`;
// The strip under the address row: the agent's request for help (orange, with a note field and Done), or else the
// agent's last action for STRIP_MS after it. When the user also acted within BOTH_MS, it says that both use the page.
// It blocks nothing: the user and the agent can act at any time.
function AgentStrip({ evt, ask, note, setNote, userAt, onDone, onWindow }: { evt: AgentEvt | null; ask: { reason: string; at: string } | null; note: string; setNote: (v: string) => void; userAt: React.MutableRefObject<number>; onDone: () => void; onWindow?: () => void }) {
  const [, tick] = useState(0);
  const live = !!evt && Date.now() - evt.seen < STRIP_MS;
  useEffect(() => { if (!live && !ask) return; const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, [live, !!ask, evt?.seen]);
  if (ask) return (
    <div className="bw-agentline asking" role="status">
      <span className="bw-who"><i />The agent asks you</span>
      <span className="bw-what" title={ask.reason}>“{ask.reason}”</span>
      <input className="bw-note" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onDone(); }} placeholder="Note for the agent (optional)" aria-label="Note for the agent" />
      <button className="btn primary" onClick={onDone} title="Tell the agent that you are done. Your note goes with it.">Done</button>
      {onWindow && <button className="btn" onClick={onWindow} title="A normal Chrome window on this computer, with the same profile and tabs. For passkeys, password managers and hard sign-ins. The pages load again.">Open in a window</button>}
    </div>
  );
  if (!live) return null;
  const both = Math.abs(userAt.current - evt!.seen) < BOTH_MS && Date.now() - userAt.current < STRIP_MS;
  return (
    <div className={`bw-agentline ${both ? 'both' : ''}`} role="status">
      <span className="bw-who"><i />{both ? 'You and the agent both use this page' : 'Agent'}</span>
      <span className="bw-what">{both ? 'Agent: ' : ''}{agentText(evt!)} · {ago(Date.now() - evt!.seen)}</span>
    </div>
  );
}
// The agent's pointer over the page: where it clicked, scrolled or dropped last, for POINTER_MS, with a ring at a click.
// The point is in CSS pixels of the page, like the frame size (frameSize), so it maps to the canvas in percent.
function AgentPointer({ evt, frame, active }: { evt: AgentEvt; frame: { w: number; h: number }; active: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setTimeout(() => tick(n => n + 1), POINTER_MS + 50); return () => clearTimeout(t); }, [evt.seen]);
  if (evt.x === undefined || evt.y === undefined || Date.now() - evt.seen > POINTER_MS || (evt.target && evt.target !== active) || !frame.w || !frame.h) return null;
  const style = { left: `${(evt.x / frame.w) * 100}%`, top: `${(evt.y / frame.h) * 100}%` };
  return (
    <div className="bw-apointer" style={style} aria-hidden="true">
      {evt.kind === 'click' && <span key={evt.seen} className="bw-aring" />}
      <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 2l16 9-7 2-3 7z" fill="var(--bw-agent)" stroke="#fff" strokeWidth="1.5" /></svg>
      <span className="bw-atag">Agent</span>
    </div>
  );
}

// ---------- the parts of the page that the view draws ----------
type Widget = { kind: 'select'; rect: { x: number; y: number; w: number; h: number }; selectedIndex: number; options: { text: string; disabled: boolean; group: string }[] }
  | { kind: 'input'; rect: { x: number; y: number; w: number; h: number }; inputType: string; value: string; min?: string; max?: string; step?: string };
interface PageMenu { x: number; y: number; href: string; src: string; selection: boolean }
interface DownloadItem { guid: string; name: string; url: string; state: 'inProgress' | 'completed' | 'canceled'; old?: boolean; hidden?: boolean }

// the zoom levels of the view, as in Chrome
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const TIP_MS = 600;
// The title of the element under the mouse, like a browser's tooltip: it shows TIP_MS after the mouse stopped there, a
// little below the mouse.
function Tooltip({ tip, at }: { tip: { text: string; at: number }; at: { x: number; y: number } }) {
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(false); const t = setTimeout(() => setShow(true), Math.max(0, TIP_MS - (Date.now() - tip.at))); return () => clearTimeout(t); }, [tip]);
  return show ? <div className="bw-tip" role="tooltip" style={{ left: at.x + 4, top: at.y + 20 }}>{tip.text}</div> : null;
}
