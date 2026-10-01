import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

// Every test makes its own temporary repository with a bare remote. No test touches a real project.
const top = mkdtempSync(join(tmpdir(), 'tb-force-'));
process.env.TASKBOARD_DIR = join(top, 'tbdir');
process.env.TASKBOARD_VAULT = join(top, 'vault');
mkdirSync(join(top, 'tbdir'), { recursive: true });
mkdirSync(join(top, 'vault', 'tasks'), { recursive: true });
const { squashTask, listBackups, restoreBackup } = await import('../server/task-repair.ts');
const { rebaseTask } = await import('../server/task-git.ts');
const push = await import('../server/push.ts');
const store = await import('../server/store.ts');
type Task = import('../server/store.ts').Task;
after(() => rmSync(top, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
let n = 0;
function setup(branch = 'task/example') {
  const root = join(top, `repo-${++n}`);
  const main = join(root, 'main'), work = join(root, 'task'), bare = join(root, 'remote.git'), other = join(root, 'other');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-b', 'master');
  git(main, 'config', 'user.email', 'force-test@example.invalid');
  git(main, 'config', 'user.name', 'Force Test');
  writeFileSync(join(main, 'base.txt'), 'base\n');
  git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
  git(root, 'init', '--bare', '-b', 'master', bare);
  git(main, 'remote', 'add', 'origin', bare);
  git(main, 'push', 'origin', 'master', 'master:prod');
  git(main, 'worktree', 'add', '-b', branch, work);
  git(root, 'clone', '--branch', 'prod', bare, other);
  git(other, 'config', 'user.email', 'other@example.invalid'); git(other, 'config', 'user.name', 'Other Person');
  const task = { id: `force-${n}`, num: 1000 + n, title: 'Force', agent: 'codex', cwd: work, folder: main, branch, worktree: true, role: undefined } as unknown as Task;
  const commit = (files: Record<string, string>, message: string) => {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(work, name), body);
    git(work, 'add', '-A'); git(work, 'commit', '-m', message);
    return git(work, 'rev-parse', 'HEAD');
  };
  // another person adds a commit to origin/prod
  const moveProd = (name: string, body: string) => {
    git(other, 'checkout', '-q', 'prod'); git(other, 'pull', '-q', 'origin', 'prod');
    writeFileSync(join(other, name), body); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', `prod: ${name}`); git(other, 'push', '-q', 'origin', 'prod');
  };
  const remoteHead = () => git(main, 'ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0];
  // a push the way Taskboard does it: a record in pushes.json, then the push, then the result
  const taskboardPush = async (state: Awaited<ReturnType<typeof push.inspectPush>>) => {
    const record = push.recordPush(state, `push-${n}-${Math.random().toString(36).slice(2)}`);
    const out = await push.runPush(task, state);
    push.finishPush(record, 'succeeded', out);
    return out;
  };
  return { root, main, work, bare, other, task, commit, moveProd, remoteHead, taskboardPush };
}
const backupsOf = (cwd: string, t: Task) => git(cwd, 'for-each-ref', '--format=%(refname)', `refs/taskboard-backup/${t.id}/`).split('\n').filter(Boolean);

test('rebase after a push saves a backup, and the next push needs a force push card with a pinned lease', async () => {
  const { work, task, commit, moveProd, remoteHead, taskboardPush } = setup();
  commit({ 'a.txt': 'a\n' }, 'A');
  const pushedHead = commit({ 'b.txt': 'b\n' }, 'B');
  await taskboardPush(await push.inspectPush(task, 'First push', { base: 'origin/prod' }));
  assert.equal(remoteHead(), pushedHead);
  moveProd('prod.txt', 'prod\n');
  const out = await rebaseTask(task, 'start', undefined, 'origin/prod');
  const [backup] = backupsOf(work, task);
  assert.ok(backup, 'tb git rebase made a backup');
  assert.equal(git(work, 'rev-parse', backup), pushedHead);
  assert.match(out, new RegExp(`Backup of the old head: ${backup}\\nUndo: tb git repair --restore ${backup}`));
  assert.match(await listBackups(task), new RegExp(backup));
  const state = await push.inspectPush(task, 'Push the rebased branch', { base: 'origin/prod' });
  assert.equal(state.fastForward, false);
  assert.equal(state.forcePush, true);
  assert.equal(state.needsCard, true);
  assert.equal(state.oldHead, pushedHead);
  assert.match(state.forceBasis!, new RegExp(`Taskboard pushed ${pushedHead} for this task at `));
  const card = push.pushCardDetail(state);
  assert.match(card, /^FORCE PUSH: Yes\. This task rewrote its branch with tb git rebase or tb git repair after an earlier push\.\n/);
  assert.match(card, new RegExp(`--force-with-lease=refs/heads/task/example:${pushedHead}\\. The lease is pinned to the remote head that Taskboard observed`));
  assert.match(card, /Commits that leave the remote branch: 2\n\S+ B — Force Test.*\n\S+ A — Force Test/);
  await taskboardPush(state);
  assert.equal(remoteHead(), git(work, 'rev-parse', 'HEAD'));
  // a rebase that changes nothing makes no backup
  await rebaseTask(task, 'start', undefined, 'origin/prod');
  assert.equal(backupsOf(work, task).length, 1);
});

test('a branch rebased before backups existed can force push when its remote head is one that Taskboard pushed', async () => {
  const { work, task, commit, moveProd, remoteHead, taskboardPush } = setup();
  const pushedHead = commit({ 'a.txt': 'a\n' }, 'A');
  await taskboardPush(await push.inspectPush(task, 'First push', { base: 'origin/prod' }));
  moveProd('prod.txt', 'prod\n');
  await rebaseTask(task, 'start', undefined, 'origin/prod');
  // remove the backup to copy the state of task 144, which rebased with an older Taskboard
  for (const b of backupsOf(work, task)) git(work, 'update-ref', '-d', b);
  const state = await push.inspectPush(task, 'Push', { base: 'origin/prod' });
  assert.equal(state.forcePush, true);
  assert.match(state.forceBasis!, /Taskboard pushed .* \(push push-/);
  await taskboardPush(state);
  assert.equal(remoteHead(), git(work, 'rev-parse', 'HEAD'));
  assert.notEqual(remoteHead(), pushedHead);
});

test('without a Taskboard push record and without a backup, the push is refused and the message names both checks', async () => {
  const { work, task, commit, moveProd, remoteHead } = setup();
  const pushedHead = commit({ 'a.txt': 'a\n' }, 'A');
  git(work, 'push', '-q', 'origin', 'task/example'); // a push that Taskboard did not make
  moveProd('prod.txt', 'prod\n');
  await rebaseTask(task, 'start', undefined, 'origin/prod');
  for (const b of backupsOf(work, task)) git(work, 'update-ref', '-d', b);
  const state = await push.inspectPush(task, 'Push', { base: 'origin/prod' });
  assert.equal(state.forcePush, false);
  assert.match(state.forceRefusal!, new RegExp(`is at ${pushedHead}, and the local branch does not contain that commit, so a normal push is not a fast-forward`));
  assert.match(state.forceRefusal!, new RegExp(`Check 1: ${pushedHead} is not a head that Taskboard pushed for this task to origin/task/example\\. Check 2: ${pushedHead} is not in a backup of this task`));
  assert.match(state.forceRefusal!, /Ask the user what to do\.$/);
  await assert.rejects(push.runPush(task, state), /both checks failed/);
  assert.equal(remoteHead(), pushedHead);
});

test('the push fails when the remote branch moves after the card was made', async () => {
  const { root, main, work, bare, task, commit, moveProd, remoteHead, taskboardPush } = setup();
  commit({ 'a.txt': 'a\n' }, 'A');
  await taskboardPush(await push.inspectPush(task, 'First push', { base: 'origin/prod' }));
  moveProd('prod.txt', 'prod\n');
  await rebaseTask(task, 'start', undefined, 'origin/prod');
  const card = await push.inspectPush(task, 'Push', { base: 'origin/prod' });
  assert.equal(card.forcePush, true);
  // someone pushes to the task branch before the user approves: Taskboard sees the new head and stops
  const theirs = join(root, 'theirs');
  git(root, 'clone', '-q', '--branch', 'task/example', bare, theirs);
  git(theirs, 'config', 'user.email', 'other@example.invalid'); git(theirs, 'config', 'user.name', 'Other Person');
  writeFileSync(join(theirs, 'theirs.txt'), '1\n'); git(theirs, 'add', '-A'); git(theirs, 'commit', '-q', '-m', 'their commit'); git(theirs, 'push', '-q', 'origin', 'task/example');
  const moved = remoteHead();
  await assert.rejects(push.runPush(task, card), /The branch changed/);
  assert.equal(remoteHead(), moved);
  const after = await push.inspectPush(task, 'Push', { base: 'origin/prod' });
  assert.equal(after.forcePush, false);
  assert.match(after.forceRefusal!, new RegExp(`the remote head ${moved} is not in the local repository`));

  // the remote moves after Taskboard checked it and before git sends the push: --force-with-lease stops the push.
  // A pre-push hook in the task repository moves the remote branch at that moment, one time.
  const ownCard = await (async () => {
    // put the remote back on a head that Taskboard pushed for this task, so that a force push card is offered
    git(theirs, 'push', '-q', '--force', 'origin', `${card.oldHead}:refs/heads/task/example`);
    return push.inspectPush(task, 'Push', { base: 'origin/prod' });
  })();
  assert.equal(ownCard.forcePush, true);
  const hooks = join(root, 'hooks'), marker = join(root, 'hook-ran');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\n[ -e '${marker}' ] && exit 0\ntouch '${marker}'\nenv -i PATH="$PATH" HOME="$HOME" git -C '${theirs}' push -q --force origin HEAD:refs/heads/task/example\n`);
  chmodSync(join(hooks, 'pre-push'), 0o755);
  git(main, 'config', 'core.hooksPath', hooks);
  await assert.rejects(push.runPush(task, ownCard), /git push failed: .*(stale info|rejected|failed to update)/s);
  assert.equal(readFileSync(marker, 'utf8'), '');
  assert.equal(remoteHead(), git(theirs, 'rev-parse', 'HEAD'));
  git(main, 'config', '--unset', 'core.hooksPath');
});

test('a branch that another task also uses gets no force push', async () => {
  const { main, task, commit, moveProd, taskboardPush } = setup();
  commit({ 'a.txt': 'a\n' }, 'A');
  await taskboardPush(await push.inspectPush(task, 'First push', { base: 'origin/prod' }));
  moveProd('prod.txt', 'prod\n');
  await rebaseTask(task, 'start', undefined, 'origin/prod');
  store.create({ id: 'force-owner', num: 9001, title: 'Other owner', agent: 'codex', status: 'idle', cwd: main, folder: main, branch: 'task/example', worktree: true, session: 'none', desc: '' });
  try {
    const state = await push.inspectPush(task, 'Push', { base: 'origin/prod' });
    assert.equal(state.forcePush, false);
    assert.match(state.forceRefusal!, /Taskboard cannot offer a force push: task #9001 \(Other owner\) also uses the branch task\/example\./);
  } finally { store.remove('force-owner'); }
  assert.equal((await push.inspectPush(task, 'Push', { base: 'origin/prod' })).forcePush, true);
});

test('a protected branch gets no force push even when Taskboard pushed its remote head', async () => {
  const { work, task, commit, moveProd, remoteHead, taskboardPush } = setup('release/demo');
  const pushedHead = commit({ 'a.txt': 'a\n' }, 'A');
  await taskboardPush(await push.inspectPush(task, 'First push', { base: 'origin/prod' }));
  moveProd('prod.txt', 'prod\n');
  await rebaseTask(task, 'start', undefined, 'origin/prod');
  assert.equal(backupsOf(work, task).length, 1);
  const state = await push.inspectPush(task, 'Push', { base: 'origin/prod' });
  assert.equal(state.forcePush, false);
  assert.match(state.forceRefusal!, /release\/demo is a protected branch/);
  await assert.rejects(push.runPush(task, state), /protected branch/);
  assert.equal(remoteHead(), pushedHead);
  for (const b of ['master', 'main', 'prod', 'release/x']) assert.equal(push.isProtectedBranch(b, undefined, []), true, b);
  assert.equal(push.isProtectedBranch('task/x', 'task/x', []), true);
});

test('a repair after a push offers a force push whose card names the backup', async () => {
  const { work, task, commit, remoteHead } = setup();
  commit({ 'a.txt': 'a\n' }, 'A');
  const pushedHead = commit({ 'b.txt': 'b\n' }, 'B');
  git(work, 'push', '-q', 'origin', 'task/example'); // no Taskboard push record: only the backup can allow the force push
  await squashTask(task, 'master', 'A and B');
  const [backup] = backupsOf(work, task);
  const state = await push.inspectPush(task, 'Push the repaired branch');
  assert.equal(state.forcePush, true);
  assert.equal(state.forceBasis, `${pushedHead} is in the backup ${backup} that tb git rebase or tb git repair made for this task.`);
  assert.match(push.pushCardDetail(state), new RegExp(`Why Taskboard offers a force push: ${pushedHead} is in the backup`));
  await push.runPush(task, state);
  assert.equal(remoteHead(), git(work, 'rev-parse', 'HEAD'));
});

test('a rebase with conflicts keeps its backup through --continue, and the backup allows the force push', async () => {
  const { work, task, commit, moveProd, remoteHead } = setup();
  const pushedHead = commit({ 'shared.txt': 'task\n' }, 'Task edits shared');
  git(work, 'push', '-q', 'origin', 'task/example');
  moveProd('shared.txt', 'prod\n');
  let message = '';
  await rebaseTask(task, 'start', undefined, 'origin/prod').catch(e => { message = String(e); });
  const [backup] = backupsOf(work, task);
  assert.equal(git(work, 'rev-parse', backup), pushedHead);
  assert.match(message, /The rebase has conflicts/);
  assert.match(message, new RegExp(`Backup of the old head: ${backup}`));
  writeFileSync(join(work, 'shared.txt'), 'task and prod\n');
  const out = await rebaseTask(task, 'continue');
  assert.match(out, new RegExp(`Finished the rebase of task/example.*\\nBackup of the old head: ${backup}`));
  assert.deepEqual(backupsOf(work, task), [backup]);
  const state = await push.inspectPush(task, 'Push', { base: 'origin/prod' });
  assert.equal(state.forcePush, true);
  assert.match(state.forceBasis!, new RegExp(`in the backup ${backup}`));
  await push.runPush(task, state);
  assert.equal(remoteHead(), git(work, 'rev-parse', 'HEAD'));
  // tb git repair --restore uses the backup of the rebase
  await restoreBackup(task, backup.split('/').pop()!);
  assert.equal(git(work, 'rev-parse', 'HEAD'), pushedHead);
});
