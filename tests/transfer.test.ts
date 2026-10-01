import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'tb-transfer-test-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-transfer-test-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ name: 'transfer-test', controller: { autostart: false }, permissions: { trustWorkspaces: false } }));
const bin = join(root, 'bin'); mkdirSync(bin);
for (const name of ['claude', 'codex', 'agy']) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nif [ "${name}" = claude ] && [ "$1" = auth ]; then echo '{"loggedIn":true}'; elif [ "${name}" = agy ] && [ "$1" = models ]; then printf 'test\\tmodel\\n'; elif [ "${name}" = codex ] && [ "$1" = login ]; then echo 'Logged in'; else sleep 30; fi\n`);
  chmodSync(path, 0o755);
}
process.env.PATH = `${bin}:${process.env.PATH}`;
const store = await import('../server/store.ts');
const { taskFiles, workspaceFiles, verifyFile, targetCheck, stage, start, cancel, peer, signedRequest } = await import('../server/transfer.ts');

const project = join(root, 'project'); mkdirSync(project);
execFileSync('git', ['init', project], { stdio: 'ignore' });
writeFileSync(join(project, 'tracked.txt'), 'before\n');
execFileSync('git', ['-C', project, 'add', '.']);
execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture'], { stdio: 'ignore' });
writeFileSync(join(project, 'tracked.txt'), 'after\n');
writeFileSync(join(project, 'new.txt'), 'new work\n');
writeFileSync(join(project, '.env'), 'PASSWORD=abcdefghijklmnop\n');
writeFileSync(join(project, 'secret.txt'), 'api_key = abcdefghijklmnop\n');
const task = store.create({ id: 'transfer-fixture', num: 1, title: 'Transfer fixture', agent: 'codex', status: 'idle',
  cwd: project, folder: project, session: 'task-1', desc: 'Continue the fixture.' });
mkdirSync(join(store.taskDir(task.id), 'outbox'));
writeFileSync(join(store.taskDir(task.id), 'outbox', 'result.md'), 'Result.\n');
writeFileSync(join(store.taskDir(task.id), 'outbox', '.env'), 'PASSWORD=abcdefghijklmnop\n');

test('the file lists omit secrets and include changed work', async () => {
  const workspace = await workspaceFiles(task);
  assert.deepEqual(workspace.files.map(f => f.path).sort(), ['new.txt', 'tracked.txt']);
  assert.ok(workspace.omitted.some(x => x.startsWith('.env:')));
  assert.ok(workspace.omitted.some(x => x.startsWith('secret.txt:')));
  const files = taskFiles(task);
  assert.ok(files.files.some(f => f.path === 'log.md'));
  assert.ok(files.files.some(f => f.path === 'outbox/result.md'));
  assert.ok(files.omitted.some(x => x.startsWith('outbox/.env:')));
});

test('the target rejects paths that escape or follow a symbolic link', () => {
  const dest = join(root, 'dest'); mkdirSync(dest);
  const make = (path: string) => ({ path, size: 4, hash: '0'.repeat(64), data: Buffer.from('data').toString('base64') });
  assert.throws(() => verifyFile(make('../outside'), dest), /Unsafe transfer file path/);
  assert.throws(() => verifyFile(make('.env'), dest), /Unsafe transfer file path/);
  symlinkSync(root, join(dest, 'link'));
  assert.throws(() => verifyFile(make('link/outside.txt'), dest), /symbolic link/);
});

test('a transfer request needs a signature from a paired machine', async () => {
  const machines = await import('../server/machines.ts');
  const { TOKEN } = await import('../server/config.ts');
  const paired = machines.add('Paired source', 'http://127.0.0.1:9', TOKEN);
  const path = '/api/transfer/check', request = signedRequest(path, { folder: '/tmp/target' });
  const fake = (signature: string) => ({ originalUrl: path, body: request.payload,
    get: (name: string) => ({ 'x-taskboard-token': TOKEN, 'x-taskboard-peer-signature': signature } as Record<string, string>)[name.toLowerCase()] }) as Parameters<typeof peer>[0];
  assert.equal(peer(fake(request.headers['x-taskboard-peer-signature'])).id, paired.id);
  assert.throws(() => peer(fake('0'.repeat(64))), /not paired/);
  machines.remove(paired.id);
});

test('staging checks the target and cancel removes only the staged task', async () => {
  const target = join(root, 'target');
  execFileSync('git', ['clone', '--local', project, target], { stdio: 'ignore' });
  const check = await targetCheck(target);
  const source = { id: 'source-task', num: 8, title: 'Source task', desc: 'Continue the work.', agent: 'codex' as const,
    branch: check.git.branch, head: check.git.head, remote: check.git.remote };
  const machine = { id: 'source', name: 'Source', url: 'https://source.example.invalid', token: 'test' };
  const input = { transferId: '12345678-1234-1234-1234-123456789abc', folder: target, handoffOnly: false, source, account: 'codex-default',
    files: [], workspace: [], groups: ['Transfer tests'] };
  const made = await stage(input, machine);
  assert.equal(made.state, 'staged');
  assert.ok(store.get(made.id));
  assert.equal((await stage(input, machine)).id, made.id);
  assert.ok(existsSync(join(store.taskDir(made.id), 'handoffs', `transfer-${input.transferId}.md`)));
  assert.deepEqual(await cancel(input.transferId, machine), { canceled: true });
  assert.equal(store.get(made.id), undefined);
  assert.deepEqual(await cancel(input.transferId, machine), { canceled: true });
});

test('the target starts one staged task from its handoff', async () => {
  const target = join(root, 'target');
  const check = await targetCheck(target);
  const transferId = 'aaaaaaaa-1234-1234-1234-123456789abc';
  const source = { id: 'source-claude', num: 9, title: 'Source Claude', desc: 'Continue from this handoff.', agent: 'claude' as const,
    branch: check.git.branch, head: check.git.head, remote: check.git.remote };
  const machine = { id: 'source', name: 'Source', url: 'https://source.example.invalid', token: 'test' };
  const made = await stage({ transferId, folder: target, handoffOnly: false, source, account: 'claude-default', files: [], workspace: [], groups: [] }, machine);
  try {
    const result = await start(transferId);
    assert.equal(result.state, 'started');
    assert.equal((await start(transferId)).id, made.id);
    assert.equal(store.get(made.id)?.transfer?.state, 'started');
  } finally {
    try { execFileSync('tmux', ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-session', '-t', `=task-${made.num}`], { stdio: 'ignore' }); } catch { /* already ended */ }
  }
});

test('a handoff can start from a folder without Git', async () => {
  const folder = join(root, 'plain-folder'); mkdirSync(folder);
  const check = await targetCheck(folder);
  assert.equal(check.git.head, '');
  const transferId = 'bbbbbbbb-1234-1234-1234-123456789abc';
  const machine = { id: 'source', name: 'Source', url: 'https://source.example.invalid', token: 'test' };
  const made = await stage({ transferId, folder, handoffOnly: true, source: { id: 'plain-source', num: 10,
    title: 'Plain folder', desc: 'Continue here.', agent: 'claude', head: 'another-commit', remote: 'another-remote' },
    account: 'claude-default', files: [], workspace: [], groups: [] }, machine);
  try { assert.equal((await start(transferId)).state, 'started'); }
  finally { try { execFileSync('tmux', ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-session', '-t', `=task-${made.num}`], { stdio: 'ignore' }); } catch { /* already ended */ } }
});

test('cancel removes a staged worktree from a Git bundle', async () => {
  const target = join(root, 'target'), check = await targetCheck(target);
  execFileSync('git', ['-C', project, 'add', 'tracked.txt', 'new.txt']);
  execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Local work'], { stdio: 'ignore' });
  const head = execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const file = join(root, 'commits.bundle');
  execFileSync('git', ['-C', project, 'bundle', 'create', file, 'HEAD', `^${check.git.head}`], { stdio: 'ignore' });
  const bytes = readFileSync(file);
  const transferId = 'cccccccc-1234-1234-1234-123456789abc';
  const machine = { id: 'source', name: 'Source', url: 'https://source.example.invalid', token: 'test' };
  const made = await stage({ transferId, folder: target, handoffOnly: false, source: { id: 'bundle-source', num: 11,
    title: 'Bundle source', desc: 'Keep the commit.', agent: 'claude', branch: check.git.branch, head, remote: check.git.remote },
    account: 'claude-default', files: [], workspace: [], groups: [], bundle: { size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'), base: check.git.head, data: bytes.toString('base64') } }, machine);
  const staged = store.get(made.id)!;
  assert.equal(staged.transfer?.worktreeCreated, true);
  assert.ok(existsSync(join(staged.cwd, 'new.txt')));
  assert.deepEqual(await cancel(transferId, machine), { canceled: true });
  assert.equal(existsSync(staged.cwd), false);
  assert.equal(store.get(made.id), undefined);
});
