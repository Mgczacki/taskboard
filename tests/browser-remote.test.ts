// The browser of a task on another machine: the pipe of /ws/browser to the other server (server/browser-forward.ts),
// and the sign-ins that one machine sends to another (exportSites, checkCookies and importCookies in
// server/browser-signins.ts). The pipe tests use fake sockets. The export and import test uses real headless Chrome in a
// temporary Taskboard folder and is skipped when Chrome is not installed. The cookies are fake.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-remote-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-remote-${process.pid}`;
mkdirSync(process.env.TASKBOARD_DIR);
writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ name: 'remote-test', controller: { autostart: false, remoteControl: false } }));
const forward = await import('../server/browser-forward.ts');
const browser = await import('../server/task-browser.ts');
const signins = await import('../server/browser-signins.ts');
after(async () => { signins.stopLive(); await browser.stop('template').catch(() => {}); });

// A socket with the parts that pipe() uses. sent: what pipe() sent on it, closed: the close code (0 for none given).
class Fake extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent: { data: string | Buffer; binary: boolean }[] = []; closed: number | null = null;
  send(data: string | Buffer, opts?: { binary?: boolean }) { this.sent.push({ data, binary: !!opts?.binary }); }
  close(code?: number) { if (this.closed !== null) return; this.closed = code ?? 0; this.readyState = 3; this.emit('close'); }
}
const text = (s: Fake) => s.sent.filter(m => !m.binary).map(m => String(m.data));

test('messages from the view wait until the other server answers, then go in order', () => {
  const view = new Fake(), up = new Fake(); up.readyState = 0;
  forward.pipe(view as never, up as never);
  view.emit('message', Buffer.from('{"type":"hello","acks":true}'), false);
  view.emit('message', Buffer.from('{"type":"size","w":800,"h":600}'), false);
  assert.equal(up.sent.length, 0);
  up.readyState = 1; up.emit('open');
  assert.deepEqual(text(up), ['{"type":"hello","acks":true}', '{"type":"size","w":800,"h":600}']);
});

test('frames stay binary, text stays text', () => {
  const view = new Fake(), up = new Fake();
  forward.pipe(view as never, up as never);
  up.emit('message', Buffer.from([0xff, 0xd8, 0xff]), true);
  up.emit('message', Buffer.from('{"type":"tabs","tabs":[]}'), false);
  assert.equal(view.sent[0].binary, true);
  assert.deepEqual([...(view.sent[0].data as Buffer)], [0xff, 0xd8, 0xff]);
  assert.deepEqual(text(view), ['{"type":"tabs","tabs":[]}']);
});

test('a slow view loses frames, never text, and the other server hears drawn for each lost frame', () => {
  const view = new Fake(), up = new Fake();
  forward.pipe(view as never, up as never);
  view.emit('message', Buffer.from('{"type":"hello","acks":true}'), false);
  view.bufferedAmount = forward.BACKLOG + 1;
  up.emit('message', Buffer.from([1, 2, 3]), true);
  up.emit('message', Buffer.from('{"type":"nav","loading":false}'), false);
  assert.equal(view.sent.filter(m => m.binary).length, 0);
  assert.deepEqual(text(view), ['{"type":"nav","loading":false}']);
  assert.deepEqual(text(up).slice(1), ['{"type":"drawn"}']);
});

test('a view without acks gets no drawn report on its behalf', () => {
  const view = new Fake(), up = new Fake();
  forward.pipe(view as never, up as never);
  view.bufferedAmount = forward.BACKLOG + 1;
  up.emit('message', Buffer.from([1]), true);
  assert.equal(up.sent.length, 0);
});

test('each side closes with the other; an unreachable machine closes the view with 4502', () => {
  let view = new Fake(), up = new Fake();
  forward.pipe(view as never, up as never);
  view.close(); assert.notEqual(up.closed, null);
  view = new Fake(); up = new Fake();
  forward.pipe(view as never, up as never);
  up.emit('error', new Error('ECONNREFUSED'));
  assert.equal(view.closed, 4502);
});

test('checkCookies keeps the known fields of valid cookies and refuses the others', () => {
  const ok = signins.checkCookies([{ name: 'sid', value: 'v', domain: '.example.com', path: '/', expires: 2000000000, httpOnly: true, secure: true, session: false, sameSite: 'Lax', extra: 'x', partitionKey: { a: 1 } }]);
  assert.deepEqual(ok, [{ name: 'sid', value: 'v', domain: '.example.com', path: '/', expires: 2000000000, httpOnly: true, secure: true, session: false, sameSite: 'Lax' }]);
  assert.throws(() => signins.checkCookies([]), /No cookies/);
  assert.throws(() => signins.checkCookies([{ name: 'a', value: 'v', domain: 'bad domain!', path: '/' }]), /wrong domain/);
  assert.throws(() => signins.checkCookies([{ name: 'a', value: 'x'.repeat(signins.MAX_VALUE + 1), domain: 'example.com', path: '/' }]), /wrong field/);
  assert.throws(() => signins.checkCookies([{ name: 'a', value: 'v', domain: 'example.com', path: 'no-slash' }]), /wrong field/);
  assert.throws(() => signins.checkCookies(Array.from({ length: signins.MAX_COOKIES + 1 }, () => ({ name: 'a', value: 'v', domain: 'example.com', path: '/' }))), /At most/);
});

test('the template sends the cookies of the chosen sites, and an import puts them into a template', { skip: browser.chromePath() ? false : 'Chrome is not installed' }, async () => {
  const cookie = (name: string, domain: string) => ({ name, value: `SECRET-${name}`, domain, path: '/', expires: Math.round(Date.now() / 1000) + 3600, httpOnly: false, secure: false, session: false });
  await signins.importCookies([cookie('a1', 'site-a.localhost'), cookie('b1', 'site-b.localhost')]);
  const sent = await signins.exportSites(['site-a.localhost']);
  assert.deepEqual(sent.map(c => c.name), ['a1']);
  await signins.removeSite('site-a.localhost');
  assert.deepEqual((await signins.sites('template'))?.map(s => s.site), ['site-b.localhost']);
  const r = await signins.importCookies(sent);
  assert.deepEqual(r, { sites: ['site-a.localhost'], cookies: 1 });
  assert.deepEqual((await signins.sites('template'))?.map(s => s.site).sort(), ['site-a.localhost', 'site-b.localhost']);
  await assert.rejects(signins.exportSites(['site-c.localhost']), /no cookies/);
});
