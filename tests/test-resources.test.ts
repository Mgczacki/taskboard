import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { waitFor } from './helpers/wait-for.ts';

const fixture = join(import.meta.dirname, 'fixtures', 'test-resources-child.test.mjs');
for (const mode of ['failure', 'timeout', 'interrupt'] as const) {
  test(`private tmux and Chrome child end after ${mode}`, { timeout: 15000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `tb-resources-${mode}-`)));
    const socket = `tb-resources-${mode}-${process.pid}`;
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: process.cwd(), env: { ...process.env, TB_FIXTURE_ROOT: root, TB_FIXTURE_SOCKET: socket, TB_FIXTURE_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    try {
      await waitFor(() => existsSync(join(root, 'ready')), { description: 'resource fixture to start', timeoutMs: 5000, state: () => output });
      const pid = Number(readFileSync(join(root, 'chrome.pid'), 'utf8'));
      if (mode === 'interrupt') child.kill('SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`fixture did not exit: ${output.slice(-500)}`)), 8000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      if (mode !== 'interrupt') assert.notEqual(child.exitCode, 0, 'the fixture reports its intended failure');
      await waitFor(() => {
        const tmux = spawnSync('tmux', ['-L', socket, 'has-session', '-t', 'fixture'], { timeout: 1000 });
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        return tmux.status !== 0 && !alive;
      }, { description: `${mode} fixture resources to end`, timeoutMs: 4000, state: () => output.slice(-500) });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      rmSync(root, { recursive: true, force: true });
    }
  });
}
