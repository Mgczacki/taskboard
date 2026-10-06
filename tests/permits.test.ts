import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'tb-permits-'));
process.env.TASKBOARD_DIR = join(root, 'tbdir');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_PORT = '4399';
const store = await import('../server/store.ts');
const { taskDir } = store;
const { GUARD_SCRIPT } = await import('../server/config.ts');
const permits = await import('../server/permits.ts');
const machine = await import('../server/machine.ts');
type Task = import('../server/store.ts').Task;
mkdirSync(join(root, 'work'), { recursive: true });
mkdirSync(join(root, 'tbdir', 'hooks'), { recursive: true });
copyFileSync(fileURLToPath(new URL('../server/hooks/guard.mjs', import.meta.url)), GUARD_SCRIPT);
const freshTask = (id: string) => { mkdirSync(taskDir(id), { recursive: true }); return { id, num: 1, agent: 'codex', cwd: join(root, 'work'), folder: join(root, 'work'), role: undefined, worktree: false } as Task; };
after(() => rmSync(root, { recursive: true, force: true }));

test('rolling permit windows use the current setting and give the next request time', () => {
  const at = Date.parse('2026-10-06T12:00:00.000Z');
  const limits = { enabled: true, tenMinutes: 2, day: 4 };
  const times = [at - 600001, at - 590000, at - 1000].map(time => new Date(time).toISOString());
  assert.match(permits.requestLimitBlock(times, limits, at)!, /10 minutes \(2\/2\).*2026-10-06T12:00:10.000Z/);
  assert.equal(permits.requestLimitBlock(times, { ...limits, tenMinutes: 3 }, at), undefined);
  assert.equal(permits.requestLimitBlock(times, { ...limits, enabled: false }, at), undefined);
  const both = [...times, new Date(at - 3600000).toISOString()];
  assert.match(permits.requestLimitBlock(both, limits, at)!, /10 minutes \(2\/2\) and 24 hours \(4\/4\).*2026-10-07T11:00:00.000Z/);
  assert.equal(permits.requestLimitBlock(times, limits, at + 10000), undefined);
});

test('failed and denied permits count under changed settings; off still keeps the pending guard', async () => {
  const task = freshTask('configured-limits');
  machine.update({ permitRequestLimits: { enabled: true, tenMinutes: 2, day: 20 } });
  const failed = permits.request(task, 'Failure', [{ command: 'echo failed' }]);
  await permits.run(failed, task, 'user', '', '', async () => ({ code: 1, signal: null, output: '' }));
  const denied = permits.request(task, 'Denial', [{ command: 'echo denied' }]);
  permits.deny(denied, 'test');
  assert.throws(() => permits.request(task, 'Blocked', [{ command: 'pwd' }]), /10 minutes \(2\/2\).*next request can be made at/);
  machine.update({ permitRequestLimits: { tenMinutes: 3 } });
  const pending = permits.request(task, 'After change', [{ command: 'pwd' }]);
  assert.throws(() => permits.request(task, 'Pending', [{ command: 'pwd' }]), /already has a pending permit/);
  permits.deny(pending, 'test');
  machine.update({ permitRequestLimits: { enabled: false } });
  const unlimited = permits.request(task, 'Off', [{ command: 'pwd' }]);
  assert.equal(unlimited.state, 'pending');
  permits.deny(unlimited, 'test');
});

test('permit limit settings reject invalid values and keep defaults for old files', () => {
  assert.deepEqual(machine.readPermitRequestLimits(undefined), machine.DEFAULT_PERMIT_REQUEST_LIMITS);
  assert.deepEqual(machine.readPermitRequestLimits({ enabled: 'no', tenMinutes: 0, day: 20.5 }), machine.DEFAULT_PERMIT_REQUEST_LIMITS);
  assert.throws(() => machine.update({ permitRequestLimits: { tenMinutes: 0 } }), /whole numbers/);
  assert.throws(() => machine.update({ permitRequestLimits: { day: 1.5 } }), /whole numbers/);
});

test('a sequence runs each step once in order', async () => {
  const task = freshTask('success');
  const p = permits.request(task, 'Check the ordered run', ['echo A', 'echo B', 'echo C', 'echo D'].map(command => ({ command })));
  const seen: string[] = [];
  const result = await permits.run(p, task, 'user', '', '', async (_task, step) => { seen.push(step.command); return { code: 0, signal: null, output: step.command }; });
  assert.deepEqual(seen, ['echo A', 'echo B', 'echo C', 'echo D']);
  assert.equal(result.state, 'succeeded');
  assert.deepEqual(result.steps.map(s => s.state), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
  await permits.run(p, task, 'user', '', '', async () => { throw new Error('ran twice'); });
  assert.deepEqual(seen, ['echo A', 'echo B', 'echo C', 'echo D']);
});

test('a refused MCP tool cannot create a shell permit', () => {
  const task = freshTask('mcp');
  const refusal = { command: 'mcp__claude-in-chrome__browser_batch', toolName: 'mcp__claude-in-chrome__browser_batch' };
  assert.equal(permits.canPermitRefusal(task, refusal), false);
  assert.throws(() => permits.request(task, 'Run the refused tool', [{ command: refusal.command }]), /MCP tool call cannot run from a shell permit/);
  assert.equal(permits.canPermitRefusal(task, { command: 'echo allowed', toolName: 'Bash' }), true);
});

test('a signal failure names the signal and cancels later steps', async () => {
  const task = freshTask('abort');
  const p = permits.request(task, 'Check a child process signal', [{ command: 'echo first' }, { command: 'echo later' }]);
  await permits.run(p, task, 'user', '', '', async () => ({ code: null, signal: 'SIGABRT', output: '' }));
  assert.equal(p.error, 'Step 1 failed: signal SIGABRT');
  assert.deepEqual(p.steps.map(s => s.state), ['failed', 'cancelled']);
});

test('step 2 failure cancels steps 3 and 4', async () => {
  const task = freshTask('failure');
  const p = permits.request(task, 'Check failure', ['echo 1', 'echo 2', 'echo 3', 'echo 4'].map(command => ({ command })));
  const seen: string[] = [];
  await permits.run(p, task, 'user', '', '', async (_task, step) => { seen.push(step.command); return { code: step.command === 'echo 2' ? 2 : 0, signal: null, output: 'output' }; });
  assert.deepEqual(seen, ['echo 1', 'echo 2']);
  assert.deepEqual(p.steps.map(s => s.state), ['succeeded', 'failed', 'cancelled', 'cancelled']);
});

test('paths, expiry, and controller limits stop a request', async () => {
  const task = freshTask('limits');
  assert.throws(() => permits.request(task, 'Wrong folder', [{ command: 'pwd', cwd: root }]), /protected Taskboard files/);
  const expired = permits.request(task, 'Too late', [{ command: 'pwd' }]);
  expired.expiresAt = new Date(Date.now() - 1000).toISOString();
  let ran = false;
  await permits.run(expired, task, 'user', '', '', async () => { ran = true; return { code: 0, signal: null, output: '' }; });
  assert.equal(ran, false); assert.equal(expired.state, 'expired');
  const low = permits.request(task, 'Read a path', [{ command: 'pwd' }]);
  assert.equal(permits.controllerAllowed(low, task, false), false);
  assert.equal(permits.controllerAllowed(low, task, true), true);
  permits.deny(low, 'test');
  const network = permits.request(task, 'Network', [{ command: 'pwd', network: true }]);
  assert.equal(permits.controllerAllowed(network, task, true), false);
  permits.deny(network, 'test');
});

test('the guard blocks a server process command and cancels later steps', async () => {
  const task = freshTask('guard');
  writeFileSync(join(root, 'tbdir', 'server.pid'), JSON.stringify({ pid: 123456 }));
  const p = permits.request(task, 'Check guard', [{ command: 'kill 123456' }, { command: 'echo later' }]);
  let ran = false;
  await permits.run(p, task, 'user', '', '', async () => { ran = true; return { code: 0, signal: null, output: '' }; });
  assert.equal(ran, false);
  assert.deepEqual(p.steps.map(s => s.state), ['failed', 'cancelled']);
});

test('a changed script does not run', async () => {
  const task = freshTask('script');
  const script = join(task.cwd, 'permit-test.sh');
  writeFileSync(script, 'echo first\n');
  const p = permits.request(task, 'Run a script', [{ command: 'bash permit-test.sh' }]);
  writeFileSync(script, 'echo changed\n');
  let ran = false;
  await permits.run(p, task, 'user', '', '', async () => { ran = true; return { code: 0, signal: null, output: '' }; });
  assert.equal(ran, false);
  assert.equal(p.state, 'failed');
  assert.deepEqual(p.steps.map(s => s.state), ['cancelled']);
});

test('a restart marks a running record unknown without retrying it', () => {
  const task = freshTask('restart');
  const p = permits.request(task, 'Check restart', [{ command: 'pwd' }]);
  p.state = 'running';
  writeFileSync(join(root, 'tbdir', 'permits', p.id + '.json'), JSON.stringify(p));
  permits.load();
  assert.equal(permits.get(p.id)?.state, 'unknown');
});

test('the normal shell can signal a process after approval', async () => {
  const task = freshTask('signal');
  const { spawn } = await import('node:child_process');
  const child = spawn('sleep', ['30']);
  const stopped = new Promise(resolve => child.once('close', resolve));
  assert.ok(child.pid);
  const p = permits.request(task, 'Stop this test process', [{ command: `kill -TERM ${child.pid}` }]);
  await permits.run(p, task, 'user');
  assert.equal(p.state, 'succeeded');
  assert.equal(p.steps[0].exitCode, 0);
  await stopped;
});

test('a changed command fails its hash check', async () => {
  const task = freshTask('hash');
  const p = permits.request(task, 'Check text', [{ command: 'echo first' }]);
  p.steps[0].command = 'echo second';
  let ran = false;
  await permits.run(p, task, 'user', '', '', async () => { ran = true; return { code: 0, signal: null, output: '' }; });
  assert.equal(ran, false);
  assert.match(p.error || '', /approved steps changed/);
});

test('a denial keeps the comment in the wake-up text', () => {
  const task = freshTask('deny');
  const p = permits.request(task, 'Check denial', [{ command: 'pwd' }]);
  permits.deny(p, 'Use the task folder.');
  assert.equal(p.decisionComment, 'Use the task folder.');
  assert.match(permits.notice(p), /User comment: Use the task folder/);
});

test('a high-risk controller approval needs the user message in its chat', () => {
  const task = freshTask('controller');
  const p = permits.request(task, 'Send a signal', [{ command: 'kill -0 999999' }]);
  assert.equal(p.riskClass, 'high');
  const transcript = join(root, 'controller.jsonl');
  const words = `Approve ${p.steps[0].command}`;
  assert.equal(permits.explicitControllerRequest(transcript, 'claude', words, p), false);
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: words } }) + '\n');
  assert.equal(permits.explicitControllerRequest(transcript, 'claude', words, p), false);
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: words } }) + '\n');
  assert.equal(permits.explicitControllerRequest(transcript, 'claude', words, p), true);
});

test('a task branch git command is low risk only in its worktree', () => {
  const task = { ...freshTask('git-rule'), worktree: true, branch: 'task/test' };
  const p = permits.request(task, 'Save task changes', [{ command: 'git add -A' }]);
  assert.equal(p.riskClass, 'low');
  assert.equal(permits.controllerRule(p, task, true), 'low-risk commands');
  permits.deny(p, 'test');
  const other = join(root, 'other-folder');
  mkdirSync(other, { recursive: true });
  assert.throws(() => permits.request(task, 'Change another folder', [{ command: 'git add -A', cwd: other }]), /own worktree branch/);
});

test('a shared checkout merge sequence needs a user or explicit high-risk approval', () => {
  const shared = join(root, 'shared-checkout');
  mkdirSync(shared, { recursive: true });
  const task = { ...freshTask('shared-merge'), worktree: true, branch: 'task/test', folder: shared };
  const p = permits.request(task, 'Finish the merge', [
    { command: 'git merge --abort', cwd: shared },
    { command: 'git merge task/test', cwd: shared },
  ]);
  assert.equal(p.riskClass, 'high');
  assert.equal(permits.controllerRule(p, task, true), undefined);
  permits.deny(p, 'test');
});

test('a safe step can run when the task folder contains another task worktree', () => {
  const parent = join(root, 'shared-parent');
  const safe = join(parent, 'safe');
  const other = join(parent, 'other');
  mkdirSync(safe, { recursive: true });
  mkdirSync(other, { recursive: true });
  store.create({ ...freshTask('other-worktree'), num: 2, title: 'Other', status: 'idle', cwd: other, folder: parent, worktree: true, branch: 'task/other', session: 'other', desc: '' });
  const task = { ...freshTask('parent-task'), cwd: parent, folder: parent };
  const p = permits.request(task, 'Read from a safe folder', [{ command: 'pwd', cwd: safe }]);
  assert.equal(p.steps[0].cwd, realpathSync(safe));
  permits.deny(p, 'test');
  assert.equal(permits.canPermitRefusal(task, { command: 'pwd', cwd: safe, toolName: 'Bash' }), true);
  writeFileSync(join(safe, 'read.sh'), 'echo safe\n');
  assert.ok(permits.validate(task, [{ command: 'bash read.sh', cwd: safe }]).steps[0].scriptHash);
  const production = permits.request(task, 'Read G3 ECS data', [{ command: 'aws ecs describe-tasks --cluster prod', cwd: safe, network: true }]);
  assert.equal(production.riskClass, 'high');
  assert.equal(permits.controllerRule(production, task, true), undefined);
  permits.deny(production, 'test');

  assert.throws(() => permits.validate(task, [{ command: 'pwd' }]), /working directory overlaps another task worktree/);
  assert.throws(() => permits.validate(task, [{ command: 'pwd', cwd: other }]), /working directory overlaps another task worktree/);
  assert.throws(() => permits.validate(task, [{ command: `cat ${join(other, 'data')}`, cwd: safe }]), /command accesses another task worktree/);
  assert.throws(() => permits.validate(task, [{ command: `cat --file=${join(other, 'data')}`, cwd: safe }]), /command accesses another task worktree/);
  symlinkSync(other, join(safe, 'link'));
  assert.throws(() => permits.validate(task, [{ command: 'cat link/data', cwd: safe }]), /command accesses another task worktree/);
  writeFileSync(join(other, 'read.sh'), 'echo other\n');
  assert.throws(() => permits.validate(task, [{ command: `bash ${join(other, 'read.sh')}`, cwd: safe }]), /command accesses another task worktree/);
  writeFileSync(join(safe, 'read.sh'), `cat ${join(other, 'data')}\n`);
  assert.throws(() => permits.validate(task, [{ command: 'bash read.sh', cwd: safe }]), /command accesses another task worktree/);
  assert.throws(() => permits.validate(task, [{ command: `bash -c 'cat ${join(other, 'data')}'`, cwd: safe }]), /Put interpreter code in a script file/);
});

test('quoted shell syntax stays a literal argument', async () => {
  const task = freshTask('literal');
  const p = permits.request(task, 'Check quoted text', [{ command: "echo 'one; echo two'" }]);
  await permits.run(p, task, 'user');
  assert.equal(p.state, 'succeeded');
  assert.equal(p.steps[0].outputTail?.trim(), 'one; echo two');
});
