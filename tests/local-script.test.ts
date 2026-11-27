import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localScriptEnvironment, localScriptExecution } from '../server/local-script.ts';

test('the local runtime writes report prose and denies protected effects', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tb-local-script-'));
  const work = join(root, 'work'), task = join(root, 'task'), outbox = join(task, 'outbox');
  mkdirSync(work); mkdirSync(outbox, { recursive: true });
  const script = join(task, 'report-generator.mjs');
  const run = (source: string) => {
    writeFileSync(script, source);
    const execution = localScriptExecution(['node', script], work, task);
    return spawnSync(execution.bin, execution.args, { cwd: work, encoding: 'utf8', timeout: 10000,
      env: localScriptEnvironment({ ...process.env, NODE_OPTIONS: '--allow-child-process', TASKBOARD_TOKEN: 'test-secret' }) });
  };
  try {
    writeFileSync(join(outbox, 'input.json'), '{"samples":3}');
    const result = run(`import fs from 'node:fs';
      const out=${JSON.stringify(outbox)};
      const samples=JSON.parse(fs.readFileSync(out+'/input.json')).samples;
      fs.writeFileSync(out+'/phase-1-processes.md', 'Samples: '+samples);
      fs.writeFileSync(out+'/phase-1-and-2-report.md', 'Use pnpm release only after approval. Read server.pid.');
      if (process.env.TASKBOARD_TOKEN || process.env.NODE_OPTIONS) throw Error('Unsafe environment');`);
    assert.equal(result.status, 0, JSON.stringify({ stderr: result.stderr, signal: result.signal, error: result.error?.message }));
    assert.match(readFileSync(join(outbox, 'phase-1-and-2-report.md'), 'utf8'), /pnpm release/);
    for (const command of ['pnpm release', 'pnpm rollback', 'tb restart', 'pnpm deploy --env prod', 'gh pr merge 42', 'tb approve card']) {
      const child = run(`import {execSync} from 'node:child_process'; execSync(${JSON.stringify(command)});`);
      assert.notEqual(child.status, 0, command);
      assert.match(child.stderr, /ERR_ACCESS_DENIED|Operation not permitted|EPERM/, command);
    }
    for (const target of [join(work, 'source.ts'), join(task, 'ask.json'), join(root, 'permit.json')]) {
      const child = run(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(target)}, 'changed');`);
      assert.notEqual(child.status, 0, target);
    }
    symlinkSync(join(work, 'escape.txt'), join(outbox, 'escape'));
    assert.notEqual(run(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(join(outbox, 'escape'))}, 'changed');`).status, 0);
    writeFileSync(join(task, 'ask.json'), 'private fixture');
    symlinkSync(join(task, 'ask.json'), join(outbox, 'read-escape'));
    assert.notEqual(run(`import fs from 'node:fs'; console.log(fs.readFileSync(${JSON.stringify(join(outbox, 'read-escape'))}, 'utf8'));`).status, 0);
    const network = run(`import net from 'node:net'; net.connect(4317, '127.0.0.1').on('error', () => process.exit(7));`);
    assert.notEqual(network.status, 0);
    const signal = run(`process.kill(process.ppid, 0);`);
    assert.notEqual(signal.status, 0);
    const replace = run(`process.execve('/usr/bin/true', ['true'], {});`);
    assert.notEqual(replace.status, 0);
    const replaceNode = run(`process.execve(process.execPath, [process.execPath, '-e', 'process.exit(0)'], {});`);
    assert.notEqual(replaceNode.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
