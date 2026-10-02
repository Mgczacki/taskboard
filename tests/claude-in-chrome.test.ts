// Claude in Chrome for the Claude Code sessions that Taskboard starts (machine.ts claudeInChrome, agents.ts
// claudeNoChrome). Off adds --no-chrome, so Claude Code does not show "Claude in Chrome extension detected" at start.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-cic-')));
for (const k of Object.keys(process.env)) if (/^(TASK_|TB_)/.test(k)) delete process.env[k];
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-cic-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR); mkdirSync(join(root, 'vault', 'tasks'), { recursive: true });
// a machine.json from before the setting: the browser mode "task" gave tasks Claude in Chrome, and there is no claudeInChrome
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'cic-test', controller: { autostart: false, remoteControl: false }, browser: { claude: 'task', codex: 'only' } }));
const store = await import('../server/store.ts');
const machine = await import('../server/machine.ts');
const agents = await import('../server/agents.ts');
agents.writeClaudeSettings();

const task = store.create({ id: 'cic-claude', num: 1, title: 'Chrome', agent: 'claude', status: 'idle', cwd: root, folder: root, session: 'cic-1', desc: '' });
const controller = { ...task, id: 'controller', num: 0, role: 'controller' as const };
const cmd = () => agents.command(store.get('cic-claude')!, 'go', false);

test.after(() => rmSync(root, { recursive: true, force: true }));

test('an old settings file gets Claude in Chrome Off for tasks and the controller, and keeps its browser modes', () => {
  assert.deepEqual(machine.get().claudeInChrome, { tasks: false, controller: false });
  assert.equal(machine.get().browser.claude, 'task');
  assert.equal(machine.get().browser.codex, 'only');
  assert.deepEqual(machine.readClaudeInChrome(undefined), { tasks: false, controller: false });
  assert.deepEqual(machine.readClaudeInChrome({ tasks: 'yes', controller: 1 }), { tasks: false, controller: false });
  assert.deepEqual(machine.readClaudeInChrome({ tasks: true }), { tasks: true, controller: false });
});

test('Off: the task command has --no-chrome in each browser mode', () => {
  for (const mode of ['off', 'task', 'only'] as const) {
    machine.update({ browserClaude: mode });
    assert.ok(cmd().includes('--no-chrome'), mode);
  }
  assert.equal(agents.claudeNoChrome(controller), true);
});

test('On: no --no-chrome, except in the task browser mode "only"', () => {
  machine.update({ claudeInChromeTasks: true, browserClaude: 'task' });
  assert.ok(!cmd().includes('--no-chrome'));
  machine.update({ browserClaude: 'off' });
  assert.ok(!cmd().includes('--no-chrome'));
  machine.update({ browserClaude: 'only' });
  // with a task browser (its MCP server is found) "only" turns Claude in Chrome off
  assert.equal(agents.claudeNoChrome(store.get('cic-claude')!, true), true);
  assert.equal(cmd().includes('--no-chrome'), cmd().includes('--mcp-config'));
  // the task setting does not change the controller
  assert.equal(agents.claudeNoChrome(controller), true);
  const saved = JSON.parse(readFileSync(join(root, 'state', 'machine.json'), 'utf8'));
  assert.deepEqual(saved.claudeInChrome, { tasks: true, controller: false });
  machine.update({ claudeInChromeTasks: false, browserClaude: 'task' });
});

test('the controller setting changes the controller launch key, so the controller restarts between turns', () => {
  const off = agents.controllerLaunchKey('claude');
  assert.equal(JSON.parse(off).noChrome, true);
  machine.update({ claudeInChromeController: true });
  assert.equal(agents.claudeNoChrome(controller), false);
  assert.notEqual(agents.controllerLaunchKey('claude'), off);
  assert.equal(JSON.parse(agents.controllerLaunchKey('claude')).noChrome, false);
  // Codex and Antigravity controllers have no such flag: their key does not change
  assert.equal(JSON.parse(agents.controllerLaunchKey('codex')).noChrome, undefined);
  machine.update({ claudeInChromeController: false });
});
