// Long text and first prompts typed into agents through tmux, with the fake agent in tests/fixtures/fake-agent.cjs.
// Covers: tb send with long text (task 51), a new Codex task with a long first prompt (task 158), tb resume of a task
// without a saved session, and Codex's update dialog (task 144).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { waitFor } from './helpers/wait-for.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-long-text-')));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
process.env.TASKBOARD_TMUX_SOCKET = `tb-long-text-${process.pid}`;
process.env.CODEX_HOME = join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
const fake = readFileSync(join(import.meta.dirname, 'fixtures', 'fake-agent.cjs'), 'utf8');
for (const name of ['claude', 'codex', 'agy']) writeFileSync(join(bin, name), fake, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
writeFileSync(join(process.env.TASKBOARD_DIR, 'accounts.json'), JSON.stringify([{ id: 'codex-fixture', agent: 'codex', name: 'Codex fixture', dir: process.env.CODEX_HOME, maxParallel: 100, created: new Date().toISOString() }]));
writeFileSync(join(process.env.TASKBOARD_DIR, 'machine.json'), JSON.stringify({ controller: { autostart: false }, permissions: { trustWorkspaces: false } }));
const store = await import('../server/store.ts');
const agents = await import('../server/agents.ts');
const tmux = await import('../server/tmux.ts');
const { deliverText, holdsText } = await import('../server/deliver-text.ts');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const LENGTHS = [1, 500, 1000, 2000, 4000, 6000, 8000, 12000, 20000];
// a text of n characters that starts with "T", like the message in task 51, and ends with a marker
const textOf = (n: number) => n < 8 ? 'T'.slice(0, n) : ('The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(n / 45))).slice(0, n - 7) + ' END' + String(n % 1000).padStart(3, '0');
const submitted = (t: { id: string }) => {
  const f = join(store.taskDir(t.id), 'submitted.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { text: string; argv?: boolean }) : [];
};
let num = 100;
async function liveTask(agent: 'claude' | 'codex', env: Record<string, string> = {}) {
  const n = ++num;
  const t = store.create({ id: `long-${n}`, num: n, title: 'Long text fixture', agent, status: 'idle', cwd: root, folder: root, session: `task-${n}`, sessionId: `fixture-${n}`, account: agent === 'codex' ? 'codex-fixture' : undefined, desc: '' });
  mkdirSync(store.taskDir(t.id), { recursive: true });
  await tmux.newSession(t.session, root, { TASK_DIR: store.taskDir(t.id), FAKE_AGENT: agent, ...env }, [join(bin, agent)], async () => {});
  await waitFor(async () => /for shortcuts/.test(await tmux.capture(t.session, 0)), {
    description: `${agent} to draw its input box`,
    state: async () => `expected for shortcuts; screen:\n${await tmux.capture(t.session, 0)}`,
  });
  return t;
}

test('failure 1 reproduced: typing the whole text, 400 ms, then Enter does not submit long text to a Codex-like input box', { timeout: 120000 }, async () => {
  for (const n of [2000, 6000, 12000]) {
    const t = await liveTask('codex');
    try {
      await tmux.sendKeys(t.session, textOf(n));
      await waitFor(async () => (await tmux.capture(t.session, 0)).includes(`[Pasted Content ${n + 1} chars]`), {
        description: `Codex to draw the pasted text of ${n} characters`,
        state: async () => `expected pasted text; screen:\n${await tmux.capture(t.session, 0)}`,
      });
      // the Enter came during the fast input, so it became a part of the paste and nothing was submitted
      assert.deepEqual(submitted(t), [], `length ${n}`);
      assert.match(await tmux.capture(t.session, 0), new RegExp(`\\[Pasted Content ${n + 1} chars\\]`));
    } finally { await tmux.killSession(t.session); }
  }
  // tmux refuses one send-keys argument above about 16 KB
  const t = await liveTask('codex');
  try { await assert.rejects(tmux.sendKeys(t.session, textOf(20000)), /command too long/); } finally { await tmux.killSession(t.session); }
});

test('long text arrives whole and is submitted once, for Codex and Claude Code input boxes', { timeout: 180000 }, async () => {
  for (const agent of ['codex', 'claude'] as const) {
    for (const n of LENGTHS) {
      const t = await liveTask(agent);
      try {
        const r = await deliverText(t, textOf(n));
        assert.equal(r.submitted, true, `${agent} ${n}`);
        await waitFor(() => submitted(t).length > 0, {
          description: `${agent} to submit ${n} characters`,
          state: async () => `expected one submission; submissions: ${JSON.stringify(submitted(t))}; screen:\n${await tmux.capture(t.session, 0)}`,
        });
        assert.deepEqual(submitted(t).map(s => s.text), [textOf(n)], `${agent} ${n}`);
      } finally { await tmux.killSession(t.session); }
    }
  }
});

test('an empty text and a fresh draft in the box are refused, and Enter is not pressed', { timeout: 60000 }, async () => {
  const t = await liveTask('codex');
  try {
    await assert.rejects(deliverText(t, ''), /The text is empty/);
    await assert.rejects(deliverText(t, '   \n '), /The text is empty/);
    await assert.rejects(agents.sendTaskText(t, ''), /The text is empty/);
    // a lone "T" left in the box, as in task 51: the paste would join it, so nothing is typed
    await tmux.tmux('send-keys', '-t', `=${t.session}:`, '-l', 'T');
    await waitFor(async () => (await tmux.capture(t.session, 0)).includes('› T'), {
      description: 'Codex to show the draft', state: async () => `expected T in the input box; screen:\n${await tmux.capture(t.session, 0)}`,
    });
    // a draft that changed in the last 3 s is not moved (task 271 moves a quiet draft and puts it back)
    await assert.rejects(deliverText(t, textOf(6000)), /holds a draft\. Taskboard types the message when the draft has not changed and no key was typed for 3 s.*Nothing was typed\./);
    await pause(800);
    assert.deepEqual(submitted(t), []);
  } finally { await tmux.killSession(t.session); }
});

test('the input box check accepts only the text or a placeholder with its length', () => {
  const codex = (box: string) => `OpenAI Codex\n\n› ${box}\n\n  ? for shortcuts`;
  const rule = '─'.repeat(40);
  const claude = (box: string) => `${rule}\n❯ ${box}\n${rule}\n  ? for shortcuts`;
  const text = 'x'.repeat(6000);
  assert.equal(holdsText(codex('[Pasted Content 6000 chars]'), text, 'codex', true), true);
  assert.equal(holdsText(codex('[Pasted Content 5999 chars]'), text, 'codex', true), false);
  assert.equal(holdsText(codex('T[Pasted Content 6000 chars]'), text, 'codex', true), false);
  assert.equal(holdsText(codex('T'), 'The quick fox', 'codex', false), false);
  assert.equal(holdsText(codex('The quick\n  fox'), 'The quick fox', 'codex', false), true);
  assert.equal(holdsText(claude('[Pasted text #1]'), text, 'claude', true), true);
  assert.equal(holdsText(claude('[Pasted text #1]'), 'short', 'claude', false), false);
});

test('failure 2: a Codex task with a 7,000 character prompt in a worktree starts, and gets its whole prompt', { timeout: 120000 }, async () => {
  const repo = join(root, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const prompt = textOf(7000);
  const t = await agents.startTask({ title: 'Long first prompt', desc: prompt, agent: 'codex', folder: repo, worktree: true, branch: 'long-prompt', account: 'codex-fixture' });
  try {
    assert.equal(await tmux.hasSession(t.session), true);
    assert.equal(t.cwd, join(repo + '-wt', t.id));
    // the prompt did not fit on the command line, so it waits in the task folder and is typed in when the box shows
    assert.ok(!JSON.parse(readFileSync(join(store.taskDir(t.id), 'argv.json'), 'utf8')).includes(prompt));
    assert.equal(agents.pendingPrompt.get(t.id), prompt);
    // the old start: the prompt on the command line makes tmux refuse the whole command (this is what task 158 hit)
    const old = tmux.newSessionArgs('old-158', t.cwd, agents.baseEnv(t), agents.command(t, prompt, false));
    assert.ok(tmux.commandBytes(old) > 16364, `old command has ${tmux.commandBytes(old)} bytes`);
    await assert.rejects(tmux.tmux(...old), /command too long/);
    await waitFor(async () => {
      if (!agents.pendingPrompt.has(t.id)) return true;
      await agents.typePendingPrompt(store.get(t.id)!, await tmux.capture(t.session, 0));
      return !agents.pendingPrompt.has(t.id);
    }, { description: 'the first Codex prompt to leave the pending queue', state: async () => `screen:\n${await tmux.capture(t.session, 0)}` });
    await waitFor(() => submitted(t).length > 0, {
      description: 'Codex to submit the first prompt', state: async () => `expected one submission; screen:\n${await tmux.capture(t.session, 0)}`,
    });
    assert.deepEqual(submitted(t).map(s => s.text), [prompt]);
    assert.equal(agents.pendingPrompt.has(t.id), false);
  } finally { await tmux.killSession(t.session); }
});

test('a start that tmux refuses reports a short, clear error and does not keep the task', { timeout: 60000 }, async () => {
  // a title of 20 KB goes into the task instructions on the command line, so even without the prompt it is too long
  await assert.rejects(agents.startTask({ title: 'T'.repeat(20000), desc: 'Short prompt', agent: 'codex', folder: root, worktree: false, account: 'codex-fixture' }),
    (e: Error) => /^Codex did not start, so Taskboard did not keep task #\d+: The command that starts the agent has \d+ bytes, and tmux accepts at most about 16000\.$/.test(e.message));
  // a task that did not start is removed (commit f2226ac1)
  assert.equal(store.all().find(x => x.title.length === 20000), undefined);
  // a tmux error names the command, not the whole command line
  await assert.rejects(tmux.tmux('send-keys', '-t', '=no-such-session:', 'x'.repeat(5000)), (e: Error) => e.message.length < 300 && /^tmux send-keys failed: /.test(e.message));
});

test('resuming a task without a saved session id starts a new session with its first prompt', { timeout: 60000 }, async () => {
  const n = ++num;
  const t = store.create({ id: `never-${n}`, num: n, title: 'Never started', agent: 'codex', status: 'suspended', cwd: root, folder: root, session: `task-${n}`, account: 'codex-fixture', desc: 'FIRST_PROMPT_158 Renumber the migrations.' });
  try {
    assert.equal(agents.neverStarted(t), true);
    const r = await agents.resumeTask(t);
    assert.equal(r.status, 'working');
    assert.match(r.statusSource || '', /new session with its first prompt/);
    assert.equal(await tmux.hasSession(t.session), true);
    await waitFor(() => submitted(t).some(s => s.argv && s.text === 'FIRST_PROMPT_158 Renumber the migrations.'), {
      description: 'the resumed task to receive its first prompt', state: async () => `submissions: ${JSON.stringify(submitted(t))}; screen:\n${await tmux.capture(t.session, 0)}`,
    });
  } finally { await tmux.killSession(t.session); }
  // a Codex task with a session id still resumes that session
  assert.equal(agents.neverStarted({ ...t, sessionId: 'saved' }), false);
});

test('Codex update dialog: the real text is a blocking question, and no Enter reaches it', { timeout: 60000 }, async () => {
  // the dialog as Codex 0.158.0 drew it for task 144
  const dialog = [
    '  Update available · 0.158.0 → 0.160.0',
    '  Release notes: https://github.com/openai/codex/releases/latest',
    "› 1. Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)",
    '  2. Skip',
    '  3. Skip until next version',
    '  enter continue · esc skip',
  ];
  assert.match(dialog.join('\n'), agents.blockingQuestion);
  assert.match(dialog.slice(2).join('\n'), agents.blockingQuestion, 'the options alone, when the title scrolled away');
  assert.match('› 1. Install now\n  2. Later', agents.blockingQuestion);
  assert.doesNotMatch('› Ask Codex to do anything\n  ? for shortcuts', agents.blockingQuestion);
  // Taskboard starts Codex without its update check
  const cmd = agents.command({ ...store.create({ id: 'cmd-1', num: 1, title: 'Command', agent: 'codex', status: 'idle', cwd: root, folder: root, session: 'task-1', desc: '' }) }, 'hi', false);
  assert.ok(cmd.join(' ').includes('-c check_for_update_on_startup=false'));

  // a live Codex that shows the dialog: tb send refuses and types nothing
  const t = await liveTask('codex', { FAKE_UPDATE: '1' });
  try {
    await waitFor(async () => (await tmux.capture(t.session, 0)).includes('Update available'), {
      description: 'the Codex update question', state: async () => `expected Update available; screen:\n${await tmux.capture(t.session, 0)}`,
    });
    await assert.rejects(agents.sendTaskText(store.get(t.id)!, 'Please continue'), /asks a question/);
    await agents.typePendingPrompt(t, await tmux.capture(t.session, 0));
    agents.pendingPrompt.set(t.id, 'A first prompt');
    await agents.typePendingPrompt(t, await tmux.capture(t.session, 0));
    assert.equal(agents.pendingPrompt.get(t.id), 'A first prompt', 'the first prompt waits while the dialog shows');
    await pause(500);
    assert.deepEqual(submitted(t), []);
  } finally { agents.pendingPrompt.delete(t.id); await tmux.killSession(t.session); }

  // a resumed Codex that draws its input box and then the dialog (task 144): the text is not typed and Enter is not pressed
  const n = ++num;
  const r = store.create({ id: `resume-${n}`, num: n, title: 'Resume with dialog', agent: 'codex', status: 'stopped', cwd: root, folder: root, session: `task-${n}`, sessionId: `saved-${n}`, account: 'codex-fixture', desc: '' });
  // a session that keeps the tmux server running, so its global environment can be set for the next session
  await tmux.newSession('keep', root, {}, ['sleep', '600'], async () => {});
  await tmux.tmux('set-environment', '-g', 'FAKE_UPDATE', '1');
  try {
    await assert.rejects(agents.sendTaskText(r, 'Please continue'), /asks a question/);
    await pause(500);
    assert.ok(!submitted(r).some(s => s.text === 'UPDATE_CHOSEN'));
    assert.deepEqual(submitted(r).filter(s => !s.argv), []);
  } finally { await tmux.tmux('set-environment', '-gu', 'FAKE_UPDATE'); await tmux.killSession(r.session); }
});

test.after(() => {
  try { execFileSync('tmux', ['-L', process.env.TASKBOARD_TMUX_SOCKET!, 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
});
