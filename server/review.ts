// Document review. An agent runs `tb review <file>`; the file shows up on the user Inbox. You comment on
// paragraphs or diagrams, then "Send feedback" writes the comments into the agent's inbox and tells the agent.
// When the agent runs `tb review` again on the same file, that becomes the next version.
// State: ~/.taskboard/reviews.json. Each requested version is copied to ~/.taskboard/reviews/<id>/v<N><ext>.
import type { Express } from 'express';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { TB_DIR } from './config.ts';
import * as docs from './docs.ts';
import * as agents from './agents.ts';
import * as store from './store.ts';

export interface Comment { id: string; v: number; block: number; quote: string; text: string; at: string; sent?: boolean }
export interface ReviewItem {
  id: string; path: string; name: string; task: string; state: 'pending' | 'changes' | 'accepted';
  version: number; versions: { v: number; at: string; file: string }[]; comments: Comment[];
  requestedAt: string; updated: string; dismissedAt?: string;
}

const FILE = join(TB_DIR, 'reviews.json');
const DIR = join(TB_DIR, 'reviews');
mkdirSync(DIR, { recursive: true });
const load = (): Record<string, ReviewItem> => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = (r: Record<string, ReviewItem>) => writeFileSync(FILE, JSON.stringify(r, null, 2));
const now = () => new Date().toISOString();
const clock = () => new Date().toTimeString().slice(0, 5);
const newId = () => randomBytes(6).toString('hex');

// The newest document from this task that still waits for the user (not yet answered with feedback or accepted).
export function pendingFor(taskId: string): ReviewItem | undefined {
  return Object.values(load()).filter(x => x.task === taskId && x.state === 'pending').sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
}

export function pendingForPath(path: string): ReviewItem | undefined {
  return Object.values(load()).find(x => x.path === path && x.state === 'pending' && !x.dismissedAt);
}

export function mountReview(app: Express) {
  app.post('/api/review/request', (req, res) => {
    const path = docs.safePath(String(req.body.path || ''));
    if (!path) return res.status(400).json({ error: 'The file must exist inside the vault (~/AgentVault), usually in your outbox.' });
    const all = load();
    let item = Object.values(all).find(x => x.path === path);
    const task = String(req.body.task || item?.task || '');
    const t = store.get(task);
    if (!item) {
      const id = newId();
      item = { id, path, name: basename(path), task, state: 'pending', version: 0, versions: [], comments: [], requestedAt: now(), updated: now() };
      all[id] = item;
    }
    item.version += 1;
    mkdirSync(join(DIR, item.id), { recursive: true });
    const copy = join(DIR, item.id, `v${item.version}${extname(path)}`);
    copyFileSync(path, copy);
    item.versions.push({ v: item.version, at: now(), file: copy });
    delete item.dismissedAt;
    item.state = 'pending'; item.requestedAt = now(); item.updated = now();
    if (task) item.task = task;
    save(all);
    if (t) store.update(t.id, { status: 'review', ask: `Review ${item.name}`, statusSource: `Marked for review with tb review at ${clock()}.` });
    res.json(item);
  });

  app.get('/api/review', (req, res) => {
    const items = Object.values(load()).filter(x => req.query.dismissed === '1' ? !!x.dismissedAt : !x.dismissedAt).map(x => {
      const t = store.get(x.task);
      return { ...x, taskNum: t?.num, taskTitle: t?.title, agent: t?.agent, taskStatus: t?.status };
    });
    items.sort((a, b) => {
      const pa = a.state === 'pending' ? 0 : 1, pb = b.state === 'pending' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return pa === 0 ? a.requestedAt.localeCompare(b.requestedAt) : b.updated.localeCompare(a.updated);
    });
    res.json(items);
  });

  app.get('/api/review/:id/v/:v', (req, res) => {
    const x = load()[req.params.id]; const v = x?.versions.find(y => y.v === Number(req.params.v));
    if (!v || !existsSync(v.file)) return res.status(404).send('Not found');
    res.type('text/plain; charset=utf-8').send(readFileSync(v.file, 'utf8'));
  });

  app.post('/api/review/:id/dismiss', (req, res) => {
    const all = load(); const x = all[req.params.id]; if (!x) return res.status(404).end();
    if (!x.dismissedAt) { x.dismissedAt = now(); x.updated = x.dismissedAt; save(all); }
    res.json(x);
  });
  app.post('/api/review/:id/restore', (req, res) => {
    const all = load(); const x = all[req.params.id]; if (!x) return res.status(404).end();
    if (x.dismissedAt) { delete x.dismissedAt; x.updated = now(); save(all); }
    res.json(x);
  });

  // Dismissal changes visibility only. Restore before taking a review action.
  app.use('/api/review/:id', (req, res, next) => {
    if (req.method !== 'GET' && load()[req.params.id]?.dismissedAt)
      return res.status(409).json({ error: 'Restore this inbox item before changing its review.' });
    next();
  });

  app.post('/api/review/:id/comment', (req, res) => {
    const all = load(); const x = all[req.params.id]; if (!x) return res.status(404).end();
    const c: Comment = { id: newId(), v: x.version, block: Number(req.body.block ?? -1), quote: String(req.body.quote || '').slice(0, 600), text: String(req.body.text || ''), at: now() };
    x.comments.push(c); x.updated = now(); save(all); res.json(c);
  });
  app.patch('/api/review/:id/comment/:cid', (req, res) => {
    const all = load(); const c = all[req.params.id]?.comments.find(y => y.id === req.params.cid); if (!c) return res.status(404).end();
    c.text = String(req.body.text || c.text); save(all); res.json(c);
  });
  app.delete('/api/review/:id/comment/:cid', (req, res) => {
    const all = load(); const x = all[req.params.id]; if (!x) return res.status(404).end();
    x.comments = x.comments.filter(y => y.id !== req.params.cid); save(all); res.json({});
  });

  app.post('/api/review/:id/feedback', async (req, res) => {
    const all = load(); const x = all[req.params.id]; if (!x) return res.status(404).end();
    const t = store.get(x.task); if (!t) return res.status(400).json({ error: 'The task that asked for this review no longer exists.' });
    const open = x.comments.filter(c => c.v === x.version && !c.sent);
    if (!open.length) return res.status(400).json({ error: 'Write at least one comment first.' });
    const general = open.filter(c => c.block < 0), anchored = open.filter(c => c.block >= 0).sort((a, b) => a.block - b.block);
    const md = [
      `# Review comments: ${x.name} (version ${x.version})`, '',
      `From the user, on ${new Date().toLocaleString('en-GB')}. File: ${x.path}`, '',
      ...anchored.flatMap(c => [`## On: "${c.quote.replace(/\s+/g, ' ').slice(0, 200)}"`, '', c.text, '']),
      ...(general.length ? ['## General', '', ...general.map(c => `- ${c.text}`), ''] : []),
    ].join('\n');
    const dir = docs.inboxDir(t.id); mkdirSync(dir, { recursive: true });
    const fname = `review-${basename(x.name, extname(x.name))}-v${x.version}.md`;
    const target = join(dir, fname);
    writeFileSync(target, md);
    const sentFile = join(dir, '.sent.json');
    let sent: Record<string, unknown> = {}; try { sent = JSON.parse(readFileSync(sentFile, 'utf8')); } catch { /* none yet */ }
    sent[fname] = { task: '__review', at: now(), orig: fname };
    writeFileSync(sentFile, JSON.stringify(sent, null, 2));
    try {
      const delivery = await agents.sendTaskText(t, `Review comments on ${x.name} (version ${x.version}) are in your inbox: ${target}. Revise the document, then run tb review ${x.path} again.`);
      open.forEach(c => { c.sent = true; });
      x.state = 'changes'; x.updated = now(); save(all);
      store.update(t.id, { status: 'working', ask: '', statusSource: `Review feedback sent by you at ${clock()}.` });
      store.touch(t.id);
      res.json({ path: target, resumed: delivery.resumed });
    } catch (e) { res.status(409).json({ error: e instanceof Error ? e.message : String(e), path: target }); }
  });

  app.post('/api/review/:id/accept', (req, res) => {
    const all = load(); const x = all[req.params.id]; if (!x) return res.status(404).end();
    x.state = 'accepted'; x.updated = now(); save(all);
    const t = store.get(x.task);
    if (t && t.status === 'review') store.update(t.id, { status: 'idle', ask: '', statusSource: `Review accepted by you at ${clock()}.` });
    res.json(x);
  });
  app.post('/api/review/:id/reopen', (req, res) => {
    const all = load(); const x = all[req.params.id]; if (!x) return res.status(404).end();
    x.state = 'pending'; x.updated = now(); save(all); res.json(x);
  });
}
