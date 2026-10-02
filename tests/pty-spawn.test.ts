// server/pty-spawn.ts: spawning and ending terminals leaves no pseudo-terminal descriptor open (node-pty 1.1.0 on
// macOS leaked one for each spawn), and the terminal still works.
import assert from 'node:assert/strict';
import { fstatSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { spawnPty } from '../server/pty-spawn.ts';

// the descriptors of this process that are character devices (pseudo-terminals among them)
const devices = () => readdirSync('/dev/fd').map(Number).filter(fd => { try { return fstatSync(fd).isCharacterDevice(); } catch { return false; } }).length;

test('ten terminals that open and end leave no descriptor behind', { timeout: 30000 }, async () => {
  const start = devices();
  for (let i = 0; i < 10; i++) {
    const p = spawnPty('/bin/sh', ['-c', 'printf ready; sleep 30'], { cols: 80, rows: 24 });
    const out = await new Promise<string>(resolve => { let s = ''; p.onData(d => { s += d; if (s.includes('ready')) resolve(s); }); });
    assert.match(out, /ready/);
    await new Promise<void>(resolve => { p.onExit(() => resolve()); p.kill(); });
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(devices(), start);
});

test('input reaches the program and the size is set', { timeout: 10000 }, async () => {
  const p = spawnPty('/bin/sh', ['-c', 'stty size; read line; echo "got $line"'], { cols: 91, rows: 33 });
  let out = '';
  const done = new Promise<void>(resolve => p.onExit(() => resolve()));
  p.onData(d => { out += d; if (out.includes('33 91')) p.write('hello\r'); });
  await done;
  assert.match(out, /33 91/);
  assert.match(out, /got hello/);
});
