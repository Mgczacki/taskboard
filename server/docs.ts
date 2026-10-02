// Inbox and outbox. Each task folder has outbox/ (documents the agent writes for you or other agents)
// and inbox/ (documents sent to it). Sending copies the file, so the agent reads it like any local file.
// inbox/.sent.json records where each inbox file came from.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, TASKS_DIR, VAULT } from './config.ts';
import * as store from './store.ts';

export interface DocInfo { name: string; path: string; kind: 'md' | 'html' | 'other'; size: number; mtime: string; from?: { task: string; num: number; title: string; at: string }; sentTo?: { task: string; num: number; at: string }[]; pending?: boolean }

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
  const pending = new Set(readJson<string[]>(pendingFile(id), []));
  const inbox: DocInfo[] = list(inboxDir(id)).map(f => {
    const s = sent[f.name]; const src = s && store.get(s.task);
    return { ...f, kind: kindOf(f.name), ...(pending.has(f.name) ? { pending: true } : {}), from: s ? { task: s.task, num: src?.num ?? 0, title: s.task === '__review' ? 'User Inbox (your comments)' : s.task === '__account_inbox' ? 'Taskboard messages' : src?.title ?? s.task, at: s.at } : undefined };
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
// The number of files in a folder, read again only when the folder's modification time changed (a file was added,
// removed or renamed). Every task list counts both folders of every task, archived ones included.
const countCache = new Map<string, { mtime: number; n: number }>();
function fileCount(dir: string) {
  let mtime: number;
  try { mtime = statSync(dir).mtimeMs; } catch { countCache.delete(dir); return 0; }
  const c = countCache.get(dir);
  if (c?.mtime === mtime) return c.n;
  const n = list(dir).length;
  countCache.set(dir, { mtime, n });
  return n;
}
export const counts = (id: string) => ({ inbox: fileCount(inboxDir(id)), outbox: fileCount(outboxDir(id)) });

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

export function uploadSystem(toTask: string, name: string, text: string): string {
  mkdirSync(inboxDir(toTask), { recursive: true });
  const target = basename(name).replace(/[^\w.\-]+/g, '_');
  const path = join(inboxDir(toTask), target);
  writeFileSync(path, text);
  const sent = readJson<Record<string, unknown>>(sentFile(toTask), {});
  sent[target] = { task: 'taskboard', at: new Date().toISOString(), orig: target };
  writeFileSync(sentFile(toTask), JSON.stringify(sent, null, 2));
  const pending = readJson<string[]>(pendingFile(toTask), []);
  if (!pending.includes(target)) pending.push(target);
  writeFileSync(pendingFile(toTask), JSON.stringify(pending));
  return path;
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
  told(taskId, pending);
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

// Inbox files the agent has not been told about yet.
export const pendingNames = (taskId: string) => readJson<string[]>(pendingFile(taskId), []);

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
  told(taskId, names);
}

// Runs each time the agent is told about inbox files (server/inbox-delivery.ts records the time).
const toldListeners = new Set<(taskId: string, names: string[]) => void>();
export const onInboxTold = (fn: (taskId: string, names: string[]) => void) => { toldListeners.add(fn); };
const told = (taskId: string, names: string[]) => toldListeners.forEach(fn => { try { fn(taskId, names); } catch { /* a listener must not stop the notice */ } });

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
  if (!existsSync(full)) return null;
  return inside(realpathSync(full), realpathSync(VAULT)) ? full : null;
}

const WORKTREES = join(HOME, 'taskboard-wt');
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);
export function safeLocalPath(input: string): string | null {
  const path = resolve(input.replace(/^~(?=\/)/, HOME));
  if (!existsSync(path)) return null;
  const real = realpathSync(path);
  return [VAULT, WORKTREES].some(root => existsSync(root) && inside(real, realpathSync(root))) ? real : null;
}

export type ViewerLink =
  | { kind: 'document'; document: ReturnType<typeof resolveDocumentLink> }
  | { kind: 'vault-document'; path: string; heading?: string }
  | { kind: 'local'; path: string }
  | { kind: 'web'; url: string }
  | { kind: 'refused'; error: string };

export function resolveViewerLink(source: string, href: string): ViewerLink {
  if (!href || href.length > 4096) return { kind: 'refused', error: 'The link is invalid.' };
  if (/^https?:\/\//i.test(href)) return { kind: 'web', url: href };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('file://')) return { kind: 'refused', error: 'This link type cannot open.' };
  const src = safeLocalPath(source);
  if (!src) return { kind: 'refused', error: 'The source document is outside Taskboard.' };
  let path = href, heading: string | undefined;
  const hash = path.indexOf('#');
  if (hash >= 0) { try { heading = decodeURIComponent(path.slice(hash + 1)); } catch { return { kind: 'refused', error: 'The heading is invalid.' }; } path = path.slice(0, hash); }
  if (path.startsWith('file://')) { try { path = fileURLToPath(path); } catch { return { kind: 'refused', error: 'The file path is invalid.' }; } }
  const full = resolve(path ? path.startsWith('~/') ? join(HOME, path.slice(2)) : path.startsWith('/') ? path : join(resolve(src, '..'), path) : src);
  const safe = safeLocalPath(full);
  if (!safe) return { kind: 'refused', error: `Taskboard cannot open ${full}. The file must be inside the vault or a Taskboard worktree.` };
  const rel = relative(realpathSync(TASKS_DIR), safe).split(sep);
  if (rel.length === 3 && ['inbox', 'outbox'].includes(rel[1])) {
    const doc = resolveDocumentLink(rel[0], join(TASKS_DIR, ...rel) + (heading ? '#' + encodeURIComponent(heading) : ''));
    if (doc && doc.kind !== 'other') return { kind: 'document', document: doc };
  }
  // Markdown opens in the reader, HTML in the sandboxed preview window
  if (/\.(md|markdown|html?)$/i.test(safe) && inside(safe, realpathSync(VAULT))) return { kind: 'vault-document', path: safe, ...(heading ? { heading } : {}) };
  return { kind: 'local', path: safe };
}

const blockedLocal = /\.(?:app|command|sh|bash|zsh|fish|js|mjs|cjs|ts|tsx|py|rb|pl|php|exe|bat|cmd|ps1|scpt|applescript|jar|dmg|pkg|html?|svg)$/i;
export function openableLocalPath(path: string): string | null {
  const safe = safeLocalPath(path);
  if (!safe || !statSync(safe).isFile() || blockedLocal.test(safe) || (statSync(safe).mode & 0o111)) return null;
  return safe;
}

export const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
export function resolveDocumentImage(source: string, href: string): { path: string; type: string } | null {
  const src = safeLocalPath(source);
  if (!src || !inside(src, realpathSync(VAULT)) || !href || href.includes('#') || href.includes('?')) return null;
  const path = resolve(href.startsWith('/') ? href : join(resolve(src, '..'), href));
  const safe = safeLocalPath(path);
  const type = imageTypes[extname(path).toLowerCase()];
  if (!safe || !type || !statSync(safe).isFile() || !inside(safe, realpathSync(VAULT))) return null;
  return { path: safe, type };
}

export function resolveDocumentLink(sourceTask: string, input: string): (DocInfo & { task: string; box: 'inbox' | 'outbox'; line?: number; heading?: string }) | null {
  if (!store.get(sourceTask) || !input || input.length > 2048) return null;
  let path = input.replace(/[),.;]+$/, '');
  let line: number | undefined, heading: string | undefined;
  const fragment = path.match(/#([^#]+)$/);
  if (fragment) { try { heading = decodeURIComponent(fragment[1]); } catch { return null; } path = path.slice(0, -fragment[0].length); }
  const number = path.match(/:(\d+)$/);
  if (number) { line = Number(number[1]); path = path.slice(0, -number[0].length); }
  if (path.startsWith('file://')) { try { path = fileURLToPath(path); } catch { return null; } }
  // agents also write the vault path without "~/", or start at the tasks folder
  if (path.startsWith('~/AgentVault/')) path = join(VAULT, path.slice('~/AgentVault/'.length));
  else if (path.startsWith('AgentVault/')) path = join(VAULT, path.slice('AgentVault/'.length));
  else if (path.startsWith('tasks/')) path = join(VAULT, path);
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
