import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tb-mail-files-'));
process.env.TASKBOARD_DIR = join(root, 'server');
process.env.TASKBOARD_VAULT = join(root, 'vault');
const { stageBytes, receiveBytes, verifyFile, extractText, routeFile } = await import('../server/mail/files.ts');

test('a received file stays private until its bytes pass a hash check', () => {
  const bytes = Buffer.from('This is a document.');
  const outgoing = stageBytes(bytes, 'note.txt');
  const incoming = receiveBytes(bytes, 'note.txt', outgoing.hash);
  assert.equal(extractText(incoming), 'This is a document.');
  assert.equal(readFileSync(routeFile(incoming, join(root, 'task-inbox')), 'utf8'), 'This is a document.');
  assert.throws(() => receiveBytes(Buffer.from('changed'), 'note.txt', outgoing.hash), /hash/);
  writeFileSync(incoming.path, 'changed');
  assert.throws(() => verifyFile(incoming), /changed/);
});

test('file intake rejects unreviewable names and bytes', () => {
  assert.throws(() => stageBytes(Buffer.from('a'), 'run.sh'), /TXT/);
  assert.throws(() => stageBytes(Buffer.from('a'), '../note.txt'), /file name/);
  assert.throws(() => stageBytes(Buffer.alloc(10 * 1024 * 1024 + 1), 'large.txt'), /10 MiB/);
  const invalid = stageBytes(Buffer.from([0xff]), 'text.txt');
  assert.throws(() => extractText(invalid));
  const unsupported = receiveBytes(Buffer.from('script bytes'), 'run.sh', stageBytes(Buffer.from('script bytes'), 'text.txt').hash);
  assert.throws(() => extractText(unsupported), /not supported/);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
