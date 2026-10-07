// The saved drafts of the document viewers (web/src/documentDraft.ts), with a stand-in for localStorage.
import assert from 'node:assert/strict';
import test from 'node:test';

const saved = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); }, removeItem: (k: string) => { saved.delete(k); } },
  dispatchEvent: () => true,
});
const { draftKey, moveDraft, readDraft, writeDraft } = await import('../web/src/documentDraft.ts');

test('a draft is saved for one document and one review version, apart from the BTW question', () => {
  const path = '/vault/tasks/a/outbox/design.html';
  const v1 = draftKey('comment', path, 1), v2 = draftKey('comment', path, 2);
  assert.notEqual(v1, v2);
  assert.notEqual(v1, draftKey('btw', path, 1));
  assert.notEqual(v1, draftKey('comment', '/vault/tasks/b/outbox/design.html', 1));
  assert.equal(draftKey('comment', path), draftKey('comment', path, null), 'a document that is not a review item');
  // every view of the same document and version reads the same text
  writeDraft(v1, 'Unsent comment');
  assert.equal(readDraft(draftKey('comment', path, 1)), 'Unsent comment');
  assert.equal(readDraft(draftKey('btw', path, 1)), '');
  writeDraft(v1, '');
  assert.equal(saved.has(v1), false, 'a sent or deleted draft leaves no entry');
});

test('the unsent text moves to a new review version, and never replaces a draft there', () => {
  const path = '/vault/tasks/a/outbox/plan.md';
  const v1 = draftKey('comment', path, 1), v2 = draftKey('comment', path, 2), v3 = draftKey('comment', path, 3);
  writeDraft(v1, 'Written for version 1');
  moveDraft(v1, v2);
  assert.deepEqual([readDraft(v1), readDraft(v2)], ['', 'Written for version 1']);
  writeDraft(v3, 'Already written for version 3');
  moveDraft(v2, v3);
  assert.deepEqual([readDraft(v2), readDraft(v3)], ['Written for version 1', 'Already written for version 3']);
});
