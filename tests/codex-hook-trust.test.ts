import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// trustCodexHook writes to ~/.codex/config.toml of the default Codex account: HOME is a scratch folder here.
const root = mkdtempSync(join(tmpdir(), 'tb-codex-hook-trust-'));
process.env.HOME = join(root, 'home');
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
mkdirSync(join(root, 'home', '.codex'), { recursive: true });
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
const { codexFlags } = await import('../server/agents.ts');
const { codexHookKey, isTaskboardCodexHook, trustCodexHook } = await import('../server/trust.ts');
after(() => rmSync(root, { recursive: true, force: true }));

const config = join(root, 'home', '.codex', 'config.toml');
const hash = (c: string) => `sha256:${c.repeat(64)}`;
// hooks.PreToolUse=[...] -> pre_tool_use, the event part of the key that Codex hooks/list reports
const hookEvents = (flags: string[]) => flags.flatMap(f => f.match(/^hooks\.([A-Za-z]+)=/)?.[1] || [])
  .map(e => e.replace(/[A-Z]/g, (c, i) => (i ? '_' : '') + c.toLowerCase()));

test('every hook that a Codex task gets with -c is one that trustCodexHook accepts (tasks 263 to 265)', () => {
  for (const role of [undefined, 'controller'] as const) {
    const events = hookEvents(codexFlags({ role }));
    assert.deepEqual(events.sort(), ['post_tool_use', 'pre_tool_use', 'stop', 'user_prompt_submit']);
    for (const e of events) assert.ok(isTaskboardCodexHook(codexHookKey(e)), `${role || 'task'}: ${e}`);
  }
});

test('trustCodexHook trusts the queue hooks of a normal Codex task once, and refuses other hooks with their key', () => {
  writeFileSync(config, 'model = "x"\n');
  const t = { id: 'a-1', agent: 'codex', role: undefined } as any;
  trustCodexHook(t, codexHookKey('user_prompt_submit'), hash('a'));
  trustCodexHook(t, codexHookKey('user_prompt_submit'), hash('a'));
  trustCodexHook(t, codexHookKey('stop'), hash('b'));
  trustCodexHook(t, codexHookKey('stop'), hash('c'));
  const body = readFileSync(config, 'utf8');
  assert.equal(body.split('[hooks.state."/<session-flags>/config.toml:user_prompt_submit:0:0"]').length, 2);
  assert.match(body, new RegExp(`user_prompt_submit:0:0"\\]\\n+trusted_hash = "${hash('a')}"`));
  assert.match(body, new RegExp(`stop:0:0"\\]\\n+trusted_hash = "${hash('c')}"`));
  assert.doesNotMatch(body, new RegExp(hash('b')));
  const repo = '/repo/.codex/config.toml:pre_tool_use:0:0';
  assert.throws(() => trustCodexHook(t, repo, hash('d')), new RegExp(`Codex listed the hook "${repo.replace(/\./g, '\\.')}", which is not a Taskboard hook`));
  assert.throws(() => trustCodexHook(t, codexHookKey('stop'), 'md5:1'), /not a sha256 hash/);
  assert.throws(() => trustCodexHook({ ...t, agent: 'claude' }, codexHookKey('stop'), hash('a')), /Only a Codex task/);
  assert.doesNotMatch(readFileSync(config, 'utf8'), /\/repo\//);
});
