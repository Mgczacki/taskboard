// Which tab the dashboard's browser view shows when tabs open and close by themselves (attachViewer in
// task-browser.ts). The view reads the DevTools target events of the browser connection (Target.targetCreated,
// Target.targetInfoChanged, Target.targetDestroyed) and gives them to one TabSwitch. TabSwitch decides, and the view
// carries out each decision (decide):
// - A new page target with an openerId (window.open, a link with target=_blank, a form with a target) is a popup or a
//   new tab from a page: the view switches to it.
// - A new page target without an opener (Target.createTarget of an agent, /json/new, tb browser open) is a tab that an
//   agent opened: the view switches to it.
// - A new tab that the user opened in the background (a middle click, or a Cmd or Ctrl click without Shift, in the
//   view) does not take the view: the view offers it ('offer'). Chrome reports such a tab like a tab of an agent (no
//   openerId, canAccessOpener false, measured on Chrome 154 on 3 October 2026), and the protocol gives no disposition.
//   So TabSwitch remembers the last click of that kind (userClick) and treats a new tab within BACKGROUND_MS of it as
//   a background tab.
// - With the switch turned off (Settings, or the override of one browser), the view offers each new tab instead.
// - A new tab whose address is still empty waits up to BLANK_MS for its address. Chrome reports a popup with url ''
//   and gives the address 10 to 110 ms later (after redirects), or only when the page commits (1.5 s for a server that
//   answered after 1.5 s). So a tab that still has url '' after BLANK_MS takes the view.
// - A tab at about:blank waits up to BLANK_CLOSE_MS more: Chrome reported the end of a popup that closed itself 20 ms
//   after window.open('') only 380 to 540 ms later. A tab that closes in that time is ignored. Page.windowOpen of the
//   opener comes about 15 ms before Target.targetCreated, with the address that the page asked for (windowOpen): a
//   popup for about:blank waits like a tab at about:blank from its start.
// - When the shown tab closes (a login popup finished), the view goes back: to the most recent tab in the history that
//   is the opener of the closed tab or another popup of the same opener, else to the opener, else to the most recent
//   open tab in the history, else to the first tab.
export const BLANK_MS = 150, BLANK_CLOSE_MS = 850, BACKGROUND_MS = 1000, HISTORY = 20;

export interface TargetInfo { targetId: string; type: string; url?: string; title?: string; openerId?: string; canAccessOpener?: boolean }
export type SwitchReason = 'popup' | 'agent' | 'back';
export type Decision =
  | { kind: 'switch'; id: string; from: string; reason: SwitchReason }
  | { kind: 'offer'; id: string; reason: 'background' | 'off' };
export interface Timers { now: () => number; set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void }
const realTimers: Timers = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t as NodeJS.Timeout) };
interface Page { id: string; url: string; opener?: string; at: number; timer?: unknown; done: boolean }
const blank = (url = '') => url === '' || url === 'about:blank';

export class TabSwitch {
  // the tab that the view shows, and the tabs that it showed before (the newest last)
  active = '';
  history: string[] = [];
  private pages = new Map<string, Page>();
  private gone = new Set<string>(); // closed tabs, so a poll that listed them before they closed does not add them again
  private bgClick: { at: number; tab: string } | null = null;
  private quietNew = 0; // the view's own new-tab button: its tab is shown by the view itself
  private asked = new Map<string, { url: string; at: number }>(); // Page.windowOpen: opener -> the address it asked for
  constructor(private decide: (d: Decision) => void, private auto: () => boolean = () => true, private t: Timers = realTimers) {}

  // The tabs that exist when the view starts (or when the browser starts again): no decision for them.
  seed(ids: string[]) {
    for (const p of this.pages.values()) this.t.clear(p.timer);
    this.pages = new Map(ids.map(id => [id, { id, url: '', at: 0, done: true }]));
    this.history = this.history.filter(h => this.pages.has(h));
  }
  known(id: string) { return this.pages.has(id); }
  // The view shows this tab now (a switch, a selection by the user, or a tab that the view opened itself).
  shown(id: string) {
    if (id === this.active) return;
    if (this.active) this.history = [...this.history.filter(h => h !== this.active && h !== id), this.active].slice(-HISTORY);
    this.active = id;
    const p = this.pages.get(id);
    if (p && !p.done) { p.done = true; this.t.clear(p.timer); }
  }
  // A mouse press in the view. A middle click, or a Cmd or Ctrl click without Shift, opens a link in a background tab.
  // Modifier bits: 2 Ctrl, 4 Meta, 8 Shift.
  userClick(button: string, modifiers: number) {
    if (button === 'middle' || (button === 'left' && modifiers & (2 | 4) && !(modifiers & 8))) this.bgClick = { at: this.t.now(), tab: this.active };
  }
  // The view's new-tab button: the next tab without an opener is that tab (the view shows it itself).
  userNewTab() { this.quietNew++; }
  // Page.windowOpen of a page: it opens a window or tab with this address.
  windowOpen(opener: string, url: string) { this.asked.set(opener, { url, at: this.t.now() }); }

  created(info: TargetInfo): void {
    if (info.type !== 'page' || this.gone.has(info.targetId)) return;
    if (this.pages.has(info.targetId)) return this.changed(info); // a poll listed it first, without its opener
    const p: Page = { id: info.targetId, url: info.url || '', opener: info.openerId || undefined, at: this.t.now(), done: false };
    this.pages.set(p.id, p);
    if (!p.opener && this.quietNew > 0) { this.quietNew--; p.done = true; return; }
    const asked = p.opener ? this.asked.get(p.opener) : undefined;
    if (asked && p.at - asked.at <= BACKGROUND_MS) { this.asked.delete(p.opener!); if (p.url === '' && blank(asked.url)) p.url = 'about:blank'; }
    if (!blank(p.url)) return this.resolve(p);
    p.timer = this.t.set(() => {
      if (p.done || !this.pages.has(p.id)) return;
      if (p.url !== 'about:blank') return this.resolve(p);
      p.timer = this.t.set(() => this.resolve(p), BLANK_CLOSE_MS);
    }, BLANK_MS);
  }
  changed(info: TargetInfo): void {
    const p = this.pages.get(info.targetId);
    if (!p) return this.created(info);
    // a popup for about:blank (windowOpen) keeps that address while Chrome still reports ''
    if (info.url || p.url !== 'about:blank') p.url = info.url ?? p.url;
    if (info.openerId && !p.opener) p.opener = info.openerId;
    if (!p.done && !blank(p.url)) this.resolve(p);
  }
  destroyed(id: string) {
    const p = this.pages.get(id);
    if (!p) return;
    this.t.clear(p.timer); p.done = true;
    this.pages.delete(id);
    this.gone.add(id);
    if (this.gone.size > 200) this.gone.delete(this.gone.values().next().value!);
    this.history = this.history.filter(h => h !== id);
    if (id !== this.active) return;
    const to = this.back(p.opener);
    if (to) this.decide({ kind: 'switch', id: to, from: id, reason: 'back' });
  }
  // The tab list of a poll that asked Chrome at the time `asked`: tabs that the events did not report count as new tabs
  // (without opener information), and tabs that are gone count as closed. A tab reported after `asked` stays.
  listed(tabs: { id: string; url: string }[], asked = this.t.now()) {
    const ids = new Set(tabs.map(t => t.id));
    for (const p of [...this.pages.values()]) if (!ids.has(p.id) && p.at <= asked) this.destroyed(p.id);
    for (const t of tabs) if (!this.pages.has(t.id)) this.created({ targetId: t.id, type: 'page', url: t.url });
  }
  // The tab to show when the shown tab is gone, or '' when there is no tab.
  back(opener?: string): string {
    const open = (h: string) => this.pages.has(h);
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (open(h) && opener && (h === opener || this.pages.get(h)!.opener === opener)) return h;
    }
    if (opener && open(opener)) return opener;
    for (let i = this.history.length - 1; i >= 0; i--) if (open(this.history[i])) return this.history[i];
    return this.pages.keys().next().value ?? '';
  }
  private resolve(p: Page) {
    if (p.done || !this.pages.has(p.id)) return;
    p.done = true; this.t.clear(p.timer);
    if (p.id === this.active) return;
    const bg = this.bgClick;
    if (bg && p.at - bg.at <= BACKGROUND_MS && (!p.opener || p.opener === bg.tab)) { this.bgClick = null; return this.decide({ kind: 'offer', id: p.id, reason: 'background' }); }
    if (!this.auto()) return this.decide({ kind: 'offer', id: p.id, reason: 'off' });
    this.decide({ kind: 'switch', id: p.id, from: this.active, reason: p.opener ? 'popup' : 'agent' });
  }
}
