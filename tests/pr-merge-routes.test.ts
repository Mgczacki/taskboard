import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A fake gh (TASKBOARD_GH) answers the GraphQL read of a pull request, the branch rules read, and the two GraphQL
// mutations (enqueuePullRequest, mergePullRequest) from a JSON state file. It writes each call to a log, so the test
// can show which GitHub writes ran. The task is not a Git worktree, like a task whose folder holds several repositories.
const root = mkdtempSync(join(tmpdir(), 'tb-pr-merge-'));
const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), folder = join(root, 'folder');
const stateFile = join(root, 'gh-state.json'), ghLog = join(root, 'gh.log');
mkdirSync(tbdir); mkdirSync(folder); mkdirSync(join(vault, 'tasks'), { recursive: true });
const HEAD = 'a'.repeat(40), NEW_HEAD = 'b'.repeat(40), BASE = 'c'.repeat(40), MERGED = 'd'.repeat(40);

interface Pr { draft?: boolean; head?: string; state?: string; mergeStateStatus?: string; mergeable?: string; inQueue?: boolean; reviewDecision?: string | null;
  checks?: { name: string; status?: string; conclusion?: string | null; required?: boolean }[] }
const green = [{ name: 'lint + unit tests', status: 'COMPLETED', conclusion: 'SUCCESS', required: true }, { name: 'publish', status: 'COMPLETED', conclusion: 'SKIPPED' }];
const state = {
  repos: { 'o/direct': { all: true }, 'o/queued': { all: true }, 'o/open': { all: true } } as Record<string, { all: boolean }>,
  rules: {
    'o/direct:main': [{ type: 'pull_request', parameters: { required_approving_review_count: 0, allowed_merge_methods: ['squash'] } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint + unit tests' }] } }],
    'o/queued:main': [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge', 'squash', 'rebase'] } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint + unit tests' }] } },
      { type: 'merge_queue', parameters: { merge_method: 'SQUASH' } }],
    'o/open:main': [],
  } as Record<string, unknown[]>,
  prs: {} as Record<string, Pr>,
  failMutation: false,
};
const setPr = (key: string, pr: Pr) => { state.prs[key] = { head: HEAD, state: 'OPEN', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', reviewDecision: null, checks: green, ...pr }; writeFileSync(stateFile, JSON.stringify(state)); };
writeFileSync(stateFile, JSON.stringify(state));
writeFileSync(join(root, 'gh.mjs'), `
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const s = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const get = k => args.find(a => a.startsWith(k + '='))?.slice(k.length + 1);
const query = get('query') || '';
const kind = query.includes('enqueuePullRequest') ? 'enqueue' : query.includes('mergePullRequest') ? 'merge' : query ? 'read' : 'rest';
appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ kind, args: args.map(a => a.startsWith('query=') ? 'query=' + kind : a), token: process.env.GH_TOKEN || 'none' }) + '\\n');
const out = v => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (kind === 'rest') { const m = args[1].match(/^repos\\/(.+)\\/rules\\/branches\\/([^?]+)/); out(s.rules[m[1] + ':' + m[2]] || []); }
if (kind === 'read') {
  const repo = get('owner') + '/' + get('name'), r = s.repos[repo], pr = s.prs[repo + '#' + get('number')];
  if (!r) out({ data: { repository: null } });
  out({ data: { repository: { nameWithOwner: repo, mergeCommitAllowed: r.all, squashMergeAllowed: true, rebaseMergeAllowed: r.all, pullRequest: pr && {
    id: 'PR_' + get('number'), number: Number(get('number')), url: 'https://github.com/' + repo + '/pull/' + get('number'), title: 'Fix it', state: pr.state,
    isDraft: !!pr.draft, headRefName: 'fix', headRefOid: pr.head, baseRefName: 'main', baseRefOid: ${JSON.stringify(BASE)},
    mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, isMergeQueueEnabled: repo === 'o/queued', isInMergeQueue: !!pr.inQueue, reviewDecision: pr.reviewDecision,
    commits: { nodes: [{ commit: { oid: pr.head, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: pr.checks.map(c => ({ __typename: 'CheckRun', isRequired: !!c.required, ...c })) } } } }] } } } } });
}
if (s.failMutation) { process.stderr.write('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)'); process.exit(1); }
if (kind === 'enqueue') out({ data: { enqueuePullRequest: { mergeQueueEntry: { position: 2, state: 'QUEUED' } } } });
out({ data: { mergePullRequest: { pullRequest: { state: 'MERGED', headRefOid: get('head'), mergeCommit: { oid: ${JSON.stringify(MERGED)} } } } } });
`);
writeFileSync(join(root, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'gh.mjs')}' "$@"\n`);
chmodSync(join(root, 'gh'), 0o755);
writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false } }));
writeFileSync(join(vault, 'tasks', 'merge-task.md'), `---\nid: merge-task\nnum: 1\ntitle: Merge test\nagent: codex\nstatus: idle\ncwd: ${folder}\nfolder: ${folder}\nworktree: false\nsession: test\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatusAt: 2026-01-01T00:00:00.000Z\n---\n# Merge test\n`);
const calls = () => existsSync(ghLog) ? readFileSync(ghLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { kind: string; args: string[]; token: string }) : [];
const writes = () => calls().filter(c => c.kind === 'enqueue' || c.kind === 'merge');

test('a task requests one exact pull request merge, and only the dashboard approves it', async () => {
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const address = s.address(); const port = typeof address === 'object' && address ? address.port : 0; s.close(() => resolve(port)); }); });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(),
    env: { ...process.env, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_GH: join(root, 'gh'), GH_TOKEN: 'server-env-token',
      TASKBOARD_TMUX_SOCKET: `tb-pr-merge-${port}`, TASKBOARD_MACHINE_NAME: 'pr-merge-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { const r = await fetch(base + '/api/info'); if (r.ok) break; } catch { /* server starts */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const taskKey = readFileSync(join(tbdir, 'task-tokens', 'merge-task'), 'utf8').trim();
    const taskHeaders = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-task-token': taskKey, 'x-tb-actor': 'merge-task' };
    const controllerHeaders = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': 'controller',
      'x-tb-mail-controller': readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim() };
    const userHeaders = { 'content-type': 'application/json', origin: base };
    const post = async (path: string, body: unknown, headers: Record<string, string> = taskHeaders) => {
      const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json().catch(() => ({})) };
    };
    const read = async (id: string) => (await fetch(base + `/api/git/pr-merges/${id}`, { headers: taskHeaders })).json();
    const ask = (repo: string, number: number, extra: Record<string, unknown> = {}) => post('/api/git/pr-merge-request', { repo, number, head: HEAD, ...extra });
    const refused = async (repo: string, number: number, pattern: RegExp, extra: Record<string, unknown> = {}) => {
      const r = await ask(repo, number, extra);
      assert.equal(r.status, 400, JSON.stringify(r.data));
      assert.match(r.data.error, pattern);
    };

    // input checks: a short head, no number, a bad method
    assert.match((await ask('o/direct', 1, { head: 'abc1234' })).data.error, /full 40-character head commit/);
    assert.match((await post('/api/git/pr-merge-request', { repo: 'o/direct', head: HEAD })).data.error, /--pr/);
    assert.match((await ask('o/direct', 1, { method: 'fast-forward' })).data.error, /--method merge, squash or rebase/);
    assert.equal((await post('/api/git/pr-merge-request', { repo: 'o/direct', number: 1, head: HEAD }, controllerHeaders)).status, 403);

    // rejected before a card: a stale head, a draft, failed and unfinished checks, a missing required check,
    // a review, a branch behind its base, a blocked rule, conflicts, a merged pull request, an entry in the queue
    setPr('o/direct#2', { head: NEW_HEAD }); await refused('o/direct', 2, new RegExp(`has head ${NEW_HEAD}, not ${HEAD}\\. The head changed after your review`));
    setPr('o/direct#3', { draft: true }); await refused('o/direct', 3, /is a draft/);
    setPr('o/direct#4', { checks: [...green, { name: 'unit tests (2/6)', status: 'COMPLETED', conclusion: 'FAILURE' }] }); await refused('o/direct', 4, /did not pass: unit tests \(2\/6\) FAILURE/);
    setPr('o/direct#5', { checks: [{ ...green[0], status: 'IN_PROGRESS', conclusion: null }] }); await refused('o/direct', 5, /have not finished: lint \+ unit tests IN_PROGRESS/);
    setPr('o/direct#6', { checks: [green[1]] }); await refused('o/direct', 6, /lint \+ unit tests NOT REPORTED/);
    setPr('o/direct#7', { reviewDecision: 'CHANGES_REQUESTED' }); await refused('o/direct', 7, /needs an approving review/);
    setPr('o/direct#8', { mergeStateStatus: 'BEHIND' }); await refused('o/direct', 8, /is behind main/);
    setPr('o/direct#9', { mergeStateStatus: 'BLOCKED' }); await refused('o/direct', 9, /BLOCKED, not CLEAN.*does not bypass branch rules/);
    setPr('o/direct#10', { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }); await refused('o/direct', 10, /has conflicts/);
    setPr('o/direct#11', { state: 'MERGED' }); await refused('o/direct', 11, /is merged/);
    setPr('o/queued#12', { inQueue: true }); await refused('o/queued', 12, /already in the merge queue/);
    await refused('o/direct', 404, /no pull request #404 in o\/direct/);
    // the method: the ruleset of o/direct allows only squash. o/open allows three and needs --method
    setPr('o/direct#1', {}); await refused('o/direct', 1, /allows only squash/, { method: 'merge' });
    setPr('o/open#20', {}); await refused('o/open', 20, /allows merge, squash, rebase\. Give one of them with --method/);
    await refused('o/queued', 12, /already in the merge queue/, { method: 'merge' });
    setPr('o/queued#13', {}); await refused('o/queued', 13, /merge queue of main merges with squash/, { method: 'merge' });
    assert.equal(writes().length, 0, 'no rejected request reached a GitHub write');

    // approved: a direct merge with the only allowed method, at the exact head
    const first = await ask('o/direct', 1);
    assert.equal(first.status, 202, JSON.stringify(first.data) + output);
    const { approval, prMerge } = first.data;
    assert.equal(approval.action, 'github-pr-merge');
    for (const line of ['Repository: o/direct', 'Pull request: #1 https://github.com/o/direct/pull/1', `Head: fix at ${HEAD}`, `Base: main at ${BASE}`,
      'Draft: No', 'Merge state: CLEAN', '- lint + unit tests: SUCCESS (required)', '- publish: SKIPPED', 'Merge method: squash', 'Merge queue required: No', 'never uses an administrator merge'])
      assert.ok(approval.detail.includes(line), `card lacks ${line}:\n${approval.detail}`);
    // neither the task nor the controller can approve the card
    assert.equal((await post(`/api/approvals/${approval.id}/approve`, {}, { ...taskHeaders, origin: base })).status, 403);
    assert.equal((await post(`/api/approvals/${approval.id}/approve`, {}, { ...controllerHeaders, origin: base })).status, 403);
    // the general permit guard still refuses gh pr merge, and names the supported command
    const permit = await post('/api/permits', { reason: 'merge', steps: [{ command: 'gh pr merge 1 --squash --admin', network: true }] });
    assert.equal(permit.status, 400);
    assert.match(permit.data.error, /A GitHub write needs a separate user decision\. .*tb git pr-merge-request/);
    const approved = await post(`/api/approvals/${approval.id}/approve`, {}, userHeaders);
    assert.equal(approved.data.state, 'approved', JSON.stringify(approved.data));
    assert.match(approved.data.result, new RegExp(`o/direct#1 at ${HEAD} merged into main with squash as ${MERGED}`));
    const merged = await read(prMerge.id);
    assert.equal(merged.state, 'merged');
    assert.equal(merged.mergeCommit, MERGED);
    let w = writes();
    assert.equal(w.length, 1);
    assert.deepEqual(w[0].args, ['api', 'graphql', '-f', 'query=merge', '-f', 'id=PR_1', '-f', `head=${HEAD}`, '-f', 'method=SQUASH']);
    assert.ok(calls().every(c => c.token === 'none' && !c.args.some(a => /admin/i.test(a))), 'no server token and no administrator flag');
    assert.ok(readFileSync(join(vault, 'tasks', 'merge-task', 'inbox', `pr-merge-${prMerge.id}.md`), 'utf8').includes(`Merge commit: ${MERGED}`));

    // rejected: the user denies the card. Nothing reaches GitHub
    setPr('o/direct#21', {});
    const second = await ask('o/direct', 21);
    await post(`/api/approvals/${second.data.approval.id}/deny`, {}, userHeaders);
    assert.equal((await read(second.data.prMerge.id)).state, 'denied');
    assert.equal(writes().length, 1);

    // stale: the head moves after the card was made. Approve runs nothing and marks the card stale
    setPr('o/direct#22', {});
    const third = await ask('o/direct', 22);
    setPr('o/direct#22', { head: NEW_HEAD });
    const stale = await post(`/api/approvals/${third.data.approval.id}/approve`, {}, userHeaders);
    assert.equal(stale.data.state, 'pending');
    assert.match(stale.data.staleFacts, new RegExp(`has head ${NEW_HEAD}.*Ask the task to run tb git pr-merge-request again`));
    // a check that fails after the card was made also stops Approve
    setPr('o/direct#22', { checks: [{ ...green[0], conclusion: 'FAILURE' }] });
    assert.match((await post(`/api/approvals/${third.data.approval.id}/approve`, {}, userHeaders)).data.staleFacts, /did not pass: lint \+ unit tests FAILURE/);
    assert.equal(writes().length, 1);

    // draft: a pull request that turns into a draft after the card was made
    setPr('o/direct#23', {});
    const fourth = await ask('o/direct', 23);
    setPr('o/direct#23', { draft: true });
    assert.match((await post(`/api/approvals/${fourth.data.approval.id}/approve`, {}, userHeaders)).data.staleFacts, /is a draft/);
    assert.equal(writes().length, 1);

    // queue: the base requires a merge queue. Approve adds the pull request to the queue, with no merge method
    const tbEnv = { ...process.env, TB_URL: base, TB_TOKEN_FILE: join(tbdir, 'token'), TASK_ID: 'merge-task', TB_TASK_TOKEN: taskKey };
    const tb = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), 'bin', 'tb'), ...args], { cwd: folder, env: tbEnv, encoding: 'utf8' });
    assert.match(tb('git', 'pr-merge-request', '--pr', '13').stderr, /give --pr NUMBER and --head SHA/);
    const cli = tb('git', 'pr-merge-request', '--repo', 'o/queued', '--pr', '13', '--head', HEAD);
    assert.equal(cli.status, 0, cli.stderr);
    const cliMatch = cli.stdout.match(/^Pull request merge request (\S+): pending\. o\/queued#13 at a{40}, through the merge queue\. The user decides card (\S+) on the dashboard\./);
    assert.ok(cliMatch, cli.stdout);
    const queueCard = (await (await fetch(base + '/api/approvals', { headers: userHeaders })).json() as { id: string; detail: string }[]).find(a => a.id === cliMatch[2]);
    assert.ok(queueCard?.detail.includes('Merge queue required: Yes') && queueCard.detail.includes('Merge method: squash')
      && queueCard.detail.includes(`Approve adds the pull request at head ${HEAD} to the merge queue of main`), queueCard?.detail);
    assert.equal((await post(`/api/approvals/${cliMatch[2]}/approve`, {}, userHeaders)).data.state, 'approved');
    const queued = JSON.parse(tb('git', 'pr-merge-result', cliMatch[1], '--wait').stdout);
    assert.equal(queued.state, 'queued');
    assert.match(queued.result, /in the merge queue of main at position 2 \(QUEUED\)/);
    w = writes();
    assert.equal(w.length, 2);
    assert.deepEqual(w[1].args, ['api', 'graphql', '-f', 'query=enqueue', '-f', 'id=PR_13', '-f', `head=${HEAD}`]);

    // GitHub refuses the write: the card fails, and the task gets the exact error
    setPr('o/direct#24', {});
    state.failMutation = true; writeFileSync(stateFile, JSON.stringify(state));
    const fifth = await ask('o/direct', 24);
    const failed = await post(`/api/approvals/${fifth.data.approval.id}/approve`, {}, userHeaders);
    assert.equal(failed.data.state, 'failed');
    assert.match(failed.data.result, /Merging the pull request failed with exit code 1: GraphQL: Head branch was modified/);
    assert.equal((await read(fifth.data.prMerge.id)).state, 'failed');
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    spawnSync('tmux', ['-L', `tb-pr-merge-${port}`, 'kill-server']);
    rmSync(root, { recursive: true, force: true });
  }
});
