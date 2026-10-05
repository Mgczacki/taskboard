import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalPaste } from '../web/src/terminalPaste.ts';

const key = (element: EventTarget, metaKey = true, ctrlKey = false) => {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { code: 'KeyV', metaKey, ctrlKey, altKey: false, shiftKey: false });
  element.dispatchEvent(event);
  return event;
};
const settle = () => new Promise(resolve => setTimeout(resolve, 45));

test('the login terminal pastes clipboard text when the shortcut has no paste event', async () => {
  const element = new EventTarget();
  const calls: string[] = [];
  const dispose = terminalPaste(element as HTMLElement, text => calls.push(`text:${text}`), () => calls.push('live'), async () => 'paste-check-302');
  const event = key(element);
  await settle();
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(calls, ['live', 'text:paste-check-302']);
  dispose();
});

test('native paste sends one control message and does not paste twice', async () => {
  const element = new EventTarget();
  const calls: string[] = [];
  const dispose = terminalPaste(element as HTMLElement, text => calls.push(`text:${text}`), () => calls.push('live'), async () => { calls.push('read'); return 'paste-check-302'; });
  key(element, false, true);
  element.dispatchEvent(new Event('paste'));
  await settle();
  assert.deepEqual(calls, ['live']);
  dispose();
});

test('a denied clipboard read leaves native paste available', async () => {
  const element = new EventTarget();
  const calls: string[] = [];
  const dispose = terminalPaste(element as HTMLElement, text => calls.push(`text:${text}`), () => calls.push('live'), async () => { throw Error('denied'); });
  key(element);
  await settle();
  element.dispatchEvent(new Event('paste'));
  assert.deepEqual(calls, ['live']);
  dispose();
});

test('a missing clipboard API leaves native paste available', async () => {
  const element = new EventTarget();
  const calls: string[] = [];
  const dispose = terminalPaste(element as HTMLElement, text => calls.push(`text:${text}`), () => calls.push('live'), () => { throw Error('unavailable'); });
  key(element);
  await settle();
  element.dispatchEvent(new Event('paste'));
  assert.deepEqual(calls, ['live']);
  dispose();
});
