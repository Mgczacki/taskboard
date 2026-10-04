import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { RELEASE_REF, checkRef, releaseCommand, writePermit } from '../server/release-permit.ts';

const guard = fileURLToPath(new URL('../server/hooks/guard.mjs', import.meta.url));

// a scratch TASKBOARD_DIR with a release-permits folder; run(command, taskId) gives the guard's deny reason or ''
function releaseGuard() {
  const dir = mkdtempSync(join(tmpdir(), 'tb-release-guard-'));
  const permits = join(dir, 'release-permits');
  mkdirSync(permits);
  const run = (command, taskId = 'task-41') => {
    const result = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
      env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: taskId },
    });
    assert.equal(result.status, 0);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason : '';
  };
  const file = (taskId = 'task-41') => join(permits, taskId + '.json');
  const permit = (data, taskId = 'task-41') => writeFileSync(file(taskId), JSON.stringify(data));
  return { dir, run, file, permit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a dashboard permit lets one task run one release command', () => {
  const g = releaseGuard();
  try {
    assert.match(g.run('pnpm release'), /has no release approval\. Run `tb release-request`/);
    writePermit(g.dir, 'task-41', null);
    assert.equal(g.run('pnpm release'), '');
    assert.equal(existsSync(g.file()), false);
    assert.match(g.run('pnpm release'), /has no release approval/);
    writePermit(g.dir, 'task-41', null);
    assert.equal(g.run('pnpm run release --no-switch'), '');
  } finally { g.done(); }
});

test('the release command with --ref runs when the permit is for that ref', () => {
  const g = releaseGuard();
  try {
    writePermit(g.dir, 'task-41', 'master');
    assert.equal(g.run(releaseCommand('master')), '');
    writePermit(g.dir, 'task-41', 'release/1.2');
    assert.equal(g.run('pnpm release --no-switch --ref release/1.2'), '');
    // a permit from a server that did not record the ref allows each accepted form
    g.permit({ taskId: 'task-41', expiresAt: Date.now() + 60_000 });
    assert.equal(g.run('pnpm release --ref master'), '');
  } finally { g.done(); }
});

test('the guard keeps the permit and names the approved command when the ref differs', () => {
  const g = releaseGuard();
  try {
    writePermit(g.dir, 'task-41', 'master');
    assert.match(g.run('pnpm release'), /the user approved `pnpm release --ref master` \(valid until \d\d:\d\d:\d\d, still unused\), not `pnpm release`/);
    assert.match(g.run('pnpm release --ref other'), /approved `pnpm release --ref master`.*not `pnpm release --ref other`/);
    writePermit(g.dir, 'task-41', null);
    assert.match(g.run('pnpm release --ref master'), /approved `pnpm release`.*not `pnpm release --ref master`/);
    assert.equal(existsSync(g.file()), true);
  } finally { g.done(); }
});

test('an expired permit, a permit of another task and a broken permit give their own message', () => {
  const g = releaseGuard();
  try {
    g.permit({ taskId: 'task-41', ref: null, expiresAt: Date.now() - 5000 });
    assert.match(g.run('pnpm release'), /expired at \d\d:\d\d:\d\d \(\d+ s ago\).*Stop and tell the user/);
    // another task's permit does not help this task
    writePermit(g.dir, 'task-42', null);
    assert.match(g.run('pnpm release', 'task-43'), /this task \(task-43\) has no release approval/);
    assert.equal(existsSync(g.file('task-42')), true);
    // a file under this task's name that names another task
    g.permit({ taskId: 'task-42', ref: null, expiresAt: Date.now() + 60_000 });
    assert.match(g.run('pnpm release'), /names task task-42, not this task \(task-41\)/);
    writeFileSync(g.file(), '{');
    assert.match(g.run('pnpm release'), /cannot be read/);
    writePermit(g.dir, 'controller', null);
    assert.match(g.run('pnpm release', 'controller'), /not such a task/);
  } finally { g.done(); }
});

test('a release command with a second command, a redirect or an unknown option is refused and keeps the permit', () => {
  const g = releaseGuard();
  try {
    writePermit(g.dir, 'task-41', null);
    for (const c of ['pnpm release && pnpm rollback', 'pnpm release; ls', 'pnpm release || true', 'pnpm release | tee log',
      'pnpm release > log', 'pnpm release `id`', 'pnpm release --ref $(id)', 'pnpm release --ref "master"', 'pnpm release --ref -x',
      'pnpm release --ref', 'pnpm release --ref a --ref b', 'pnpm release --force', 'cd /tmp && pnpm release', 'node scripts/release.mjs',
      'npm run release', 'pnpm release\nls']) {
      assert.match(g.run(c), /not an accepted form of the release command.*valid until \d\d:\d\d:\d\d and is still unused. Accepted forms: `pnpm release`/, c);
      assert.equal(existsSync(g.file()), true, c);
    }
    assert.doesNotMatch(g.run('pnpm release; ls'), /stopping it would cut off you/);
    assert.match(g.run('pnpm rollback'), /rollback needs the user/);
    assert.match(g.run('node scripts/restart.mjs'), /only the user restarts/);
    assert.equal(g.run('pnpm release'), '');
  } finally { g.done(); }
});

test('commands that only read may name the release, rollback and restart scripts', () => {
  const g = releaseGuard();
  try {
    for (const c of ['cat scripts/release.mjs', 'head -40 scripts/rollback.mjs', 'grep -n "pnpm release" README.md',
      'cat scripts/release.mjs | grep ref | head', 'grep -rn restart.mjs scripts', 'wc -l scripts/restart.mjs'])
      assert.equal(g.run(c), '', c);
    for (const c of ['cat scripts/release.mjs | node', 'cat scripts/release.mjs; pnpm release', 'cat $(pnpm release)',
      'cat x > scripts/release.mjs', 'sed -n 1p scripts/release.mjs', 'grep x scripts/rollback.mjs && pnpm rollback'])
      assert.notEqual(g.run(c), '', c);
  } finally { g.done(); }
});

test('the guard and the server accept the same release refs', () => {
  const guardSource = readFileSync(guard, 'utf8');
  assert.ok(guardSource.includes(`const RELEASE_REF = ${RELEASE_REF};`), 'guard.mjs has the RELEASE_REF of server/release-permit.ts');
  for (const ref of ['master', 'release/1.2', 'v1.0.0', 'a1b2c3d', 'task/x_y-z'])
    assert.equal(checkRef(ref), ref);
  for (const ref of ['-x', '$(id)', 'a b', "a'b", 'a;b', '../x', '@{u}', 'x'.repeat(201)])
    assert.throws(() => checkRef(ref), /release ref/, ref);
  assert.equal(checkRef(undefined), null);
});

test('a worktree task uses Taskboard for Git writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-git-guard-'));
  const run = command => spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
    env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: 'task-41', TASK_WORKTREE: join(dir, 'work') },
  }).stdout;
  try {
    assert.match(run('git commit -m test'), /permissionDecision.*deny/);
    assert.match(run('git -C other merge master'), /permissionDecision.*deny/);
    assert.equal(run('tb git commit "test"'), '');
    assert.equal(run('tb git merge-request'), '');
    assert.equal(run('tb git rebase --continue'), '');
    assert.equal(run('tb git rebase --abort'), '');
    assert.equal(run('git status --short'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a task in master cannot run raw Git writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-master-guard-'));
  try {
    const result = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { command: 'git merge --continue' } }), encoding: 'utf8',
      env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: 'task-42', TASK_WORKTREE: '' },
    });
    assert.match(result.stdout, /permissionDecision.*deny/);
    assert.match(result.stdout, /tb git merge-request/);
    const withEditor = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_input: { command: 'GIT_EDITOR=true git merge --continue' } }), encoding: 'utf8',
      env: { ...process.env, TASKBOARD_DIR: dir, TASK_ID: 'task-42', TASK_WORKTREE: '' },
    });
    assert.match(withEditor.stdout, /permissionDecision.*deny/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
