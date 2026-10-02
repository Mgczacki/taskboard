// The values that the server keeps between task changes so that a task list does not read every task many times
// (store.all, links.ts, docs.counts), and the overload rule of the performance monitor (server/perf.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'taskboard-caches-'));
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_DIR = join(root, 'private');
const store = await import('../server/store.ts');
const links = await import('../server/links.ts');
const docs = await import('../server/docs.ts');
const { overloaded } = await import('../server/perf.ts');
links.start();

let n = 0;
const task = (title: string, extra: Partial<import('../server/store.ts').Task> = {}) => {
  const num = 500 + ++n;
  return store.create({ id: `c-${num}`, num, title, agent: 'codex', status: 'working', cwd: root, folder: root, session: `c-${num}`, desc: title, ...extra });
};
const user = { actor: 'user' as const };
test.after(() => rmSync(root, { recursive: true, force: true }));

test('store.all keeps the newest first, follows adds and removes, and gives each caller its own array', () => {
  const a = task('first'), b = task('second');
  const list = store.all();
  assert.deepEqual(list.slice(0, 2).map(t => t.id), [b.id, a.id]);
  list.reverse();
  assert.equal(store.all()[0].id, b.id, 'a change of the returned array does not change the next one');
  const c = task('third');
  assert.equal(store.all()[0].id, c.id);
  store.remove(c.id);
  assert.ok(!store.all().some(t => t.id === c.id));
  const v = store.version();
  store.update(a.id, { now: 'step two' });
  assert.notEqual(store.version(), v, 'each update changes the version');
});

test('the link lists follow each change of a task: a new link, a replacement, a link marked done and an archive', () => {
  const dep = task('dependency'), waiter = task('waiter');
  assert.equal(links.info(store.get(dep.id)!), undefined);
  const link = links.add(String(waiter.num), { kind: 'dependsOn', to: `#${dep.num}` }, user);
  assert.deepEqual(links.info(store.get(dep.id)!)?.waitedOnBy, [waiter.id]);
  // a task that replaces the dependency is the one waited on now
  const next = task('replacement');
  links.add(String(next.num), { kind: 'replaces', to: `#${dep.num}` }, user);
  assert.deepEqual(links.info(store.get(next.id)!)?.waitedOnBy, [waiter.id]);
  assert.equal(links.info(store.get(dep.id)!)?.waitedOnBy, undefined);
  assert.equal(links.info(store.get(dep.id)!)?.replacedBy, next.id);
  links.markDone(waiter.id, link.id, user);
  assert.equal(links.info(store.get(next.id)!)?.waitedOnBy, undefined);
  // the copy that a caller gets is not the kept list
  const other = task('other waiter');
  links.add(String(other.num), { kind: 'dependsOn', to: `#${next.num}` }, user);
  links.info(store.get(next.id)!)!.waitedOnBy!.push('changed');
  assert.deepEqual(links.info(store.get(next.id)!)?.waitedOnBy, [other.id]);
  store.update(other.id, { status: 'archived' });
  assert.equal(links.info(store.get(next.id)!)?.waitedOnBy, undefined);
});

test('docs.counts follows files that are added to and removed from the inbox and the outbox', () => {
  const t = task('documents');
  assert.deepEqual(docs.counts(t.id), { inbox: 0, outbox: 0 });
  docs.uploadSystem(t.id, 'note.md', 'text');
  assert.equal(docs.counts(t.id).inbox, 1);
  const out = docs.outboxDir(t.id);
  rmSync(out, { recursive: true, force: true });
  assert.equal(docs.counts(t.id).outbox, 0);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'a.md'), 'a');
  writeFileSync(join(out, 'b.md'), 'b');
  assert.equal(docs.counts(t.id).outbox, 2);
  unlinkSync(join(out, 'a.md'));
  assert.equal(docs.counts(t.id).outbox, 1);
});

test('the machine counts as overloaded above twice the cores or above 80 % swap use', () => {
  assert.equal(overloaded(19, 10, null), false);
  assert.equal(overloaded(21, 10, null), true);
  assert.equal(overloaded(5, 10, { usedMb: 11900, totalMb: 13300 }), true);
  assert.equal(overloaded(5, 10, { usedMb: 9000, totalMb: 13300 }), false);
  assert.equal(overloaded(5, 10, { usedMb: 500, totalMb: 512 }), false, 'a swap under 1 GB does not count');
});
