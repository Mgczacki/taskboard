import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { waitFor } from './helpers/wait-for.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-tmux-launch-')));
process.env.TASKBOARD_DIR = root;
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-launch-${process.pid}`;
const tmux = await import('../server/tmux.ts');

test('an oversized tmux request starts with exact arguments and environment', { timeout: 30000 }, async () => {
  const output = join(root, 'agent.json');
  const injected = `value ' " $(touch ${join(root, 'injected')}) ; \n last`;
  const longArg = 'scope/'.repeat(3000);
  const env = { TASK_ID: 'fixture-216', CODEX_HOME: join(root, 'account'), TEST_SECRET: 'account-secret', TEST_VALUE: injected };
  const script = 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), env: { TASK_ID: process.env.TASK_ID, CODEX_HOME: process.env.CODEX_HOME, TEST_SECRET: process.env.TEST_SECRET, TEST_VALUE: process.env.TEST_VALUE }, cwd: process.cwd() })); setInterval(() => {}, 1000)';
  const command = [process.execPath, '-e', script, output, longArg, injected];
  const old = tmux.newSessionArgs('large', root, env, command);
  assert.ok(tmux.commandBytes(old) > 16000);
  await assert.rejects(tmux.tmux(...old), /command too long/);
  try {
    await tmux.newSession('large', root, env, command);
    await waitFor(() => existsSync(output), { description: 'the stand-in agent to record its launch' });
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
      args: [longArg, injected], env, cwd: root,
    });
    assert.equal((await tmux.tmux('show-environment', '-t', '=large', 'CODEX_HOME')).trim(), `CODEX_HOME=${env.CODEX_HOME}`);
    assert.equal(existsSync(join(root, 'injected')), false);
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith('agent-launch-')), []);
  } finally { await tmux.killSession('large'); }
});

test('an environment above the tmux limit reaches the agent', { timeout: 30000 }, async () => {
  const output = join(root, 'large-env.txt');
  const value = 'account/'.repeat(2200);
  const env = { TEST_SECRET: value };
  const command = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], process.env.TEST_SECRET); setInterval(() => {}, 1000)', output];
  assert.ok(tmux.commandBytes(tmux.newSessionArgs('large-env', root, env, command)) > tmux.MAX_COMMAND_BYTES);
  try {
    await tmux.newSession('large-env', root, env, command);
    await waitFor(() => existsSync(output), { description: 'the stand-in agent to receive its environment' });
    assert.equal(readFileSync(output, 'utf8'), value);
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith('agent-launch-')), []);
  } finally { await tmux.killSession('large-env'); }
});

test('a failed oversized launch removes its private file and does not show its contents', async () => {
  const secret = 'private-' + 'x'.repeat(17000);
  await tmux.newSession('duplicate', root, {}, ['sleep', '60']);
  try {
    await assert.rejects(tmux.newSession('duplicate', root, { TEST_SECRET: secret }, ['true']), error => {
      assert.doesNotMatch(String(error), /private-/);
      return true;
    });
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith('agent-launch-')), []);
  } finally { await tmux.killSession('duplicate'); }
});

test.after(async () => {
  try { await tmux.tmux('kill-server'); } catch { /* the scratch server may already be gone */ }
  rmSync(root, { recursive: true, force: true });
});
