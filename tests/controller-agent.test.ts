// Settings > Controller agent and Controller: skip permission prompts. Covers the migration of the older Claude Code
// only setting, the controller command of each agent with the skip setting on and off, the launch key, the generated
// AGENTS.md, the handoff note, and the Codex controller hooks (inbox notice, queued messages, usage). No agent runs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-controller-agent-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-controller-agent-${process.pid}`;
process.env.TASKBOARD_MACHINE_NAME = 'agent-test';
// the default Codex account reads its session files from HOME/.codex/sessions
process.env.HOME = join(root, 'home');
delete process.env.CODEX_HOME;
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
mkdirSync(process.env.TASKBOARD_VAULT, { recursive: true });
// a machine.json from a release before the setting: Claude Code only, prompts skipped
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ name: 'agent-test', controller: { autostart: false, remoteControl: false, dangerouslySkipPermissions: true }, permissions: { trustWorkspaces: false, autoReview: true } }));
const machine = await import('../server/machine.ts');
const store = await import('../server/store.ts');
const agents = await import('../server/agents.ts');
const events = await import('../server/events.ts');
const queue = await import('../server/message-queue.ts');
const docs = await import('../server/docs.ts');

test('the older Claude Code switch becomes skipPermissions.claude; Codex and Antigravity start off', () => {
  const m = machine.readController({ autostart: false, remoteControl: true, dangerouslySkipPermissions: true, models: { claude: 'opus' } });
  assert.equal(m.agentSaved, false);
  assert.equal(m.controller.agent, 'claude');
  assert.deepEqual(m.controller.skipPermissions, { claude: true, codex: false, antigravity: false });
  assert.equal(m.controller.dangerouslySkipPermissions, true);
  assert.equal(m.controller.models.claude, 'opus');
  assert.equal(m.controller.models.codex, '');
  // a value saved by this release wins over the older field
  const n = machine.readController({ agent: 'codex', skipPermissions: { claude: false, codex: true }, dangerouslySkipPermissions: true, accounts: { codex: 'codex-work', antigravity: 5 } });
  assert.equal(n.agentSaved, true);
  assert.equal(n.controller.agent, 'codex');
  assert.deepEqual(n.controller.skipPermissions, { claude: false, codex: true, antigravity: false });
  assert.deepEqual(n.controller.accounts, { codex: 'codex-work' });
  // nothing saved: a new machine, everything off
  const fresh = machine.readController(undefined);
  assert.deepEqual(fresh.controller.skipPermissions, { claude: false, codex: false, antigravity: false });
  assert.equal(fresh.controller.autostart, true);
  assert.equal(machine.readController({ agent: 'gemini' }).agentSaved, false);
});

test('the server reads the older file, and an update writes both the new and the older field', () => {
  assert.equal(machine.controllerAgentKnown(), false);
  assert.equal(machine.get().controller.skipPermissions.claude, true);
  machine.adoptControllerAgent('claude', 'claude-default');
  assert.equal(machine.controllerAgentKnown(), true);
  machine.update({ controllerSkipPermissions: { codex: true } });
  const saved = JSON.parse(readFileSync(join(process.env.TASKBOARD_DIR!, 'machine.json'), 'utf8'));
  assert.equal(saved.controller.agent, 'claude');
  assert.deepEqual(saved.controller.skipPermissions, { claude: true, codex: true, antigravity: false });
  assert.equal(saved.controller.dangerouslySkipPermissions, true);
  // the older patch field still sets the Claude Code value
  machine.update({ dangerouslySkipPermissions: false });
  assert.equal(machine.get().controller.skipPermissions.claude, false);
  assert.equal(machine.get().controller.dangerouslySkipPermissions, false);
  // a switch keeps the account of the agent that ran before, for a switch back
  machine.setControllerAgent('codex', 'codex-work', { agent: 'claude', account: 'claude-default' });
  assert.deepEqual(machine.get().controller.accounts, { claude: 'claude-default', codex: 'codex-work' });
  machine.setControllerAgent('claude', 'claude-default');
  assert.throws(() => machine.update({ controllerSkipPermissions: { gemini: true } as never }), /claude, codex and antigravity/);
  assert.throws(() => machine.update({ controllerSkipPermissions: { codex: 'yes' } as never }), /true or false/);
  machine.update({ controllerSkipPermissions: { claude: false, codex: false, antigravity: false } });
});

const ctl = (agent: store.Agent, extra: Partial<store.Task> = {}) => ({ id: 'controller', num: 0, title: 'Controller', agent, status: 'idle', cwd: join(process.env.TASKBOARD_VAULT!, 'controller'), folder: '', session: 'tb-controller', role: 'controller', desc: '', created: '', statusAt: '', ...extra }) as store.Task;
const skip = (agent: 'claude' | 'codex' | 'antigravity', on: boolean) => machine.update({ controllerSkipPermissions: { [agent]: on } });

test('Claude Code: --dangerously-skip-permissions replaces the permission mode', () => {
  skip('claude', false);
  let c = agents.controllerCommand(ctl('claude', { sessionId: 's1' }), null, false);
  assert.equal(c[0], 'claude');
  assert.ok(!c.includes('--dangerously-skip-permissions'));
  assert.deepEqual(c.slice(c.indexOf('--permission-mode'), c.indexOf('--permission-mode') + 2), ['--permission-mode', 'auto']);
  assert.deepEqual(c.slice(c.indexOf('--session-id'), c.indexOf('--session-id') + 2), ['--session-id', 's1']);
  skip('claude', true);
  c = agents.controllerCommand(ctl('claude', { sessionId: 's1' }), 'Read the handoff.', true);
  assert.ok(c.includes('--dangerously-skip-permissions'));
  assert.ok(!c.includes('--permission-mode'));
  assert.ok(c.includes('--resume'));
  assert.equal(c.at(-1), 'Read the handoff.');
  skip('claude', false);
});

test('Codex: --dangerously-bypass-approvals-and-sandbox replaces the approval and sandbox flags; hooks stay', () => {
  skip('codex', false);
  let c = agents.controllerCommand(ctl('codex'), null, false);
  assert.equal(c[0], 'codex');
  assert.ok(!c.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(c.slice(c.indexOf('-a'), c.indexOf('-a') + 4), ['-a', 'on-request', '-s', 'workspace-write']);
  assert.ok(c.includes('approvals_reviewer="auto_review"'));
  // the guard and the three controller hooks; no developer_instructions (the controller reads AGENTS.md)
  assert.ok(c.some(x => x.startsWith('hooks.PreToolUse=') && x.includes('guard.mjs')));
  for (const e of ['UserPromptSubmit', 'PostToolUse', 'Stop']) assert.ok(c.some(x => x.startsWith(`hooks.${e}=`) && x.includes('codex-hook.mjs')), e);
  assert.ok(!c.some(x => x.startsWith('developer_instructions=')));
  skip('codex', true);
  c = agents.controllerCommand(ctl('codex', { sessionId: 'thread-1' }), null, true);
  assert.equal(c[1], 'resume');
  assert.equal(c.at(-1), 'thread-1');
  assert.ok(c.includes('--dangerously-bypass-approvals-and-sandbox'));
  for (const gone of ['-a', '-s', '--add-dir']) assert.ok(!c.includes(gone), gone);
  assert.ok(!c.some(x => x.startsWith('approvals_reviewer=')));
  assert.ok(c.some(x => x.startsWith('hooks.PreToolUse=') && x.includes('guard.mjs')), 'the guard hook stays');
  skip('codex', false);
  // a Codex task gets the guard only, and its instructions as developer_instructions
  const task = agents.command({ ...ctl('codex'), id: 'codex-task-9', num: 9, role: undefined }, 'Hello', false);
  assert.ok(!task.some(x => x.includes('codex-hook.mjs')));
  assert.ok(!task.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(task.some(x => x.startsWith('developer_instructions=')));
});

test('Antigravity: --dangerously-skip-permissions is added; --sandbox follows auto review', () => {
  skip('antigravity', false);
  let c = agents.controllerCommand(ctl('antigravity'), null, false);
  assert.ok(!c.includes('--dangerously-skip-permissions'));
  assert.ok(c.includes('--sandbox'));
  skip('antigravity', true);
  c = agents.controllerCommand(ctl('antigravity', { sessionId: 'conv-1' }), null, true);
  assert.ok(c.includes('--dangerously-skip-permissions'));
  assert.deepEqual(c.slice(-2), ['--conversation', 'conv-1']);
  skip('antigravity', false);
  // a task never gets the flag, also when the controller has it
  skip('antigravity', true);
  const task = agents.command({ ...ctl('antigravity'), id: 'agy-task-8', num: 8, role: undefined, sessionId: 'c8' }, null, true);
  assert.ok(!task.includes('--dangerously-skip-permissions'));
  skip('antigravity', false);
});

test('the launch key changes with the skip setting of the running agent only', () => {
  const before = { claude: agents.controllerLaunchKey('claude'), codex: agents.controllerLaunchKey('codex'), antigravity: agents.controllerLaunchKey('antigravity') };
  skip('codex', true);
  assert.notEqual(agents.controllerLaunchKey('codex'), before.codex);
  assert.equal(agents.controllerLaunchKey('claude'), before.claude);
  assert.equal(agents.controllerLaunchKey('antigravity'), before.antigravity);
  assert.equal(JSON.parse(agents.controllerLaunchKey('codex')).skipPermissions, true);
  assert.equal(JSON.parse(agents.controllerLaunchKey('codex')).codexHooks, 3);
  skip('codex', false);
  assert.equal(agents.controllerLaunchKey('codex'), before.codex);
  assert.equal(JSON.parse(agents.controllerLaunchKey('claude')).guidance, 2);
});

test('AGENTS.md is generated, marked as generated, has the controller guidance, and fits the Codex limit', () => {
  const md = agents.controllerAgentsMd();
  assert.match(md.split('\n')[0], /^<!-- Generated by Taskboard \(server\/agents\.ts controllerAgentsMd\)\. Do not edit/);
  assert.ok(md.endsWith(agents.controllerMd()));
  assert.ok(Buffer.byteLength(md) < 32 * 1024, `${Buffer.byteLength(md)} bytes`);
  assert.match(md, /Do not start agents with your own sub-agent tools/);
  assert.match(md, /plain English/);
  // the core stays small; rare work is in controllerGuide, which tb prints on demand
  assert.ok(Buffer.byteLength(agents.controllerMd()) < 8 * 1024, `${Buffer.byteLength(agents.controllerMd())} bytes`);
  assert.match(md, /Run `tb approve --help` and read it before your first approval/);
  assert.match(md, /Run `tb mail help` and follow it/);
  assert.doesNotMatch(md, /CLOUDSDK_CONFIG/);
  assert.match(agents.controllerGuide('approvals')!, /tb pending answer <id> --option <key> --user-request/);
  assert.match(agents.controllerGuide('approvals')!, /A force push needs the word force/);
  assert.match(agents.controllerGuide('mail')!, /tb mail propose-route <id> <task>/);
  assert.match(agents.controllerGuide('mail')!, /Keep the body under 1,500 characters/);
  assert.equal(agents.controllerGuide('other'), null);
  agents.writeControllerGuidance(true);
  const dir = join(process.env.TASKBOARD_VAULT!, 'controller');
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), md);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), agents.controllerMd());
  assert.ok(existsSync(join(dir, 'plans')));
});

test('the handoff note names the old session, the rules file and the open tasks', () => {
  const tasks = [
    { ...ctl('codex'), id: 'a-1', num: 1, role: undefined, title: 'Fix login', status: 'working', now: 'Running tests' },
    { ...ctl('claude'), id: 'b-2', num: 2, role: undefined, title: 'Old work', status: 'archived' },
  ] as store.Task[];
  const note = agents.controllerHandoff({ agent: 'claude', account: 'claude-default', sessionId: 'old-1', transcript: '/x/old-1.jsonl' }, 'codex', tasks);
  assert.match(note, /# Controller handoff: Claude Code to Codex/);
  assert.match(note, /claude --resume old-1/);
  assert.match(note, /AGENTS\.md/);
  assert.match(note, /#1 Fix login · Codex · working · Running tests/);
  assert.doesNotMatch(note, /Old work/);
  assert.match(note, /Do not act on a task until the user asks/);
});

test('the controller on Codex: hooks give the inbox notice, queued messages and the usage to the model', () => {
  const c = store.create({ ...ctl('codex'), sessionId: 'thread-ctl', status: 'idle' });
  mkdirSync(store.taskDir(c.id), { recursive: true });
  // UserPromptSubmit: working, and the usage of the accounts
  let out = events.codexHookEvent(c.id, { hook_event_name: 'UserPromptSubmit', session_id: 'thread-ctl', transcript_path: '/x/rollout.jsonl' }).output as any;
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Machine routing rules:/);
  assert.equal(store.get(c.id)!.status, 'working');
  assert.equal(store.get(c.id)!.transcript, '/x/rollout.jsonl');
  // PostToolUse: queued messages
  writeFileSync(join(store.taskDir(c.id), 'message-queue.json'), JSON.stringify([{ id: 'q1', kind: 'message', text: 'From the dashboard.', from: 'you', queued: new Date().toISOString(), state: 'queued', reason: 'busy', tries: 1 }]));
  queue.start(); queue.stop();
  out = events.codexHookEvent(c.id, { hook_event_name: 'PostToolUse', session_id: 'thread-ctl' }).output as any;
  assert.match(out.hookSpecificOutput.additionalContext, /From the dashboard\./);
  assert.equal(queue.list(c.id)[0].deliveredBy, 'PostToolUse hook');
  // Stop: a queued message keeps the turn going
  writeFileSync(join(store.taskDir(c.id), 'message-queue.json'), JSON.stringify([{ id: 'q2', kind: 'message', text: 'Second.', from: 'you', queued: new Date().toISOString(), state: 'queued', reason: 'busy', tries: 1 }]));
  queue.start(); queue.stop();
  out = events.codexHookEvent(c.id, { hook_event_name: 'Stop', session_id: 'thread-ctl' }).output as any;
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /Second\./);
  assert.deepEqual(events.codexHookEvent(c.id, { hook_event_name: 'Stop', session_id: 'thread-ctl' }), {});
  // an inbox file reaches it at the next tool call
  docs.uploadSystem(c.id, 'note.md', '# Note\n');
  out = events.codexHookEvent(c.id, { hook_event_name: 'PostToolUse', session_id: 'thread-ctl' }).output as any;
  assert.match(out.hookSpecificOutput.additionalContext, /note\.md/);
  // a Claude Code controller does not take Codex events
  store.update(c.id, { agent: 'claude' });
  assert.deepEqual(events.codexHookEvent(c.id, { hook_event_name: 'UserPromptSubmit', session_id: 'thread-ctl' }), {});
});

test('Codex: a turn in a background thread without a session file does not replace the conversation', () => {
  const t = store.create({ ...ctl('codex'), id: 'codex-bg-7', num: 7, role: undefined, sessionId: 'thread-main', transcript: '/x/main.jsonl', status: 'working' });
  events.codexEvent(t.id, { type: 'agent-turn-complete', 'thread-id': 'thread-background', 'last-assistant-message': 'I cannot read that file.' });
  let now = store.get(t.id)!;
  assert.equal(now.sessionId, 'thread-main');
  assert.equal(now.transcript, '/x/main.jsonl');
  assert.equal(now.status, 'working');
  // the turn of the real conversation still counts
  events.codexEvent(t.id, { type: 'agent-turn-complete', 'thread-id': 'thread-main', 'last-assistant-message': 'Done.' });
  assert.notEqual(store.get(t.id)!.status, 'working');
  // /new: the new thread has its own session file
  const day = join(process.env.HOME!, '.codex', 'sessions', '2026', '10', '03'); mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-2026-10-03T04-00-00-thread-new.jsonl'), '');
  events.codexEvent(t.id, { type: 'agent-turn-complete', 'thread-id': 'thread-new', 'last-assistant-message': 'New conversation.' });
  now = store.get(t.id)!;
  assert.equal(now.sessionId, 'thread-new');
  assert.ok(now.pastSessions?.includes('thread-main'));
});
