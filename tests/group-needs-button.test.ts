import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
  localStorage: storage, sessionStorage: storage, addEventListener: () => {}, removeEventListener: () => {},
  location: new URL('http://127.0.0.1/'), WebSocket: class { close() {} send() {} },
});
globals.window = globals;
const { GroupNeedsButton } = await import('../web/src/components/ManagerBoard.tsx');

test('group attention badge keeps its meaning in hover and screen reader text', () => {
  for (const [count, name, words] of [
    [4, 'Experimentation system migration', '4 tasks need you'],
    [3, 'Dynamic Routing', '3 tasks need you'],
    [1, 'One task', '1 task needs you'],
    [0, 'Empty group', 'Nothing in Empty group needs you'],
  ] as const) {
    const button = GroupNeedsButton({ count, groupName: name, shown: false, toggle: () => {} });
    const html = renderToStaticMarkup(button);
    assert.match(html, new RegExp(`>${count}!<\\/button>$`));
    assert.equal(button.props['aria-label'], button.props.title);
    assert.ok(button.props.title.includes(words));
    assert.equal(button.props['aria-haspopup'], 'dialog');
    assert.equal(button.props['aria-expanded'], false);
    assert.equal(button.props.className.includes('hot'), count > 0);
  }
});

test('badge click opens its menu without selecting or dragging the group tab', () => {
  let toggles = 0, stopped = 0;
  const button = GroupNeedsButton({ count: 4, groupName: 'Experimentation system migration', shown: true, toggle: () => toggles++ });
  button.props.onPointerDown({ stopPropagation: () => stopped++ } as never);
  button.props.onClick({ stopPropagation: () => stopped++ } as never);
  assert.equal(stopped, 2);
  assert.equal(toggles, 1);
  assert.equal(button.props['aria-expanded'], true);
  const css = readFileSync(new URL('../web/src/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.need-chip \{[^}]*flex: none;[^}]*white-space: nowrap;/);
  assert.match(css, /\.canvas \.gtabs \{[^}]*overflow-x: auto;/);
  assert.match(css, /\.gtab \{[^}]*flex: none;/);
});
