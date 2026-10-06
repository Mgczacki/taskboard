// What the agent does in its task browser, as the dashboard view sees it (agentWatch, onAgentEvent and attachViewer in
// server/task-browser.ts), and the agent's request for help (setAsk, answerAsk). A real headless Chrome runs in a
// temporary Taskboard folder. The agent is a stand-in for chrome-devtools-mcp: it sends DevTools commands through
// proxyAgent. The view is a stand-in for the dashboard's WebSocket. Skipped when Chrome is not installed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import WebSocket from 'ws';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-agent-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-agent-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'agent-test', controller: { autostart: false, remoteControl: false } }));
const browser = await import('../server/task-browser.ts');
const skip = browser.chromePath() ? false : 'Chrome is not installed';
const ID = 'agentview';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (ok: () => boolean, what: string, ms = 8000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await wait(25); assert.ok(ok(), what); };

// a socket stand-in: send() records what the server sends
const socket = (record: (m: any) => void) => Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string | Buffer) => { if (typeof d === 'string') record(JSON.parse(d)); }, close() {} });
const seen: any[] = [], answers: any[] = [];
const view = socket(m => seen.push(m));
const agent = socket(m => answers.push(m));
let next = 0;
const cmd = (method: string, params: object = {}, sessionId?: string) => { const id = ++next; agent.emit('message', JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), false); return id; };

before(async () => {
  if (skip) return;
  const m = await browser.ensure(ID);
  const page = (await (await fetch(`http://127.0.0.1:${m.port}/json/list`)).json() as { id: string; type: string; webSocketDebuggerUrl: string }[]).find(t => t.type === 'page')!;
  await browser.once(page.webSocketDebuggerUrl, 'Page.navigate', { url: 'data:text/html,<button style="position:absolute;left:0;top:0;width:300px;height:200px">Next</button><input aria-label="Email" style="position:absolute;top:300px">' });
  await wait(500);
  browser.attachViewer(view as any, ID, false);
  await until(() => seen.some(s => s.type === 'active'), 'the view shows a tab');
  browser.proxyAgent(agent as any, ID);
});
after(async () => { view.emit('close'); agent.emit('close'); if (!skip) await browser.stop(ID); });

test('a click and typing of the agent reach the view with the element name', { skip }, async () => {
  const pageId = seen.find(s => s.type === 'active').id;
  const attach = cmd('Target.attachToTarget', { targetId: pageId, flatten: true });
  await until(() => answers.some(a => a.id === attach), 'the agent attached to the page');
  const session = answers.find(a => a.id === attach).result.sessionId;
  cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 60, button: 'left', clickCount: 1 }, session);
  cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 60, button: 'left', clickCount: 1 }, session);
  await until(() => seen.some(s => s.type === 'agent' && s.kind === 'click'), 'the view got the click');
  const click = seen.find(s => s.type === 'agent' && s.kind === 'click');
  assert.equal(click.x, 50); assert.equal(click.y, 60);
  assert.equal(click.target, pageId);
  assert.equal(click.shown, true);
  assert.equal(click.label, 'Next');
  // typing into a focused field: one event for a burst, with the number of characters only
  cmd('Runtime.evaluate', { expression: 'document.querySelector("input").focus()' }, session);
  await wait(200);
  cmd('Input.insertText', { text: 'hello' }, session);
  cmd('Input.insertText', { text: '@x.io' }, session);
  await until(() => seen.some(s => s.type === 'agent' && s.kind === 'type'), 'the view got the typing');
  const typed = seen.find(s => s.type === 'agent' && s.kind === 'type');
  assert.equal(typed.chars, 10);
  assert.equal(typed.label, 'Email');
  assert.equal(JSON.stringify(typed).includes('hello'), false, 'the typed text itself does not go to the view');
});

test('the agent asks for help, and Done answers it with the note', { skip }, async () => {
  const done: { id: string; reason: string; note: string }[] = [];
  browser.onAskDone((id, ask, note) => done.push({ id, reason: ask.reason, note }));
  browser.setAsk(ID, 'Sign in   to the shop');
  await until(() => seen.some(s => s.type === 'ask' && s.ask?.reason === 'Sign in to the shop'), 'the view got the request');
  assert.equal(browser.askOf(ID)?.reason, 'Sign in to the shop');
  await until(() => seen.some(s => s.type === 'tabs' && s.ask?.reason === 'Sign in to the shop'), 'the tab list carries the request');
  view.emit('message', JSON.stringify({ type: 'askDone', note: 'Signed in.' }));
  await until(() => done.length > 0, 'Done answered the request');
  assert.deepEqual(done[0], { id: ID, reason: 'Sign in to the shop', note: 'Signed in.' });
  assert.equal(browser.askOf(ID), null);
  assert.equal(browser.readMeta(ID).ask, undefined);
});

test('agentWatch maps sessions to targets from the answers of Chrome', () => {
  const events: browser.AgentEvent[] = [];
  const off = browser.onAgentEvent('watchonly', e => events.push(e));
  const w = browser.agentWatch('watchonly');
  w.command(JSON.stringify({ id: 7, method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } }));
  w.answer(JSON.stringify({ id: 7, result: { sessionId: 'S1' } }));
  w.answer(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'S2', targetInfo: { targetId: 'T2' } } }));
  w.command(JSON.stringify({ id: 8, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 2 }, sessionId: 'S1' }));
  w.command(JSON.stringify({ id: 9, method: 'Page.navigate', params: { url: 'https://example.com/a' }, sessionId: 'S2' }));
  w.command(JSON.stringify({ id: 10, method: 'Page.captureScreenshot', params: {}, sessionId: 'S2' }));
  w.command(JSON.stringify({ id: 11, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 1, y: 2 }, sessionId: 'S1' }));
  off();
  assert.deepEqual(events.map(e => [e.kind, e.target]), [['click', 'T1'], ['navigate', 'T2'], ['look', 'T2']]);
});

test('follow mode tracks an agent tab, pauses on manual selection, and resumes after reconnect', { skip, timeout: 30000 }, async () => {
  const first = seen.find(s => s.type === 'active').id;
  view.emit('message', JSON.stringify({ type: 'followAgent', on: true }));
  await until(() => seen.some(s => s.type === 'followAgent' && s.on === true), 'follow mode is on');
  const create = cmd('Target.createTarget', { url: 'about:blank' });
  await until(() => answers.some(a => a.id === create), 'the agent opened a tab');
  const second = answers.find(a => a.id === create).result.targetId;
  await until(() => seen.some(s => s.type === 'active' && s.id === second), 'the view follows the new tab');
  const attachSecond = cmd('Target.attachToTarget', { targetId: second, flatten: true });
  await until(() => answers.some(a => a.id === attachSecond), 'the agent attached to the new tab');
  const sessionSecond = answers.find(a => a.id === attachSecond).result.sessionId;
  cmd('Page.navigate', { url: 'data:text/html,<title>Agent page</title><p>Moved</p>' }, sessionSecond);
  await until(() => seen.some(s => s.type === 'tabs' && s.tabs.some((t: any) => t.id === second && t.url.startsWith('data:text/html'))), 'the followed page navigates');
  view.emit('message', JSON.stringify({ type: 'select', id: first }));
  await until(() => seen.some(s => s.type === 'followAgent' && s.on === false), 'manual selection turns follow off');
  await until(() => [...seen].reverse().find(s => s.type === 'active')?.id === first, 'the manual tab is shown');
  cmd('Page.captureScreenshot', {}, sessionSecond);
  await wait(200);
  assert.equal([...seen].reverse().find(s => s.type === 'active')?.id, first, 'agent activity does not override manual selection');

  view.emit('close');
  const reconnected: any[] = [];
  const again = socket(m => reconnected.push(m));
  browser.attachViewer(again as any, ID, false);
  again.emit('message', JSON.stringify({ type: 'hello', followAgent: true }));
  await until(() => reconnected.some(s => s.type === 'active' && s.id === second), 'reconnected view follows the last agent page');
  const attachFirst = cmd('Target.attachToTarget', { targetId: first, flatten: true });
  await until(() => answers.some(a => a.id === attachFirst), 'the agent attached to the first tab');
  const sessionFirst = answers.find(a => a.id === attachFirst).result.sessionId;
  cmd('Page.captureScreenshot', {}, sessionFirst);
  await until(() => [...reconnected].reverse().find(s => s.type === 'active')?.id === first, 'the reconnected view follows the agent switch');
  again.emit('close');
});
