import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'tb-permits-'));
process.env.TASKBOARD_DIR = join(root, 'tbdir');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_PORT = '4399';
const { taskDir } = await import('../server/store.ts');
const { GUARD_SCRIPT } = await import('../server/config.ts');
const permits = await import('../server/permits.ts');
type Task = import('../server/store.ts').Task;
mkdirSync(join(root, 'work'), { recursive: true });
mkdirSync(join(root, 'tbdir', 'hooks'), { recursive: true });
copyFileSync(fileURLToPath(new URL('../server/hooks/guard.mjs', import.meta.url)), GUARD_SCRIPT);
const freshTask = (id: string) => { mkdirSync(taskDir(id), { recursive: true }); return { id, num: 1, agent: 'codex', cwd: join(root, 'work'), folder: join(root, 'work'), role: undefined, worktree: false } as Task; };
after(() => rmSync(root, { recursive: true, force: true }));

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
