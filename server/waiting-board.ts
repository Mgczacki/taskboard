import * as store from './store.ts';
import * as approvals from './approvals.ts';
import * as pending from './pending.ts';
import * as review from './review.ts';
import * as links from './links.ts';
import * as messageQueue from './message-queue.ts';
import type { Group } from './groups.ts';
import * as managerEvents from './manager-events.ts';

export function waitFor(t: store.Task): store.WaitingOn | undefined {
  const card = approvals.pendingFor(t.id)[0];
  if (card) return { on: 'user', target: card.target || card.id, reason: card.summary, needs: card.summary,
    since: card.created, card: card.id, unblocks: card.unblocks || [], source: 'checked' };
  const question = pending.list().find(x => x.taskId === t.id);
  if (question) return { on: 'user', target: question.id, reason: question.question, needs: question.question,
    since: question.createdAt, card: question.id, unblocks: [], source: 'checked' };
  const r = review.pendingFor(t.id);
  if (r) return { on: 'user', target: r.path, reason: 'Review requested', needs: `Review ${r.path}`,
    since: r.requestedAt, card: '', unblocks: [], source: 'checked' };
  const dep = t.links?.find(l => l.kind === 'dependsOn' && !links.depDone(l));
  if (dep) return { on: 'task', target: String(store.get(dep.to)?.num || dep.to), reason: dep.note || 'Dependency not met',
    needs: `Complete task #${store.get(dep.to)?.num || dep.to}`, since: dep.at, card: '', unblocks: [], source: 'checked' };
  const failed = messageQueue.list(t.id).find(q => q.state === 'failed');
  if (failed) return { on: 'task', target: String(t.num), reason: failed.reason, needs: 'Retry or remove the failed message',
    since: failed.queued, card: '', unblocks: [], source: 'checked' };
  const ready = links.state(t) === 'ready';
  if (t.waitingOn?.on && t.waitingOn.on !== 'nothing' && !(ready && t.waitingOn.on === 'task' &&
      (t.links || []).some(link => link.kind === 'dependsOn' && links.depDone(link) &&
        [link.to, String(store.get(link.to)?.num), `#${store.get(link.to)?.num}`].includes(t.waitingOn!.target)))) return t.waitingOn;
  if (t.status === 'needs-you' && t.ask) return { on: 'user', target: '', reason: t.ask, needs: t.ask,
    since: t.statusAt, card: '', unblocks: [], source: 'reported' };
  const lines = store.readLog(t.id).split('\n').reverse();
  const line = lines.find(x => x.startsWith('- Waiting:'))?.slice('- Waiting:'.length).trim();
  if (line && !ready && !/^nothing\.?$/i.test(line)) return { on: 'nothing', target: '', reason: line, needs: '',
    since: t.updated, card: '', unblocks: [], source: 'log' };
}

export function board(g: Group) {
  const columns: Record<'needsYou' | 'waitingOther' | 'running' | 'free' | 'blocked', unknown[]> =
    { needsYou: [], waitingOther: [], running: [], free: [], blocked: [] };
  for (const id of g.tasks) {
    const t = store.get(id); if (!t || t.status === 'archived') continue;
    const waitingOn = waitFor(t);
    const old = t.status !== 'working' && Date.now() - Date.parse(waitingOn?.since || t.updated) > 2 * 60 * 60_000;
    const row = { id: t.id, num: t.num, title: t.title, status: t.status, state: links.state(t), now: t.now,
      waitingOn, ageMinutes: Math.max(0, Math.round((Date.now() - Date.parse(waitingOn?.since || t.statusAt)) / 60000)),
      source: old ? 'old' : waitingOn?.source || 'reported' };
    if (waitingOn?.on === 'user') columns.needsYou.push(row);
    else if (t.status === 'stopped' || waitingOn?.needs.startsWith('Retry or')) columns.blocked.push(row);
    else if (waitingOn && waitingOn.on !== 'nothing') columns.waitingOther.push(row);
    else if (t.status === 'working') columns.running.push(row);
    else columns.free.push(row);
  }
  return { group: { id: g.id, name: g.name, manager: g.manager }, heartbeat: managerEvents.heartbeat(g.id), columns };
}
