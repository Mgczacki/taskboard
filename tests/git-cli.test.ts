import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('all Git subcommands handle help and reject flag values without sending requests', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url!, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: 'ok', state: 'succeeded', push: { id: 'p', state: 'pending' },
        pullRequest: { id: 'pr', state: 'pending' }, approval: { id: 'card' } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const run = (args: string[], task = 'cli-test') => new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/tb', 'git', ...args], {
      env: { ...process.env, TASK_ID: task, TB_TASK_TOKEN: 'test-only', TB_TOKEN_FILE: '/dev/null', TB_URL: `http://127.0.0.1:${address.port}` },
    });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, text }));
  });
  const commands = ['commit', 'reword', 'rebase', 'merge-from', 'repair', 'check', 'merge-request', 'push-request',
    'push-result', 'pr-request', 'pr-result', 'pr-merge-request', 'pr-merge-result', 'pr-ready-request', 'pr-ready-result'];
  try {
    for (const command of commands) {
      for (const help of ['--help', '-h']) {
        const result = await run([command, help], '');
        assert.equal(result.code, 0, `${command}: ${result.text}`);
        assert.match(result.text, new RegExp(`tb git ${command}`));
      }
      for (const flag of ['--unknown', '-a']) {
        assert.equal((await run([command, flag])).code, 1, command);
      }
    }
    assert.deepEqual(requests, []);
    const invalid = [
      ['toString'], ['constructor'],
      ['commit'], ['commit', '-a message'], ['commit', '  --help'], ['commit', 'Message', '--amend'],
      ['reword', '-m', 'Message'], ['commit', '--worktree', '-a', 'Message'],
      ['rebase', '--continue', '--stage', '--abort'], ['merge-from', '--continue', '--stage', '-a'],
      ['repair', '--squash', '--base', 'master', '-m', '--unknown'],
      ['repair', '--squash', '--base', 'master', '-m'], ['repair', '--list', '-m', 'Message'],
      ['repair', '--list', '--base', 'master'], ['repair', '--drop', '--squash'],
      ['check', '--base'], ['check', '--base', '--unknown'],
      ['merge-request', 'extra'], ['push-request', '--reason', 'Push', '--unknown'],
      ['push-request', '--reason', '--branch', 'task/x'], ['push-request', '--reason', 'Push', '--force'],
      ['pr-request', '--title', '--draft'], ['pr-request', '--title', 'Title', '--body-file'],
      ['pr-merge-request', '--pr', '1', '--head', '--unknown'], ['pr-ready-request', '--pr', '--head', 'abc1234'],
      ['commit', 'Message', '--worktree', 'one', '--worktree', 'two'],
      ['check', '--base', 'master', '--base', 'origin/main'],
    ];
    for (const command of ['push-result', 'pr-result', 'pr-merge-result', 'pr-ready-result']) {
      invalid.push([command, '--wait'], [command, 'id', '--unknown'], [command, 'id', 'extra']);
    }
    for (const args of invalid) {
      const result = await run(args);
      assert.equal(result.code, 1, `${args.join(' ')}: ${result.text}`);
    }
    assert.deepEqual(requests, []);
    for (const args of [['commit', 'Fix --help'], ['reword', 'New message', '--worktree', 'api'],
      ['repair', '--squash', '--base', 'abc1234', '-m', 'One commit'],
      ['pr-request', '--title', 'Title', '--body', '- First change\n- Second change'],
      ['merge-request'], ['push-request', '--reason', 'Publish'], ['push-result', '--wait', 'id']]) {
      const result = await run(args);
      assert.equal(result.code, 0, result.text);
    }
    assert.deepEqual(requests, [
      { path: '/api/git/commit', body: { message: 'Fix --help' } },
      { path: '/api/git/reword', body: { message: 'New message', worktree: 'api' } },
      { path: '/api/git/repair', body: { mode: 'squash', base: 'abc1234', message: 'One commit' } },
      { path: '/api/git/pr-request', body: { title: 'Title', body: '- First change\n- Second change', draft: false } },
      { path: '/api/git/merge-request', body: {} },
      { path: '/api/git/push-request', body: { reason: 'Publish', remote: 'origin', thenRelease: false } },
      { path: '/api/git/pushes/id', body: null },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
