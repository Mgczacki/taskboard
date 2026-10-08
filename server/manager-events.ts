import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TB_DIR } from './config.ts';
import * as store from './store.ts';
import * as groups from './groups.ts';
import * as messageQueue from './message-queue.ts';

export interface ManagerEvent { at: string; group: string; task: string; kind: string; text: string }
const eventFile = join(TB_DIR, 'manager-events.jsonl');
const queueFile = join(TB_DIR, 'manager-event-queue.json');
const ciFile = join(TB_DIR, 'ci-watches.json');
const queue: ManagerEvent[] = (() => { try { return JSON.parse(readFileSync(queueFile, 'utf8')); } catch { return []; } })();
const watches: { task: string; repo: string; pr: number; next: number; attempt: number; started: number }[] =
  (() => { try { return JSON.parse(readFileSync(ciFile, 'utf8')); } catch { return []; } })();
const save = () => writeFileSync(queueFile, JSON.stringify(queue), { mode: 0o600 });
const saveWatches = () => writeFileSync(ciFile, JSON.stringify(watches), { mode: 0o600 });
const safe = (text: string) => text.replace(/\[Taskboard event digest[^\]]*\]/gi, '[task text]');
const timers = new Map<string, NodeJS.Timeout>();
const exec = promisify(execFile);
const backoff = [60_000, 120_000, 300_000, 600_000];
const fromManager = (event: ManagerEvent) => groups.get(event.group)?.manager === event.task;
const groupSnapshot = () => new Map(groups.all().map(g => [g.id, { manager: g.manager, tasks: [...g.tasks], name: g.name }]));
let lastGroups = groupSnapshot();
const selfOnlyDigest = (text: string, manager: store.Task) => {
  if (text.includes('\nCurrent group:\n') || text.includes('\n- group: ')) return false;
  const header = /^\[Taskboard event digest, [^\n]+, group .+, (\d+) events\]/.exec(text);
  if (!header) return false;
  const tasks = [...text.matchAll(/^- #([^\s]+) /gm)].map(x => x[1]);
  return tasks.length > 0 && tasks.length === Number(header[1]) && tasks.every(task => task === String(manager.num) || task === manager.id);
};
const schedule = (group: string) => {
  if (timers.has(group)) return;
  const timer = setTimeout(() => { timers.delete(group); void flush(group); }, 120_000);
  timer.unref(); timers.set(group, timer);
};

export function record(task: string, kind: string, text: string, immediate = false) {
  for (const g of groups.groupsOf(task)) {
    if (!g.manager || g.manager === task) continue;
    const event: ManagerEvent = { at: new Date().toISOString(), group: g.id, task, kind, text: safe(text).slice(0, 500) };
    appendFileSync(eventFile, JSON.stringify(event) + '\n');
    queue.push(event); save();
    if (immediate) void flush(g.id);
    else schedule(g.id);
  }
}

function groupChanged() {
  const current = groupSnapshot();
  for (const [id, now] of current) {
    const before = lastGroups.get(id);
    if (!before || (before.manager === now.manager && before.tasks.length === now.tasks.length && before.tasks.every(task => now.tasks.includes(task)))) continue;
    const removed = before.tasks.filter(task => !now.tasks.includes(task));
    const added = now.tasks.filter(task => !before.tasks.includes(task));
    // An earlier digest can describe a member or manager that no longer belongs to this group.
    for (const managerId of new Set([before.manager, now.manager].filter((x): x is string => !!x))) {
      for (const message of messageQueue.list(managerId)) {
        if (message.state === 'queued' && message.from === 'taskboard' &&
            [before.name, now.name].some(name => message.text.startsWith(`[Taskboard event digest, `) && message.text.includes(`, group ${name}, `)))
          messageQueue.remove(managerId, message.id);
      }
    }
    if (before.manager && before.manager !== now.manager) {
      const previous = store.get(before.manager);
      if (previous) void messageQueue.send(previous, `You no longer manage group ${before.name}. Read tb board "${before.name}" for its current manager and tasks.`,
        { from: 'taskboard', kind: 'message', holdWhenParked: true, queueOnError: true }).catch(e => console.error('manager role notice', e));
    }
    const kept = queue.filter(event => event.group !== id);
    queue.splice(0, queue.length, ...kept);
    if (now.manager && store.get(now.manager)) {
      const changes = [
        ...(before.manager !== now.manager ? [`manager changed from ${before.manager || 'none'} to ${now.manager}`] : []),
        ...removed.map(task => `#${store.get(task)?.num || task} ${store.get(task)?.title || task} left the group`),
        ...added.map(task => `#${store.get(task)?.num || task} ${store.get(task)?.title || task} joined the group`),
      ];
      const event: ManagerEvent = { at: new Date().toISOString(), group: id, task: 'taskboard', kind: 'group', text: changes.join('; ') || 'Membership changed' };
      appendFileSync(eventFile, JSON.stringify(event) + '\n');
      queue.push(event);
      schedule(id);
    }
    save();
  }
  lastGroups = current;
}

export async function flush(group: string) {
  const timer = timers.get(group); if (timer) { clearTimeout(timer); timers.delete(group); }
  const g = groups.get(group); const manager = g?.manager && store.get(g.manager);
  if (!manager) return;
  const events = queue.filter(x => x.group === group && !fromManager(x) && (x.task === 'taskboard' || g!.tasks.includes(x.task)));
  if (!queue.some(x => x.group === group)) return;
  queue.splice(0, queue.length, ...queue.filter(x => x.group !== group)); save();
  if (!events.length) return;
  const lines = events.map(x => x.task === 'taskboard' ? `- group: ${x.text}` : `- #${store.get(x.task)?.num || x.task} ${x.kind}: ${x.text}`);
  let snapshot = '';
  if (events.some(x => x.task === 'taskboard' || x.kind === 'ready')) {
    const { board } = await import('./waiting-board.ts');
    const current = board(g);
    const rows = Object.values(current.columns).flat() as { num: number; title: string; status: string; state?: string; waitingOn?: { on: string; needs: string; reason: string } }[];
    snapshot = `\nCurrent group:\n${rows.map(row => `- #${row.num} ${row.title} (${row.status}${row.state ? `, ${row.state}` : ''})${row.waitingOn && row.waitingOn.on !== 'nothing' ? `: ${row.waitingOn.on}: ${row.waitingOn.needs || row.waitingOn.reason}` : ''}`).join('\n') || '- No active tasks'}`;
  }
  const digest = `[Taskboard event digest, ${new Date().toISOString()}, group ${g.name}, ${events.length} events]\n${lines.join('\n')}${snapshot}\nBoard: tb board "${g.name}"`;
  if (groups.get(group)?.manager !== manager.id) return;
  try {
    const result = await messageQueue.send(manager, digest, { from: 'taskboard', kind: 'message', holdWhenParked: true, queueOnError: true });
    if (result.state === 'failed') throw new Error(result.reason || 'The manager message was not queued.');
  }
  catch (e) { queue.unshift(...events); save(); schedule(group); console.error('manager event delivery', e); }
}

export function heartbeat(group: string) {
  const events = queue.filter(x => x.group === group && !fromManager(x));
  const manager = groups.get(group)?.manager;
  const lastTurn = manager ? store.get(manager)?.updated : undefined;
  const notResponding = !!events.length && !!lastTurn && Date.now() - Date.parse(lastTurn) > 30 * 60_000;
  return { pending: events.length, lastEvent: events.at(-1)?.at || null, lastTurn: lastTurn || null, notResponding };
}

export function watchCi(task: string, repo: string, pr: number) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isInteger(pr) || pr < 1) throw new Error('Give --repo owner/name and a positive PR number.');
  const old = watches.find(x => x.task === task && x.repo === repo && x.pr === pr);
  if (old) return old;
  const w = { task, repo, pr, next: Date.now(), attempt: 0, started: Date.now() };
  watches.push(w); saveWatches(); void checkCi(); return w;
}

async function checkCi() {
  for (const w of [...watches]) {
    if (w.next > Date.now()) continue;
    let output = '';
    try { output = (await exec('gh', ['pr', 'checks', String(w.pr), '--repo', w.repo], { timeout: 30000 })).stdout.trim(); }
    catch (e: any) { output = String(e.stdout || e.stderr || e.message).trim(); }
    const pending = /\b(pending|queued|in.progress|waiting)\b/i.test(output) || !output;
    if (!pending || Date.now() - w.started >= 12 * 60 * 60_000) {
      record(w.task, 'CI', `${w.repo} PR #${w.pr}: ${output.slice(0, 250) || 'No checks found.'}`, !pending && /\bfail/i.test(output));
      watches.splice(watches.indexOf(w), 1);
    } else { w.next = Date.now() + (backoff[Math.min(w.attempt, backoff.length - 1)] || 600_000); w.attempt++; }
    saveWatches();
  }
}

export function start() {
  lastGroups = groupSnapshot();
  groups.onGroupsChange(groupChanged);
  // Older queue files may hold events from the manager itself. Remove them before scheduling delivery.
  const pending = queue.filter(x => !fromManager(x));
  if (pending.length !== queue.length) { queue.splice(0, queue.length, ...pending); save(); }
  for (const managerId of new Set(groups.all().map(g => g.manager).filter((id): id is string => !!id))) {
    const manager = store.get(managerId); if (!manager) continue;
    for (const message of messageQueue.list(managerId))
      if (message.state === 'queued' && message.from === 'taskboard' && selfOnlyDigest(message.text, manager))
        messageQueue.remove(managerId, message.id);
  }
  const status = new Map(store.all().map(t => [t.id, t.status]));
  const accounts = new Map(store.all().map(t => [t.id, t.account]));
  store.onTaskChange(t => {
    const before = status.get(t.id); status.set(t.id, t.status);
    const oldAccount = accounts.get(t.id); accounts.set(t.id, t.account);
    if (before && before !== t.status) record(t.id, 'status', `${before} to ${t.status}`, t.status === 'stopped');
    if (oldAccount !== t.account) for (const g of groups.all().filter(g => g.manager === t.id)) {
      const event: ManagerEvent = { at: new Date().toISOString(), group: g.id, task: 'taskboard', kind: 'account', text: `Manager #${t.num} moved to account ${t.account || 'default'}.` };
      appendFileSync(eventFile, JSON.stringify(event) + '\n'); queue.push(event); save(); schedule(g.id);
    }
  });
  for (const e of queue) schedule(e.group);
  const warned = new Set<string>();
  setInterval(() => {
    void checkCi();
    for (const g of groups.all()) {
      const h = heartbeat(g.id);
      if (!h.notResponding) { warned.delete(g.id); continue; }
      if (warned.has(g.id)) continue;
      warned.add(g.id);
      const controller = store.get('controller');
      if (controller) void messageQueue.send(controller, `Manager #${store.get(g.manager || '')?.num || g.manager} of ${g.name} has ${h.pending} events pending and has not updated for 30 minutes. Read tb board "${g.name}".`, { from: 'taskboard', kind: 'message' });
    }
  }, 60_000).unref();
}
