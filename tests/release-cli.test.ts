import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('release help sends no request, and an approved card ends the wait immediately', async () => {
  const requests: string[] = [];
  let state = 'approved';
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      res.statusCode = 202;
      res.end(JSON.stringify({ approval: { id: 'card', summary: 'release Taskboard' } }));
    } else res.end(JSON.stringify({ action: 'release', state, result: 'Task #444 may run pnpm release --ref 7eb37b9f once.' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const run = (args: string[]) => new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/tb', ...args], {
      env: { ...process.env, TASK_ID: 'release-test', TB_TASK_TOKEN: 'test-only', TB_TOKEN_FILE: '/dev/null', TB_URL: `http://127.0.0.1:${address.port}` },
    });
    let text = '';
    child.stdout.on('data', b => { text += b; });
    child.stderr.on('data', b => { text += b; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, text }));
  });
  try {
    for (const command of ['release-request', 'release-result']) {
      for (const flag of ['--help', '-h']) {
        const result = await run([command, '--ref', '7eb37b9f', flag]);
        assert.equal(result.code, 0, result.text);
        assert.match(result.text, new RegExp(`tb ${command}`));
      }
    }
    assert.deepEqual(requests, [], 'help cannot create or poll a card');
    for (const args of [['--ref'], ['--unknown'], ['--ref', '--unknown']]) {
      assert.equal((await run(['release-request', ...args])).code, 1);
    }
    assert.deepEqual(requests, [], 'invalid options cannot create a card');
    const pending = await run(['release-request', '--ref', '7eb37b9f']);
    assert.equal(pending.code, 2);
    assert.match(pending.text, /Approval pending: card card/);
    assert.match(pending.text, /tb release-result card --wait/);
    assert.doesNotMatch(pending.text, /Run that command now/);
    const start = Date.now();
    const approved = await run(['release-result', 'card', '--wait', '--timeout', '540']);
    assert.equal(approved.code, 0, approved.text);
    assert.match(approved.text, /approved card authorizes that command/);
    assert.match(approved.text, /Do not wait for expiry/);
    assert.ok(Date.now() - start < 2000, 'approval must not enter the polling sleep');
    assert.deepEqual(requests, ['POST /api/release/request', 'GET /api/approvals/card']);
    state = 'pending';
    const waiting = await run(['release-result', 'card', '--wait', '--timeout', '0']);
    assert.equal(waiting.code, 2);
    assert.doesNotMatch(waiting.text, /Run it now/);
    state = 'denied';
    assert.equal((await run(['release-result', 'card', '--wait'])).code, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
