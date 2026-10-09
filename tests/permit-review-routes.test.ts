import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers/wait-for.ts';

test('CLI and routes review exact settings and explain a conflicting directory', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tb-permit-review-')));
  const tbdir = join(root, 'tbdir'), vault = join(root, 'vault'), parent = join(root, 'workspace');
  const attached = join(parent, 'attached'), other = join(parent, 'other'), config = join(root, 'config');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TASK_|TB_|TASKBOARD_)/.test(name)));
  for (const path of [tbdir, join(vault, 'tasks', 't216'), join(vault, 'tasks', 'other'), parent, attached, other, config]) mkdirSync(path, { recursive: true });
  writeFileSync(join(tbdir, 'machine.json'), JSON.stringify({ controller: { autostart: false, remoteControl: false }, permitRequestLimits: { enabled: false } }));
  const note = (id: string, fields: Record<string, unknown>) => writeFileSync(join(vault, 'tasks', id + '.md'),
    `---\n${Object.entries({ id, title: id, agent: 'codex', status: 'idle', session: id, created: '2026-01-01T00:00:00.000Z', ...fields }).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join('\n')}\n---\n# ${id}\n`);
  note('t216', { num: 216, cwd: parent, folder: parent, scopes: [{ id: 'attached', kind: 'worktree', name: 'attached', path: attached, folder: parent, branch: 'task/attached' }] });
  note('other', { num: 217, cwd: other, folder: parent, worktree: true, branch: 'task/other' });
  const transcript = join(root, 'controller.jsonl');
  writeFileSync(transcript, '');
  note('controller', { num: 0, role: 'controller', agent: 'claude', cwd: attached, folder: parent, transcript });
  const port = await new Promise<number>(resolvePort => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolvePort((address as { port: number }).port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...clean, TASKBOARD_PORT: String(port), TASKBOARD_DIR: tbdir, TASKBOARD_VAULT: vault, TASKBOARD_TMUX_SOCKET: `tb-permit-review-${port}`, TASKBOARD_MACHINE_NAME: 'permit-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  try {
    await waitFor(async () => { if (child.exitCode !== null) throw new Error(output); return (await fetch(base + '/api/info')).ok; }, { description: 'the isolated permit test server', timeoutMs: 15000, state: () => output });
    const token = readFileSync(join(tbdir, 'token'), 'utf8').trim();
    const controllerToken = readFileSync(join(tbdir, 'mail-controller.token'), 'utf8').trim();
    const taskToken = readFileSync(join(tbdir, 'task-tokens', 't216'), 'utf8').trim();
    const taskHeaders = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-task-token': taskToken, 'x-tb-actor': 't216' };
    const controllerHeaders = { 'content-type': 'application/json', 'x-taskboard-token': token, 'x-tb-actor': 'controller', 'x-tb-mail-controller': controllerToken };
    const userHeaders = { 'content-type': 'application/json', origin: base };
    const post = async (path: string, body: unknown, headers: Record<string, string> = taskHeaders) => {
      const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const patch = async (body: unknown) => {
      const response = await fetch(base + '/api/info', { method: 'PATCH', headers: userHeaders, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.text());
    };
    const cards = async () => (await (await fetch(base + '/api/approvals')).json()) as any[];
    const permitCard = async (id: string) => (await cards()).find(card => card.payload?.permitId === id);
    const cli = (args: string[], cwd = attached) => new Promise<{ code: number | null; out: string }>(done => {
      const proc = spawn(process.execPath, [resolve('bin/tb'), ...args], { cwd, env: { ...clean, TASK_ID: 't216', TB_URL: base, TB_TOKEN_FILE: join(tbdir, 'token') }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { out += data; }); proc.on('close', code => done({ code, out }));
    });
    const permits = async () => (await (await fetch(base + '/api/permits', { headers: taskHeaders })).json()) as any[];
    const latest = async () => (await permits())[0];

    // A request from an attached worktree uses the CLI directory instead of the parent task folder.
    const suggested = await cli(['suggest', 'pwd', '--why', 'Read the attached worktree', '--env', `GH_CONFIG_DIR=${config}`, '--unset-env', 'GH_TOKEN']);
    assert.equal(suggested.code, 0, suggested.out + output);
    assert.ok(suggested.out.includes(`resolved cwd: ${attached}`));
    const p = await latest();
    assert.ok(p, suggested.out + output + JSON.stringify(await permits()));
    assert.equal(p.steps[0].cwd, attached);
    assert.deepEqual(p.steps[0].env, { GH_CONFIG_DIR: config });
    assert.deepEqual(p.steps[0].unsetEnv, ['GH_TOKEN']);
    assert.equal(p.riskClass, 'low');
    const card = await permitCard(p.id);
    assert.ok(card.detail.includes(`Set GH_CONFIG_DIR: ${config}`));
    assert.ok(card.detail.includes(p.stepHash));
    assert.equal(card.validUntil, p.expiresAt);
    assert.equal((await post(`/api/permits/${p.id}/controller-approve`, {}, controllerHeaders)).status, 403);
    assert.equal((await post(`/api/permits/${p.id}/controller-approve`, {}, taskHeaders)).status, 403);
    await patch({ controllerCanApprovePermits: true, confirmLowerControl: true });
    const decided = await post(`/api/permits/${p.id}/controller-approve`, {}, controllerHeaders);
    assert.equal(decided.status, 200, JSON.stringify(decided.data));
    assert.equal(decided.data.state, 'succeeded');
    assert.equal(decided.data.steps[0].outputTail.trim(), attached);
    assert.equal(decided.data.approvedBy, 'controller');
    assert.equal((await permitCard(p.id)).decidedBy.by, 'controller');
    assert.equal((await post(`/api/permits/${p.id}/controller-approve`, {}, controllerHeaders)).status, 403);

    // A rejected parent directory makes a card with a correction and no execution button.
    const rejected = await cli(['suggest', 'pwd', '--why', 'Inspect the parent', '--cwd', parent]);
    assert.equal(rejected.code, 1);
    assert.ok(rejected.out.includes(parent)); assert.ok(rejected.out.includes(other));
    assert.match(rejected.out, /cwd-overlaps-other-worktree/);
    assert.ok(rejected.out.includes(attached)); assert.match(rejected.out, /--cwd/);
    const refusal = (await cards()).find(card => card.payload?.diagnostic);
    assert.ok(refusal);
    assert.equal(refusal.payload.canPermit, false);
    assert.equal(refusal.payload.diagnostic.conflictingTask, 'the worktree of task #217');
    assert.equal((await post(`/api/refusals/${refusal.id}/permit`, {}, userHeaders)).status, 400);
    const controllerCards = await (await fetch(base + '/api/controller/approvals', { headers: controllerHeaders })).json();
    assert.equal(controllerCards.cards.find((c: any) => c.id === refusal.id).controllerMayApprove, false);

    // Unknown names fail before any values enter records or cards.
    const before = (await cards()).length;
    const rejectedEnv = await cli(['suggest', 'pwd', '--why', 'Check a secret setting', '--env', 'GH_TOKEN=do-not-store-this']);
    assert.equal(rejectedEnv.code, 1);
    assert.ok(!rejectedEnv.out.includes('do-not-store-this'));
    assert.equal((await cards()).length, before);
    assert.ok(!JSON.stringify(await permits()).includes('do-not-store-this'));

    // Legacy env text becomes separate fields and still needs user approval when policy is off.
    await patch({ controllerCanApprovePermits: false });
    const legacy = await post('/api/permits', { reason: 'Review legacy environment syntax', steps: [{ command: `env GH_CONFIG_DIR=${config} echo reviewed`, cwd: attached }] });
    assert.equal(legacy.status, 202, JSON.stringify(legacy.data));
    const lp = legacy.data.permit;
    assert.equal(lp.steps[0].reviewRule, 'environment-values-in-command');
    assert.ok(!lp.steps[0].command.includes('GH_CONFIG_DIR'));
    assert.match((await permitCard(lp.id)).detail, /Rule: environment-values-in-command/);
    assert.equal((await post(`/api/permits/${lp.id}/controller-approve`, {}, controllerHeaders)).status, 403);
    const userDecision = await post(`/api/permits/${lp.id}/decide`, { approve: true }, userHeaders);
    assert.equal(userDecision.data.state, 'succeeded');
    assert.equal(userDecision.data.approvedBy, 'user');
    assert.equal((await post(`/api/permits/${lp.id}/decide`, { approve: true }, userHeaders)).data.startedAt, userDecision.data.startedAt);

    // A settings file with no cwd also uses the CLI directory for each step.
    const stepsFile = join(root, 'steps.json');
    writeFileSync(stepsFile, JSON.stringify({ steps: [{ command: 'pwd' }, { command: 'echo second', env: { GH_CONFIG_DIR: config } }] }));
    assert.equal((await cli(['suggest', '--steps', stepsFile, '--why', 'Read in order'])).code, 0);
    const sequence = await latest();
    assert.deepEqual(sequence.steps.map((s: any) => s.cwd), [attached, attached]);
    await post(`/api/permits/${sequence.id}/decide`, { approve: false }, userHeaders);

    // High risk settings require the named permit in a real user message and the configured policy.
    const high = (await post('/api/permits', { reason: 'Review a configuration file', steps: [{ command: 'pwd', cwd: attached, env: { GIT_CONFIG_GLOBAL: join(config, 'gitconfig') } }] })).data.permit;
    assert.equal(high.riskClass, 'high');
    assert.equal((await post(`/api/permits/${high.id}/controller-approve`, {}, controllerHeaders)).status, 403);
    const words = `approve permit ${high.id}`;
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: words } }) + '\n');
    await patch({ controllerApprovals: { permit: false } });
    assert.equal((await post(`/api/permits/${high.id}/controller-approve`, { userRequest: words }, controllerHeaders)).status, 403);
    await patch({ controllerApprovals: { permit: true } });
    const highDecision = await post(`/api/permits/${high.id}/controller-approve`, { userRequest: words }, controllerHeaders);
    assert.equal(highDecision.status, 200, JSON.stringify(highDecision.data));
    assert.equal(highDecision.data.controllerRequestText, words);
    assert.equal(highDecision.data.approvalRule, 'explicit user request');
    const audit = readFileSync(join(tbdir, 'approval-decisions.jsonl'), 'utf8');
    assert.ok(audit.includes(lp.approvalId));
    assert.ok(audit.includes(high.approvalId));

    // Supervised requests use the same fields and retain their dashboard gate.
    writeFileSync(join(attached, 'review-script.sh'), 'echo checked\n');
    const runBody = { name: 'review-script', reason: 'Read script output', risk: 'Writes task output.', command: 'bash review-script.sh', cwd: attached, env: { GH_CONFIG_DIR: config }, unsetEnv: ['GH_TOKEN'] };
    const run = await post('/api/permits/supervised', runBody);
    assert.equal(run.status, 202, JSON.stringify(run.data));
    assert.deepEqual(run.data.permit.steps[0].env, { GH_CONFIG_DIR: config });
    const rp = run.data.permit;
    const rc = await permitCard(rp.id);
    assert.ok(rc.detail.includes(`Set GH_CONFIG_DIR: ${config}`));
    const runWords = `approve permit ${rp.id}`;
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: runWords } }) + '\n');
    assert.equal((await post(`/api/permits/${rp.id}/controller-approve`, { userRequest: runWords }, controllerHeaders)).status, 403);
    const list = await (await fetch(base + '/api/controller/approvals', { headers: controllerHeaders })).json();
    const listedRun = list.cards.find((card: any) => card.id === rc.id);
    const generalRun = await post(`/api/approvals/${rc.id}/controller-approve`, { userRequest: runWords, version: listedRun.version }, controllerHeaders);
    assert.equal(generalRun.status, 403, JSON.stringify(generalRun.data));
    assert.match(generalRun.data.error, /supervised run/);
    await post(`/api/permits/${rp.id}/decide`, { approve: false }, userHeaders);
    const runDirectory = await post('/api/permits/supervised', { ...runBody, cwd: parent });
    assert.equal(runDirectory.status, 400);
    assert.ok(runDirectory.data.diagnostic, JSON.stringify(runDirectory.data));
    assert.equal(runDirectory.data.diagnostic.rule, 'cwd-overlaps-other-worktree');
    assert.ok(runDirectory.data.refusal);
  } finally {
    if (child.exitCode === null) await new Promise<void>(done => { child.once('exit', () => done()); child.kill('SIGTERM'); });
    rmSync(root, { recursive: true, force: true });
  }
});
