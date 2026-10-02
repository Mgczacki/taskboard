import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'tb-transfer-api-'));
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function port() {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const value = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(r => server.close(() => r()));
  return value;
}
const json = async (url: string, method = 'GET', body?: unknown, origin?: string) => {
  const response = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
};
async function ready(url: string) {
  for (let i = 0; i < 100; i++) {
    try { await json(`${url}/api/info`); return; } catch { await delay(100); }
  }
  throw new Error(`Test server did not start: ${url}`);
}

test('a paired target starts the handoff before the source is archived', { timeout: 60000 }, async () => {
  const sourcePort = await port(), targetPort = await port();
  const sourceUrl = `http://127.0.0.1:${sourcePort}`, targetUrl = `http://127.0.0.1:${targetPort}`;
  const sourceToken = 'a'.repeat(48), targetToken = 'b'.repeat(48);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const fake = `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true}'; exit 0; fi\nif [ "$1" = models ]; then printf 'test\\tmodel\\n'; exit 0; fi\nif [ "$1" = login ]; then echo 'Logged in'; exit 0; fi\nif [ -e "$FAIL_LAUNCH_MARKER" ]; then exit 1; fi\necho TEST_AGENT_READY\nsleep 40\n`;
  for (const name of ['claude', 'codex', 'agy']) { const file = join(bin, name); writeFileSync(file, fake); chmodSync(file, 0o755); }
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=master', remote], { stdio: 'ignore' });
  const sourceRepo = join(root, 'source-repo'), targetRepo = join(root, 'target-repo');
  execFileSync('git', ['clone', remote, sourceRepo], { stdio: 'ignore' });
  writeFileSync(join(sourceRepo, 'tracked.txt'), 'before\n');
  execFileSync('git', ['-C', sourceRepo, 'add', '.']);
  execFileSync('git', ['-C', sourceRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture'], { stdio: 'ignore' });
  execFileSync('git', ['-C', sourceRepo, 'push', 'origin', 'master'], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, targetRepo], { stdio: 'ignore' });
  const configure = (name: string, token: string, peerName: string, peerUrl: string, peerToken: string) => {
    const dir = join(root, name); mkdirSync(join(dir, 'state'), { recursive: true }); mkdirSync(join(dir, 'vault'), { recursive: true });
    writeFileSync(join(dir, 'state', 'token'), token);
    writeFileSync(join(dir, 'state', 'machine.json'), JSON.stringify({ name, controller: { autostart: false }, permissions: { trustWorkspaces: false, autoReview: false, agentsNeedApproval: false } }));
    writeFileSync(join(dir, 'state', 'machines.json'), JSON.stringify([{ id: peerName, name: peerName, url: peerUrl, token: peerToken }]));
    return dir;
  };
  const sourceDir = configure('source', sourceToken, 'target', targetUrl, targetToken);
  const targetDir = configure('target', targetToken, 'source', sourceUrl, sourceToken);
  const children: ChildProcess[] = [];
  const server = (dir: string, portNumber: number) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'),
      env: { ...process.env, TASKBOARD_PORT: String(portNumber), TASKBOARD_DIR: join(dir, 'state'), TASKBOARD_VAULT: join(dir, 'vault'), FAIL_LAUNCH_MARKER: join(dir, 'fail-launch'),
        TASKBOARD_TMUX_SOCKET: `tb-transfer-api-${portNumber}`, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  };
  try {
    server(targetDir, targetPort); server(sourceDir, sourcePort);
    await Promise.all([ready(sourceUrl), ready(targetUrl)]);
    const created = await json(`${sourceUrl}/api/tasks`, 'POST', { title: 'Move between machines', desc: 'Continue the work.', agent: 'claude',
      folder: sourceRepo, worktree: false, account: 'claude-default' }, sourceUrl);
    writeFileSync(join(sourceRepo, 'tracked.txt'), 'after\n');
    for (let i = 0; i < 40; i++) {
      const machines = await json(`${sourceUrl}/api/machines`);
      if (machines.some((m: { id: string; online: boolean }) => m.id === 'target' && m.online)) break;
      await delay(100);
    }
    const check = await json(`${sourceUrl}/api/tasks/${created.id}/transfer/check`, 'POST', { machine: 'target', folder: targetRepo }, sourceUrl);
    assert.equal(check.ready, true);
    assert.ok(check.workspace.files.some((f: { path: string }) => f.path === 'tracked.txt'));
    const moved = await json(`${sourceUrl}/api/tasks/${created.id}/transfer/move`, 'POST', { machine: 'target', folder: targetRepo,
      account: 'claude-default', fingerprint: check.fingerprint, handoffOnly: false, includeFiles: true, includeWorkspace: true,
      includeTranscript: false, stopNow: true }, sourceUrl);
    const sourceTask = (await json(`${sourceUrl}/api/tasks`)).find((t: { id: string }) => t.id === created.id);
    const targetTask = (await json(`${targetUrl}/api/tasks`)).find((t: { id: string }) => t.id === moved.id);
    assert.equal(sourceTask.status, 'archived');
    assert.equal(sourceTask.transfer.state, 'started');
    assert.equal(targetTask.transfer.state, 'started');
    assert.equal(readFileSync(join(targetRepo, 'tracked.txt'), 'utf8'), 'after\n');
    assert.ok(existsSync(join(targetDir, 'vault', 'tasks', moved.id, 'handoffs', `transfer-${moved.transferId}.md`)));
    const secondSource = join(root, 'second-source'), secondTarget = join(root, 'second-target');
    execFileSync('git', ['clone', remote, secondSource], { stdio: 'ignore' });
    execFileSync('git', ['clone', remote, secondTarget], { stdio: 'ignore' });
    const second = await json(`${sourceUrl}/api/tasks`, 'POST', { title: 'Move from remote panel', desc: 'Continue on target.', agent: 'claude',
      folder: secondSource, worktree: false, account: 'claude-default' }, sourceUrl);
    const remoteId = encodeURIComponent(`source~${second.id}`);
    const remoteCheck = await json(`${targetUrl}/api/tasks/${remoteId}/transfer/check`, 'POST', { machine: 'target', folder: secondTarget }, targetUrl);
    assert.equal(remoteCheck.ready, true);
    const remoteMove = await json(`${targetUrl}/api/tasks/${remoteId}/transfer/move`, 'POST', { machine: 'target', folder: secondTarget,
      account: 'claude-default', fingerprint: remoteCheck.fingerprint, handoffOnly: false, includeFiles: true, includeWorkspace: true,
      includeTranscript: false, stopNow: true }, targetUrl);
    assert.ok((await json(`${targetUrl}/api/tasks`)).some((t: { id: string; transfer?: { state: string } }) => t.id === remoteMove.id && t.transfer?.state === 'started'));
    const bundleSource = join(root, 'bundle-source'), bundleTarget = join(root, 'bundle-target');
    execFileSync('git', ['clone', remote, bundleSource], { stdio: 'ignore' });
    execFileSync('git', ['clone', remote, bundleTarget], { stdio: 'ignore' });
    writeFileSync(join(bundleSource, 'new-commit.txt'), 'Only on the source.\n');
    execFileSync('git', ['-C', bundleSource, 'add', '.']);
    execFileSync('git', ['-C', bundleSource, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Local commit'], { stdio: 'ignore' });
    const bundleTask = await json(`${sourceUrl}/api/tasks`, 'POST', { title: 'Move local commit', desc: 'Keep the local commit.',
      agent: 'claude', folder: bundleSource, worktree: false, account: 'claude-default' }, sourceUrl);
    const bundleCheck = await json(`${sourceUrl}/api/tasks/${bundleTask.id}/transfer/check`, 'POST', { machine: 'target', folder: bundleTarget }, sourceUrl);
    assert.equal(bundleCheck.ready, false);
    assert.equal(bundleCheck.bundle.available, true);
    const bundleMove = await json(`${sourceUrl}/api/tasks/${bundleTask.id}/transfer/move`, 'POST', { machine: 'target', folder: bundleTarget,
      account: 'claude-default', fingerprint: bundleCheck.fingerprint, handoffOnly: false, useBundle: true,
      includeFiles: true, includeWorkspace: true, includeTranscript: false, stopNow: true }, sourceUrl);
    const bundled = (await json(`${targetUrl}/api/tasks`)).find((t: { id: string }) => t.id === bundleMove.id);
    assert.equal(bundled.transfer.state, 'started');
    assert.ok(existsSync(join(bundled.cwd, 'new-commit.txt')));
    assert.equal(execFileSync('git', ['-C', bundled.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), bundleCheck.source.head);
    const thirdSource = join(root, 'third-source'), thirdTarget = join(root, 'third-target');
    execFileSync('git', ['clone', remote, thirdSource], { stdio: 'ignore' });
    execFileSync('git', ['clone', remote, thirdTarget], { stdio: 'ignore' });
    const third = await json(`${sourceUrl}/api/tasks`, 'POST', { title: 'Recover failed transfer', desc: 'Continue after a failed target start.',
      agent: 'claude', folder: thirdSource, worktree: false, account: 'claude-default' }, sourceUrl);
    const thirdCheck = await json(`${sourceUrl}/api/tasks/${third.id}/transfer/check`, 'POST', { machine: 'target', folder: thirdTarget }, sourceUrl);
    writeFileSync(join(targetDir, 'fail-launch'), 'fail');
    await assert.rejects(json(`${sourceUrl}/api/tasks/${third.id}/transfer/move`, 'POST', { machine: 'target', folder: thirdTarget,
      account: 'claude-default', fingerprint: thirdCheck.fingerprint, handoffOnly: false, includeFiles: true, includeWorkspace: true,
      includeTranscript: false, stopNow: true }, sourceUrl), /target agent stopped/i);
    const failed = (await json(`${sourceUrl}/api/tasks`)).find((t: { id: string }) => t.id === third.id);
    assert.equal(failed.status, 'suspended');
    assert.equal(failed.transfer.state, 'failed');
    const recovered = await json(`${sourceUrl}/api/tasks/${third.id}/transfer/recover`, 'POST', { action: 'resume-source' }, sourceUrl);
    assert.equal(recovered.state, 'source-ready');
    assert.ok(!(await json(`${targetUrl}/api/tasks`)).some((t: { id: string }) => t.id === failed.transfer.task));
    const resumed = await json(`${sourceUrl}/api/tasks/${third.id}/resume`, 'POST', {}, sourceUrl);
    // the fake Claude Code writes no transcript, so the source has no saved conversation and starts again with its first prompt
    assert.equal(resumed.status, 'working');
    assert.match(resumed.statusSource, /new session with its first prompt/);
  } finally {
    for (const child of children) child.kill('SIGTERM');
    for (const portNumber of [sourcePort, targetPort]) {
      try { execFileSync('tmux', ['-L', `tb-transfer-api-${portNumber}`, 'kill-server'], { stdio: 'ignore' }); } catch { /* no test session */ }
    }
  }
});
