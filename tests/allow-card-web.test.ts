// The Allow always buttons on a card where one task asks to type into another task (web ApprovalCard.tsx): the buttons
// stand in the row of Approve once and name the two task numbers and the direction. A card without an offer keeps
// the plain Approve button.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
  localStorage: storage, sessionStorage: storage, addEventListener: () => {}, removeEventListener: () => {},
  location: new URL('http://127.0.0.1/'), WebSocket: class { close() {} send() {} },
});
globals.window = globals;
// ApprovalCard.tsx imports components that import style sheets. Node cannot load a .css file, so each one loads as an empty module.
register('data:text/javascript,' + encodeURIComponent("export async function load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); }"));
const { ApprovalCard } = await import('../web/src/components/ApprovalCard.tsx');
const allow = await import('../server/allow-rules.ts');

const a = { id: 'task-a', num: 12, title: 'Writer task', status: 'idle' }, b = { id: 'task-b', num: 15, title: 'Reader task', status: 'idle' };
const card = (offer: unknown) => ({ id: 'c1', actor: 'task-a', action: 'send', summary: 'type into #15 Reader task', detail: 'Hello', created: new Date().toISOString(), state: 'pending', ...(offer ? { allow: offer } : {}) });
const render = (offer: unknown) => renderToStaticMarkup(createElement(ApprovalCard, { a: card(offer) as never, allTasks: [a, b] as never, setOpenId: () => {}, openController: () => {}, toast: () => {} }));
const buttons = (html: string) => [...html.slice(html.lastIndexOf('<div class="ap-a">')).matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(m => m[1]);

test('an ordinary message card has Approve once, then one Always allow button for each choice, with numbers and direction', () => {
  const html = render(allow.offer(a, b));
  assert.deepEqual(buttons(html), ['Approve once', 'Always allow #12 → #15', 'Always allow #12 ↔ #15', 'Always allow any task → #15', 'Deny', 'Open task']);
  assert.match(html, /<b>#12 → #15<\/b> \(one way\): Task #12 &quot;Writer task&quot; may type messages into task #15 &quot;Reader task&quot; without a card\. Messages in the other direction still need a card\./);
  assert.match(html, /<b>#12 ↔ #15<\/b> \(both ways\): Tasks #12 &quot;Writer task&quot; and #15 &quot;Reader task&quot; may type messages into each other without a card\./);
  assert.match(html, /at most 30 deliveries in one hour/);
});

test('a card between two groups or of a manager offers only the one-way and the two-way button', () => {
  assert.deepEqual(buttons(render(allow.offer(a, b, 'message', allow.TASK_SCOPES))), ['Approve once', 'Always allow #12 → #15', 'Always allow #12 ↔ #15', 'Deny', 'Open task']);
});

test('a document card names documents on its buttons, and a card without an offer keeps the Approve button', () => {
  assert.deepEqual(buttons(render(allow.offer(a, b, 'doc'))).slice(0, 3), ['Approve once', 'Always allow documents #12 → #15', 'Always allow documents #12 ↔ #15']);
  const plain = render(undefined);
  assert.deepEqual(buttons(plain), ['Approve', 'Deny', 'Open task']);
  assert.doesNotMatch(plain, /Always allow/);
});
