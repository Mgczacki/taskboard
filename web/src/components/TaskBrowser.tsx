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
const askClose = (id: string) => () => post({ type: 'close', id });
channel?.addEventListener('message', (e: MessageEvent<WinMsg>) => {
  const m = e.data;
  if (m.type === 'open' && !popped.has(m.id)) { popped.set(m.id, askClose(m.id)); notify(); }
  else if (m.type === 'closed' && popped.delete(m.id)) notify();
  else if (m.type === 'close' && m.id === BROWSER_PAGE) window.close();
  else if (m.type === 'who' && BROWSER_PAGE) post({ type: 'open', id: BROWSER_PAGE });
});
if (!BROWSER_PAGE) post({ type: 'who' });

const isApp = () => !!(window as unknown as { taskboardApp?: { isApp: boolean } }).taskboardApp?.isApp;
export function popOutBrowser(id: string, title: string, sub = '', autostart = false) {
  if (popped.has(id)) return;
  const q = new URLSearchParams({ browser: id, title, ...(sub ? { sub } : {}), ...(autostart ? { start: '1' } : {}) });
  const w = window.open(`/?${q}`, `tb-browser-${id}`, `popup,width=${Math.min(1280, screen.availWidth)},height=${Math.min(900, screen.availHeight)}`);
  // the desktop app opens its own window and window.open returns null; a plain browser returns null when it blocks the window
  if (w || isApp()) { popped.set(id, askClose(id)); notify(); return; }
  floatInPage(id, title, sub, autostart);
}

// The page of a browser window: only the view, with the task as the window title.
export function BrowserWindowPage() {
  const q = new URLSearchParams(location.search);
  const id = q.get('browser') || '', title = q.get('title') || 'Task browser', sub = q.get('sub') || '';
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
  Object.assign(host.style, { left: Math.max(20, innerWidth - 1040 - k * 28) + 'px', top: 70 + k * 28 + 'px', width: '980px', height: Math.min(720, innerHeight - 120) + 'px' });
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => { root.unmount(); host.remove(); popped.delete(id); notify(); };
  popped.set(id, close); notify();
  root.render(<FloatBrowser id={id} title={title} sub={sub} close={close} host={host} autostart={autostart} />);
}
function FloatBrowser({ id, title, sub, close, host, autostart }: { id: string; title: string; sub: string; close: () => void; host: HTMLElement; autostart: boolean }) {
  const [big, setBig] = useState(false);
  const toggle = () => { host.classList.toggle('big'); setBig(host.classList.contains('big')); };
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const sx = e.clientX, sy = e.clientY, l = host.offsetLeft, t = host.offsetTop; host.classList.add('moving');
    const mv = (ev: PointerEvent) => { host.style.left = l + ev.clientX - sx + 'px'; host.style.top = Math.max(0, t + ev.clientY - sy) + 'px'; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); host.classList.remove('moving'); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };
  return (
    <>
      <div className="fw-h" onPointerDown={drag} onDoubleClick={toggle} onMouseDown={() => { host.style.zIndex = String(++z); }}>
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
// the CSS cursor keywords that the page can report ('cursor' from the server); other values show the arrow
const CURSORS = new Set(['default', 'pointer', 'text', 'vertical-text', 'move', 'grab', 'grabbing', 'crosshair', 'help', 'wait', 'progress', 'not-allowed', 'no-drop', 'copy', 'alias', 'cell', 'context-menu', 'zoom-in', 'zoom-out', 'none', 'all-scroll', 'col-resize', 'row-resize', 'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize']);

// onCanvas: the task panel passes it, so the More menu can show the browser in the task's Canvas window
export function BrowserView({ id, title = '', autostart = false, floating = false, archived = false, isTemplate = false, onCanvas }: { id: string; title?: string; autostart?: boolean; floating?: boolean; archived?: boolean; isTemplate?: boolean; onCanvas?: () => void }) {
  const isPopped = usePopped(id);
  if (isPopped && !floating) return (
    <div className="bw-empty"><div className="bw-card">
      <div className="bw-card-icon"><Icon d={I.popout} size={28} /></div>
      <h3>This browser is in its own window</h3>
      <div className="bw-actions"><button className="btn primary" onClick={() => popped.get(id)?.()}>Put it back here</button></div>
    </div></div>
  );
  return <Live id={id} title={title} autostart={autostart} floating={floating} archived={archived} isTemplate={isTemplate} onCanvas={onCanvas} />;
}

function Live({ id, title, autostart, floating, archived, isTemplate, onCanvas }: { id: string; title: string; autostart: boolean; floating: boolean; archived: boolean; isTemplate: boolean; onCanvas?: () => void }) {
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
  const [sharing, reloadSharing] = useSharing(id, isTemplate || archived, running);
  const setShared = (on: boolean) => api.signinShared(id, on).then(() => { reloadSharing(); setTold(on ? 'This browser gets shared sign-ins again.' : 'This browser gets no shared sign-ins now. It keeps the sign-ins it has: Reset gives an empty profile.'); }).catch(e => setErr(String(e.message || e)));
  const signinParts = !isTemplate && !archived && <>
    <SigninNote status={sharing} onMode={setSignin} onShared={on => void setShared(on)} />
    {told && <div className="banner bw-signins">{told} <button className="btn ghost" onClick={() => setTold('')}>OK</button></div>}
    {signin && <SigninDialog id={id} mode={signin} onClose={() => setSignin(null)} onDone={text => { setSignin(null); setTold(text); reloadSharing(); }} />}
  </>;
  const canvas = useRef<HTMLCanvasElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const frameSize = useRef({ w: 1280, h: 800 });
  const ws = useRef<WebSocket | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
        else if (m.type === 'tabs') { setTabs(prev => JSON.stringify(prev) === JSON.stringify(m.tabs) ? prev : m.tabs); setRunning(true); setAgents(m.agents || 0); setMuted(m.muted ?? null); setErr(''); }
        else if (m.type === 'active') setActive(m.id);
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
      s.onopen = () => { send({ type: 'hello', acks: true }); send({ type: 'visible', on: shown.current }); sendSize(); };
      s.onclose = () => { if (!closed) retry = setTimeout(connect, 2000); };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); clearTimeout(flashTimer.current); clearTimeout(peekTimer.current); ws.current?.close(); };
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
  const sendSize = () => { const r = screen.current?.getBoundingClientRect(); if (r && r.width > 100 && r.height > 100) send({ type: 'size', w: r.width, h: r.height }); };
  useEffect(() => {
    if (!screen.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(sendSize, 200); });
    ro.observe(screen.current);
    return () => { ro.disconnect(); clearTimeout(timer); };
  }, [running]);

  const activeTab = tabs.find(t => t.id === active);
  useEffect(() => { if (!editing) setAddr(activeTab?.url === 'about:blank' ? '' : activeTab?.url || ''); }, [activeTab?.url, editing]);
  const dialog = activeTab?.dialog;
  useEffect(() => { setPromptText(dialog?.defaultPrompt || ''); }, [active, dialog?.type, dialog?.message]);
  const answer = (accept: boolean) => send({ type: 'dialog', id: active, accept, ...(dialog?.type === 'prompt' ? { text: promptText } : {}) });
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
    if (e.metaKey && ['v', 'c', 'x'].includes(e.key.toLowerCase())) return; // these go through the paste, copy and cut events
    if (down && shortcut(e)) { e.preventDefault(); return; }
    if (e.metaKey && ['l', 'r', '[', ']'].includes(e.key.toLowerCase())) { e.preventDefault(); return; } // the key up of a shortcut
    // Cmd alone does not go to the page. Its key down reached Chrome as a stuck key (see keyEvent in
    // server/task-browser.ts). The Cmd shortcuts that go to the page carry the Meta bit in their modifiers.
    if (e.key === 'Meta') return;
    e.preventDefault();
    send({ type: 'key', down, key: e.key, code: e.code, keyCode: e.keyCode, modifiers: MOD(e) });
    if (!down && (e.shiftKey || e.metaKey || e.altKey)) peek(); // Shift+Arrow, Cmd+A and the like change the selection
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
  const go = () => { setEditing(false); if (addr.trim()) send({ type: 'nav', action: 'go', url: addr.trim() }); screen.current?.focus(); };
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
        onKeyDown={e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { setEditing(false); setAddr(activeTab?.url || ''); screen.current?.focus(); } }} spellCheck={false} />
      {!editing && addr && (compact && pageTitle
        ? <span className="bw-urlview" aria-hidden="true" title={addr}><span className="bw-ttl">{pageTitle}</span>{parts.host && <span className="dim">{parts.host}</span>}</span>
        : <span className="bw-urlview" aria-hidden="true"><span className="dim">{parts.scheme}</span>{parts.host}<span className="dim">{parts.rest}</span></span>)}
      {compact && !editing && addr && <button className="bw-cp" onMouseDown={e => e.preventDefault()} onClick={e => { e.stopPropagation(); copyAddress(); }} aria-label="Copy the address" title="Copy the address"><Icon d={I.copy} size={13} /></button>}
    </div>
  );
  const popOut = () => { setPop(null); popOutBrowser(id, title || (isTemplate ? 'Template browser' : 'Task browser'), isTemplate ? 'Sign in here. New task browsers copy this profile.' : ''); };
  const stopButton = <button className="bw-ib danger" onClick={() => send({ type: 'stop' })} aria-label={isTemplate ? 'Close the template browser' : 'Stop the browser'} title={isTemplate ? 'Close the template browser. New task browsers can copy it only when it is closed.' : 'Stop the browser. Its pages open again at the next start.'}><Icon d={I.power} /></button>;
  const sound = <SoundSwitch id={id} muted={muted} onChange={setMuted} onDone={s => setMuted(s.muted)} onError={setErr} />;
  return (
    <div className={`bw ${inside ? 'kb' : ''} ${compact ? 'compact' : ''}`} data-tb-browser="" onKeyDownCapture={leave} onFocus={() => setInside(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setInside(false); }}>
      {compact ? (
        <div className="bw-bar bw-row">
          {navButtons}
          {address}
          {flash && <span className="bw-chip flash">{flash}</span>}
          <button className={`bw-tabsbtn bw-popbtn ${pop === 'tabs' ? 'on' : ''}`} onClick={() => setPop(p => p === 'tabs' ? null : 'tabs')} aria-expanded={pop === 'tabs'} aria-label={`All ${tabs.length} tabs`} title={`All ${tabs.length} tabs${waiting ? '. A page waits for an answer.' : ''}`}>
            <b>{tabs.length}</b><Icon d={I.down} size={12} />{waiting && <i className="bw-ask" />}
          </button>
          <button className="bw-ib" onClick={() => send({ type: 'new', url: 'about:blank' })} aria-label="New tab" title="New tab"><Icon d={I.plus} /></button>
          {sound}
          {stopButton}
          <button className={`bw-ib bw-popbtn bw-more ${pop === 'menu' ? 'on' : ''}`} onClick={() => setPop(p => p === 'menu' ? null : 'menu')} aria-expanded={pop === 'menu'} aria-label="More" title="More: copy the address, pop out, memory, keys">
            <Icon d={I.more} weight={3} />{agents > 0 && <i className="bw-agent" />}
          </button>
          {nav.loading && <div className="bw-progress" />}
          {pop === 'tabs' && <TabList tabs={tabs} active={active} name={tabName}
            onSelect={t => { setPop(null); send({ type: 'select', id: t }); screen.current?.focus(); }}
            onClose={t => send({ type: 'close', id: t })} onNew={() => { setPop(null); send({ type: 'new', url: 'about:blank' }); }}
            onDone={() => { setPop(null); screen.current?.focus(); }} />}
          {pop === 'menu' && <div className="bw-pop bw-menu" role="menu">
            {activeTab?.url && activeTab.url !== 'about:blank' && <button className="bw-mi" role="menuitem" onClick={() => { setPop(null); copyAddress(); }}><Icon d={I.copy} size={15} /><span>Copy the address</span></button>}
            <button className="bw-mi" role="menuitem" onClick={popOut}><Icon d={I.popout} size={15} /><span>Pop out<small>Show the browser in its own window</small></span></button>
            {onCanvas && <button className="bw-mi" role="menuitem" onClick={() => { setPop(null); onCanvas(); }}><Icon d={I.canvas} size={15} /><span>Show on Canvas<small>Above the terminal of this task</small></span></button>}
            <div className="bw-msep" />
            {!isTemplate && !archived && <>
              {!sharing?.noShared && <button className="bw-mi" role="menuitem" onClick={() => { setPop(null); setSignin('sync'); }}><Icon d={I.reload} size={15} /><span>Sync sign-ins from the template<small>Adds its cookies for the sites you choose</small></span></button>}
              <button className="bw-mi" role="menuitem" onClick={() => { setPop(null); setSignin('save'); }}><Icon d={I.copy} size={15} /><span>Use this browser's sign-ins for new tasks<small>Copies them into the template</small></span></button>
              <button className="bw-mi" role="menuitemcheckbox" aria-checked={!sharing?.noShared} onClick={() => { setPop(null); void setShared(!!sharing?.noShared); }}><Icon d={sharing?.noShared ? I.close : I.lock} size={15} /><span>Shared sign-ins: {sharing?.noShared ? 'off' : 'on'}<small>{sharing?.noShared ? 'Click to get the template and live sign-ins' : 'Click to turn off, for untrusted pages'}</small></span></button>
              <button className="bw-mi danger" role="menuitem" onClick={() => { setPop(null); setSignin('reset'); }}><Icon d={I.stop} size={15} /><span>{sharing?.noShared ? 'Reset to an empty profile' : 'Reset from template'}<small>Deletes this browser's own sign-ins</small></span></button>
              <div className="bw-msep" />
            </>}
            {!isTemplate && <BrowserMemory id={id} row />}
            {agents > 0 && <div className="bw-minfo"><i className="bw-agent in" />An agent is connected to this browser</div>}
            {keyLabel('browserLeave') && <div className="bw-minfo" title="While the focus is in this browser, every key goes to the page, also ⌘ and ⌃ keys."><kbd>{keyLabel('browserLeave')}</kbd> gives the keys back to Taskboard</div>}
          </div>}
        </div>
      ) : <>
        <div className="bw-tabs" onDoubleClick={e => { if (e.target === e.currentTarget) send({ type: 'new', url: 'about:blank' }); }}>
          {tabs.map(t => (
            <div key={t.id} className={`bw-tab ${t.id === active ? 'on' : ''}`} onClick={() => send({ type: 'select', id: t.id })}
              onAuxClick={e => { if (e.button === 1) { e.preventDefault(); send({ type: 'close', id: t.id }); } }} title={t.title ? `${t.title}\n${t.url}` : t.url}>
              {t.id === active && nav.loading ? <span className="bw-spin" aria-label="Loading" /> : <Favicon tab={t} />}
              {t.dialog && <i className="bw-ask" title="This page waits for an answer" />}
              <span className="t">{tabName(t)}</span>
              <button className="bw-x" onClick={e => { e.stopPropagation(); send({ type: 'close', id: t.id }); }} aria-label="Close this tab" title="Close this tab (middle-click)"><Icon d={I.close} size={12} /></button>
            </div>
          ))}
          <button className="bw-ib bw-new" onClick={() => send({ type: 'new', url: 'about:blank' })} aria-label="New tab" title="New tab"><Icon d={I.plus} /></button>
        </div>
        <div className="bw-bar">
          {navButtons}
          {address}
          <div className="bw-side">
            {flash && <span className="bw-chip flash">{flash}</span>}
            {keyLabel('browserLeave') && <span className="bw-chip bw-leave" title={`While the focus is in this browser, every key goes to the page, also ⌘ and ⌃ keys. Press ${keysText('browserLeave')} to give the keys back to Taskboard.`}><kbd>{keyLabel('browserLeave')}</kbd> leaves</span>}
            {agents > 0 && <span className="bw-chip agent" title="An agent is connected to this browser through its task-browser tools"><i />Agent</span>}
            {!isTemplate && <BrowserMemory id={id} />}
            {sound}
            {!floating && <button className="bw-ib" onClick={popOut} aria-label="Pop out" title="Show the browser in its own window"><Icon d={I.popout} /></button>}
            {stopButton}
          </div>
          {nav.loading && <div className="bw-progress" />}
        </div>
      </>}
      {dialog && <div className="bw-dialog" role="alertdialog" aria-label="The page waits for an answer">
        <i className="bw-ask in" />
        <span className="bw-dialog-t"><b>{dialog.type === 'beforeunload' ? 'Leave this page?' : dialog.type === 'alert' ? 'The page says:' : 'The page asks:'}</b> {dialog.message}</span>
        {dialog.type === 'prompt' && <input className="bw-dialog-in" value={promptText} onChange={e => setPromptText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') answer(true); if (e.key === 'Escape') answer(false); }} aria-label="Answer" />}
        <button className="btn primary" onClick={() => answer(true)}>{dialog.type === 'beforeunload' ? 'Leave' : 'OK'}</button>
        {dialog.type !== 'alert' && <button className="btn" onClick={() => answer(false)}>{dialog.type === 'beforeunload' ? 'Stay' : 'Cancel'}</button>}
      </div>}
      {err && <div className="banner">{err} <button className="btn ghost" onClick={() => setErr('')}>OK</button></div>}
      {signinParts}
      <div className={`bw-screen ${framed ? 'framed' : ''}`} ref={screenRef} tabIndex={0}
        onMouseDown={e => { screen.current?.focus(); mouse('mousePressed', e, e.detail || 1); }}
        onMouseUp={e => { mouse('mouseReleased', e, e.detail || 1); peek(); }}
        onMouseMove={e => mouse('mouseMoved', e)}
        onContextMenu={e => e.preventDefault()} style={{ cursor }}
        onKeyDown={e => key(e, true)} onKeyUp={e => key(e, false)}
        onPaste={e => { const text = e.clipboardData.getData('text'); if (text) send({ type: 'text', text }); e.preventDefault(); }}
        onCopy={e => copy(e, false)} onCut={e => copy(e, true)}>
        <canvas ref={canvas} />
        {!framed && <div className="bw-wait"><span className="bw-spin" />{running === null ? 'Connecting…' : 'Waiting for the page…'}</div>}
      </div>
    </div>
  );
}

// The tab list of the compact row: one row for each tab, with a find field from 8 tabs. Up and Down move the
// selection, Enter shows the selected tab, Escape closes the list.
function TabList({ tabs, active, name, onSelect, onClose, onNew, onDone }: { tabs: BrowserTab[]; active: string; name: (t: BrowserTab) => string; onSelect: (id: string) => void; onClose: (id: string) => void; onNew: () => void; onDone: () => void }) {
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
            <span className="bw-li-f"><Favicon tab={t} />{t.dialog && <i className="bw-ask" />}</span>
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
