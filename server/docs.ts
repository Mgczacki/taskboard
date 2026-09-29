// Inbox and outbox. Each task folder has outbox/ (documents the agent writes for you or other agents)
// and inbox/ (documents sent to it). Sending copies the file, so the agent reads it like any local file.
// inbox/.sent.json records where each inbox file came from.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { TASKS_DIR, VAULT } from './config.ts';
import * as store from './store.ts';

export interface DocInfo { name: string; path: string; kind: 'md' | 'html' | 'other'; size: number; mtime: string; from?: { task: string; num: number; title: string; at: string }; sentTo?: { task: string; num: number; at: string }[] }

export const outboxDir = (id: string) => join(store.taskDir(id), 'outbox');
export const inboxDir = (id: string) => join(store.taskDir(id), 'inbox');
const sentFile = (id: string) => join(inboxDir(id), '.sent.json');
const kindOf = (n: string): DocInfo['kind'] => /\.(md|markdown|txt)$/i.test(n) ? 'md' : /\.html?$/i.test(n) ? 'html' : 'other';

function readJson<T>(f: string, d: T): T { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } }

function list(dir: string): { name: string; path: string; size: number; mtime: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => !n.startsWith('.')).map(n => ({ n, st: statSync(join(dir, n)) })).filter(x => x.st.isFile())
    .map(({ n, st }) => ({ name: n, path: join(dir, n), size: st.size, mtime: st.mtime.toISOString() })).sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function docsFor(id: string) {
  const sent = readJson<Record<string, { task: string; at: string }>>(sentFile(id), {});
  const inbox: DocInfo[] = list(inboxDir(id)).map(f => {
    const s = sent[f.name]; const src = s && store.get(s.task);
    return { ...f, kind: kindOf(f.name), from: s ? { task: s.task, num: src?.num ?? 0, title: s.task === '__review' ? 'User Inbox (your comments)' : src?.title ?? s.task, at: s.at } : undefined };
  });
  // who received each outbox file: scan other tasks' inbox records
  const receivers: Record<string, { task: string; num: number; at: string }[]> = {};
  for (const t of store.all()) {
    const r = readJson<Record<string, { task: string; at: string; orig?: string }>>(sentFile(t.id), {});
    for (const [name, s] of Object.entries(r)) if (s.task === id) (receivers[s.orig || name] ||= []).push({ task: t.id, num: t.num, at: s.at });
  }
  const outbox: DocInfo[] = list(outboxDir(id)).map(f => ({ ...f, kind: kindOf(f.name), sentTo: receivers[f.name] || [] }));
  return { inbox, outbox };
}
export const counts = (id: string) => ({ inbox: list(inboxDir(id)).length, outbox: list(outboxDir(id)).length });

// Tasks with new inbox files the agent has not been told about yet (Claude Code learns on its next prompt).
const pendingFile = (id: string) => join(inboxDir(id), '.pending.json');

export function send(fromTask: string, name: string, toTask: string): string {
  const src = join(outboxDir(fromTask), basename(name));
  if (!existsSync(src)) throw new Error(`No such file in #${store.get(fromTask)?.num}'s outbox: ${name}`);
  mkdirSync(inboxDir(toTask), { recursive: true });
  let target = basename(name), n = 2;
  while (existsSync(join(inboxDir(toTask), target))) target = basename(name, extname(name)) + `-${n++}` + extname(name);
  copyFileSync(src, join(inboxDir(toTask), target));
  const sent = readJson<Record<string, unknown>>(sentFile(toTask), {});
  sent[target] = { task: fromTask, at: new Date().toISOString(), orig: basename(name) };
  writeFileSync(sentFile(toTask), JSON.stringify(sent, null, 2));
  const pending = readJson<string[]>(pendingFile(toTask), []); pending.push(target);
  writeFileSync(pendingFile(toTask), JSON.stringify(pending));
  return join(inboxDir(toTask), target);
}

// A file you drop on a task: saved in its inbox, and the agent is told like for a file sent from another task.
export function upload(toTask: string, name: string, data: Buffer): string {
  mkdirSync(inboxDir(toTask), { recursive: true });
  const clean = basename(name).replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '') || 'file';
  let target = clean, n = 2;
  while (existsSync(join(inboxDir(toTask), target))) target = basename(clean, extname(clean)) + `-${n++}` + extname(clean);
  writeFileSync(join(inboxDir(toTask), target), data);
  const sent = readJson<Record<string, unknown>>(sentFile(toTask), {});
  sent[target] = { task: 'you', at: new Date().toISOString(), orig: basename(name) };
  writeFileSync(sentFile(toTask), JSON.stringify(sent, null, 2));
  const pending = readJson<string[]>(pendingFile(toTask), []); pending.push(target);
  writeFileSync(pendingFile(toTask), JSON.stringify(pending));
  return join(inboxDir(toTask), target);
}

export function removeFromInbox(taskId: string, name: string) {
  const f = join(inboxDir(taskId), basename(name)); if (existsSync(f)) unlinkSync(f);
}

// Inbox files the agent has not been told about, with who sent each; clears the list.
// Used by the prompt hook, by /inbox/tell and by `tb inbox wait`, so each file is reported once.
export interface InboxArrival { name: string; path: string; from: { task: string; num?: number; title?: string } | null }
export function takePending(taskId: string): InboxArrival[] {
  const pending = readJson<string[]>(pendingFile(taskId), []);
  if (!pending.length) return [];
  writeFileSync(pendingFile(taskId), '[]');
  const sent = readJson<Record<string, { task: string }>>(sentFile(taskId), {});
  return pending.map(n => {
    const s = sent[n]; const t = s && store.get(s.task);
    return { name: n, path: join(inboxDir(taskId), n), from: s ? { task: s.task, num: t?.num, title: t?.title } : null };
  });
}

// Text for the agent about files it has not been told about; clears the list.
export function takeInboxNotice(taskId: string): string | null {
  const pending = takePending(taskId);
  if (!pending.length) return null;
  const lines = pending.map(f => `- ${f.path}${f.from?.num ? ` (from task #${f.from.num} "${f.from.title}")` : ''}`);
  return `New file${pending.length > 1 ? 's' : ''} in your Taskboard inbox. Read ${pending.length > 1 ? 'them' : 'it'} before continuing if relevant:\n${lines.join('\n')}`;
}

export function pendingInboxNotice(taskId: string): { notice: string; names: string[] } | null {
  const names = readJson<string[]>(pendingFile(taskId), []);
  if (!names.length) return null;
  const sent = readJson<Record<string, { task: string }>>(sentFile(taskId), {});
  const lines = names.map(name => {
    const sender = store.get(sent[name]?.task);
    return `- ${join(inboxDir(taskId), name)}${sender ? ` (from task #${sender.num} "${sender.title}")` : ''}`;
  });
  return { notice: `New file${names.length > 1 ? 's' : ''} in your Taskboard inbox. Read ${names.length > 1 ? 'them' : 'it'} before continuing if relevant:\n${lines.join('\n')}`, names };
}

export function acknowledgeInboxNotice(taskId: string, names: string[]) {
  const delivered = new Set(names);
  writeFileSync(pendingFile(taskId), JSON.stringify(readJson<string[]>(pendingFile(taskId), []).filter(name => !delivered.has(name))));
}

// Every send between tasks, for the graph: document → receiving task.
export function edges() {
  const out: { from: string; to: string; name: string; at: string }[] = [];
  for (const t of store.all()) {
    const r = readJson<Record<string, { task: string; at: string; orig?: string }>>(sentFile(t.id), {});
    for (const [name, s] of Object.entries(r)) out.push({ from: s.task, to: t.id, name: s.orig || name, at: s.at });
  }
  return out;
}

// Only files inside the vault can be served.
export function safePath(p: string): string | null {
  const full = resolve(p.replace(/^~(?=\/)/, process.env.HOME || ''));
  if (!full.startsWith(resolve(VAULT) + sep) || !existsSync(full)) return null;
  return realpathSync(full).startsWith(realpathSync(VAULT) + sep) ? full : null;
}

export function resolveDocumentLink(sourceTask: string, input: string): (DocInfo & { task: string; box: 'inbox' | 'outbox'; line?: number; heading?: string }) | null {
  if (!store.get(sourceTask) || !input || input.length > 2048) return null;
  let path = input.replace(/[),.;]+$/, '');
  let line: number | undefined, heading: string | undefined;
  const fragment = path.match(/#([^#]+)$/);
  if (fragment) { try { heading = decodeURIComponent(fragment[1]); } catch { return null; } path = path.slice(0, -fragment[0].length); }
  const number = path.match(/:(\d+)$/);
  if (number) { line = Number(number[1]); path = path.slice(0, -number[0].length); }
  if (path.startsWith('~/AgentVault/')) path = join(VAULT, path.slice('~/AgentVault/'.length));
  else if (path.startsWith('~/')) return null;
  const full = resolve(path.startsWith('/') ? path : join(store.taskDir(sourceTask), path));
  const rel = relative(TASKS_DIR, full).split(sep);
  if (rel.length !== 3 || !rel[0] || !['inbox', 'outbox'].includes(rel[1]) || !rel[2]) return null;
  const [task, box, name] = rel;
  if (!store.get(task)) return null;
  if (!safePath(full) || !realpathSync(full).startsWith(realpathSync(TASKS_DIR) + sep)) return null;
  const doc = list(join(store.taskDir(task), box)).find(x => x.name === name && x.path === full);
  if (!doc) return null;
  return { ...doc, kind: kindOf(name), task, box: box as 'inbox' | 'outbox', ...(line && line > 0 ? { line } : {}), ...(heading ? { heading } : {}) };
}
