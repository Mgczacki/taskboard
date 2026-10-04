// Tests for the Taskboard settings of the tmux server (scripts/tmux-settings.mjs and ensureConfigured in
// server/tmux.ts). The first tests use a fake tmux in memory. The last test uses a real tmux server on a scratch socket.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySettings, compareSettings, MARK, OPTIONS, readMark, SETTINGS_VERSION, TERMINAL_FEATURES } from '../scripts/tmux-settings.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-tmux-settings-')));
const socket = `tb-tmux-settings-${process.pid}`;
process.env.TASKBOARD_DIR = join(root, 'state'); process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = socket; process.env.TASKBOARD_PORT = '4398';
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
const endScratch = () => { try { execFileSync('tmux', ['-L', socket, 'kill' + '-server'], { stdio: 'ignore' }); } catch { /* not running */ } };
after(() => { endScratch(); rmSync(root, { recursive: true, force: true }); });

const TOKEN = 'secret-token-123', URL = 'http://127.0.0.1:4398';
// A tmux server in memory with the tmux defaults. start() is a new tmux server; stop() ends it.
function fakeTmux() {
  const defaults = () => new Map<string, string>([['status', 'on'], ['mouse', 'off'], ['escape-time', '10'], ['history-limit', '2000'], ['remain-on-exit', 'off'], ['extended-keys', 'off'], ['window-size', 'latest'], ['monitor-bell', 'on'], ['bell-action', 'any'], ['visual-bell', 'off'], ['default-terminal', 'tmux-256color'], ['set-clipboard', 'external'], ['focus-events', 'off']]);
  const f = { running: false, opts: defaults(), features: ['xterm*:clipboard:ccolour:cstyle:focus:title'], hook: '', keys: '', sets: 0, calls: [] as string[][],
    start() { f.running = true; f.opts = defaults(); f.features = ['xterm*:clipboard:ccolour:cstyle:focus:title']; f.hook = ''; f.keys = ''; },
    stop() { f.running = false; },
    run: async (args: string[]) => {
      f.calls.push(args);
      if (!f.running) throw new Error('no server running on /private/tmp/tmux-501/x');
      const [cmd, flags, name, value] = args;
      if (cmd === 'show-options' && name === 'terminal-features') return f.features.join('\n') + '\n';
      if (cmd === 'show-options') return (f.opts.get(name) ?? '') + (f.opts.has(name) ? '\n' : '');
      if (cmd === 'set-option' && flags === '-as') { f.features.push(value); return ''; }
      if (cmd === 'set-option') { f.sets++; f.opts.set(name, value); return ''; }
      if (cmd === 'set-hook') { f.hook = `alert-bell[0] ${args[3]}\n`; return ''; }
      if (cmd === 'show-hooks') return f.hook;
      if (cmd === 'source-file') { f.keys = 'bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-no-clear pbcopy'; return ''; }
      if (cmd === 'list-keys') return f.keys;
      throw new Error(`unknown ${cmd}`);
    },
  };
  return f;
}
const file = join(root, 'copy.conf');

test('no tmux server: no mark, nothing to compare', async () => {
  const f = fakeTmux();
  assert.equal(await readMark(f.run), null);
  assert.equal(await compareSettings(f.run, TOKEN, URL), null);
});

test('a new tmux server has the tmux defaults; applying sets every option and the mark', async () => {
  const f = fakeTmux(); f.start();
  assert.equal(await readMark(f.run), '');
  const differ = (await compareSettings(f.run, TOKEN, URL))!;
  for (const n of ['status', 'mouse', 'escape-time', 'history-limit', 'remain-on-exit', 'extended-keys', 'alert-bell hook', 'copy-mode bindings', MARK]) assert.ok(differ.includes(n), n);
  assert.ok(!differ.join(' ').includes(TOKEN), 'the token is never in the names');
  await applySettings(f.run, TOKEN, URL, file);
  assert.deepEqual(await compareSettings(f.run, TOKEN, URL), []);
  assert.equal(f.opts.get('status'), 'off'); assert.equal(f.opts.get('mouse'), 'on'); assert.equal(f.opts.get(MARK), SETTINGS_VERSION);
});

test('applying twice adds no second terminal-features entry', async () => {
  const f = fakeTmux(); f.start();
  await applySettings(f.run, TOKEN, URL, file); await applySettings(f.run, TOKEN, URL, file);
  for (const t of TERMINAL_FEATURES) assert.equal(f.features.filter(x => x === t).length, 1, t);
});

test('a restarted tmux server loses the mark; the mark of an older version or a hand-set option also differs', async () => {
  const f = fakeTmux(); f.start();
  await applySettings(f.run, TOKEN, URL, file);
  f.stop(); f.start(); // tmux kill-server, then a new tmux server
  assert.equal(await readMark(f.run), '');
  await applySettings(f.run, TOKEN, URL, file);
  f.opts.set(MARK, 'older'); f.opts.set('status', 'on');
  assert.deepEqual(await compareSettings(f.run, TOKEN, URL), ['status', MARK]);
});

test('a hook with another token or port differs', async () => {
  const f = fakeTmux(); f.start();
  await applySettings(f.run, 'other-token', URL, file);
  assert.deepEqual(await compareSettings(f.run, TOKEN, URL), ['alert-bell hook']);
  await applySettings(f.run, TOKEN, 'http://127.0.0.1:4317', file);
  assert.deepEqual(await compareSettings(f.run, TOKEN, URL), ['alert-bell hook']);
});

test('the option list keeps the settings that the user saw lost on 4 October 2026', () => {
  const want = { status: 'off', mouse: 'on', 'escape-time': '0', 'history-limit': '5000', 'remain-on-exit': 'on', 'extended-keys': 'on' };
  for (const [k, v] of Object.entries(want)) assert.equal(OPTIONS.find(o => o[1] === k)?.[2], v, k);
});

test('ensureConfigured on a real scratch tmux server: new server, configured server, two calls at once, restarted server', { timeout: 30000 }, async () => {
  const tmux = await import('../server/tmux.ts');
  const show = (o: string) => execFileSync('tmux', ['-L', socket, 'show-options', '-gqv', o], { encoding: 'utf8' }).trim();
  assert.equal(await tmux.ensureConfigured(), false, 'no tmux server: nothing to do');
  // a tmux server that something other than newSession started (a process window, the user)
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'other', 'sleep 60']);
  assert.equal(show('status'), 'on');
  // two sessions that start at the same time share one run
  const both = await Promise.all([tmux.ensureConfigured(), tmux.ensureConfigured()]);
  assert.deepEqual(both, [true, true]);
  assert.equal(show('status'), 'off'); assert.equal(show('mouse'), 'on'); assert.equal(show(MARK), SETTINGS_VERSION);
  assert.equal(await tmux.ensureConfigured(), false, 'the mark matches: nothing to do');
  assert.deepEqual(await tmux.compareSettings(), []);
  const features = execFileSync('tmux', ['-L', socket, 'show-options', '-sv', 'terminal-features'], { encoding: 'utf8' }).split('\n');
  for (const t of TERMINAL_FEATURES) assert.equal(features.filter(x => x === t).length, 1, t);
  // the tmux server ends while this process runs; newSession starts a new one and configures it
  endScratch();
  await tmux.newSession('task-x', root, {}, ['sleep', '60']);
  assert.equal(show('status'), 'off'); assert.equal(show('remain-on-exit'), 'on'); assert.equal(show(MARK), SETTINGS_VERSION);
  // an option set by hand: repairSettings sets it again and names it
  execFileSync('tmux', ['-L', socket, 'set-option', '-g', 'status', 'on']);
  assert.deepEqual(await tmux.repairSettings(), ['status']);
  assert.equal(show('status'), 'off');
});
