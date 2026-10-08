import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-computer-use-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-computer-use-${process.pid}`;
process.env.HOME = join(root, 'home');
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
mkdirSync(join(root, 'vault', 'tasks'), { recursive: true });
mkdirSync(process.env.HOME, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ controller: { agent: 'codex' } }));
const machine = await import('../server/machine.ts');
const store = await import('../server/store.ts');
const agents = await import('../server/agents.ts');
const grant = await import('../server/computer-use.ts');
agents.writeClaudeSettings();
const task = (agent: store.Agent, extra: Partial<store.Task> = {}) => store.create({
  id: `computer-${agent}-${extra.computerUse ? 'yes' : 'no'}`, num: agent === 'codex' ? 1 : 2,
  title: 'Computer use', agent, status: 'idle', cwd: root, folder: root,
  session: `computer-${agent}`, desc: '', ...extra,
});
const codexDenied = 'plugins.computer-use@openai-bundled.enabled=false';
test.after(() => rmSync(root, { recursive: true, force: true }));

test('an existing task without a grant stays denied on first start and resume', () => {
  const t = task('codex');
  assert.equal(agents.computerUseAllowed(t), false);
  for (const resume of [false, true]) {
    const cmd = agents.command({ ...t, sessionId: 'thread-1' }, null, resume);
    assert.ok(cmd.includes(codexDenied));
    assert.ok(cmd.includes('mcp_servers.computer-use.enabled=false'));
    assert.ok(cmd.includes('mcp_servers.cua_repl.enabled=false'));
    if (resume) assert.equal(cmd[1], 'resume');
  }
  const saved = store.get(t.id)!;
  assert.equal(saved.computerUse, undefined);
  assert.equal(agents.computerUseAllowed(saved), false);
});

test('a task with an explicit stored grant keeps it on resume and account move commands', () => {
  const t = task('codex', { computerUse: true });
  assert.equal(agents.computerUseAllowed(t), true);
  for (const resume of [false, true]) {
    const cmd = agents.command({ ...t, account: 'other-account', sessionId: 'thread-2' }, null, resume);
    assert.ok(!cmd.includes(codexDenied));
  }
  assert.equal(store.get(t.id)!.computerUse, true);
});

test('Claude tasks deny OS computer-use tools while the task browser stays distinct', () => {
  const t = task('claude');
  const denied = agents.command(t, null, false);
  assert.ok(denied.includes('--disallowedTools'));
  assert.ok(denied.includes('mcp__computer-use__*'));
  const allowed = agents.command({ ...t, computerUse: true }, null, true);
  assert.ok(!allowed.includes('mcp__computer-use__*'));
});


test('a granted Claude task and controller get the computer-use MCP server', () => {
  const executable = join(process.env.HOME!, '.codex', 'computer-use', 'Codex Computer Use.app', 'Contents',
    'SharedSupport', 'SkyComputerUseClient.app', 'Contents', 'MacOS', 'SkyComputerUseClient');
  mkdirSync(join(executable, '..'), { recursive: true });
  writeFileSync(executable, 'test');
  const t = store.get('computer-claude-no')!;
  const denied = agents.command(t, null, false);
  const deniedConfig = denied[denied.indexOf('--mcp-config') + 1];
  if (denied.includes('--mcp-config')) assert.equal(JSON.parse(readFileSync(deniedConfig, 'utf8')).mcpServers['computer-use'], undefined);
  const allowed = agents.command({ ...t, computerUse: true }, null, false);
  const config = JSON.parse(readFileSync(allowed[allowed.indexOf('--mcp-config') + 1], 'utf8'));
  assert.equal(config.mcpServers['computer-use'].command, executable);
  const codex = agents.command({ ...store.get('computer-codex-yes')!, sessionId: 'thread-2' }, null, true);
  assert.ok(codex.includes('mcp_servers.computer-use.enabled=true'));
  assert.ok(codex.some(x => x.startsWith('mcp_servers.computer-use.command=')));
  const controller = { ...t, role: 'controller' as const };
  const ctl = agents.controllerCommand(controller, null, false);
  assert.ok(ctl.includes('--mcp-config'));
  assert.equal(JSON.parse(readFileSync(ctl[ctl.indexOf('--mcp-config') + 1], 'utf8')).mcpServers['computer-use'].command, executable);
});

test('the controller defaults on, and its setting persists and changes its next launch', () => {
  assert.equal(machine.readController(undefined).controller.computerUse, true);
  assert.equal(machine.readController({ computerUse: 'yes' }).controller.computerUse, true);
  assert.equal(agents.computerUseAllowed({ role: 'controller', agent: 'codex' }), true);
  const controller = { ...store.get('computer-codex-no')!, role: 'controller' as const };
  assert.ok(!agents.controllerCommand(controller, null, false).includes(codexDenied));
  const before = agents.controllerLaunchKey('codex');
  machine.update({ controllerComputerUse: false });
  assert.equal(JSON.parse(readFileSync(join(process.env.TASKBOARD_DIR!, 'machine.json'), 'utf8')).controller.computerUse, false);
  assert.notEqual(agents.controllerLaunchKey('codex'), before);
  assert.ok(agents.controllerCommand(controller, null, true).includes(codexDenied));
  const claude = { ...store.get('computer-claude-no')!, role: 'controller' as const };
  assert.ok(agents.controllerCommand(claude, null, true).includes('mcp__computer-use__*'));
  machine.update({ controllerComputerUse: true });
});

test('only a dashboard request can authorize computer use at launch', () => {
  assert.equal(grant.dashboardComputerUseGrant('http://localhost:4317', undefined, undefined), true);
  assert.equal(grant.dashboardComputerUseGrant(undefined, 'controller', undefined), false);
  assert.equal(grant.dashboardComputerUseGrant('http://localhost:4317', 'task-1', undefined), false);
  assert.equal(grant.dashboardComputerUseGrant('http://localhost:4317', undefined, 'task-token'), false);
});
