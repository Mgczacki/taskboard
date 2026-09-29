import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

test('resolves links from a Markdown document', () => {
  const json = join(outbox, 'layout-b.json');
  writeFileSync(json, '{}');
  assert.deepEqual(docs.resolveViewerLink(file, 'design.md#heading'), {
    kind: 'document', document: docs.resolveDocumentLink('link-test', file + '#heading'),
  });
  assert.deepEqual(docs.resolveViewerLink(file, './design.md'), {
    kind: 'document', document: docs.resolveDocumentLink('link-test', file),
  });
  assert.deepEqual(docs.resolveViewerLink(file, 'layout-b.json'), { kind: 'local', path: realpathSync(json) });
  assert.deepEqual(docs.resolveViewerLink(file, 'https://example.com/test'), { kind: 'web', url: 'https://example.com/test' });
  assert.equal(docs.resolveViewerLink(file, '/etc/hosts').kind, 'refused');
});

test('opens vault Markdown and rejects executable files', () => {
  const guide = join(process.env.TASKBOARD_VAULT!, 'guide.md');
  const script = join(outbox, 'run.sh');
  writeFileSync(guide, '# Guide');
  writeFileSync(script, 'echo test');
  assert.deepEqual(docs.resolveViewerLink(file, guide + '#guide'), { kind: 'vault-document', path: realpathSync(guide), heading: 'guide' });
  assert.equal(docs.openableLocalPath(script), null);
  writeFileSync(join(outbox, 'active.svg'), '<svg onload="alert(1)"/>');
  assert.equal(docs.openableLocalPath(join(outbox, 'active.svg')), null);
  assert.equal(docs.openableLocalPath('/etc/hosts'), null);
});

test('serves only images in the vault with fixed image types', () => {
  for (const ext of ['png', 'jpg', 'gif', 'webp', 'svg']) {
    const path = join(outbox, `image.${ext}`);
    writeFileSync(path, 'test');
    assert.match(docs.resolveDocumentImage(file, `image.${ext}`)?.type || '', /^image\//);
  }
  assert.equal(docs.resolveDocumentImage(file, '/etc/hosts'), null);
  assert.equal(docs.resolveDocumentImage(file, 'layout-b.json'), null);
  assert.equal(docs.resolveDocumentImage(file, 'outside.md'), null);
});

test('resolves paths that start at the vault or the tasks folder, and file URLs', () => {
  const html = join(outbox, 'mock up.html');
  writeFileSync(html, '<!doctype html><title>Mock</title>');
  assert.equal(docs.resolveDocumentLink('link-test', 'AgentVault/tasks/link-test/outbox/design.md')?.path, file);
  assert.equal(docs.resolveDocumentLink('link-test', 'tasks/link-test/outbox/design.md.')?.path, file);
  assert.equal(docs.resolveDocumentLink('link-test', pathToFileURL(html).href)?.path, html);
  assert.equal(docs.resolveDocumentLink('link-test', 'AgentVault/tasks/link-test/outbox/mock up.html')?.kind, 'html');
  assert.equal(docs.resolveDocumentLink('link-test', 'tasks/../../outside.md'), null);
  assert.equal(docs.resolveDocumentLink('link-test', 'file:///etc/hosts'), null);
});

test('opens HTML links from a Markdown document in Taskboard', () => {
  const html = join(outbox, 'mockup.html');
  writeFileSync(html, '<!doctype html><title>Mock</title>');
  const link = docs.resolveViewerLink(file, 'mockup.html#layout-a');
  assert.equal(link.kind, 'document');
  assert.equal(link.kind === 'document' && link.document?.kind, 'html');
  assert.equal(link.kind === 'document' && link.document?.heading, 'layout-a');
  const page = join(process.env.TASKBOARD_VAULT!, 'page.html');
  writeFileSync(page, '<!doctype html><title>Page</title>');
  assert.deepEqual(docs.resolveViewerLink(file, page), { kind: 'vault-document', path: realpathSync(page) });
});
