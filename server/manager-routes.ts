import type { Express, Request } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as store from './store.ts';
import * as groups from './groups.ts';
import * as role from './manager-role.ts';
import * as delegation from './manager-delegation.ts';
import * as checkins from './manager-checkins.ts';
import * as board from './waiting-board.ts';
import * as approvals from './approvals.ts';

const exec = promisify(execFile);
const findGroup = (ref: string) => groups.all().find(g => g.id === ref || g.name === ref);
export async function branchHead(t: store.Task): Promise<string | null> {
  try { return (await exec('git', ['rev-parse', 'HEAD'], { cwd: t.cwd })).stdout.trim(); }
  catch (e) {
    if (!t.branch && /not a git repository/.test(String((e as Error).message))) return null;
    throw e;
  }
}

interface Dependencies {
  dashboard: (req: Request) => boolean;
  userCli: (req: Request) => boolean;
  cardView: (card: approvals.Approval) => unknown;
  archive: (task: store.Task, beforeArchive?: () => void) => Promise<unknown>;
  inFlight: () => string;
}

export function mount(app: Express, deps: Dependencies) {
  const user = (req: Request) => deps.dashboard(req) || deps.userCli(req);
  app.get('/api/delegation/audit', (req, res) => {
    const g = req.query.group ? findGroup(String(req.query.group)) : undefined;
    if (req.query.group && !g) return res.status(404).json({ error: 'No such group.' });
    const actor = req.get('x-tb-actor');
    if (actor && (!g || !role.roles(actor).some(r => r.id === g.id))) return res.status(403).json({ error: 'Read the record of your managed group only.' });
    res.json(delegation.auditRows(g?.id));
  });
  app.get('/api/delegation/:group', (req, res) => {
    const g = findGroup(req.params.group);
    if (!g) return res.status(404).json({ error: 'No such group.' });
    res.json({ group: g.id, ...delegation.settings(g), kindsAvailable: delegation.KINDS, warnings: delegation.WARNINGS });
  });
  app.post('/api/delegation/revoke-all', (req, res) => {
    if (!user(req)) return res.status(403).json({ error: 'Only the user can change delegation. Tasks and controllers cannot change it.' });
    try { res.json(delegation.revoke()); }
    catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
  app.post('/api/delegation/:group', (req, res) => {
    if (!user(req)) return res.status(403).json({ error: 'Only the user can change delegation. Tasks and controllers cannot change it.' });
    const g = findGroup(req.params.group);
    if (!g) return res.status(404).json({ error: 'No such group.' });
    try { res.json(delegation.configure(g, req.body, req.body.confirmDangerous === true)); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  app.get('/api/manager/:group/cards', (req, res) => {
    const g = findGroup(req.params.group), actor = req.get('x-tb-actor') || '';
    if (!g || !role.roles(actor).some(r => r.id === g.id)) return res.status(403).json({ error: 'Only this group manager can list its cards here.' });
    res.json(approvals.open().filter(a => a.actor !== actor && g.tasks.includes(a.actor)).map(a => ({
      ...deps.cardView(a) as object, version: delegation.versionOf(a), head: delegation.cardHead(a)?.head, kind: delegation.kindOf(a),
    })));
  });
  app.post('/api/manager/:group/cards/:card/decide', async (req, res) => {
    const g = findGroup(req.params.group), a = approvals.get(req.params.card), actor = req.get('x-tb-actor') || '';
    if (!g || !a) return res.status(404).json({ error: 'No such group or card.' });
    try {
      delegation.check(actor, g.id, a, new Set(), req.body.approve === true);
      if (typeof req.body.approve !== 'boolean') throw new Error('Choose approve or deny.');
      if (req.body.approve && ['release', 'restart'].includes(a.action) && deps.inFlight()) throw new Error(deps.inFlight());
      const head = await branchHead(store.get(a.actor)!);
      res.json(await delegation.decide(actor, g.id, a, { version: String(req.body.version || ''), head: req.body.head,
        reason: String(req.body.reason || ''), approve: req.body.approve }, head));
    } catch (e) { res.status(403).json({ error: (e as Error).message }); }
  });
  app.post('/api/tasks/:id/complete', (req, res) => {
    const t = store.get(req.params.id);
    if (!t) return res.status(404).end();
    if (req.get('x-tb-actor') !== t.id && !deps.dashboard(req)) return res.status(403).json({ error: 'Only this task or the dashboard records completion.' });
    const result = String(req.body.result || '').trim();
    if (!result || result.length > 10000 || t.status === 'archived') return res.status(400).json({ error: 'Give a final result under 10000 characters for a live task.' });
    const wait = board.waitFor(t);
    if (wait && wait.on !== 'nothing') return res.status(409).json({ error: 'Clear the named wait before recording completion.' });
    res.json(store.update(t.id, { completion: { at: new Date().toISOString(), result } }));
  });
  app.post('/api/manager/:group/archive/:task', async (req, res) => {
    const g = findGroup(req.params.group), actor = req.get('x-tb-actor') || '';
    const reason = String(req.body.reason || '').trim();
    if (!g) return res.status(404).json({ error: 'No such group.' });
    try {
      delegation.groupFor(actor, g.id, req.params.task);
      const t = store.get(req.params.task)!;
      const authorize = () => { delegation.groupFor(actor, g.id, t.id); checkins.canArchive(t, board.waitFor(t)); };
      authorize();
      if (!reason || reason.length > 2000) throw new Error('Give an archive reason under 2000 characters.');
      const head = await branchHead(t);
      authorize();
      const row = { group: g.id, manager: actor, card: null, kind: 'archive', task: t.id, head, decision: 'archive', reason };
      delegation.audit({ ...row, state: 'requested' });
      try { await deps.archive(t, authorize); delegation.audit({ ...row, state: 'archived' }); }
      catch (e) { delegation.audit({ ...row, state: 'failed' }); throw e; }
      res.json({ archived: t.id });
    } catch (e) { res.status(403).json({ error: (e as Error).message }); }
  });
}
