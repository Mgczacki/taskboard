import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import * as accounts from './accounts.ts';
import * as store from './store.ts';
import { TB_DIR } from './config.ts';

type Agent = accounts.AgentKind;
type Event = { at: string; tokens?: number; kind: 'tokens' | 'turn'; id?: string };
type FileData = { agent: Agent; account: string; session: string; size: number; mtime: number; head: string; tail?: string; events: Event[]; cumulative?: number; hasResponseUsage?: boolean };
type Cache = { files: Record<string, FileData>; scannedAt?: string };
const cachePath = join(TB_DIR, 'daily-stats.json');
let cache: Cache = { files: {} };
try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* first scan */ }
let scanning = false, scanned = 0, total = 0, version = 0;
const grouped = new Map<string, { version: number; at: number; data: unknown }>();

function fingerprint(path: string, start = 0, length = 4096): string {
  const fd = openSync(path, 'r'), buf = Buffer.alloc(4096);
  try { const n = readSync(fd, buf, 0, Math.min(length, buf.length), start); return createHash('sha1').update(buf.subarray(0, n)).digest('hex'); }
  finally { closeSync(fd); }
}

function files(): { path: string; agent: Agent; account: string; session: string }[] {
  const out: { path: string; agent: Agent; account: string; session: string }[] = [];
  const walk = (dir: string, depth: number, add: (p: string) => void) => {
    let names: string[]; try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      if (name.endsWith('.jsonl')) add(p);
      else if (depth > 0 && !name.includes('.')) walk(p, depth - 1, add);
    }
  };
  for (const a of accounts.all()) {
    if (a.agent === 'claude') walk(join(a.dir, 'projects'), 1, p => out.push({ path: p, agent: a.agent, account: a.id, session: basename(p, '.jsonl') }));
    if (a.agent === 'codex') walk(join(a.dir, 'sessions'), 3, p => out.push({ path: p, agent: a.agent, account: a.id, session: basename(p, '.jsonl').match(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)?.[0] || '' }));
    if (a.agent === 'antigravity') {
      let ids: string[] = []; try { ids = readdirSync(join(a.dir, 'brain')); } catch { /* not installed */ }
      for (const id of ids) { const p = join(a.dir, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'); if (existsSync(p)) out.push({ path: p, agent: a.agent, account: a.id, session: id }); }
    }
  }
  return out;
}
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
function addLine(data: FileData, line: string) {
  if (data.agent === 'claude' && !line.includes('"usage"') && !/"type"\s*:\s*"user"/.test(line)) return;
  if (data.agent === 'codex' && !line.includes('token_count') && !line.includes('token_usage_record') && !line.includes('user_message')) return;
  if (data.agent === 'antigravity' && !line.includes('USER_INPUT')) return;
  let o: any; try { o = JSON.parse(line); } catch { return; }
  const at = o.timestamp || o.created_at;
  if (!at || !Number.isFinite(Date.parse(at))) return;
  if (data.agent === 'claude') {
    if (o.type === 'assistant' && o.message?.usage && o.message?.id) {
      const u = o.message.usage;
      data.events.push({ at, kind: 'tokens', id: o.message.id, tokens: positive(u.input_tokens) + positive(u.cache_creation_input_tokens) + positive(u.cache_read_input_tokens) + positive(u.output_tokens) });
    } else if (o.type === 'user' && !o.isMeta && !o.isSidechain &&
      (typeof o.message?.content === 'string' ? !/^\s*</.test(o.message.content) : Array.isArray(o.message?.content) && o.message.content.some((p: any) => p.type === 'text' && !/^\s*</.test(p.text || '')))) {
      data.events.push({ at, kind: 'turn', id: o.uuid });
    }
  } else if (data.agent === 'codex') {
    const p = o.payload || {};
    if (o.type === 'token_usage_record' && p.usage) {
      data.hasResponseUsage = true;
      data.events.push({ at, kind: 'tokens', id: p.response_id || `${p.turn_id}:${o.ordinal}`, tokens: positive(p.usage.total_tokens) });
    } else if (o.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const n = positive(p.info.total_token_usage.total_tokens), old = data.cumulative || 0;
      data.events.push({ at, kind: 'tokens', tokens: n >= old ? n - old : n });
      data.cumulative = n;
    } else if (o.type === 'event_msg' && p.type === 'user_message') data.events.push({ at, kind: 'turn' });
  } else if (o.type === 'USER_INPUT') data.events.push({ at, kind: 'turn', id: String(o.step_index) });
}

async function readOne(f: ReturnType<typeof files>[number], old?: FileData): Promise<FileData> {
  const st = statSync(f.path), first = fingerprint(f.path);
  if (old && old.size === st.size && old.mtime === st.mtimeMs && old.head === first) return old;
  const append = old && old.size >= 0 && st.size > old.size && old.head === first && !!old.tail &&
    old.tail === fingerprint(f.path, Math.max(0, old.size - 4096), Math.min(4096, old.size));
  const data: FileData = append ? { ...old, events: [...old.events] } : { ...f, size: 0, mtime: 0, head: first, events: [] };
  if (st.size > 0) {
    const stream = createReadStream(f.path, { start: append ? old.size : 0, end: st.size - 1 });
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) addLine(data, line);
  }
  const last = Buffer.alloc(1);
  if (st.size > 0) { const fd = openSync(f.path, 'r'); try { readSync(fd, last, 0, 1, st.size - 1); } finally { closeSync(fd); } }
  data.size = st.size > 0 && last[0] !== 10 ? -1 : st.size;
  data.mtime = st.mtimeMs; data.head = first;
  data.tail = data.size >= 0 ? fingerprint(f.path, Math.max(0, data.size - 4096), Math.min(4096, data.size)) : undefined;
  return data;
}

async function refresh() {
  if (scanning) return;
  scanning = true; scanned = 0;
  try {
    const list = files(); total = list.length;
    const next: Record<string, FileData> = {};
    for (const f of list) {
      try { next[f.path] = await readOne(f, cache.files[f.path]); } catch { if (cache.files[f.path]) next[f.path] = cache.files[f.path]; }
      scanned++;
    }
    cache = { files: next, scannedAt: new Date().toISOString() };
    writeFileSync(cachePath, JSON.stringify(cache));
    version++; grouped.clear();
  } finally { scanning = false; }
}

export function get(timeZone: string) {
  new Intl.DateTimeFormat('en-US', { timeZone });
  if (!scanning && (!cache.scannedAt || Date.now() - Date.parse(cache.scannedAt) > 60000))
    void refresh().catch(e => console.error('daily stats scan failed', e));
  const saved = grouped.get(timeZone);
  if (saved?.version === version && Date.now() - saved.at < 15000) return { ...saved.data as object, scanning, scanned, total };
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = (at: string) => { const p = Object.fromEntries(fmt.formatToParts(new Date(at)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
  type Row = { date: string; tokens: number; turns: number; started: number; imported: number; archived: number; byAccount: Record<string, { tokens: number; turns: number; taskboardTokens: number; otherTokens: number }> };
  const days: Record<string, Row> = {};
  const row = (at: string) => { const date = day(at); return days[date] ||= { date, tokens: 0, turns: 0, started: 0, imported: 0, archived: 0, byAccount: {} }; };
  const taskSessions = new Map<string, store.Task>();
  for (const t of store.all()) for (const s of [t.sessionId, ...(t.pastSessions || [])]) if (s) taskSessions.set(`${t.agent}:${s}`, t);
  const claudeAccounts = new Map<string, string>();
  const claudeLatest = new Map<string, Event>();
  for (const f of Object.values(cache.files)) if (f.agent === 'claude') for (const e of f.events) if (e.kind === 'tokens' && e.id) {
    const old = claudeAccounts.get(e.id);
    claudeAccounts.set(e.id, old && old !== f.account ? 'claude-unknown' : old || f.account);
    claudeLatest.set(e.id, e);
  }
  const seen = new Set<string>();
  for (const f of Object.values(cache.files)) {
    const t = taskSessions.get(`${f.agent}:${f.session}`);
    for (const e of f.events) {
      if (f.agent === 'claude' && e.kind === 'tokens' && e.id && claudeLatest.get(e.id) !== e) continue;
      if (f.agent === 'codex' && f.hasResponseUsage && e.kind === 'tokens' && !e.id) continue;
      const unique = e.id ? `${f.agent}:${e.kind}:${e.id}` : '';
      if (unique && seen.has(unique)) continue;
      if (unique) seen.add(unique);
      const account = f.agent === 'claude' && e.kind === 'tokens' && e.id ? claudeAccounts.get(e.id) || f.account : f.account;
      const r = row(e.at), a = r.byAccount[account] ||= { tokens: 0, turns: 0, taskboardTokens: 0, otherTokens: 0 };
      if (e.kind === 'turn') { r.turns++; a.turns++; }
      else { const n = e.tokens || 0; r.tokens += n; a.tokens += n; if (t && (!t.imported || Date.parse(e.at) >= Date.parse(t.created))) a.taskboardTokens += n; else a.otherTokens += n; }
    }
  }
  for (const t of store.all()) {
    if (t.role === 'controller') continue;
    if (t.imported) row(t.created).imported++;
    else row(t.created).started++;
    if (t.status === 'archived') row(t.statusAt).archived++;
  }
  try {
    for (const line of readFileSync(join(TB_DIR, 'daily-archive-events.jsonl'), 'utf8').split('\n')) {
      if (!line) continue; const e = JSON.parse(line); const t = store.get(e.id);
      if (t?.status === 'archived' && t.statusAt === e.at) continue;
      row(e.at).archived++;
    }
  } catch { /* no archive events yet */ }
  const accountList = accounts.all().map(a => ({ id: a.id, name: a.name, agent: a.agent }));
  if ([...claudeAccounts.values()].includes('claude-unknown')) accountList.push({ id: 'claude-unknown', name: 'Unknown account', agent: 'claude' });
  const data = { days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)), accounts: accountList, scannedAt: cache.scannedAt, timeZone };
  grouped.set(timeZone, { version, at: Date.now(), data });
  return { ...data, scanning, scanned, total };
}
