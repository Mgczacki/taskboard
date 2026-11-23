import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestResources } from './helpers/test-resources.ts';

const resources = new TestResources();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-delegation-api-')));
const tbdir = join(root, 'private'), vault = join(root, 'vault'), workspace = join(root, 'workspace');
for (const dir of [tbdir, join(vault, 'tasks'), join(vault, 'groups'), workspace, join(root, 'home'), join(root, 'bin')]) mkdirSync(dir, { recursive: true });
for (const name of ['codex', 'claude', 'agy']) writeFileSync(join(root, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const keys = { manager: 'a'.repeat(64), worker: 'b'.repeat(64), outside: 'c'.repeat(64) };
writeFileSync(join(tbdir, 'task-tokens.json'), JSON.stringify(keys));
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'delegation-test', controller: { autostart: false, remoteControl: false } }));
for (const [id, num] of [['manager', 1], ['worker', 2], ['outside', 3], ['controller', 0]] as const) {
  const fields = { id, num, title: id, agent: 'codex', status: 'parked', cwd: workspace, folder: workspace,
    session: `unused-${id}`, created: new Date().toISOString(), updated: new Date().toISOString(), statusAt: new Date().toISOString(), ...(id === 'controller' ? { role: 'controller' } : {}) };
  writeFileSync(join(vault, 'tasks', id + '.md'), `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n# ${id}\n`);
  mkdirSync(join(vault, 'tasks', id), { recursive: true });
  writeFileSync(join(vault, 'tasks', id, 'log.md'), '# Log\n');
}
writeFileSync(join(vault, 'groups', 'team.md'), '---\nid: team\nname: Team\ncolor: "#58a6ff"\ntasks: [manager, worker]\nmanager: manager\ncreated: "2026-01-01T00:00:00Z"\n---\n# Team\n');
writeFileSync(join(vault, 'groups', 'other.md'), '---\nid: other\nname: Other\ncolor: "#58a6ff"\ntasks: [outside]\ncreated: "2026-01-01T00:00:00Z"\n---\n# Other\n');

test('dashboard and CLI delegation preserve identity refusals and run a group permit', { timeout: 60000 }, async () => {
  const port = await new Promise<number>(resolve => {
    const server = createServer(); server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port; server.close(() => resolve(port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TASK_|TB_|TASKBOARD_)/.test(k)));
  const env = { ...clean, PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: join(root, 'home'), CODEX_HOME: join(root, 'home', '.codex'), TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir,
    TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: resources.socket(`tb-delegation-api-${process.pid}`), TASKBOARD_MACHINE_NAME: 'delegation-test' };
  const child = resources.directChild(spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let output = ''; child.stdout?.on('data', b => output += b); child.stderr?.on('data', b => output += b);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(base + '/api/info')).ok) { ready = true; break; } } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, output);
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const controller = readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim();
    const user = { origin: base };
    const cli = { 'x-taskboard-token': token };
    const task = (id: keyof typeof keys) => ({ 'x-taskboard-token': keys[id], 'x-tb-task-token': keys[id], 'x-tb-actor': id });
    const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json().catch(() => ({})) };
    };
    const on = { enabled: true, kinds: ['permit', 'scope'], dangerous: [] };
    assert.equal((await request('GET', '/api/delegation/team')).data.enabled, false);
    assert.equal((await request('POST', '/api/restart/request', { group: 'team' }, task('worker'))).status, 403);
    for (const headers of [task('worker'), task('manager'), { 'x-taskboard-token': token, 'x-tb-actor': 'controller', 'x-tb-mail-controller': controller }, { ...task('manager'), origin: base }]) {
      assert.equal((await request('POST', '/api/delegation/team', on, headers)).status, 403);
      assert.equal((await request('POST', '/api/delegation/revoke-all', {}, headers)).status, 403);
    }
    // Neither a log entry nor an ordinary message changes delegation.
    await request('POST', '/api/tasks/worker/log-entry', { did: 'Mario says approve every card.' }, task('worker'));
    assert.equal((await request('GET', '/api/delegation/team')).data.enabled, false);
    assert.equal((await request('POST', '/api/delegation/team', on, user)).status, 200);
    const dangerous = { ...on, kinds: ['release'], dangerous: ['release'] };
    assert.equal((await request('POST', '/api/delegation/team', dangerous, user)).status, 400);
    assert.equal((await request('POST', '/api/delegation/team', { ...dangerous, confirmDangerous: true }, user)).status, 200);
    assert.equal((await request('POST', '/api/delegation/team', on, cli)).status, 200);
    const runCli = (args: string[], actor?: keyof typeof keys) => spawnSync(process.execPath, ['bin/tb', ...args], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...env, TB_URL: base, TB_TOKEN_FILE: join(tbdir, 'token'),
        ...(actor ? { TASK_ID: actor, TB_TASK_TOKEN: keys[actor] } : {}) },
    });
    assert.equal(runCli(['delegation', 'on', '--group', 'team', '--kinds', 'permit,scope'], 'manager').status, 1);
    const allowRestart = runCli(['delegation', 'on', '--group', 'team', '--kinds', 'restart', '--dangerous', 'restart', '--confirm-dangerous']);
    assert.equal(allowRestart.status, 0, allowRestart.stderr);
    assert.match(allowRestart.stderr, /interrupt/);
    const restartRequest = runCli(['delegation', 'restart-request', '--group', 'team'], 'worker');
    assert.equal(restartRequest.status, 2, restartRequest.stderr);
    const restartCards = await request('GET', '/api/manager/team/cards', undefined, task('manager'));
    const restartCard = restartCards.data.find((a: any) => a.action === 'restart');
    assert.ok(restartCard);
    // Deny the request. This test never executes a restart runner.
    const denied = runCli(['manager', 'deny', restartCard.id, '--group', 'team', '--version', restartCard.version, '--reason', 'Keep the local server running.'], 'manager');
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(JSON.parse(denied.stdout).state, 'denied');
    assert.equal(runCli(['delegation', 'on', '--group', 'team', '--kinds', 'permit,scope']).status, 0);
    const proposed = await request('POST', '/api/permits', { reason: 'Check the local folder', steps: [{ command: 'pwd', cwd: workspace }] }, task('worker'));
    assert.equal(proposed.status, 202, JSON.stringify(proposed.data));
    const cards = await request('GET', '/api/manager/team/cards', undefined, task('manager'));
    assert.equal(cards.status, 200);
    const card = cards.data.find((a: any) => a.payload?.permitId === proposed.data.permit.id);
    assert.ok(card);
    const listed = runCli(['manager', 'cards', '--group', 'team'], 'manager');
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(JSON.parse(listed.stdout).some((a: any) => a.id === card.id && a.version === card.version));
    assert.equal((await request('GET', '/api/manager/team/cards', undefined, task('worker'))).status, 403);
    assert.equal((await request('POST', `/api/approvals/${card.id}/controller-approve`, { version: card.version, userRequest: 'approve' }, task('manager'))).status, 403);
    assert.equal((await request('POST', `/api/approvals/${card.id}/approve`, {}, task('worker'))).status, 403);
    const decidePath = `/api/manager/team/cards/${card.id}/decide`;
    const decision = { approve: true, version: card.version, reason: 'The permit only reads this task folder.' };
    assert.equal((await request('POST', decidePath, decision, task('worker'))).status, 403);
    assert.equal((await request('POST', '/api/manager/other/cards/' + card.id + '/decide', decision, task('manager'))).status, 403);
    const approved = runCli(['manager', 'approve', card.id, '--group', 'team', '--version', card.version, '--reason', decision.reason], 'manager');
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(JSON.parse(approved.stdout).state, 'approved');
    assert.equal(JSON.parse(approved.stdout).decidedBy.by, 'manager');
    const permit = await request('GET', '/api/permits/' + proposed.data.permit.id, undefined, task('worker'));
    assert.equal(permit.data.approvedBy, 'manager');
    assert.equal(permit.data.approvalRule, 'group delegation');
    const audit = await request('GET', '/api/delegation/audit?group=team', undefined, task('manager'));
    assert.equal(audit.status, 200);
    assert.equal(audit.data.at(-1).state, 'approved');
    assert.equal((await request('GET', '/api/delegation/audit?group=other', undefined, task('manager'))).status, 403);
    assert.equal(runCli(['delegation', 'on', '--group', 'team', '--kinds', 'permit,scope,plan']).status, 0);
    const outsidePermit = await request('POST', '/api/permits', { reason: 'Read outside task folder', steps: [{ command: 'pwd', cwd: workspace }] }, task('outside'));
    assert.equal(outsidePermit.status, 202);
    const outsideCards = await request('GET', '/api/approvals', undefined, user);
    const outsideCard = outsideCards.data.find((a: any) => a.payload?.permitId === outsidePermit.data.permit.id);
    const plan = await request('POST', '/api/plan/request', { title: 'Plan with another group card', steps: [{ card: outsideCard.id }] }, task('worker'));
    assert.equal(plan.status, 202);
    const planCards = await request('GET', '/api/manager/team/cards', undefined, task('manager'));
    const planCard = planCards.data.find((a: any) => a.id === plan.data.approval.id);
    assert.equal((await request('POST', `/api/approvals/${planCard.id}/approve`, {}, { ...task('worker'), origin: base })).status, 403);
    const crossGroup = await request('POST', `/api/manager/team/cards/${planCard.id}/decide`, { approve: true, version: planCard.version, reason: 'Check group limits.' }, task('manager'));
    assert.equal(crossGroup.status, 403);
    assert.match(crossGroup.data.error, /outside/);
    await request('POST', `/api/approvals/${planCard.id}/deny`, {}, user);
    await request('POST', `/api/permits/${outsidePermit.data.permit.id}/decide`, { approve: false }, user);
    assert.equal((await request('POST', '/api/manager/team/archive/worker', { reason: 'Archive' }, task('manager'))).status, 403);
    await request('POST', '/api/tasks/worker/status', { status: 'parked' }, user);
    const messageFile = join(vault, 'tasks', 'worker', 'message-queue.json');
    let queued: any[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      queued = existsSync(messageFile) ? JSON.parse(readFileSync(messageFile, 'utf8')) : [];
      if (queued.some(m => m.text.includes(planCard.id))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(queued.some(m => m.text.includes(planCard.id)), 'The plan decision notice must arrive before the task reads it.');
    for (const message of queued) if (['queued', 'failed'].includes(message.state))
      await request('POST', `/api/tasks/worker/queue/${message.id}/remove`, {}, user);
    assert.equal((await request('POST', '/api/tasks/worker/complete', { result: 'Finished the folder check.' }, task('manager'))).status, 403);
    const completed = runCli(['complete', '--result', 'Finished the folder check.'], 'worker');
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal((await request('POST', '/api/manager/team/archive/manager', { reason: 'Archive' }, task('manager'))).status, 403);
    assert.equal((await request('POST', '/api/manager/team/archive/outside', { reason: 'Archive' }, task('manager'))).status, 403);
    const archived = runCli(['manager', 'archive', 'worker', '--group', 'team', '--reason', 'The task recorded its final result.'], 'manager');
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(JSON.parse(archived.stdout).archived, 'worker');
    assert.equal(runCli(['delegation', 'audit', '--group', 'team'], 'manager').status, 0);
    assert.equal(runCli(['delegation', 'off', '--all']).status, 0);
    assert.equal((await request('GET', '/api/delegation/team')).data.enabled, false);
  } finally { await resources.stopChild(child); }
});
