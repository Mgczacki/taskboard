import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'taskboard-document-links-'));
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_DIR = join(root, 'server');
const store = await import('../server/store.ts');
const docs = await import('../server/docs.ts');

store.create({ id: 'link-test', num: 1, title: 'Test', agent: 'codex', status: 'idle', cwd: root, folder: root, session: 'link-test', desc: '' });
const outbox = docs.outboxDir('link-test');
mkdirSync(outbox, { recursive: true });
const file = join(outbox, 'design.md');
writeFileSync(file, '# Heading\n');

test('resolves listed inbox and outbox documents with locations', () => {
  assert.equal(docs.resolveDocumentLink('link-test', file + ':1')?.line, 1);
  assert.equal(docs.resolveDocumentLink('link-test', 'outbox/design.md#heading')?.heading, 'heading');
  assert.equal(docs.resolveDocumentLink('link-test', './outbox/design.md')?.path, file);
  assert.equal(docs.resolveDocumentLink('link-test', '~/AgentVault/tasks/link-test/outbox/design.md')?.path, file);
  const spaced = join(outbox, 'design notes.md');
  writeFileSync(spaced, '# Notes\n');
  assert.equal(docs.resolveDocumentLink('link-test', 'outbox/design notes.md')?.path, spaced);
});

test('rejects paths outside the task documents and missing files', () => {
  assert.equal(docs.resolveDocumentLink('link-test', '../link-test.md'), null);
  assert.equal(docs.resolveDocumentLink('link-test', '/etc/hosts'), null);
  assert.equal(docs.resolveDocumentLink('link-test', 'outbox/missing.md'), null);
});

test('rejects a listed symlink whose target leaves the task folders', () => {
  symlinkSync('/etc/hosts', join(outbox, 'outside.md'));
  assert.equal(docs.resolveDocumentLink('link-test', 'outbox/outside.md'), null);
});
