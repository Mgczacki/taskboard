import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-follow-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-follow-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'follow-test', controller: { autostart: false, remoteControl: false } }));
const browser = await import('../server/task-browser.ts');

test('agent commands select the page used for navigation, viewing, scrolling, and new tabs', () => {
  const selected: string[] = [];
  const off = browser.onAgentPage('follow-watch', target => selected.push(target));
  const watch = browser.agentWatch('follow-watch');
  watch.command(JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'A' } }));
  watch.answer(JSON.stringify({ id: 1, result: { sessionId: 'SA' } }));
  watch.command(JSON.stringify({ id: 2, method: 'Target.attachToTarget', params: { targetId: 'B' } }));
  watch.answer(JSON.stringify({ id: 2, result: { sessionId: 'SB' } }));
  watch.command(JSON.stringify({ id: 3, method: 'Page.navigate', params: { url: 'https://example.com' }, sessionId: 'SA' }));
  watch.command(JSON.stringify({ id: 4, method: 'Page.captureScreenshot', sessionId: 'SB' }));
  watch.command(JSON.stringify({ id: 5, method: 'Runtime.evaluate', params: { expression: 'window.scrollTo(0, 400)' }, sessionId: 'SA' }));
  watch.command(JSON.stringify({ id: 6, method: 'Target.createTarget', params: { url: 'about:blank' } }));
  watch.answer(JSON.stringify({ id: 6, result: { targetId: 'C' } }));
  assert.deepEqual(selected, ['A', 'B', 'A', 'C']);
  assert.equal(browser.lastAgentPage('follow-watch'), 'C');
  off();
  const reconnected: string[] = [browser.lastAgentPage('follow-watch')];
  const offAgain = browser.onAgentPage('follow-watch', target => reconnected.push(target));
  watch.command(JSON.stringify({ id: 7, method: 'Target.activateTarget', params: { targetId: 'B' } }));
  assert.deepEqual(reconnected, ['C', 'B']);
  offAgain();
});

test('manual tab selection turns off follow mode in the viewer connection', async () => {
  const sent: any[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN, bufferedAmount: 0,
    send: (value: string | Buffer) => { if (typeof value === 'string') sent.push(JSON.parse(value)); },
    close() {},
  });
  browser.attachViewer(socket as any, 'follow-view', false);
  socket.emit('message', JSON.stringify({ type: 'hello', followAgent: true }));
  socket.emit('message', JSON.stringify({ type: 'select', id: 'another-tab' }));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(sent.some(m => m.type === 'followAgent' && m.on === false));
  socket.emit('close');
});

test('a delayed typing notice does not return follow mode to an older tab', async () => {
  const watch = browser.agentWatch('follow-typing');
  watch.command(JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId: 'A' } }));
  watch.answer(JSON.stringify({ id: 1, result: { sessionId: 'SA' } }));
  watch.command(JSON.stringify({ id: 2, method: 'Target.attachToTarget', params: { targetId: 'B' } }));
  watch.answer(JSON.stringify({ id: 2, result: { sessionId: 'SB' } }));
  watch.command(JSON.stringify({ id: 3, method: 'Input.insertText', params: { text: 'hello' }, sessionId: 'SA' }));
  watch.command(JSON.stringify({ id: 4, method: 'Page.captureScreenshot', sessionId: 'SB' }));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(browser.lastAgentPage('follow-typing'), 'B');
});
