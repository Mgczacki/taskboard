// The command line and the instructions that each agent gets for the scopes of its task (server/scopes.ts).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-scope-cmd-')));
for (const k of Object.keys(process.env)) if (/^(TASK_|TB_)/.test(k)) delete process.env[k];
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-scope-cmd-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR); mkdirSync(join(root, 'vault', 'tasks'), { recursive: true });
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'scope-cmd-test', controller: { autostart: false, remoteControl: false } }));
const store = await import('../server/store.ts');
const agents = await import('../server/agents.ts');
const scopes = await import('../server/scopes.ts');
agents.writeClaudeSettings();

const wt = join(root, 'app-wt', 'scoped--app'), docs = join(root, 'docs');
mkdirSync(wt, { recursive: true }); mkdirSync(docs);
const scopeList: store.Scope[] = [
  { id: 'a1', kind: 'worktree', name: 'app', path: wt, repo: join(root, 'app'), branch: 'task/app-fix', base: 'origin/master', baseCommit: 'abc', at: '', reason: 'Fix' },
  { id: 'b2', kind: 'read', name: 'read-docs', path: docs, at: '', reason: 'Read' },
];
const task = (agent: store.Agent, num: number) => store.create({ id: `scoped-${agent}`, num, title: `Scoped ${agent}`, agent, status: 'idle', cwd: root, folder: root,
  session: `scoped-${num}`, desc: '', scopes: scopeList });

test('each agent gets --add-dir for an attached worktree, and Claude Code gets a Read rule for a read folder', () => {
  try {
    for (const [agent, num] of [['claude', 1], ['codex', 2], ['antigravity', 3]] as const) {
      const c = agents.command(task(agent, num), 'go', false).join('\n');
      assert.ok(c.includes(`--add-dir\n${wt}`), `${agent}: ${c}`);
      assert.ok(!c.includes(`--add-dir\n${docs}`), `${agent} gets no write access to the read folder`);
    }
    const claude = agents.command(store.get('scoped-claude')!, 'go', false);
    const settings = JSON.parse(readFileSync(claude[claude.indexOf('--settings') + 1], 'utf8'));
    assert.ok(settings.permissions.allow.includes(`Read(/${docs}/**)`));
    assert.ok(!settings.permissions.allow.some((r: string) => r.includes(docs) && !r.startsWith('Read(')), 'no Edit or Write rule for the read folder');
    const text = agents.taskInstructions(store.get('scoped-codex')!);
    assert.match(text, /This task has no Git worktree/);
    assert.match(text, /tb dep add 2 --on <task>/);
    assert.match(text, /Do not add --replaces/);
    assert.match(text, /tb scope request worktree --repo <main checkout> --base <remote branch or commit> --branch <new branch>/);
    assert.match(text, /Attached worktree app: branch task\/app-fix/);
    assert.match(text, /Add --worktree app to the tb git commands, or leave it out/);
    assert.match(text, new RegExp(`You may read the folder ${docs}. Do not write there.`));
    assert.match(agents.controllerGuide('approvals')!, /tb scope approve ID --user-request/);
    assert.match(agents.controllerMd(), /tb dep add <new> --replaces <old> --folded/);
    assert.match(agents.controllerMd(), /tb deps --group <group>/);
    // a worktree that the user removed by hand is left out, so the agent still starts
    rmSync(wt, { recursive: true });
    assert.ok(!agents.command(store.get('scoped-codex')!, 'go', false).includes(wt));
    assert.equal(scopes.worktreeScopes(store.get('scoped-codex')!).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
