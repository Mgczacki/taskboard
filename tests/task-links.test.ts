import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';

const root = mkdtempSync(join(tmpdir(), 'taskboard-links-'));
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_DIR = join(root, 'private');
const store = await import('../server/store.ts');
const links = await import('../server/links.ts');
links.start();

let n = 0;
function task(title: string, extra: Partial<import('../server/store.ts').Task> = {}) {
  const num = 100 + ++n;
  return store.create({ id: `t-${num}`, num, title, agent: 'codex', status: 'working', cwd: root, folder: root, session: `s-${num}`, desc: title, ...extra });
}
const user = { actor: 'user' as const };
const inbox = (id: string) => { const d = join(root, 'vault', 'tasks', id, 'inbox'); return existsSync(d) ? readdirSync(d).filter(f => !f.startsWith('.')) : []; };

test.after(() => rmSync(root, { recursive: true, force: true }));

test('a dependsOn link blocks a task until the other task is archived, then tells it and the controller', () => {
  store.create({ id: 'controller', num: 0, title: 'Controller', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'c', role: 'controller', desc: '' });
  const a = task('prerequisite'), b = task('waits');
  const link = links.add(String(b.num), { kind: 'dependsOn', to: `#${a.num}`, note: 'needs the new field' }, { actor: 'controller' });
  assert.equal(link.by.actor, 'controller');
  assert.equal(links.state(store.get(b.id)!), 'blocked');
  assert.deepEqual(links.info(store.get(a.id)!)?.waitedOnBy, [b.id]);
  assert.deepEqual(links.info(store.get(b.id)!)?.blockedBy, [a.id]);
  // saved in the frontmatter of the task that holds it
  const fm = matter(readFileSync(join(root, 'vault', 'tasks', b.id + '.md'), 'utf8')).data;
  assert.equal(fm.links[0].to, a.id);
  assert.equal(fm.links[0].note, 'needs the new field');

  store.update(a.id, { status: 'archived' });
  assert.equal(links.state(store.get(b.id)!), 'ready');
  assert.equal(inbox(b.id).filter(f => f.startsWith('unblocked-')).length, 1);
  assert.equal(inbox('controller').filter(f => f.startsWith('unblocked-')).length, 1);
  store.update(a.id, { statusSource: 'changed again' }); // no second notice
  assert.equal(inbox(b.id).filter(f => f.startsWith('unblocked-')).length, 1);
});

test('a replaces link parks the old task, marks it superseded and moves dependencies to the new task', () => {
  const old = task('old work'), waiter = task('needs the work'), fresh = task('new work');
  links.add(waiter.id, { kind: 'dependsOn', to: old.id }, user);
  links.add(fresh.id, { kind: 'replaces', to: old.id, folded: true, note: 'same work' }, user);
  assert.equal(store.get(old.id)!.status, 'parked');
  assert.equal(links.state(store.get(old.id)!), 'superseded');
  assert.equal(links.info(store.get(old.id)!)?.replacedBy, fresh.id);
  assert.ok(inbox(old.id).includes(`replaced-by-${fresh.num}.md`));
  // the old task is archived, but the new task still does the work
  store.update(old.id, { status: 'archived' });
  assert.equal(links.state(store.get(waiter.id)!), 'blocked');
  assert.deepEqual(links.info(store.get(waiter.id)!)?.blockedBy, [fresh.id]);
  store.update(fresh.id, { status: 'archived' });
  assert.equal(links.state(store.get(waiter.id)!), 'ready');
});

test('a task adds links only on itself, and never a replaces link', () => {
  const me = task('me'), other = task('other');
  const self = { actor: 'task' as const, task: me.id };
  assert.throws(() => links.add(other.id, { kind: 'dependsOn', to: me.id }, self), /only on itself/);
  assert.throws(() => links.add(me.id, { kind: 'replaces', to: other.id }, self), /cannot add a replaces link/);
  const l = links.add(me.id, { kind: 'followUpOf', to: other.id }, self);
  assert.throws(() => links.remove(me.id, l.id, { actor: 'task', task: other.id }), /only its own links/);
  links.remove(me.id, l.id, self);
  assert.equal((store.get(me.id)!.links || []).length, 0);
});

test('links refuse cycles, duplicates, self links and unknown tasks', () => {
  const a = task('a'), b = task('b'), c = task('c');
  links.add(a.id, { kind: 'dependsOn', to: b.id }, user);
  links.add(b.id, { kind: 'dependsOn', to: c.id }, user);
  assert.throws(() => links.add(c.id, { kind: 'dependsOn', to: a.id }, user), /cycle/);
  assert.throws(() => links.add(a.id, { kind: 'dependsOn', to: b.id }, user), /already has/);
  assert.throws(() => links.add(a.id, { kind: 'dependsOn', to: a.id }, user), /itself/);
  assert.throws(() => links.add(a.id, { kind: 'dependsOn', to: '9999' }, user), /No task/);
  assert.throws(() => links.add(a.id, { kind: 'dependsOn', to: 'm1~t-1' }, user), /another machine/);
  assert.throws(() => links.add(a.id, { kind: 'followUpOf', to: c.id, folded: true }, user), /folded/);
  links.add(a.id, { kind: 'relatedTo', to: c.id }, user);
  assert.throws(() => links.add(c.id, { kind: 'relatedTo', to: a.id }, user), /already related/);
  assert.throws(() => links.add(a.id, { kind: 'dependsOn', to: c.id, note: 'x'.repeat(501) }, user), /longer than/);
});

test('mark done unblocks a task without archiving the other task', () => {
  const a = task('external release'), b = task('waits for release');
  const l = links.add(b.id, { kind: 'dependsOn', to: a.id }, user);
  const before = inbox(b.id).length;
  links.markDone(b.id, l.id, user, 'released by hand');
  assert.equal(links.state(store.get(b.id)!), 'ready');
  assert.equal(store.get(a.id)!.status, 'working');
  assert.equal(inbox(b.id).length, before + 1);
  const f = (store.get(b.id)!.links || [])[0];
  assert.equal(f.doneNote, 'released by hand');
  assert.equal(f.doneBy?.actor, 'user');
});

test('the linked set follows links and task parents in both directions, but not the controller', () => {
  const root1 = task('analysis', { parent: 'controller' });
  const child = task('child', { parent: root1.id });
  const dep = task('prerequisite of child');
  const rel = task('related');
  const alone = task('alone', { parent: 'controller' });
  links.add(child.id, { kind: 'dependsOn', to: dep.id }, user);
  links.add(rel.id, { kind: 'relatedTo', to: dep.id }, user);
  assert.deepEqual(new Set(links.linkedSet(root1.id)), new Set([root1.id, child.id, dep.id, rel.id]));
  assert.deepEqual(links.linkedSet(alone.id), [alone.id]);
  const d = links.detail(String(child.num));
  assert.equal(d.out[0].kind, 'dependsOn');
  assert.equal(d.state, 'blocked');
  assert.equal(links.detail(dep.id).in.length, 2);
});

test('the actor comes from x-tb-actor: none is the user', () => {
  assert.deepEqual(links.actorFrom(undefined), { actor: 'user' });
  assert.deepEqual(links.actorFrom('controller'), { actor: 'controller' });
  const t = task('caller');
  assert.deepEqual(links.actorFrom(t.id), { actor: 'task', task: t.id });
  assert.throws(() => links.actorFrom('nobody'), /Unknown task/);
});
