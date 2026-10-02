import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canHide, hiddenHere, hide, unhide, type HiddenByView } from '../web/src/hideWindow.ts';

test('a group view has no Hide: the windows of a group leave it only by a drag to another tab', () => {
  assert.equal(canHide('g:abc'), false);
  assert.deepEqual(hide({}, 'g:abc', 't1'), {});
});

for (const view of ['ungrouped', 'needs', 'live', 't:t1,t2,t3']) {
  test(`Hide in the ${view} view hides the window in that view only, and Show hidden brings it back`, () => {
    let h: HiddenByView = {};
    assert.equal(canHide(view), true);
    h = hide(h, view, 't1');
    h = hide(h, view, 't1'); // a second Hide of the same window changes nothing
    assert.deepEqual(hiddenHere(h, view, ['t1', 't2', 't3']), ['t1']);
    // the other views still show the window
    for (const other of ['ungrouped', 'needs', 'live', 't:t1,t2,t3'].filter(v => v !== view)) assert.deepEqual(hiddenHere(h, other, ['t1', 't2']), []);
    h = hide(h, view, 't2');
    assert.deepEqual(hiddenHere(h, view, ['t1', 't2', 't3']), ['t1', 't2']);
    // Add window shows one window again, Show hidden shows all of them
    assert.deepEqual(hiddenHere(unhide(h, view, 't1'), view, ['t1', 't2', 't3']), ['t2']);
    assert.deepEqual(unhide(h, view), {});
  });
}

test('the count of hidden windows leaves out tasks that the view does not show any more', () => {
  const h = hide(hide({}, 'live', 't1'), 'live', 'gone');
  assert.deepEqual(hiddenHere(h, 'live', ['t1', 't2']), ['t1']);
});
