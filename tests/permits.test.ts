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
const approvals = await import('../server/approvals.ts');
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

test('a permit cannot run another Taskboard command', () => {
  const task = freshTask('nested-tb');
  assert.throws(() => permits.request(task, 'Nested command', [{ command: 'tb run job -- echo hello' }]), /cannot run another Taskboard command/);
  assert.throws(() => permits.requestSupervised(task, 'job', 'Nested command', 'tb run job', task.cwd, false, 'Starts a process.'), /cannot run another Taskboard command/);
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

test('a supervised script starts once only after user approval and keeps its exit result', async () => {
  const task = freshTask('supervised-success');
  writeFileSync(join(task.cwd, 'supervised-success.sh'), 'echo approved\n');
  const p = permits.requestSupervised(task, 'dev-check', 'Run one script', 'bash supervised-success.sh', task.cwd, true, 'Dev resources change for this run.');
  const starts: string[] = [];
  const start = (async (_owner: unknown, input: { command: string }) => { starts.push(input.command); return {} as any; }) as any;
  await assert.rejects(permits.runSupervised(p, task, start), /not approved/);
  const card = approvals.request({ actor: task.id, action: 'permit', summary: p.id, detail: p.steps[0].command, payload: { permitId: p.id } }, async () => {
    await permits.runSupervised(p, task, start); return 'Started.';
  });
  permits.attachApproval(p, card.id);
  await approvals.decide(card.id, true, { by: 'user' });
  assert.equal(starts.length, 1);
  assert.equal(p.state, 'running');
  await permits.runSupervised(p, task, start);
  assert.equal(starts.length, 1);
  permits.syncSupervised(p, { state: 'exited', exitCode: 0, ended: new Date().toISOString() } as any, 'approved\n');
  assert.equal(p.state, 'succeeded');
  assert.equal(p.steps[0].exitCode, 0);
  assert.equal(p.steps[0].outputTail, 'approved\n');
});

test('denial, expiry, and a changed script never start a supervised process', async () => {
  const task = freshTask('supervised-denied');
  const script = join(task.cwd, 'supervised-denied.sh');
  writeFileSync(script, 'echo original\n');
  const denied = permits.requestSupervised(task, 'denied', 'Check denial', 'bash supervised-denied.sh', task.cwd, false, 'No network.');
  permits.deny(denied, 'No');
  assert.equal(denied.state, 'denied');
  const expired = permits.requestSupervised(task, 'expired', 'Check expiry', 'bash supervised-denied.sh', task.cwd, false, 'No network.');
  expired.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(permits.expire(expired), true);
  assert.equal(expired.state, 'expired');
  const changed = permits.requestSupervised(task, 'changed', 'Check hash', 'bash supervised-denied.sh', task.cwd, false, 'No network.');
  writeFileSync(script, 'echo changed\n');
  const card = approvals.request({ actor: task.id, action: 'permit', summary: changed.id, detail: changed.steps[0].command, payload: { permitId: changed.id } }, async () => {
    await permits.runSupervised(changed, task, (async () => { throw new Error('started'); }) as any);
    if (changed.state !== 'running') throw new Error(changed.error);
    return 'Started.';
  });
  permits.attachApproval(changed, card.id);
  await approvals.decide(card.id, true, { by: 'user' });
  assert.equal(changed.state, 'failed');
  assert.match(changed.error || '', /changed/);
});

test('an approved run reports interruption without starting again after load', () => {
  const task = freshTask('supervised-recovery');
  writeFileSync(join(task.cwd, 'supervised-recovery.sh'), 'echo recovery\n');
  const p = permits.requestSupervised(task, 'recovery', 'Check recovery', 'bash supervised-recovery.sh', task.cwd, false, 'No network.');
  p.state = 'running';
  p.startedAt = new Date(Date.now() - 30_000).toISOString();
  writeFileSync(join(root, 'tbdir', 'permits', p.id + '.json'), JSON.stringify(p));
  permits.load();
  assert.equal(permits.get(p.id)?.state, 'running');
  permits.syncSupervised(p);
  assert.equal(p.state, 'unknown');
});

test('a stopped approved run reports cancellation and a lost window needs inspection', () => {
  const task = freshTask('supervised-stop');
  writeFileSync(join(task.cwd, 'supervised-stop.sh'), 'echo stop\n');
  const cancelled = permits.requestSupervised(task, 'cancel', 'Check stop', 'bash supervised-stop.sh', task.cwd, false, 'No network.');
  cancelled.state = 'running';
  permits.syncSupervised(cancelled, { state: 'stopped', stopNote: 'Stopped by the user.', ended: new Date().toISOString() } as any);
  assert.equal(cancelled.state, 'cancelled');
  const lost = permits.requestSupervised(task, 'lost', 'Check loss', 'bash supervised-stop.sh', task.cwd, false, 'No network.');
  lost.state = 'running';
  permits.syncSupervised(lost, { state: 'stopped', stopNote: 'Its tmux window is gone.', ended: new Date().toISOString() } as any);
  assert.equal(lost.state, 'unknown');
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


test('named environment settings leave the command and enter the exact approval hash', async () => {
  const task = freshTask('environment');
  const p = permits.request(task, 'Review nonsecret settings', [{ command: 'env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR=/tmp/gh-test echo checked' }]);
  assert.deepEqual(p.steps[0].argv, ['echo', 'checked']);
  assert.deepEqual(p.steps[0].env, { GH_CONFIG_DIR: '/tmp/gh-test' });
  assert.deepEqual(p.steps[0].unsetEnv, ['GH_TOKEN', 'GITHUB_TOKEN']);
  assert.equal(p.steps[0].reviewRule, 'environment-values-in-command');
  assert.ok(!p.steps[0].command.includes('GH_CONFIG_DIR'));
  assert.ok(p.expiresAt);
  assert.equal(permits.controllerAllowed(p, task, false), false);
  assert.equal(permits.controllerAllowed(p, task, true), true);
  p.steps[0].env!.GH_CONFIG_DIR = '/tmp/changed';
  let ran = false;
  await permits.run(p, task, 'user', '', '', async () => { ran = true; return { code: 0, signal: null, output: '' }; });
  assert.equal(ran, false);
  assert.match(p.error || '', /approved steps changed/);
});

test('only supported nonsecret settings can enter a record', () => {
  const task = freshTask('environment-secrets');
  for (const env of [{ GH_TOKEN: 'do-not-store-this' }, { PATH: '/tmp/bin' }, { NODE_OPTIONS: '--require evil' }, { TASKBOARD_DIR: '/tmp/tbdir' }]) {
    assert.throws(() => permits.request(task, 'Unsupported setting', [{ command: 'pwd', env }]), e => {
      assert.ok(!String(e).includes('do-not-store-this'));
      return /Only GH_CONFIG_DIR/.test(String(e));
    });
  }
  assert.throws(() => permits.validate(task, [{ command: 'env GH_TOKEN=do-not-store-this pwd' }]), /Only GH_CONFIG_DIR/);
  assert.throws(() => permits.validate(task, [{ command: 'env -S "sh -c echo"' }]), /one executable/);
  assert.throws(() => permits.validate(task, [{ command: 'env GH_CONFIG_DIR=/tmp/gh sh -c "echo x"' }]), /Put interpreter code/);
  assert.throws(() => permits.validate(task, [{ command: 'pwd', env: { GH_CONFIG_DIR: 'relative' } }]), /absolute nonsecret path/);
  assert.throws(() => permits.validate(task, [{ command: 'pwd', env: { GH_CONFIG_DIR: '/tmp/ghp_abcdefghijklmnop' } }]), /absolute nonsecret path/);
  assert.throws(() => permits.validate(task, [{ command: 'pwd', unsetEnv: ['TASK_ID'] }]), /Only GH_TOKEN/);
  assert.throws(() => permits.validate(task, [{ command: 'env GH_CONFIG_DIR=/tmp/gh pnpm release' }]), /release or rollback/);
  assert.throws(() => permits.validate(task, [{ command: 'env GH_CONFIG_DIR=/tmp/gh cat .env' }]), /credential file/);
  assert.throws(() => permits.validate(task, [{ command: 'pwd', env: { GH_CONFIG_DIR: process.env.TASKBOARD_DIR! } }]), /protected Taskboard/);
  assert.equal(permits.all().some(p => p.taskId === task.id), false);
});

test('execution receives approved settings and removes only the named inherited variables', async () => {
  const task = freshTask('environment-run');
  writeFileSync(join(task.cwd, 'environment-check.mjs'), 'console.log(process.env.GH_CONFIG_DIR, process.env.GH_TOKEN ? "present" : "absent", process.env.GITHUB_TOKEN ? "present" : "absent");\n');
  const p = permits.request(task, 'Check the child environment', [{ command: 'node environment-check.mjs', env: { GH_CONFIG_DIR: '/tmp/approved' }, unsetEnv: ['GH_TOKEN', 'GITHUB_TOKEN'] }]);
  const env = permits.stepEnvironment(p.steps[0], { GH_TOKEN: 'inherited', GITHUB_TOKEN: 'inherited', TASK_ID: task.id });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.TASK_ID, task.id);
  await permits.run(p, task, 'user');
  assert.equal(p.state, 'succeeded');
  assert.equal(p.steps[0].outputTail?.trim(), `${realpathSync('/tmp')}/approved absent absent`);
  await permits.run(p, task, 'user', '', '', async () => { throw new Error('ran twice'); });
  assert.equal(p.state, 'succeeded');
});

test('approved settings cannot change between steps and the guard still checks env commands', async () => {
  const task = freshTask('environment-between-steps');
  const p = permits.request(task, 'Check each step', [{ command: 'echo first' }, { command: 'echo second', env: { GH_CONFIG_DIR: '/tmp/approved' } }]);
  let count = 0;
  await permits.run(p, task, 'user', '', '', async () => {
    count++;
    p.steps[1].env!.GH_CONFIG_DIR = '/tmp/changed';
    return { code: 0, signal: null, output: '' };
  });
  assert.equal(count, 1);
  assert.equal(p.state, 'failed');
  assert.match(p.steps[1].error || '', /settings.*changed after approval/);
  writeFileSync(join(root, 'tbdir', 'server.pid'), JSON.stringify({ pid: 123456 }));
  const guarded = permits.request(task, 'Check guard with settings', [{ command: 'env GH_CONFIG_DIR=/tmp/approved kill 123456' }]);
  await permits.run(guarded, task, 'user', '', '', async () => { throw new Error('guard let this run'); });
  assert.equal(guarded.state, 'failed');
  assert.match(guarded.steps[0].error || '', /running Taskboard server/);
});

test('directory rejection gives the actual rule, owner, resolved cwd and attached worktree correction', () => {
  const parent = join(root, 'diagnostic-parent');
  const attached = join(parent, 'attached');
  const other = join(parent, 'other');
  mkdirSync(attached, { recursive: true }); mkdirSync(other);
  store.create({ ...freshTask('diagnostic-other'), num: 216, title: 'Other', status: 'idle', cwd: other, folder: parent, worktree: true, branch: 'task/other', session: 'other', desc: '' });
  const task = { ...freshTask('diagnostic-task'), cwd: parent, folder: parent, scopes: [{ kind: 'worktree', name: 'attached', path: attached }] } as Task;
  assert.throws(() => permits.validate(task, [{ command: 'pwd' }]), e => {
    assert.ok(e instanceof permits.PermitValidationError);
    assert.equal(e.diagnostic.rule, 'cwd-overlaps-other-worktree');
    assert.equal(e.diagnostic.cwd, realpathSync(parent));
    assert.equal(e.diagnostic.conflictingWorktree, realpathSync(other));
    assert.match(e.diagnostic.conflictingTask, /task #216/);
    assert.ok(e.diagnostic.correction.includes(attached));
    assert.match(e.diagnostic.correction, /--cwd/);
    return true;
  });
  const p = permits.request(task, 'Read attached', [{ command: 'pwd', cwd: attached, env: { GH_CONFIG_DIR: '/tmp/gh' } }]);
  assert.equal(p.riskClass, 'low');
  assert.equal(permits.controllerAllowed(p, task, true), true);
  permits.deny(p, 'Done');
  assert.throws(() => permits.validate(task, [{ command: 'pwd', cwd: attached, env: { GH_CONFIG_DIR: other } }]), /accesses another task worktree/);
  symlinkSync(other, join(attached, 'config-link'));
  assert.throws(() => permits.validate(task, [{ command: 'pwd', cwd: attached, env: { GH_CONFIG_DIR: join(attached, 'config-link') } }]), /accesses another task worktree/);
});

test('a changed configuration symlink fails the exact hash and production paths stay high risk', async () => {
  const task = freshTask('config-symlink');
  const config = join(task.cwd, 'config');
  const changed = join(task.cwd, 'config-changed');
  const link = join(task.cwd, 'config-path');
  mkdirSync(config); mkdirSync(changed); symlinkSync(config, link);
  const p = permits.request(task, 'Check resolved settings', [{ command: 'pwd', env: { GH_CONFIG_DIR: link } }]);
  assert.equal(p.steps[0].envPaths!.GH_CONFIG_DIR, realpathSync(config));
  rmSync(link); symlinkSync(changed, link);
  let ran = false;
  await permits.run(p, task, 'user', '', '', async () => { ran = true; return { code: 0, signal: null, output: '' }; });
  assert.equal(ran, false); assert.match(p.error || '', /approved steps changed/);
  const high = permits.request(task, 'Read with a production configuration path', [{ command: 'pwd', env: { GH_CONFIG_DIR: join(task.cwd, 'prod') } }]);
  assert.equal(high.riskClass, 'high'); assert.equal(permits.controllerAllowed(high, task, true), false);
  permits.deny(high, 'Done');
});

test('supervised settings reach the child and removal does not inherit tokens from tmux', async () => {
  const task = freshTask('supervised-env');
  writeFileSync(join(task.cwd, 'supervised-env.sh'), 'echo checked\n');
  const p = permits.requestSupervised(task, 'settings', 'Review one script', 'bash supervised-env.sh', task.cwd, false, 'Writes task output.', { env: { GH_CONFIG_DIR: '/tmp/approved' }, unsetEnv: ['GH_TOKEN', 'GITHUB_TOKEN'] });
  let owner: any, command = '';
  const start = (async (o: unknown, input: { command: string }) => { owner = o; command = input.command; return {} as any; }) as any;
  const card = approvals.request({ actor: task.id, action: 'permit', summary: 'Script with settings', detail: p.steps[0].command, payload: { permitId: p.id } }, async () => {
    await permits.runSupervised(p, task, start, { PATH: '/usr/bin:/bin', GH_TOKEN: 'inherited', GITHUB_TOKEN: 'inherited' });
    return 'Started.';
  });
  permits.attachApproval(p, card.id);
  await approvals.decide(card.id, true, { by: 'user' });
  assert.equal(p.state, 'running');
  assert.equal(owner.env.GH_CONFIG_DIR, `${realpathSync('/tmp')}/approved`);
  assert.equal(owner.env.GH_TOKEN, undefined); assert.equal(owner.env.GITHUB_TOKEN, undefined);
  assert.equal(command, "'env' '-u' 'GH_TOKEN' '-u' 'GITHUB_TOKEN' 'bash' 'supervised-env.sh'");
  permits.syncSupervised(p, { state: 'exited', exitCode: 0, ended: new Date().toISOString() } as any, 'checked');
});

test('credential file paths stay nonsecret while an explicit negative user request cannot approve', () => {
  const task = freshTask('credential-path');
  const before = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const path = join(task.cwd, 'adc.json');
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
  try {
    const p = permits.request(task, 'Use an ADC file', [{ command: 'pwd', env: { GOOGLE_APPLICATION_CREDENTIALS: path } }]);
    assert.equal(p.steps[0].env!.GOOGLE_APPLICATION_CREDENTIALS, path);
    assert.equal(p.riskClass, 'high');
    const transcript = join(root, 'negative-request.jsonl');
    const words = `do not run permit ${p.id}`;
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: words } }) + '\n');
    assert.equal(permits.explicitControllerRequest(transcript, 'claude', words, p), false);
    permits.deny(p, 'Done');
  } finally {
    if (before === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = before;
  }
});

test('named settings cannot make credential reads low risk', () => {
  const task = freshTask('credential-read');
  for (const name of ['hosts.yml', 'token', 'credentials.db']) {
    const p = permits.request(task, 'Review a credential path', [{ command: `cat ${join(task.cwd, name)}`, env: { GH_CONFIG_DIR: '/tmp/gh' } }]);
    assert.equal(p.riskClass, 'high');
    assert.equal(permits.controllerAllowed(p, task, true), false);
    permits.deny(p, 'Done');
  }
});
