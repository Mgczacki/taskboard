// server/a2anotes/check-command.mjs with a stand-in for the claude program: the arguments it passes, and how it turns
// Claude's JSON into the A2A Notes check results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tb-check-command-'));
const script = join(process.cwd(), 'server', 'a2anotes', 'check-command.mjs');
// the stand-in records its arguments and stdin, then answers with the JSON in the answer file (check-command.mjs gives
// claude only PATH, HOME, USER, LOGNAME, and CLAUDE_CONFIG_DIR, so an environment variable would not reach it)
const claude = join(dir, 'claude');
writeFileSync(claude, `#!/bin/sh\necho "$@" > ${dir}/args\ncat > ${dir}/stdin\ncat ${dir}/answer\n`, { mode: 0o755 });
const run = (mode: string, input: unknown, answer: unknown) => {
  writeFileSync(join(dir, 'answer'), JSON.stringify(answer));
  return spawnSync(process.execPath, [script, mode, '--claude', claude, '--config', join(dir, 'account')], { input: JSON.stringify(input), encoding: 'utf8' });
};

test('the review mode returns the verdict, and Claude runs with no tools and no MCP servers', () => {
  const r = run('review', { direction: 'incoming', subject: 'Hi', body: 'The report is ready.', files: [] }, { structured_output: { verdict: 'communication', reason: 'Ordinary information' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { verdict: 'communication', reason: 'Ordinary information' });
  const args = readFileSync(join(dir, 'args'), 'utf8');
  for (const part of ['--restricted', '--tools', '--strict-mcp-config', '--no-session-persistence', '--json-schema']) assert.ok(args.includes(part), part);
  assert.match(args, /another person sent/, 'an incoming message uses the incoming prompt');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'stdin'), 'utf8')), { subject: 'Hi', body: 'The report is ready.' });
});

test('the body mode keeps only exact listed sentences, and a bad answer fails', () => {
  const ok = run('body', { body: 'Hi Alex. I will check it later.', sentences: ['Hi Alex.', 'I will check it later.'] },
    { structured_output: { flags: [{ text: 'I will check it later.', reason: 'A note about the sender' }, { text: 'Not in the list', reason: 'x' }] } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { flags: [{ text: 'I will check it later.', reason: 'A note about the sender' }] });
  const bad = run('review', { direction: 'outgoing', subject: 'Hi', body: 'x', files: [] }, { is_error: true });
  assert.notEqual(bad.status, 0, 'A2A Notes treats a failed check as failed');
  assert.throws(() => execFileSync(process.execPath, [script, 'other'], { input: '{}', stdio: 'pipe' }));
});
