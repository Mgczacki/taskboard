// A real server restart with a pending permit card: the second server expires the permit, the task can request again,
// and `tb permit withdraw` cancels a pending permit and closes its card (server/index.ts, permits.closeOrphans).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers/wait-for.ts';

test('a restart expires a permit whose card expired, and a task can withdraw its pending permit', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-permit-orphans-restart-')));
  const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), work = join(root, 'work');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TASK_|TB_|TASKBOARD_)/.test(name)));
  for (const path of [tbdir, join(vault, 'tasks', 't216'), work]) mkdirSync(path, { recursive: true });
  writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false }, permitRequestLimits: { enabled: false } }));
  writeFileSync(join(vault, 'tasks', 't216.md'), `---\n${Object.entries({ id: 't216', num: 216, title: 't216', agent: 'codex', status: 'idle', session: 't216', created: '2026-01-01T00:00:00.000Z', cwd: work, folder: work })
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join('\n')}\n---\n# t216\n`);
  const port = await new Promise<number>(resolvePort => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolvePort((address as { port: number }).port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let output = '';
  const start = async () => {
    output = '';
    const c = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...clean, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: `tb-permit-orphans-${port}`, TASKBOARD_MACHINE_NAME: 'permit-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout!.on('data', data => { output += data; }); c.stderr!.on('data', data => { output += data; });
    child = c;
    await waitFor(async () => { if (c.exitCode !== null) throw new Error(output); return (await fetch(base + '/api/info')).ok; }, { description: 'the isolated permit test server', timeoutMs: 15000, state: () => output });
  };
  const stop = async () => { const c = child; if (c && c.exitCode === null) await new Promise<void>(done => { c.once('exit', () => done()); c.kill('SIGTERM'); }); };
  const cli = (args: string[]) => new Promise<{ code: number | null; out: string }>(done => {
    const proc = spawn(process.execPath, [resolve('bin/tb'), ...args], { cwd: work, env: { ...clean, TASK_ID: 't216', TB_URL: base, TB_TOKEN_FILE: join(tbdir, 'token') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { out += data; }); proc.on('close', code => done({ code, out }));
  });
  const headers = () => ({ 'x-taskboard-token': readFileSync(join(tbdir, 'token'), 'utf8').trim(), 'x-tb-task-token': readFileSync(join(tbdir, 'task-tokens', 't216'), 'utf8').trim(), 'x-tb-actor': 't216' });
  const permit = async (id: string) => (await fetch(`${base}/api/permits/${id}`, { headers: headers() })).json() as Promise<any>;
  const card = async (id: string) => ((await (await fetch(base + '/api/approvals')).json()) as any[]).find(c => c.id === id);
  const request = async (command: string) => {
    const r = await cli(['permit', 'request', '--reason', 'Read the folder', '--command', command]);
    assert.equal(r.code, 0, r.out + output);
    const id = r.out.match(/Permit ([0-9a-f-]+) waits/)![1];
    return permit(id);
  };
  try {
    await start();
    const first = await request('pwd');
    assert.equal(first.state, 'pending');
    assert.equal(first.expiresAt, '');
    assert.equal((await card(first.approvalId)).state, 'pending');
    const blocked = await cli(['permit', 'request', '--reason', 'Second', '--command', 'ls']);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.out, /already has a pending permit/);

    await stop();
    await start();
    const after = await permit(first.id);
    assert.equal(after.state, 'expired', JSON.stringify(after) + output);
    assert.deepEqual(after.steps.map((s: any) => s.state), ['cancelled']);
    assert.equal(after.steps[0].exitCode, undefined);
    assert.match(after.error, new RegExp(`approval card ${first.approvalId} closed without a decision on the permit \\(expired: Taskboard restarted before you decided`));
    assert.match(output, new RegExp(`permit ${first.id} of task #216 expired`));
    assert.equal((await card(first.approvalId)).state, 'expired');
    // the task got the reason in its inbox
    const inbox = readFileSync(join(vault, 'tasks', 't216', 'inbox', `permit-${first.id}.md`), 'utf8');
    assert.match(inbox, /Result: expired/);
    assert.match(inbox, /Reason: Its approval card/);

    // the task can request again, and withdraw that request
    const second = await request('ls');
    assert.equal((await card(second.approvalId)).state, 'pending');
    const withdrawn = await cli(['permit', 'withdraw', second.id, '--reason', 'Not needed any more.']);
    assert.equal(withdrawn.code, 0, withdrawn.out + output);
    assert.match(withdrawn.out, /cancelled\. Task #216 withdrew this permit before a decision: Not needed any more\. Nothing ran\./);
    const gone = await permit(second.id);
    assert.equal(gone.state, 'cancelled');
    assert.deepEqual(gone.steps.map((s: any) => s.state), ['cancelled']);
    const closed = await card(second.approvalId);
    assert.equal(closed.state, 'expired');
    assert.match(closed.result, /withdrew this permit.*Nothing ran\./);
    const again = await cli(['permit', 'withdraw', second.id]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /Only a pending permit can be withdrawn/);
    assert.equal((await request('pwd')).state, 'pending');
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
