import { TestResources } from './helpers/test-resources.ts';
const resources = new TestResources();
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { waitFor } from './helpers/wait-for.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-workspace-trust-')));
process.env.HOME = join(root, 'home');
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = resources.socket(`tb-trust-${process.pid}`);
delete process.env.CLAUDE_CONFIG_DIR;
const dirs = { work: join(root, 'work'), other: join(root, 'other'), legacy: join(root, 'legacy') };
for (const dir of [process.env.HOME, join(process.env.HOME, '.claude'), process.env.TASKBOARD_DIR, ...Object.values(dirs)]) mkdirSync(dir, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'accounts.json'), JSON.stringify(Object.entries(dirs).map(([id, dir]) => ({ id, dir, agent: 'claude', name: id, maxParallel: 100, created: new Date().toISOString() }))));
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false, accounts: { claude: 'work' } }, permissions: { trustWorkspaces: true, autoReview: false }, browser: { claude: 'off' } }));
const bin = join(root, 'bin'); mkdirSync(bin);
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs'), p = require('node:path');
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const dir = process.env.CLAUDE_CONFIG_DIR;
const current = p.join(dir || process.env.HOME, '.claude.json');
const legacy = p.join(dir || p.join(process.env.HOME, '.claude'), '.config.json');
const file = fs.existsSync(legacy) ? legacy : current;
fs.writeFileSync(p.join(process.env.TASK_DIR, 'launch.json'), JSON.stringify({ file, config: JSON.parse(fs.readFileSync(file)), args: process.argv.slice(2), cwd: process.cwd() }));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const { trust, restore } = await import('../server/trust.ts');
const agents = await import('../server/agents.ts');
const store = await import('../server/store.ts');
const machine = await import('../server/machine.ts');
const tmux = await import('../server/tmux.ts');
const config = (account = 'work') => account === 'default' ? join(process.env.HOME!, '.claude.json') : join(dirs[account as keyof typeof dirs], '.claude.json');
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
let count = 0;
function task(account = 'work', cwd?: string) {
  const num = ++count;
  cwd ??= join(root, `folder-${num}`); mkdirSync(cwd, { recursive: true });
  return store.create({ id: `trust-${num}`, num, title: 'Trust test', agent: 'claude', account: account === 'default' ? 'claude-default' : account, status: 'suspended', cwd, folder: cwd, session: `trust-${num}`, sessionId: `session-${num}`, desc: '' });
}
after(async () => { await resources.stop(); rmSync(root, { recursive: true, force: true }); });

test('Claude trust changes only the resolved task folder in the selected account', async () => {
  const cwd = join(root, 'actual'); mkdirSync(cwd);
  const alias = join(root, 'alias'); symlinkSync(cwd, alias);
  const before = { theme: 'dark', permissions: { deny: ['Bash(rm:*)'] }, projects: { [cwd]: { hasTrustDialogAccepted: false, allowedTools: ['Read'], history: [1] }, '/unrelated': { hasTrustDialogAccepted: false } } };
  writeFileSync(config(), JSON.stringify(before));
  writeFileSync(config('other'), '{"theme":"light"}');
  await trust(task('work', alias));
  const expected = structuredClone(before); expected.projects[cwd].hasTrustDialogAccepted = true;
  assert.deepEqual(read(config()), expected);
  assert.equal(readFileSync(config('other'), 'utf8'), '{"theme":"light"}');
  assert.equal(existsSync(config('default')), false);
  assert.equal(statSync(config()).mode & 0o777, 0o600);
  const journal = read(join(process.env.TASKBOARD_DIR!, 'trust-changes.json'));
  await trust(task('work', alias));
  assert.deepEqual(read(join(process.env.TASKBOARD_DIR!, 'trust-changes.json')), journal);
  await restore();
  assert.deepEqual(read(config()), before);
});

test('default, inherited configuration directory, and legacy files use their own account', async () => {
  const t = task('default'); await trust(t);
  assert.equal(read(config('default')).projects[t.cwd].hasTrustDialogAccepted, true);
  process.env.CLAUDE_CONFIG_DIR = dirs.other;
  try {
    const inherited = task('default'); await trust(inherited);
    assert.equal(read(config('other')).projects[inherited.cwd].hasTrustDialogAccepted, true);
    assert.equal(read(config('default')).projects[inherited.cwd], undefined);
    const named = task(); await trust(named);
    assert.equal(read(config()).projects[named.cwd].hasTrustDialogAccepted, true);
    assert.equal(read(config('other')).projects[named.cwd], undefined);
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
  const legacy = join(dirs.legacy, '.config.json');
  writeFileSync(legacy, '{"theme":"legacy"}'); writeFileSync(config('legacy'), '{"theme":"unused"}');
  const old = task('legacy'); await trust(old);
  assert.equal(read(legacy).projects[old.cwd].hasTrustDialogAccepted, true);
  assert.equal(readFileSync(config('legacy'), 'utf8'), '{"theme":"unused"}');
});

test('trust waits for a Claude save and then preserves its newer settings', async () => {
  const file = config(), t = task(); mkdirSync(`${file}.lock`);
  const pending = trust(t);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read(file).projects[t.cwd], undefined);
  writeFileSync(file, JSON.stringify({ theme: 'newer', projects: { '/another-task': { hasTrustDialogAccepted: true } } }));
  rmdirSync(`${file}.lock`);
  await pending;
  assert.equal(read(file).theme, 'newer');
  assert.equal(read(file).projects['/another-task'].hasTrustDialogAccepted, true);
  assert.equal(read(file).projects[t.cwd].hasTrustDialogAccepted, true);
  assert.equal(existsSync(`${file}.lock`), false);
});

test('parallel starts retain every folder and restoration retains later edits', async () => {
  const tasks = Array.from({ length: 8 }, () => task());
  await Promise.all(tasks.map(t => trust(t)));
  const cfg = read(config());
  for (const t of tasks) assert.equal(cfg.projects[t.cwd].hasTrustDialogAccepted, true);
  cfg.theme = 'later'; cfg.projects[tasks[0].cwd].hasTrustDialogAccepted = false;
  writeFileSync(config(), JSON.stringify(cfg));
  await restore();
  const restored = read(config());
  assert.equal(restored.theme, 'later');
  assert.equal(restored.projects[tasks[0].cwd].hasTrustDialogAccepted, false);
  for (const t of tasks.slice(1)) assert.equal(restored.projects[t.cwd].hasTrustDialogAccepted, undefined);
});

test('a restore between task starts does not drop the later trust record', async () => {
  const first = task(), second = task(), file = config(); mkdirSync(`${file}.lock`);
  const start = trust(first);
  const undo = restore();
  const later = trust(second);
  rmdirSync(`${file}.lock`);
  await Promise.all([start, undo, later]);
  assert.equal(read(file).projects[first.cwd].hasTrustDialogAccepted, undefined);
  assert.equal(read(file).projects[second.cwd].hasTrustDialogAccepted, true);
  await restore();
  assert.equal(read(file).projects[second.cwd].hasTrustDialogAccepted, undefined);
});

test('invalid configuration stays unchanged and trust releases the lock', async () => {
  for (const body of ['{broken', '[]', '{"projects":[]}', '{"projects":{"/bad":[]}}', '{"projects":{"/bad":{"hasTrustDialogAccepted":"false"}}}']) {
    const t = task();
    // Use a scratch path in the file while keeping the malformed entry under test.
    t.cwd = join(root, 'bad'); mkdirSync(t.cwd, { recursive: true });
    const input = body.replaceAll('/bad', t.cwd);
    writeFileSync(config(), input);
    await assert.rejects(trust(t));
    assert.equal(readFileSync(config(), 'utf8'), input);
    assert.equal(existsSync(`${config()}.lock`), false);
  }
  writeFileSync(config(), '{}');
});

test('a held lock aborts trust without changing the configuration', async () => {
  const file = config(), before = readFileSync(file, 'utf8'); mkdirSync(`${file}.lock`);
  try { await assert.rejects(trust(task()), /is still held/); }
  finally { rmdirSync(`${file}.lock`); }
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('new tasks, resumed tasks, and the controller trust their folder before Claude starts', async () => {
  const folder = join(root, 'launch-folder'); mkdirSync(folder);
  const first = await agents.startTask({ title: 'Trust launch', desc: 'Test', agent: 'claude', account: 'work', folder, worktree: false });
  const check = async (t: typeof first, resume: boolean) => {
    const output = join(store.taskDir(t.id), 'launch.json');
    await waitFor(() => existsSync(output), { description: 'the stand-in Claude to record its launch' });
    const launched = read(output);
    assert.equal(launched.file, config());
    assert.equal(launched.config.projects[realpathSync(t.cwd)].hasTrustDialogAccepted, true);
    assert.equal(launched.args.includes('--resume'), resume);
    assert.equal(launched.args.includes('--dangerously-skip-permissions'), false);
    assert.ok(launched.args.includes('--permission-mode'));
    await tmux.killSession(t.session); rmSync(output);
  };
  await check(first, false);
  const resumed = store.update(first.id, { transcript: join(root, 'fixture.jsonl') })!;
  await agents.resumeTask(resumed); await check(resumed, true);
  const controller = await agents.startController(); await check(controller, false);
});

test('disabling workspace trust leaves the task folder untrusted', async () => {
  machine.update({ trustWorkspaces: false });
  const t = task();
  try {
    await agents.resumeTask(t);
    const output = join(store.taskDir(t.id), 'launch.json');
    await waitFor(() => existsSync(output), { description: 'the stand-in Claude with trust disabled' });
    assert.equal(read(output).config.projects[t.cwd], undefined);
  } finally { await tmux.killSession(t.session); machine.update({ trustWorkspaces: true }); }
});

test('Codex and Antigravity already store trust in their selected account files', async () => {
  const t = task();
  mkdirSync(join(process.env.HOME!, '.codex'));
  const codex = join(process.env.HOME!, '.codex/config.toml'); writeFileSync(codex, 'approval_policy = "on-request"\n');
  await trust({ ...t, agent: 'codex', account: 'codex-default' });
  assert.match(readFileSync(codex, 'utf8'), /trust_level = "trusted"/);
  assert.match(readFileSync(codex, 'utf8'), /approval_policy = "on-request"/);
  const agy = join(process.env.HOME!, '.gemini/antigravity-cli'); mkdirSync(agy, { recursive: true });
  writeFileSync(join(agy, 'settings.json'), '{"sandbox":true}');
  await trust({ ...t, agent: 'antigravity', account: 'antigravity-default' });
  assert.deepEqual(read(join(agy, 'settings.json')), { sandbox: true, trustedWorkspaces: [t.cwd] });
});
