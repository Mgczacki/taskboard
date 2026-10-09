import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The remote is a local bare repository. Its configured URL is a github.com URL, and url.<path>.insteadOf sends Git
// to the bare repository. A fake gh (TASKBOARD_GH) records each call and prints a pull request URL.
const root = mkdtempSync(join(tmpdir(), 'tb-pr-route-'));
const main = join(root, 'main'), work = join(root, 'work'), release = join(root, 'release'), bare = join(root, 'remote.git');
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), ghLog = join(root, 'gh.log'), ghFail = join(root, 'gh-fail');
const githubUrl = 'https://github.com/test-owner/test-repo.git';
mkdirSync(main); mkdirSync(tbdir); mkdirSync(join(vault, 'tasks'), { recursive: true });
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
git(main, 'init', '-b', 'main'); git(main, 'config', 'user.email', 'pr-test@example.invalid'); git(main, 'config', 'user.name', 'PR Test');
writeFileSync(join(main, 'base.txt'), 'base\n'); git(main, 'add', '-A'); git(main, 'commit', '-m', 'base');
git(root, 'init', '--bare', '-b', 'main', bare);
git(main, 'remote', 'add', 'origin', githubUrl); git(main, 'config', `url.${bare}.insteadOf`, githubUrl);
git(main, 'push', 'origin', 'main');
git(main, 'worktree', 'add', '-b', 'task-pr', work);
writeFileSync(join(work, 'feature.txt'), 'feature\n'); git(work, 'add', '-A'); git(work, 'commit', '-m', 'add feature');
git(main, 'worktree', 'add', '-b', 'release/1.0', release); git(release, 'push', 'origin', 'release/1.0');
writeFileSync(join(root, 'gh'), `#!/bin/sh
input=$(cat)
printf '%s\\n' "ARGS $*" "STDIN $input" "TOKEN \${GH_TOKEN:-none}" >> '${ghLog}'
if [ "$1 $2" = "pr view" ]; then printf '{"headRefOid":"%s","baseRefName":"main","isDraft":true}\\n' "$(git rev-parse HEAD)"; exit 0; fi
if [ -f '${ghFail}' ]; then echo 'a pull request for branch "task-pr" into branch "main" already exists:' >&2; exit 1; fi
echo 'https://github.com/test-owner/test-repo/pull/7'
`);
chmodSync(join(root, 'gh'), 0o755);
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
const taskNote = (id: string, num: number, cwd: string, branch: string) => `---\nid: ${id}\nnum: ${num}\ntitle: PR test ${num}\nagent: codex\nstatus: idle\ncwd: ${cwd}\nfolder: ${main}\nbranch: ${branch}\nworktree: true\nsession: test\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatusAt: 2026-01-01T00:00:00.000Z\n---\n# PR test\n`;
writeFileSync(join(vault, 'tasks', 'pr-task.md'), taskNote('pr-task', 1, work, 'task-pr'));
writeFileSync(join(vault, 'tasks', 'release-task.md'), taskNote('release-task', 2, release, 'release/1.0'));

test('a task requests one exact pull request, and only the dashboard approves it', async () => {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const address = s.address(); const port = typeof address === 'object' && address ? address.port : 0; s.close(() => resolve(port)); }); });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(),
    env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_GH: join(root, 'gh'), GH_TOKEN: 'server-env-token',
      TASKBOARD_TMUX_SOCKET: `tb-pr-route-${port}`, TASKBOARD_MACHINE_NAME: 'pr-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const r = await fetch(base + '/api/info'); if (r.ok) break; } catch { /* server starts */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const taskKey = (id: string) => readFileSync(join(tbdir, 'task-tokens', id), 'utf8').trim();
    const taskHeaders = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-task-token': taskKey('pr-task'), 'x-tb-actor': 'pr-task' };
    const releaseHeaders = { ...taskHeaders, 'x-tb-task-token': taskKey('release-task'), 'x-tb-actor': 'release-task' };
    const controllerHeaders = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': 'controller',
      'x-tb-mail-controller': readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim() };
    const userHeaders = { 'content-type': 'application/json', origin: base };
    const post = async (path: string, body: unknown, headers: Record<string, string> = taskHeaders) => {
      const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json().catch(() => ({})) };
    };
    const read = async (id: string) => (await fetch(base + `/api/git/pull-requests/${id}`, { headers: taskHeaders })).json();
    const request = { title: 'Add the feature', body: 'Line one.\n\nLine two.', draft: true };

    // the branch is not on the remote yet
    const unpushed = await post('/api/git/pr-request', request);
    assert.equal(unpushed.status, 400, JSON.stringify(unpushed.data));
    assert.match(unpushed.data.error, /Push the exact head first with tb git push-request/);
    git(work, 'push', 'origin', 'task-pr');
    assert.equal((await post('/api/git/pr-request', { ...request, title: '' })).status, 400);
    assert.match((await post('/api/git/pr-request', { ...request, base: 'missing' })).data.error, /does not exist on origin/);
    assert.match((await post('/api/git/pr-request', request, releaseHeaders)).data.error, /release\/1\.0 is a protected branch/);
    assert.equal((await post('/api/git/pr-request', request, controllerHeaders)).status, 403);

    const first = await post('/api/git/pr-request', request);
    assert.equal(first.status, 202, output);
    const head1 = git(work, 'rev-parse', 'HEAD'), mainHead = git(main, 'rev-parse', 'main');
    const { approval, pullRequest } = first.data;
    assert.equal(approval.action, 'github-pr');
    for (const line of ['Repository: test-owner/test-repo', `Remote: origin (${githubUrl})`, `Base: main at ${mainHead}`, `Head: task-pr at ${head1}`, 'Draft: Yes', 'Title: Add the feature', 'Line one.\n\nLine two.'])
      assert.ok(approval.detail.includes(line), `card lacks ${line}:\n${approval.detail}`);

    // neither the task nor the controller can approve the card
    assert.equal((await post(`/api/approvals/${approval.id}/approve`, {}, { ...taskHeaders, origin: base })).status, 403);
    assert.equal((await post(`/api/approvals/${approval.id}/approve`, {}, { ...controllerHeaders, origin: base })).status, 403);
    // the general guard still refuses gh pr create, and names the supported command
    const permit = await post('/api/permits', { reason: 'open a PR', steps: [{ command: 'gh pr create --title x --body y', network: true }] });
    assert.equal(permit.status, 400);
    assert.match(permit.data.error, /A GitHub write needs a separate user decision\. .*tb git pr-request/);

    // the branch moves after the card was made: Approve runs nothing and marks the card stale
    writeFileSync(join(work, 'more.txt'), 'more\n'); git(work, 'add', '-A'); git(work, 'commit', '-m', 'more');
    const stale = await post(`/api/approvals/${approval.id}/approve`, {}, userHeaders);
    assert.equal(stale.data.state, 'pending');
    assert.match(stale.data.staleFacts, /Push the exact head first/);
    assert.equal(existsSync(ghLog), false);

    git(work, 'push', 'origin', 'task-pr');
    const head2 = git(work, 'rev-parse', 'HEAD');
    // the second request goes through the tb command, with the body in a file
    writeFileSync(join(root, 'body.md'), request.body);
    const tbEnv = { ...process.env, TB_URL: base, TB_TOKEN_FILE: join(tbdir, 'token'), TASK_ID: 'pr-task', TB_TASK_TOKEN: taskKey('pr-task') };
    const tb = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), 'bin', 'tb'), ...args], { cwd: work, env: tbEnv, encoding: 'utf8' });
    assert.match(tb('git', 'pr-request', '--title', 'x', '--body', 'a', '--body-file', 'b').stderr, /give --body or --body-file, not both/);
    const cli = tb('git', 'pr-request', '--title', request.title, '--body-file', join(root, 'body.md'), '--draft');
    assert.equal(cli.status, 0, cli.stderr);
    const cliMatch = cli.stdout.match(/^Pull request request (\S+): pending\. The user decides card (\S+) on the dashboard\./);
    assert.ok(cliMatch, cli.stdout);
    const second = { data: { pullRequest: { id: cliMatch[1] }, approval: { id: cliMatch[2] } } };
    assert.equal(second.data.approval.id, approval.id, 'a new request for the same branches replaces the open card');
    assert.equal((await read(pullRequest.id)).state, 'expired');
    const approved = await post(`/api/approvals/${approval.id}/approve`, {}, userHeaders);
    assert.equal(approved.data.state, 'approved', JSON.stringify(approved.data));
    assert.match(approved.data.result, /https:\/\/github\.com\/test-owner\/test-repo\/pull\/7/);
    const done = await read(second.data.pullRequest.id);
    assert.equal(JSON.parse(tb('git', 'pr-result', done.id, '--wait').stdout).url, 'https://github.com/test-owner/test-repo/pull/7');
    assert.equal(done.state, 'succeeded');
    assert.equal(done.url, 'https://github.com/test-owner/test-repo/pull/7');
    assert.match(done.result, new RegExp(`GitHub reports head ${head2}, base main, draft yes`));
    const log = readFileSync(ghLog, 'utf8');
    assert.ok(log.includes('ARGS pr create --repo test-owner/test-repo --base main --head task-pr --title Add the feature --body-file - --draft'), log);
    assert.ok(log.includes('STDIN Line one.\n\nLine two.'), log);
    assert.doesNotMatch(log, /server-env-token/);
    assert.ok(readFileSync(join(vault, 'tasks', 'pr-task', 'inbox', `pull-request-${done.id}.md`), 'utf8').includes('URL: https://github.com/test-owner/test-repo/pull/7'));

    // gh fails: the card fails, and the task gets the exact gh error
    writeFileSync(ghFail, '');
    const third = await post('/api/git/pr-request', { ...request, draft: false });
    const failed = await post(`/api/approvals/${third.data.approval.id}/approve`, {}, userHeaders);
    assert.equal(failed.data.state, 'failed');
    assert.match(failed.data.result, /gh pr create failed with exit code 1: a pull request for branch "task-pr" into branch "main" already exists/);
    assert.equal((await read(third.data.pullRequest.id)).state, 'failed');

    // a denial reaches the record
    const fourth = await post('/api/git/pr-request', { ...request, title: 'Other title' });
    await post(`/api/approvals/${fourth.data.approval.id}/deny`, {}, userHeaders);
    assert.equal((await read(fourth.data.pullRequest.id)).state, 'denied');
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    spawnSync('tmux', ['-L', `tb-pr-route-${port}`, 'kill-server']);
    rmSync(root, { recursive: true, force: true });
  }
});
