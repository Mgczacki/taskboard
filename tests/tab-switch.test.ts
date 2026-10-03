// The switch of the dashboard's browser view to a new tab or popup (server/tab-switch.ts), with fake DevTools target
// events and a fake clock. The target infos have the fields that Chrome 154 sent for each case of the local test site
// (tests/fixtures/popup-site.mjs): a popup starts with url '' and an openerId, a tab of an agent has no openerId, and a
// background tab from a middle or Cmd click has no openerId either.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_MS, BLANK_CLOSE_MS, BLANK_MS, type Decision, TabSwitch, type Timers } from '../server/tab-switch.ts';

function setup(auto = true) {
  let now = 1000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let n = 0;
  const t: Timers = { now: () => now, set: (fn, ms) => { timers.push({ at: now + ms, fn, id: ++n }); return n; }, clear: id => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); } };
  const out: Decision[] = [];
  const opts = { auto };
  const sw = new TabSwitch(d => { out.push(d); if (d.kind === 'switch') sw.shown(d.id); }, () => opts.auto, t);
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift(); now = next.at; next.fn();
    }
    now = end;
  };
  sw.seed(['main', 'other']);
  sw.shown('main');
  return { sw, out, advance, opts };
}
const popup = (id: string, url = '', openerId = 'main', canAccessOpener = true) => ({ targetId: id, type: 'page', url, title: '', openerId, canAccessOpener });

test('window.open: the view switches when the popup gets its address, before the blank wait ends', () => {
  const { sw, out, advance } = setup();
  sw.created(popup('p1'));
  advance(20);
  assert.equal(out.length, 0, 'no switch while the address is empty');
  sw.changed(popup('p1', 'http://site/popup'));
  assert.deepEqual(out, [{ kind: 'switch', id: 'p1', from: 'main', reason: 'popup' }]);
});

test('a link with target=_blank (openerId without access) switches like a popup', () => {
  const { sw, out } = setup();
  sw.created(popup('t1', '', 'main', false));
  sw.changed(popup('t1', 'http://site/target', 'main', false));
  assert.deepEqual(out, [{ kind: 'switch', id: 't1', from: 'main', reason: 'popup' }]);
});

test('a popup whose address stays empty (a slow server or redirects) switches after the blank wait', () => {
  const { sw, out, advance } = setup();
  sw.created(popup('p1'));
  advance(BLANK_MS - 1);
  assert.equal(out.length, 0);
  advance(1);
  assert.deepEqual(out, [{ kind: 'switch', id: 'p1', from: 'main', reason: 'popup' }]);
});

test('a window.open from a timer and a sized popup are popups too (the target info is the same)', () => {
  const { sw, out } = setup();
  sw.created(popup('timer'));
  sw.changed(popup('timer', 'http://site/popup?timer'));
  sw.created(popup('sized'));
  sw.changed(popup('sized', 'http://site/popup?sized'));
  assert.deepEqual(out.map(d => d.kind === 'switch' && d.id), ['timer', 'sized']);
});

test('OAuth popup: the view switches at the first address, stays over two redirects, and goes back to the opener when it closes', () => {
  const { sw, out, advance } = setup();
  sw.created(popup('auth'));
  sw.changed(popup('auth', 'http://site/oauth/start'));
  sw.changed(popup('auth', 'http://site/oauth/step2'));
  sw.changed(popup('auth', 'http://site/oauth/done'));
  advance(500);
  sw.destroyed('auth');
  assert.deepEqual(out, [
    { kind: 'switch', id: 'auth', from: 'main', reason: 'popup' },
    { kind: 'switch', id: 'main', from: 'auth', reason: 'back' },
  ]);
});

test('a popup right after the user selected a tab still takes the view (the old 60 s rule is gone)', () => {
  const { sw, out } = setup();
  sw.shown('other'); sw.shown('main'); // two selections by the user
  sw.created(popup('p1', 'http://site/popup'));
  assert.deepEqual(out, [{ kind: 'switch', id: 'p1', from: 'main', reason: 'popup' }]);
});

test('a popup while the user types in the address bar takes the view (the half typed address stays in the view, see TaskBrowser.tsx)', () => {
  const { sw, out } = setup();
  sw.created(popup('p1', 'http://site/popup'));
  assert.equal(out[0].kind, 'switch');
});

test('two popups: the view shows the second, then the first when the second closes, then the opener', () => {
  const { sw, out } = setup();
  sw.created(popup('one', 'http://site/one'));
  sw.created(popup('two', 'http://site/two'));
  sw.destroyed('two');
  sw.destroyed('one');
  assert.deepEqual(out.map(d => d.kind === 'switch' && `${d.reason}:${d.id}`), ['popup:one', 'popup:two', 'back:one', 'back:main']);
});

test('a tab that an agent opens with Target.createTarget takes the view', () => {
  const { sw, out } = setup();
  sw.created({ targetId: 'a1', type: 'page', url: 'http://site/agent', canAccessOpener: false });
  assert.deepEqual(out, [{ kind: 'switch', id: 'a1', from: 'main', reason: 'agent' }]);
});

test('a middle click or a Cmd click opens a background tab: the view offers it and stays', () => {
  const { sw, out, advance } = setup();
  sw.userClick('middle', 0);
  sw.created({ targetId: 'bg1', type: 'page', url: 'http://site/bg', canAccessOpener: false });
  advance(2000);
  sw.userClick('left', 4);
  sw.created({ targetId: 'bg2', type: 'page', url: 'http://site/bg', canAccessOpener: false });
  // Cmd+Shift click opens a tab in the front, like Chrome
  advance(2000);
  sw.userClick('left', 4 | 8);
  sw.created({ targetId: 'fg', type: 'page', url: 'http://site/bg', canAccessOpener: false });
  assert.deepEqual(out, [{ kind: 'offer', id: 'bg1', reason: 'background' }, { kind: 'offer', id: 'bg2', reason: 'background' }, { kind: 'switch', id: 'fg', from: 'main', reason: 'agent' }]);
});

test('a tab later than BACKGROUND_MS after a Cmd click is not a background tab, and one click covers one tab', () => {
  const { sw, out, advance } = setup();
  sw.userClick('left', 4);
  advance(BACKGROUND_MS + 1);
  sw.created({ targetId: 'late', type: 'page', url: 'http://site/x' });
  assert.equal(out[0].kind, 'switch');
  sw.shown('main');
  sw.userClick('middle', 0);
  sw.created({ targetId: 'bg', type: 'page', url: 'http://site/bg' });
  sw.created({ targetId: 'agent', type: 'page', url: 'http://site/agent' });
  assert.deepEqual(out.slice(1).map(d => `${d.kind}:${d.id}`), ['offer:bg', 'switch:agent']);
});

test('a blank popup that closes at once does not take the view', () => {
  const { sw, out, advance } = setup();
  sw.created(popup('q'));
  sw.changed(popup('q', 'about:blank'));
  advance(BLANK_MS + 230); // Chrome reported the end about 380 ms after the open
  sw.destroyed('q');
  advance(2000);
  assert.deepEqual(out, []);
});

test('a blank popup that closes late: Page.windowOpen said about:blank, so the empty address of the new target waits longer', () => {
  const { sw, out, advance } = setup();
  sw.windowOpen('main', 'about:blank');
  advance(15);
  sw.created(popup('q')); // Chrome under load sent no about:blank before BLANK_MS
  advance(BLANK_MS + 1);
  assert.deepEqual(out, [], 'no switch at the end of the short wait');
  sw.changed(popup('q', '')); // an info change with url '' keeps the address that the page asked for
  advance(370);
  sw.destroyed('q'); // Chrome reported the end 540 ms after the open
  advance(2000);
  assert.deepEqual(out, []);
});

test('a popup for a slow server (Page.windowOpen with its address, url empty until the commit) takes the view after the short wait', () => {
  const { sw, out, advance } = setup();
  sw.windowOpen('main', 'http://site/slow');
  sw.created(popup('s'));
  advance(BLANK_MS);
  assert.deepEqual(out, [{ kind: 'switch', id: 's', from: 'main', reason: 'popup' }]);
});

test('a popup that stays at about:blank (a page writes into it) takes the view after the longer wait', () => {
  const { sw, out, advance } = setup();
  sw.created(popup('w', 'about:blank'));
  advance(BLANK_MS + BLANK_CLOSE_MS - 1);
  assert.deepEqual(out, []);
  advance(1);
  assert.deepEqual(out, [{ kind: 'switch', id: 'w', from: 'main', reason: 'popup' }]);
});

test('with the switch turned off the view offers each new tab, and still goes back when the shown popup closes', () => {
  const { sw, out, opts } = setup(false);
  sw.created(popup('p1', 'http://site/popup'));
  sw.created({ targetId: 'a1', type: 'page', url: 'http://site/agent' });
  assert.deepEqual(out, [{ kind: 'offer', id: 'p1', reason: 'off' }, { kind: 'offer', id: 'a1', reason: 'off' }]);
  sw.shown('p1'); // the user clicks the offer
  sw.destroyed('p1');
  assert.deepEqual(out[2], { kind: 'switch', id: 'main', from: 'p1', reason: 'back' });
  opts.auto = true;
  sw.created(popup('p2', 'http://site/popup'));
  assert.equal(out[3].kind, 'switch');
});

test('a tab closes that the view does not show: no switch', () => {
  const { sw, out } = setup();
  sw.destroyed('other');
  assert.deepEqual(out, []);
});

test('the user closes the shown tab: the view goes back to the tab shown before it, not to a new tab', () => {
  const { sw, out } = setup();
  sw.shown('other'); // the user selects the other tab
  sw.destroyed('other'); // and closes it
  assert.deepEqual(out, [{ kind: 'switch', id: 'main', from: 'other', reason: 'back' }]);
});

test('the user went to another tab while the popup was open: the popup closes and the view goes to its opener', () => {
  const { sw, out } = setup();
  sw.created(popup('p1', 'http://site/popup'));
  sw.shown('other');
  sw.shown('p1');
  sw.destroyed('p1');
  assert.deepEqual(out.at(-1), { kind: 'switch', id: 'main', from: 'p1', reason: 'back' });
});

test('the view\'s own new-tab button: its tab takes no decision; a popup after it still does', () => {
  const { sw, out } = setup();
  sw.userNewTab();
  sw.created({ targetId: 'n1', type: 'page', url: 'about:blank' });
  sw.created(popup('p1', 'http://site/popup'));
  assert.deepEqual(out.map(d => d.id), ['p1']);
});

test('the existing tabs at the start take no decision, and a poll adds a tab that the events missed', () => {
  const { sw, out } = setup();
  sw.listed([{ id: 'main', url: 'x' }, { id: 'other', url: 'y' }, { id: 'late', url: 'http://site/late' }]);
  assert.deepEqual(out, [{ kind: 'switch', id: 'late', from: 'main', reason: 'agent' }]);
});

test('a poll does not close a tab that the events reported after the poll asked Chrome, nor add a closed tab again', () => {
  const { sw, out, advance } = setup();
  const asked = 1000;
  advance(10);
  sw.created(popup('p1', 'http://site/popup'));
  sw.listed([{ id: 'main', url: 'x' }, { id: 'other', url: 'y' }], asked);
  assert.ok(sw.known('p1'), 'the new tab stays');
  sw.destroyed('p1');
  sw.listed([{ id: 'main', url: 'x' }, { id: 'other', url: 'y' }, { id: 'p1', url: 'http://site/popup' }], asked);
  assert.ok(!sw.known('p1'), 'the closed tab is not added again');
  assert.deepEqual(out.map(d => `${d.reason}:${d.id}`), ['popup:p1', 'back:main']);
});

test('the history keeps at most 20 tabs', () => {
  const { sw } = setup();
  const ids = Array.from({ length: 30 }, (_, i) => `t${i}`);
  sw.seed(ids);
  for (const id of ids) sw.shown(id);
  assert.equal(sw.history.length, 20);
});
