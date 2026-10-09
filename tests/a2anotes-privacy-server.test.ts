import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { waitFor } from './helpers/wait-for.ts';

test('HTTP and event sockets keep incoming card text on the dashboard', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-mail-privacy-'));
  const tbdir = join(root, 'server'), vault = join(root, 'vault');
  mkdirSync(tbdir); mkdirSync(join(vault, 'tasks'), { recursive: true });
  const privateText = 'Private incoming message text';
  writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ name: 'mail-privacy', controller: { autostart: false } }));
  const accountDir = join(root, 'account'); mkdirSync(accountDir);
  writeFileSync(join(tbdir, 'accounts.json'), JSON.stringify([{ id: 'test', agent: 'codex', name: 'Test', dir: accountDir, isDefault: true, maxParallel: 1 }]));
  writeFileSync(join(tbdir, 'approvals.json'), JSON.stringify([{ id: 'incoming-card', actor: 'controller', action: 'mail-in',
    summary: 'Incoming message', detail: privateText, state: 'approved', created: new Date().toISOString(),
    payload: { message: 'incoming-message', direction: 'in', audience: 'person', stage: 'incoming', body: privateText, subject: privateText } }]));
  const port = await new Promise<number>(resolve => {
    const socket = createServer(); socket.listen(0, '127.0.0.1', () => {
      const port = (socket.address() as { port: number }).port; socket.close(() => resolve(port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TASK_|TB_|TASKBOARD_)/.test(key)));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(),
    env: { ...env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault,
      TASKBOARD_TMUX_SOCKET: `tb-mail-privacy-${process.pid}`, TASKBOARD_MACHINE_NAME: 'mail-privacy' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const sockets: WebSocket[] = [];
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(output);
      try { return (await fetch(base + '/api/info')).ok; } catch { return false; }
    }, { description: 'the isolated Taskboard server', timeoutMs: 15000 });
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const controllerToken = readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim();
    const controller = { 'x-taskboard-token': token, 'x-tb-actor': 'controller', 'x-tb-mail-controller': controllerToken };
    const user = { origin: base };
    for (const path of ['/api/approvals', '/api/approvals/incoming-card']) {
      assert.equal((await (await fetch(base + path, { headers: user })).text()).includes(privateText), true);
      assert.equal((await (await fetch(base + path, { headers: controller })).text()).includes(privateText), false);
    }
    for (const decision of ['approve', 'deny', 'return']) {
      const result = await fetch(base + `/api/approvals/incoming-card/${decision}`, { method: 'POST',
        headers: { ...controller, origin: base, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(result.status, 403, 'agent credentials cannot become a dashboard decision');
      assert.equal((await result.text()).includes(privateText), false);
    }
    const received: any[][] = [];
    for (const [url, options] of [
      [`ws://127.0.0.1:${port}/ws/events`, { headers: { origin: base } }],
      [`ws://127.0.0.1:${port}/ws/events?token=${token}`, {}],
    ] as const) {
      const messages: any[] = []; received.push(messages);
      const ws = new WebSocket(url, options); sockets.push(ws);
      ws.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'approvals') messages.push(message); });
    }
    await waitFor(() => received.every(messages => messages.length === 1), { description: 'the first approval events', timeoutMs: 5000 });
    assert.equal(JSON.stringify(received[0]).includes(privateText), true);
    assert.equal(JSON.stringify(received[1]).includes(privateText), false);
    // Request an unrelated card to exercise a broadcast. The test never approves this request.
    const update = await fetch(base + '/api/restart/request', { method: 'POST',
      headers: { ...controller, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(update.status, 202);
    await waitFor(() => received.every(messages => messages.length >= 2), { description: 'the changed approval events', timeoutMs: 5000 });
    assert.equal(JSON.stringify(received[0]).includes(privateText), true);
    assert.equal(JSON.stringify(received[1]).includes(privateText), false);
  } finally {
    sockets.forEach(ws => ws.terminate());
    if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
  }
});
