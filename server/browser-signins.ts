// Sign-ins that task browsers share (server/task-browser.ts). Each task browser has its own Chrome profile. A new task
// browser copies the template profile (~/.taskboard/browsers/template/profile) at its first start. This module adds:
// - sites(): the sites that have cookies in one browser (names only, never values), for the dashboard
// - saveAsTemplate(): the profile of one task browser becomes the template (sign-ins and site data, no history or tabs)
// - syncFromTemplate(): the template's cookies of the chosen sites go into a task browser, which keeps its own state
// - removeSite() and signOutAll(): sign-ins leave the template (and, for signOutAll, every task browser)
// - live sharing: for the sites that the user selects, a check every LIVE_MS copies new, changed and deleted cookies
//   between all running browsers that share sign-ins, and keeps them in an encrypted store for browsers that start later
// Only cookies move between running browsers. Local storage, IndexedDB and service workers move only with a profile
// copy (a new task, Reset from template, save as template): DevTools has no command that writes IndexedDB, and local
// storage can be written only from a loaded page of that site.
// Safety: cookie values stay in Chrome and in the store file (AES-256-GCM, mode 0600, in the Taskboard folder). No
// function here returns a value or logs one. A task browser with noShared (opt-out) gets no shared sign-ins.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN } from './config.ts';
import * as browser from './task-browser.ts';

const { TEMPLATE } = browser;
const SETTINGS_FILE = () => join(browser.DIR, 'signins.json');
export const STORE_FILE = () => join(browser.DIR, 'signins-store.bin');
export const LIVE_MS = Number(process.env.TASKBOARD_SIGNIN_LIVE_MS) || 5000;

// ---------- sites ----------
// A site is the registrable part of a cookie domain: mail.google.com and .google.com are both google.com. Without the
// public suffix list, a few two-part suffixes (co.uk and the like) are known here.
const TWO_PART = /\.(co|com|org|net|ac|gov|edu|ne|or)\.[a-z]{2}$/;
export function siteOf(domain: string): string {
  const d = domain.replace(/^\./, '').toLowerCase();
  if (/^[\d.]+$/.test(d) || d.startsWith('[') || !d.includes('.')) return d;
  const parts = d.split('.');
  return parts.slice(TWO_PART.test(d) ? -3 : -2).join('.');
}
const validSite = (s: string) => /^[a-z0-9.-]{1,253}$/.test(s) && !s.startsWith('.');

// A cookie as DevTools gives it (Storage.getCookies). Only this module and Chrome see the value.
export interface Cookie { name: string; value: string; domain: string; path: string; expires: number; size?: number; httpOnly: boolean; secure: boolean; session: boolean; sameSite?: string; priority?: string; sourceScheme?: string; sourcePort?: number; partitionKey?: unknown }
export interface SiteInfo { site: string; cookies: number; lastUsed?: string }
const key = (c: Cookie) => `${c.name}|${c.domain}|${c.path}|${JSON.stringify(c.partitionKey ?? null)}`;
const sig = (c: Cookie) => JSON.stringify([c.value, c.session ? -1 : Math.round(c.expires), c.httpOnly, c.secure, c.sameSite ?? '']);

async function getCookies(ws: string): Promise<Cookie[]> { return ((await browser.once(ws, 'Storage.getCookies', {}, 15000)).cookies || []) as Cookie[]; }
// the parameters of Storage.setCookies: a session cookie has no expiry
function param(c: Cookie) {
  const { size, session, expires, ...rest } = c;
  return session || expires <= 0 ? rest : { ...rest, expires };
}
async function setCookies(ws: string, list: Cookie[]) {
  for (let i = 0; i < list.length; i += 200) await browser.once(ws, 'Storage.setCookies', { cookies: list.slice(i, i + 200).map(param) }, 15000);
}
// A cookie with an expiry in the past deletes the cookie with the same name, domain and path.
async function deleteCookies(ws: string, list: Cookie[]) {
  if (list.length) await setCookies(ws, list.map(c => ({ ...c, value: '', session: false, expires: 1 })));
}

function summarize(list: { domain: string; lastUsed?: number }[]): SiteInfo[] {
  const by = new Map<string, SiteInfo>();
  for (const c of list) {
    const site = siteOf(c.domain);
    const s = by.get(site) || { site, cookies: 0 };
    s.cookies++;
    if (c.lastUsed && (!s.lastUsed || Date.parse(s.lastUsed) < c.lastUsed)) s.lastUsed = new Date(c.lastUsed).toISOString();
    by.set(site, s);
  }
  return [...by.values()].sort((a, b) => a.site.localeCompare(b.site));
}
// The cookie domains of a stopped profile, from its Cookies database (the host_key and last_access_utc columns only; the
// values are encrypted with the key in the system keychain and are not read). A cookie that no request used yet has
// last_access_utc 0, so its creation time counts. null: no sqlite3 program here, or the
// database is locked (a running Chrome holds it).
function profileCookieDomains(id: string): { domain: string; lastUsed?: number }[] | null {
  const db = join(browser.profileDir(id), 'Default', 'Cookies');
  if (!existsSync(db)) return [];
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-separator', '\t', db, 'select host_key, max(last_access_utc, creation_utc) from cookies'], { encoding: 'utf8', timeout: 5000 });
    // Chrome time: microseconds since 1601-01-01
    return out.split('\n').filter(Boolean).map(l => { const [domain, t] = l.split('\t'); const ms = Number(t) / 1000 - 11644473600000; return { domain, lastUsed: ms > 0 ? ms : undefined }; });
  } catch { return null; }
}
// The sites with cookies in one browser. A running browser answers through DevTools (also cookies that Chrome did not
// write to disk yet), with the last use from its database. null: unknown (a stopped browser and no sqlite3).
export async function sites(id: string): Promise<SiteInfo[] | null> {
  const ws = await browser.browserWs(id);
  const disk = profileCookieDomains(id);
  if (!ws) return disk && summarize(disk);
  const last = new Map<string, number>();
  for (const d of disk || []) if (d.lastUsed) last.set(d.domain, Math.max(last.get(d.domain) || 0, d.lastUsed));
  return summarize((await getCookies(ws)).map(c => ({ domain: c.domain, lastUsed: last.get(c.domain) })));
}
// The number of sites in the template, cached for 10 s (the task browser panel asks every second while it waits).
let countCache: { at: number; n: number | null } | null = null;
export async function templateSiteCount(): Promise<number | null> {
  if (countCache && Date.now() - countCache.at < 10000) return countCache.n;
  const n = existsSync(browser.profileDir(TEMPLATE)) ? (await sites(TEMPLATE).catch(() => null))?.length ?? null : 0;
  countCache = { at: Date.now(), n };
  return n;
}
const forgetCount = () => { countCache = null; };
browser.setStatusExtra(async id => id === TEMPLATE || browser.readMeta(id).noShared ? {} : { templateSites: await templateSiteCount() });

// ---------- the template for a short time ----------
// Start the template browser when it is closed, call fn with its DevTools address, and close it again. New task
// browsers wait for this (holdTemplate) instead of refusing to copy an open template.
export function withTemplate<T>(fn: (ws: string) => Promise<T>): Promise<T> {
  return browser.holdTemplate((async () => {
    if (browser.templateWindowOpen()) throw new Error('The template is open in a Chrome window. Close that window first.');
    const was = await browser.isRunning(TEMPLATE);
    const m = await browser.ensure(TEMPLATE);
    try { return await fn(m.ws); } finally { if (!was) await browser.stop(TEMPLATE); forgetCount(); }
  })());
}

// ---------- save a task browser as the template ----------
// These files of a profile hold history, open tabs, site lists and caches. A template leaves them out.
export const NOT_TEMPLATE = new Set([...browser.SKIP, 'History', 'History-journal', 'Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs',
  'Visited Links', 'Top Sites', 'Top Sites-journal', 'Favicons', 'Favicons-journal', 'Shortcuts', 'Shortcuts-journal', 'Network Action Predictor', 'Network Action Predictor-journal',
  'Session Storage', 'DawnWebGPUCache', 'DawnGraphiteCache', 'GPUPersistentCache', 'BrowserMetrics', 'Crashpad', 'Download Service']);
// The task browser stops (Chrome writes its cookies to disk when it closes), its profile is copied into the template,
// and the browser starts again with its pages when it was running. Cookies read from the running browser before the stop
// also go into the template: a stop that Chrome does not finish in time can lose cookies that it did not write yet.
export async function saveAsTemplate(id: string): Promise<{ sites: SiteInfo[] }> {
  if (id === TEMPLATE) throw new Error('This is the template.');
  if (browser.templateOpen()) throw new Error('The template browser is open. Close it on the Settings page first.');
  if (!existsSync(browser.profileDir(id))) throw new Error('This task browser has no profile yet. Start it and sign in first.');
  const ws = await browser.browserWs(id);
  const cookies = ws ? await getCookies(ws) : [];
  if (ws) await browser.stop(id);
  const tmp = join(browser.DIR, '.template-saving');
  rmSync(tmp, { recursive: true, force: true });
  try {
    browser.copyProfile(browser.profileDir(id), join(tmp, 'profile'), NOT_TEMPLATE);
    mkdirSync(join(browser.DIR, TEMPLATE), { recursive: true });
    rmSync(browser.profileDir(TEMPLATE), { recursive: true, force: true });
    renameSync(join(tmp, 'profile'), browser.profileDir(TEMPLATE));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  browser.updateMeta(TEMPLATE, { savedFrom: { task: id, at: new Date().toISOString() }, tabs: [] });
  forgetCount();
  if (cookies.length) await withTemplate(t => setCookies(t, cookies));
  if (ws) void browser.ensure(id).catch(() => {});
  console.log(`${new Date().toISOString()} sign-ins: the profile of task browser ${id} is now the template`);
  return { sites: (await sites(TEMPLATE)) || [] };
}

// ---------- sync from the template ----------
// The template's cookies of the chosen sites go into the task browser. It keeps its other cookies, its tabs and its
// site data. A stopped task browser starts for this. Local storage and IndexedDB are not synced.
export async function syncFromTemplate(id: string, chosen: string[]): Promise<{ sites: string[]; cookies: number }> {
  if (id === TEMPLATE) throw new Error('This is the template.');
  if (browser.readMeta(id).noShared) throw new Error('This task browser does not get shared sign-ins. Turn that on first.');
  if (!existsSync(browser.profileDir(TEMPLATE))) throw new Error('There is no template profile yet. Sign in in the template browser on the Settings page first.');
  const want = new Set(chosen.filter(validSite));
  if (!want.size) throw new Error('Choose at least one site.');
  const list = (await withTemplate(getCookies)).filter(c => want.has(siteOf(c.domain)));
  const m = await browser.ensure(id);
  await setCookies(m.ws, list);
  browser.updateMeta(id, { syncedAt: new Date().toISOString() });
  return { sites: [...want], cookies: list.length };
}

// ---------- send sign-ins to another machine ----------
// The template's cookies of the chosen sites (exportSites) go to another machine's Taskboard over the paired machine
// link (runtime-routes.ts), which writes them into its template (importCookies). New task browsers there copy them,
// and Sync gives them to a task browser that exists. Only cookies move: local storage and IndexedDB stay here.
// importCookies takes only the known fields of a cookie, at most MAX_COOKIES of them, each of at most MAX_VALUE
// characters, for valid site names.
export const MAX_COOKIES = 5000, MAX_VALUE = 8192;
export async function exportSites(chosen: string[]): Promise<Cookie[]> {
  if (!existsSync(browser.profileDir(TEMPLATE))) throw new Error('There is no template profile yet. Sign in in the template browser on the Settings page first.');
  const want = new Set(chosen.filter(validSite));
  if (!want.size) throw new Error('Choose at least one site.');
  const list = (await withTemplate(getCookies)).filter(c => want.has(siteOf(c.domain)));
  if (!list.length) throw new Error('The template has no cookies for these sites.');
  if (list.length > MAX_COOKIES) throw new Error(`These sites have ${list.length} cookies. Taskboard sends at most ${MAX_COOKIES}. Choose fewer sites.`);
  return list;
}
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
export function checkCookies(input: unknown): Cookie[] {
  if (!Array.isArray(input) || !input.length) throw new Error('No cookies.');
  if (input.length > MAX_COOKIES) throw new Error(`At most ${MAX_COOKIES} cookies.`);
  return input.map((c: any) => {
    if (!c || !str(c.name, 256) || !str(c.value, MAX_VALUE) || !str(c.domain, 253) || !str(c.path, 1024) || !String(c.path).startsWith('/')) throw new Error('A cookie has a wrong field.');
    if (!validSite(siteOf(c.domain))) throw new Error('A cookie has a wrong domain.');
    const out: Cookie = { name: c.name, value: c.value, domain: c.domain, path: c.path, expires: Number(c.expires) || -1, httpOnly: !!c.httpOnly, secure: !!c.secure, session: !!c.session };
    if (['Strict', 'Lax', 'None'].includes(c.sameSite)) out.sameSite = c.sameSite;
    if (['Low', 'Medium', 'High'].includes(c.priority)) out.priority = c.priority;
    return out;
  });
}
export async function importCookies(input: unknown): Promise<{ sites: string[]; cookies: number }> {
  const list = checkCookies(input);
  await withTemplate(ws => setCookies(ws, list));
  const got = [...new Set(list.map(c => siteOf(c.domain)))].sort();
  console.log(`${new Date().toISOString()} sign-ins: ${list.length} cookie(s) of ${got.length} site(s) from another machine went into the template`);
  return { sites: got, cookies: list.length };
}

// ---------- remove sign-ins ----------
// Delete the cookies of these sites in one running browser, and its local storage, IndexedDB, service workers and cache
// storage for the site and its www name (other subdomains keep their site data).
async function clearSites(ws: string, list: string[]) {
  const set = new Set(list);
  await deleteCookies(ws, (await getCookies(ws)).filter(c => set.has(siteOf(c.domain))));
  for (const s of list) for (const host of [s, `www.${s}`]) for (const scheme of ['https', 'http']) {
    await browser.once(ws, 'Storage.clearDataForOrigin', { origin: `${scheme}://${host}`, storageTypes: 'local_storage,indexeddb,service_workers,cache_storage,websql,file_systems' }).catch(() => {});
  }
}
// Remove one site from the template (and from live sharing). Task browsers keep the copies they have.
export async function removeSite(site: string) {
  if (!validSite(site)) throw new Error('Not a site name.');
  if (existsSync(browser.profileDir(TEMPLATE))) await withTemplate(ws => clearSites(ws, [site]));
  const s = readSettings();
  s.liveSites = s.liveSites.filter(x => x !== site);
  writeSettings(s);
  const st = readStore();
  for (const k of Object.keys(st.cookies)) if (siteOf(st.cookies[k].c.domain) === site) delete st.cookies[k];
  writeStore(st);
  console.log(`${new Date().toISOString()} sign-ins: ${site} removed from the template`);
}
// Sign out of all: the template profile is deleted, live sharing stops, and every task browser loses the cookies of the
// template's sites and of the live sites: a running one now, a stopped one at its next start (clearSites).
export async function signOutAll(): Promise<{ sites: string[]; now: string[]; later: string[] }> {
  if (browser.templateWindowOpen()) throw new Error('The template is open in a Chrome window. Close that window first.');
  const list = [...new Set([...((await sites(TEMPLATE).catch(() => null)) || []).map(s => s.site), ...readSettings().liveSites])];
  if (!list.length && existsSync(browser.profileDir(TEMPLATE)) && !(await browser.isRunning(TEMPLATE)) && profileCookieDomains(TEMPLATE) === null) {
    // no sqlite3: read the template's sites through Chrome
    list.push(...await withTemplate(async ws => [...new Set((await getCookies(ws)).map(c => siteOf(c.domain)))]));
  }
  await browser.stop(TEMPLATE);
  rmSync(browser.profileDir(TEMPLATE), { recursive: true, force: true });
  browser.updateMeta(TEMPLATE, { savedFrom: undefined, tabs: [] });
  writeSettings({ ...readSettings(), live: false, liveSites: [] });
  rmSync(STORE_FILE(), { force: true });
  snapshots.clear();
  forgetCount();
  const now: string[] = [], later: string[] = [];
  if (list.length) for (const id of browserIds()) {
    if (id === TEMPLATE || !existsSync(browser.profileDir(id))) continue;
    const ws = await browser.browserWs(id);
    if (ws) { await clearSites(ws, list).catch(e => console.error(`sign-ins: ${id}: ${(e as Error).message}`)); now.push(id); }
    else { browser.updateMeta(id, { clearSites: [...new Set([...(browser.readMeta(id).clearSites || []), ...list])] }); later.push(id); }
  }
  console.log(`${new Date().toISOString()} sign-ins: signed out of ${list.length} site(s) in the template and in ${now.length + later.length} task browser(s)`);
  return { sites: list, now, later };
}

// ---------- opt-out ----------
// A task browser with noShared does not copy the template at its first start, cannot sync, and is not part of live
// sharing. Turning it on does not delete what the profile has: Reset then gives an empty profile.
export function setShared(id: string, on: boolean) {
  if (id === TEMPLATE) throw new Error('The template always holds the shared sign-ins.');
  browser.updateMeta(id, { noShared: on ? undefined : true });
  snapshots.delete(id);
}

// ---------- settings: live sharing ----------
interface Settings { live: boolean; liveSites: string[] }
export function readSettings(): Settings {
  try { const s = JSON.parse(readFileSync(SETTINGS_FILE(), 'utf8')); return { live: !!s.live, liveSites: Array.isArray(s.liveSites) ? s.liveSites.filter(validSite) : [] }; } catch { return { live: false, liveSites: [] }; }
}
function writeSettings(s: Settings) { mkdirSync(browser.DIR, { recursive: true }); writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2), { mode: 0o600 }); }
export function setLive(patch: { live?: boolean; liveSites?: string[] }) {
  const s = readSettings();
  if (typeof patch.live === 'boolean') s.live = patch.live;
  if (Array.isArray(patch.liveSites)) s.liveSites = [...new Set(patch.liveSites.map(x => String(x).toLowerCase().trim()).filter(validSite))].slice(0, 200);
  writeSettings(s);
  snapshots.clear();
  if (s.live && s.liveSites.length) watchLive();
  return s;
}

// ---------- the store of live cookies ----------
// The newest known state of each cookie of a live site: the cookie, or a deletion (gone) with its time. Encrypted with
// AES-256-GCM. The key comes from the Taskboard token, which is in the same folder: the encryption keeps the values out
// of a search or a backup tool that reads text, and the file mode 0600 keeps other users out.
interface Entry { c: Cookie; at: number; gone?: boolean }
interface Store { cookies: Record<string, Entry> }
const storeKey = () => createHmac('sha256', TOKEN).update('taskboard browser sign-ins').digest();
export function readStore(): Store {
  try {
    const b = readFileSync(STORE_FILE());
    const d = createDecipheriv('aes-256-gcm', storeKey(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch { return { cookies: {} }; }
}
function writeStore(st: Store) {
  const month = Date.now() - 30 * 86400000;
  for (const [k, e] of Object.entries(st.cookies)) if ((e.gone && e.at < month) || (!e.c.session && e.c.expires > 0 && e.c.expires * 1000 < Date.now())) delete st.cookies[k];
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', storeKey(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(st), 'utf8'), c.final()]);
  mkdirSync(browser.DIR, { recursive: true });
  const tmp = STORE_FILE() + '.tmp';
  writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, STORE_FILE());
}

// ---------- live sharing ----------
// Each check reads the cookies of the live sites in every running browser that shares sign-ins (the template too).
// - A browser that was in the last check: each cookie that it added, changed or deleted since then goes into the store.
//   When two browsers change the same cookie between two checks, the browser checked later wins (the template first,
//   then the task browsers by id). Taskboard does not merge values.
// - A browser that joins (it started, or live sharing just started): its cookies that the store does not know go into
//   the store. Its cookies that the store deleted after its last check (liveSyncAt) are deleted in it.
// - Then each browser gets the store's state: missing or different cookies are set, deleted ones are deleted.
const snapshots = new Map<string, Map<string, string>>();
const browserIds = () => { try { return readdirSync(browser.DIR).filter(n => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(n) && existsSync(join(browser.DIR, n, 'browser.json'))); } catch { return []; } };
let ticking: Promise<void> | null = null;
export function liveTick(only?: { id: string; ws: string }): Promise<void> {
  const run = async () => {
    const s = readSettings();
    if (!s.live || !s.liveSites.length) return;
    const live = new Set(s.liveSites);
    const ids = only ? [only.id] : browserIds().sort((a, b) => a === TEMPLATE ? -1 : b === TEMPLATE ? 1 : a.localeCompare(b));
    const members: { id: string; ws: string; cur: Map<string, Cookie> }[] = [];
    for (const id of ids) {
      if (browser.readMeta(id).noShared) { snapshots.delete(id); continue; }
      const ws = only?.ws || await browser.browserWs(id);
      if (!ws) { snapshots.delete(id); continue; }
      const list = await getCookies(ws).catch(() => null);
      if (!list) continue;
      members.push({ id, ws, cur: new Map(list.filter(c => live.has(siteOf(c.domain))).map(c => [key(c), c])) });
    }
    if (!members.length) return;
    const st = readStore(), now = Date.now();
    let dirty = false;
    const record = (k: string, e: Entry) => { st.cookies[k] = e; dirty = true; };
    const toDelete = new Map<string, Cookie[]>();
    for (const m of members) {
      const snap = snapshots.get(m.id);
      if (snap) {
        for (const [k, c] of m.cur) if (snap.get(k) !== sig(c)) record(k, { c, at: now });
        for (const k of snap.keys()) if (!m.cur.has(k) && st.cookies[k] && !st.cookies[k].gone) record(k, { c: st.cookies[k].c, at: now, gone: true });
      } else {
        const since = Date.parse(browser.readMeta(m.id).liveSyncAt || '') || 0;
        for (const [k, c] of m.cur) {
          const e = st.cookies[k];
          if (!e) record(k, { c, at: now });
          else if (e.gone && e.at > since) toDelete.set(m.id, [...(toDelete.get(m.id) || []), c]);
        }
      }
    }
    for (const m of members) {
      const set: Cookie[] = [], del: Cookie[] = [...(toDelete.get(m.id) || [])];
      for (const [k, e] of Object.entries(st.cookies)) {
        if (!live.has(siteOf(e.c.domain))) continue;
        const have = m.cur.get(k);
        if (e.gone) { if (have && !del.includes(have)) del.push(have); }
        else if (!have || sig(have) !== sig(e.c)) set.push(e.c);
      }
      await setCookies(m.ws, set).catch(e => console.error(`sign-ins: live sync into ${m.id} failed: ${(e as Error).message}`));
      await deleteCookies(m.ws, del).catch(e => console.error(`sign-ins: live sync into ${m.id} failed: ${(e as Error).message}`));
      const snap = new Map<string, string>();
      for (const [k, e] of Object.entries(st.cookies)) if (!e.gone && live.has(siteOf(e.c.domain))) snap.set(k, sig(e.c));
      snapshots.set(m.id, snap);
      const last = Date.parse(browser.readMeta(m.id).liveSyncAt || '') || 0;
      if (set.length || del.length || now - last > 60000) browser.updateMeta(m.id, { liveSyncAt: new Date(now).toISOString() });
    }
    if (dirty) writeStore(st);
  };
  // one check at a time
  const p: Promise<void> = (ticking || Promise.resolve()).catch(() => {}).then(run);
  ticking = p; p.finally(() => { if (ticking === p) ticking = null; }).catch(() => {});
  return p;
}
let liveTimer: NodeJS.Timeout | undefined;
export function watchLive() {
  if (liveTimer) return;
  const tick = () => { liveTimer = setTimeout(() => { void liveTick().catch(e => console.error(`sign-ins: live sync failed: ${(e as Error).message}`)).finally(tick); }, LIVE_MS); liveTimer.unref(); };
  tick();
}
export function stopLive() { clearTimeout(liveTimer); liveTimer = undefined; }

// At each start: the sign-out that waited for this browser (clearSites), then the live cookies.
browser.onStarted(async (id, ws) => {
  if (id === TEMPLATE) forgetCount();
  const m = browser.readMeta(id);
  if (m.clearSites?.length) { await clearSites(ws, m.clearSites); browser.updateMeta(id, { clearSites: undefined }); }
  snapshots.delete(id);
  await liveTick({ id, ws });
});

// ---------- the overview for Settings ----------
// Which task browsers hold shared sign-ins: a copy of the template, a sync, or live sharing. The dashboard adds the task
// names. Names and dates only.
export interface BrowserShare { id: string; running: boolean; noShared: boolean; copiedFromTemplate?: string; syncedAt?: string; liveSyncAt?: string; agents: number }
export async function overview() {
  const t = browser.readMeta(TEMPLATE);
  const list: BrowserShare[] = [];
  for (const id of browserIds()) {
    if (id === TEMPLATE) continue;
    const m = browser.readMeta(id);
    if (!existsSync(browser.profileDir(id)) && !m.noShared) continue;
    list.push({ id, running: await browser.isRunning(id), noShared: !!m.noShared, copiedFromTemplate: m.copiedFromTemplate, syncedAt: m.syncedAt, liveSyncAt: m.liveSyncAt, agents: browser.agentCount(id) });
  }
  return { template: { profile: existsSync(browser.profileDir(TEMPLATE)), running: await browser.isRunning(TEMPLATE), headed: browser.templateWindowOpen(), savedFrom: t.savedFrom }, sites: existsSync(browser.profileDir(TEMPLATE)) ? await sites(TEMPLATE).catch(() => null) : [], settings: readSettings(), browsers: list };
}
if (readSettings().live) watchLive();
