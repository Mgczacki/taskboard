import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// A group manager runs `tb archive <task>` (server/manager-archive.ts). Settings let agents act without a card and the
// manager has the widest preset, so each card below comes from the manager archive rule alone.
test('a group manager requests the archive of a task of its group and only the user decides the card', { timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-manager-archive-')));
  const dir = join(root, 'state'), vault = join(root, 'vault'), work = join(root, 'work'), bin = join(root, 'bin');
  for (const path of [dir, join(vault, 'tasks'), join(vault, 'groups'), work, bin]) mkdirSync(path, { recursive: true });
  const socket = `tb-manager-archive-${process.pid}`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TASK_|TB_|TASKBOARD_)/.test(key))) as NodeJS.ProcessEnv;
  const agent = join(bin, 'claude');
  writeFileSync(agent, '#!/bin/sh\n[ "$1" = auth ] && { echo \'{"loggedIn":true,"email":"test@example.invalid"}\'; exit 0; }\nexec sleep 600\n');
  chmodSync(agent, 0o755);
  const accountDir = join(root, 'account'); mkdirSync(accountDir);
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify([{ id: 'claude-test', agent: 'claude', name: 'Claude test', dir: accountDir, maxParallel: 20, created: new Date().toISOString() }]));
  writeFileSync(join(dir, 'machine.json'), JSON.stringify({ name: 'manager-archive-test', controller: { autostart: false, remoteControl: false }, permissions: { controllerNeedsApproval: false, agentsNeedApproval: false, trustWorkspaces: false, autoReview: false } }));
  const time = new Date().toISOString();
  const ids = ['manager', 'inside', 'denied', 'moved', 'revoked', 'outside', 'controller'];
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
  ids.forEach((id, i) => {
    writeFileSync(join(vault, 'tasks', `${id}.md`), `---\nid: ${id}\nnum: ${i + 1}\ntitle: Task ${id}\nagent: claude\naccount: claude-test\nstatus: idle\n${id === 'controller' ? 'role: controller\n' : ''}cwd: ${JSON.stringify(work)}\nfolder: ${JSON.stringify(work)}\nsession: ${id}-session\ncreated: ${time}\nupdated: ${time}\nstatusAt: ${time}\n---\n${id}\n`);
    assert.equal(tmux('new-session', '-d', '-s', `${id}-session`, 'sleep 600').status, 0);
  });
  const groupNote = (id: string, tasks: string[], manager: boolean) => writeFileSync(join(vault, 'groups', `${id}.md`), `---\nid: ${id}\nname: ${id}\ncolor: '#58a6ff'\ntasks:\n${tasks.map(t => `  - ${t}\n`).join('')}created: ${JSON.stringify(time)}\n${manager ? 'manager: manager\nmanagerPreset: create\n' : ''}---\n# ${id}\n`);
  // the controller is in the managed group on purpose: the group does not give the right to archive it
  groupNote('first', ['manager', 'inside', 'denied', 'moved', 'revoked', 'controller'], true);
  groupNote('second', ['outside'], false);
  const port = await new Promise<number>(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(typeof address === 'object' && address ? address.port : 0)); }); });
  const url = `http://127.0.0.1:${port}`;
  const env = { ...clean, PATH: `${bin}:${process.env.PATH}`, TASKBOARD_PORT: String(port), TASKBOARD_DIR: dir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: socket, TASKBOARD_MACHINE_NAME: 'manager-archive-test' };
  const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; server.stdout.on('data', data => output += data); server.stderr.on('data', data => output += data);
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { ready = (await fetch(url + '/api/info')).ok; } catch { /* starting */ } if (ready) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(ready, output);
    const tokens = JSON.parse(readFileSync(join(dir, 'task-tokens.json'), 'utf8')) as Record<string, string>;
    const tb = (args: string[], as = 'manager') => new Promise<{ code: number | null; out: string }>(resolve => {
      const child = spawn(process.execPath, ['bin/tb', ...args], { cwd: process.cwd(), env: { ...env, TB_URL: url, TB_TOKEN_FILE: join(dir, 'token'), TB_TASK_TOKEN: tokens[as], TASK_ID: as }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; child.stdout.on('data', data => out += data); child.stderr.on('data', data => out += data);
      child.on('close', code => resolve({ code, out }));
    });
    // the dashboard: Taskboard's own origin, no token and no task identity
    const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', origin: url, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text(); let data: any; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data };
    };
    type Card = { id: string; actor: string; action: string; state: string; summary: string; detail: string; result?: string; payload?: any };
    const cards = async () => (await request('GET', '/api/approvals')).data as Card[];
    const pendingFor = async (target: string) => (await cards()).find(c => c.action === 'kill' && c.state === 'pending' && c.payload?.managerArchive?.target === target);
    const status = (id: string) => /^status: (\S+)$/m.exec(readFileSync(join(vault, 'tasks', `${id}.md`), 'utf8'))?.[1];
    const sessionLives = (id: string) => tmux('has-session', '-t', `${id}-session`).status === 0;
    const ask = async (target: string) => {
      const r = await tb(['archive', target]);
      assert.equal(r.code, 2, r.out + output);
      assert.match(r.out, /Approval pending: card/);
      assert.doesNotMatch(r.out, /ended and archived\.\s*$/);
      const card = await pendingFor(target); assert.ok(card, `card for ${target}`);
      // nothing is archived before the decision
      assert.notEqual(status(target), 'archived'); assert.ok(sessionLives(target));
      return card;
    };

    // refused without a card: itself, the controller, a task of another group
    const self = await tb(['archive', 'manager']);
    assert.equal(self.code, 1); assert.match(self.out, /cannot archive itself/);
    const controller = await request('POST', '/api/tasks/controller/kill', {}, { origin: '', 'x-taskboard-token': readFileSync(join(dir, 'token'), 'utf8').trim(), 'x-tb-actor': 'manager', 'x-tb-task-token': tokens.manager });
    assert.equal(controller.status, 403, JSON.stringify(controller.data)); assert.match(controller.data.error, /cannot archive the controller/);
    const outside = await tb(['archive', 'outside']);
    assert.equal(outside.code, 1); assert.match(outside.out, /outside the manager group/);
    assert.equal((await cards()).filter(c => c.action === 'kill').length, 0);
    for (const id of ['manager', 'outside', 'controller']) { assert.notEqual(status(id), 'archived'); assert.ok(sessionLives(id)); }

    // a task of the group: one card with the exact target and the effects
    const card = await ask('inside');
    assert.equal(card.actor, 'manager');
    assert.deepEqual(card.payload.managerArchive, { manager: 'manager', group: 'first', target: 'inside' });
    assert.match(card.summary, /end and archive #2 Task inside/);
    assert.match(card.detail, /Target: #2 Task inside \(task id inside\)/);
    assert.match(card.detail, /Group: first \(group id first\)/);
    assert.match(card.detail, /Requested by: #1 Task manager/);
    assert.match(card.detail, /Effects of Approve:[\s\S]*ends the agent session of #2[\s\S]*status archived/);
    // a caller with the token or a task identity cannot decide the card
    const token = readFileSync(join(dir, 'token'), 'utf8').trim();
    const byAgent = await request('POST', `/api/approvals/${card.id}/approve`, {}, { 'x-taskboard-token': token });
    assert.equal(byAgent.status, 403, JSON.stringify(byAgent.data));
    assert.notEqual(status('inside'), 'archived');
    // the controller cannot approve it, and a plan cannot hold it
    const listed = (await request('GET', '/api/controller/approvals')).data.cards.find((c: any) => c.id === card.id);
    assert.match(listed.userOnly, /Only the user decides this card/);
    const plan = await request('POST', '/api/plan/request', { title: 'approve plan', steps: [{ card: card.id }] }, { origin: '', 'x-taskboard-token': token, 'x-tb-actor': 'manager', 'x-tb-task-token': tokens.manager });
    assert.equal(plan.status, 403, JSON.stringify(plan.data)); assert.match(plan.data.error, /Only the user decides this card/);
    // the user approves on the dashboard: the task is archived and its session ends
    const approved = await request('POST', `/api/approvals/${card.id}/approve`, {});
    assert.equal(approved.status, 200); assert.equal(approved.data.state, 'approved', JSON.stringify(approved.data));
    assert.equal(status('inside'), 'archived'); assert.ok(!sessionLives('inside'));
    // the card is used: a second approve changes nothing, and a new request for an archived task is refused
    assert.equal((await request('POST', `/api/approvals/${card.id}/approve`, {})).data.state, 'approved');
    const again = await tb(['archive', 'inside']);
    assert.equal(again.code, 1); assert.match(again.out, /archived already/);

    // denial: nothing is archived, and a later request makes a new card
    const deniedCard = await ask('denied');
    const denied = await request('POST', `/api/approvals/${deniedCard.id}/deny`, {});
    assert.equal(denied.data.state, 'denied');
    assert.notEqual(status('denied'), 'archived'); assert.ok(sessionLives('denied'));
    assert.equal((await request('POST', `/api/approvals/${deniedCard.id}/approve`, {})).data.state, 'denied');
    assert.notEqual(status('denied'), 'archived');
    assert.notEqual((await ask('denied')).id, deniedCard.id);

    // the target left the group after the request: the approval archives nothing
    const movedCard = await ask('moved');
    assert.equal((await request('POST', '/api/groups/move', { taskId: 'moved', fromId: 'first', toId: 'second' })).status, 200);
    const moved = await request('POST', `/api/approvals/${movedCard.id}/approve`, {});
    assert.equal(moved.data.state, 'failed', JSON.stringify(moved.data));
    assert.match(moved.data.result, /outside the manager group\. Nothing was archived\./);
    assert.notEqual(status('moved'), 'archived'); assert.ok(sessionLives('moved'));

    // the manager lost the role after the request: the approval archives nothing
    const revokedCard = await ask('revoked');
    assert.equal((await request('POST', '/api/manager/first', { task: null })).status, 200);
    const revoked = await request('POST', `/api/approvals/${revokedCard.id}/approve`, {});
    assert.equal(revoked.data.state, 'failed', JSON.stringify(revoked.data));
    assert.match(revoked.data.result, /not a group manager\. Nothing was archived\./);
    assert.notEqual(status('revoked'), 'archived'); assert.ok(sessionLives('revoked'));

    const audit = readFileSync(join(dir, 'manager-actions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(x => x.action === 'archive-request');
    assert.ok(audit.some(x => x.target === 'inside' && /^archived, card /.test(x.result)));
    assert.ok(audit.some(x => x.target === 'moved' && /^refused at approval/.test(x.result)));
  } finally {
    server.kill('SIGTERM'); if (server.exitCode === null) await once(server, 'exit');
    tmux('kill-server');
    rmSync(root, { recursive: true, force: true });
  }
});
