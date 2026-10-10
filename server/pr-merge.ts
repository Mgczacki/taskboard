// tb git pr-merge-request: a task (a worker or a group manager) asks the user to merge one GitHub pull request at one
// exact head commit. The general guard still refuses `gh pr` and `gh api` in permits (permits.ts hardRule). This module
// is the only path that merges a pull request for a task, and only after the user approves the card on the dashboard
// (action github-pr-merge).
// inspectMerge reads the pull request, the checks of its head and the branch rules of its base with gh. It only reads.
// It refuses the request when:
//   - the head of the pull request is not the commit that the task named (a stale head)
//   - the pull request is closed, merged, a draft, or already in the merge queue
//   - a check on the head failed, did not finish, or a required check did not report
//   - a review is required or changes are requested
//   - GitHub does not report the pull request as ready to merge (conflicts, a branch behind its base, a blocked rule)
//   - the repository or its rulesets do not allow the merge method
// When the base requires a merge queue, Approve adds the pull request to that queue (GraphQL enqueuePullRequest). Else
// Approve merges it (GraphQL mergePullRequest) with the method on the card. Both calls send expectedHeadOid, so GitHub
// refuses them when the head moved. Taskboard never asks for an administrator merge and never merges around a merge
// queue. An account that may bypass the branch rules gets the same checks, because these checks are Taskboard's own.
// After a queue entry, follow() reads the pull request every POLL_MS until GitHub merges it or removes it from the
// queue, and the record gets the final state. A restart of Taskboard starts follow() again for each queued record.
// tb git pr-ready-request marks a draft pull request ready for review (GraphQL markPullRequestReadyForReview), after the
// user, or the controller on the user's request, approves its card (action github-pr-ready). It is a separate card,
// because many repositories start CI when a draft becomes ready, and a merge must wait for those checks.
// Records are saved to TB_DIR/pr-merges.json and TB_DIR/pr-ready.json.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from './store.ts';
import { repoName } from './push.ts';
import { gh, safe } from './pull-request.ts';
import { TB_DIR } from './config.ts';

const exec = promisify(execFile);
export type MergeMethod = 'merge' | 'squash' | 'rebase';
const METHODS: MergeMethod[] = ['merge', 'squash', 'rebase'];
export interface CheckResult { name: string; result: string; required: boolean }
export interface PrMergeState {
  taskId: string; repository: string; number: number; url: string; title: string; nodeId: string;
  head: string; headCommit: string; base: string; baseCommit: string; draft: boolean;
  mergeState: string; reviewDecision: string | null; checks: CheckResult[];
  // null: the merge queue sets the method, and Taskboard cannot read it from the rulesets
  method: MergeMethod | null; queue: boolean;
  // check_response_timeout_minutes of the merge_queue rule: follow() uses it for its time limit
  queueTimeoutMinutes?: number;
}
export interface PrMergeRecord extends PrMergeState {
  id: string; at: string; doneAt?: string; approvalId?: string;
  state: 'pending' | 'merged' | 'queued' | 'removed-from-queue' | 'failed' | 'denied' | 'expired' | 'unknown'; mergeCommit?: string; result?: string;
  // queued: the time of the queue entry, the last position that GitHub reported, and when follow() stops reading
  queuedAt?: string; queuePosition?: number; followUntil?: string;
}
export interface PrReadyState { taskId: string; repository: string; number: number; url: string; title: string; nodeId: string; head: string; headCommit: string; base: string }
export interface PrReadyRecord extends PrReadyState {
  id: string; at: string; doneAt?: string; approvalId?: string; state: 'pending' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'unknown'; result?: string;
}

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      id number url title state isDraft headRefName headRefOid baseRefName baseRefOid
      mergeable mergeStateStatus isMergeQueueEnabled isInMergeQueue reviewDecision
      commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
          ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
        }
      } } } } }
    }
  }
}`;
interface CheckNode { __typename: string; name?: string; status?: string; conclusion?: string | null; context?: string; state?: string; isRequired?: boolean }
interface PullRequestNode {
  id: string; number: number; url: string; title: string; state: string; isDraft: boolean; headRefName: string; headRefOid: string;
  baseRefName: string; baseRefOid: string; mergeable: string; mergeStateStatus: string; isMergeQueueEnabled?: boolean;
  isInMergeQueue?: boolean; reviewDecision: string | null;
  commits: { nodes: { commit: { oid: string; statusCheckRollup: { contexts: { pageInfo: { hasNextPage: boolean }; nodes: CheckNode[] } } | null } }[] };
}
interface Rule { type: string; parameters?: { allowed_merge_methods?: string[]; merge_method?: string; check_response_timeout_minutes?: number; required_status_checks?: { context: string }[]; required_approving_review_count?: number } }

async function ghJson<T>(args: string[], cwd: string, what: string): Promise<T> {
  const r = await gh(args, cwd).catch(e => { throw new Error(safe(`gh could not start: ${e instanceof Error ? e.message : String(e)}`)); });
  if (r.code !== 0) throw new Error(`${what} failed with exit code ${r.code}: ${safe(`${r.out}\n${r.err}`.trim())}`);
  let data: T & { errors?: { message: string }[] };
  try { data = JSON.parse(r.out); } catch { throw new Error(`${what} did not return JSON: ${safe(r.out.slice(0, 500))}`); }
  if (data?.errors?.length) throw new Error(`${what} failed: ${safe(data.errors.map(e => e.message).join('; '))}`);
  return data;
}

const OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const WAITING = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED', 'EXPECTED', 'NOT REPORTED']);
// The merge states that let Approve run. BEHIND: the base moved. A merge queue tests the pull request on the new base
// itself, so only a direct merge refuses it.
const READY = new Set(['CLEAN', 'HAS_HOOKS']);

type RepositoryNode = { nameWithOwner: string; mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean };
// Checks the input of a request and reads the pull request with QUERY. It throws when the pull request is not open, or
// when its head is not the commit that the task named. tb git pr-merge-request and tb git pr-ready-request use it.
async function readPullRequest(task: Task, input: { repo?: unknown; number?: unknown; head?: unknown }, command: string): Promise<{ repo: RepositoryNode; pr: PullRequestNode; where: string }> {
  if (task.role === 'controller') throw new Error('A task must make the request.');
  const number = typeof input.number === 'number' ? input.number : typeof input.number === 'string' && /^\d+$/.test(input.number) ? Number(input.number) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Give the pull request number with --pr, for example --pr 679.');
  if (typeof input.head !== 'string' || !/^[0-9a-f]{40}$/.test(input.head))
    throw new Error('Give the full 40-character head commit that you reviewed with --head. Taskboard acts only on that commit.');
  let repository: string;
  if (input.repo === undefined) {
    const url = await exec('git', ['config', '--get', 'remote.origin.url'], { cwd: task.cwd }).then(r => r.stdout.trim()).catch(() => '');
    const name = url && repoName(url);
    if (!name) throw new Error('Give the repository with --repo OWNER/NAME. The task folder has no github.com origin remote.');
    repository = name;
  } else if (typeof input.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) repository = input.repo;
  else throw new Error('Give the repository as OWNER/NAME, for example --repo sekai-app/sekai-agent-ts.');
  const [owner, name] = repository.split('/');
  const data = await ghJson<{ data: { repository: (RepositoryNode & { pullRequest: PullRequestNode | null }) | null } }>(
    ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`], task.cwd, 'Reading the pull request');
  const repo = data.data?.repository;
  const pr = repo?.pullRequest;
  if (!repo || !pr) throw new Error(`GitHub has no pull request #${number} in ${repository}, or this GitHub account cannot read it.`);
  const where = `${repo.nameWithOwner}#${pr.number}`;
  if (pr.state !== 'OPEN') throw new Error(`${where} is ${pr.state.toLowerCase()}. Taskboard acts only on an open pull request.`);
  if (pr.headRefOid !== input.head)
    throw new Error(`${where} has head ${pr.headRefOid}, not ${input.head}. The head changed after your review. Review the new head, then run ${command} again with --head ${pr.headRefOid}.`);
  return { repo, pr, where };
}

// Reads every value of the merge from GitHub. It throws the reason when Taskboard cannot offer the merge.
export async function inspectMerge(task: Task, input: { repo?: unknown; number?: unknown; head?: unknown; method?: unknown }): Promise<PrMergeState> {
  if (input.method !== undefined && (typeof input.method !== 'string' || !METHODS.includes(input.method as MergeMethod)))
    throw new Error('Give --method merge, squash or rebase.');
  const { repo, pr, where } = await readPullRequest(task, input, 'tb git pr-merge-request');
  if (pr.isDraft) throw new Error(`${where} is a draft. Mark it ready first with tb git pr-ready-request, and wait for its checks.`);
  if (pr.isInMergeQueue) throw new Error(`${where} is already in the merge queue. GitHub merges it when the queue checks pass.`);

  const rules = await ghJson<Rule[]>(['api', `repos/${repo.nameWithOwner}/rules/branches/${pr.baseRefName}?per_page=100`], task.cwd, 'Reading the branch rules');
  const commit = pr.commits.nodes[0]?.commit;
  if (commit?.oid !== pr.headRefOid) throw new Error(`GitHub has not finished reading the head of ${where}. Wait a minute and run the request again.`);
  const contexts = commit.statusCheckRollup?.contexts;
  if (contexts?.pageInfo.hasNextPage) throw new Error(`${where} has more than 100 checks. Taskboard reads at most 100.`);
  const checks: CheckResult[] = (contexts?.nodes || []).map(c => c.__typename === 'StatusContext'
    ? { name: c.context || '(no name)', result: c.state || 'UNKNOWN', required: !!c.isRequired }
    : { name: c.name || '(no name)', result: c.status === 'COMPLETED' ? c.conclusion || 'UNKNOWN' : c.status || 'UNKNOWN', required: !!c.isRequired });
  for (const rule of rules) for (const required of rule.type === 'required_status_checks' ? rule.parameters?.required_status_checks || [] : []) {
    const seen = checks.filter(c => c.name === required.context);
    if (seen.length) seen.forEach(c => { c.required = true; });
    else checks.push({ name: required.context, result: 'NOT REPORTED', required: true });
  }
  const failed = checks.filter(c => !OK.has(c.result) && !WAITING.has(c.result));
  if (failed.length) throw new Error(`Checks on ${pr.headRefOid} did not pass: ${failed.map(c => `${c.name} ${c.result}`).join(', ')}. Taskboard does not merge a head with a failed check.`);
  const waiting = checks.filter(c => WAITING.has(c.result));
  if (waiting.length) throw new Error(`Checks on ${pr.headRefOid} have not finished: ${waiting.map(c => `${c.name} ${c.result}`).join(', ')}. Wait for them, then run the request again.`);

  const reviews = Math.max(0, ...rules.map(r => r.type === 'pull_request' ? r.parameters?.required_approving_review_count || 0 : 0));
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.reviewDecision === 'REVIEW_REQUIRED' || (reviews > 0 && pr.reviewDecision !== 'APPROVED'))
    throw new Error(`${where} needs an approving review (GitHub reports ${pr.reviewDecision || 'no review'}). Taskboard does not bypass branch rules.`);
  if (pr.mergeable === 'CONFLICTING') throw new Error(`${where} has conflicts with ${pr.baseRefName}. Its owner must resolve them first.`);
  if (pr.mergeable !== 'MERGEABLE') throw new Error(`GitHub has not finished computing whether ${where} can merge (${pr.mergeable}). Wait a minute and run the request again.`);

  const queueRule = rules.find(r => r.type === 'merge_queue');
  const queue = pr.isMergeQueueEnabled === true || !!queueRule;
  if (!READY.has(pr.mergeStateStatus) && !(queue && pr.mergeStateStatus === 'BEHIND'))
    throw new Error(pr.mergeStateStatus === 'BEHIND'
      ? `${where} is behind ${pr.baseRefName}, and the rules require an up-to-date branch. Its owner must update the branch, and you review the new head.`
      : `GitHub reports the merge state of ${where} as ${pr.mergeStateStatus}, not CLEAN. A branch rule is not met. Taskboard does not bypass branch rules.`);

  let method: MergeMethod | null;
  if (queue) {
    const queued = queueRule?.parameters?.merge_method?.toLowerCase() as MergeMethod | undefined;
    method = queued && METHODS.includes(queued) ? queued : null;
    if (input.method !== undefined && method && input.method !== method)
      throw new Error(`The merge queue of ${pr.baseRefName} merges with ${method}. Leave out --method, or give --method ${method}.`);
  } else {
    let allowed = METHODS.filter(m => ({ merge: repo.mergeCommitAllowed, squash: repo.squashMergeAllowed, rebase: repo.rebaseMergeAllowed })[m]);
    for (const rule of rules) {
      const only = rule.type === 'pull_request' ? rule.parameters?.allowed_merge_methods : undefined;
      if (Array.isArray(only)) allowed = allowed.filter(m => only.includes(m));
    }
    if (!allowed.length) throw new Error(`The repository and its rulesets allow no merge method for ${pr.baseRefName}.`);
    if (input.method !== undefined && !allowed.includes(input.method as MergeMethod))
      throw new Error(`${pr.baseRefName} allows only ${allowed.join(', ')}. Give one of them with --method.`);
    if (input.method === undefined && allowed.length > 1) throw new Error(`${pr.baseRefName} allows ${allowed.join(', ')}. Give one of them with --method.`);
    method = (input.method as MergeMethod | undefined) || allowed[0];
  }
  return { taskId: task.id, repository: repo.nameWithOwner, number: pr.number, url: pr.url, title: pr.title, nodeId: pr.id,
    head: pr.headRefName, headCommit: pr.headRefOid, base: pr.baseRefName, baseCommit: pr.baseRefOid, draft: pr.isDraft,
    mergeState: pr.mergeStateStatus, reviewDecision: pr.reviewDecision, checks, method, queue,
    ...(queue ? { queueTimeoutMinutes: queueRule?.parameters?.check_response_timeout_minutes || 60 } : {}) };
}

// The text of the approval card. It shows each value that the GitHub call receives, and the facts that let it run.
export function cardDetail(s: PrMergeState, taskNum: number): string {
  const action = s.queue
    ? `Approve adds the pull request at head ${s.headCommit} to the merge queue of ${s.base}. GitHub merges it when the queue checks pass.`
    : `Approve merges the pull request at head ${s.headCommit} into ${s.base} with ${s.method}, once.`;
  return [`Task: #${taskNum}`, `Repository: ${s.repository}`, `Pull request: #${s.number} ${s.url}`, `Title: ${s.title}`,
    `Head: ${s.head} at ${s.headCommit}`, `Base: ${s.base} at ${s.baseCommit}`, `Draft: ${s.draft ? 'Yes' : 'No'}`,
    `Merge state: ${s.mergeState}`, `Review decision: ${s.reviewDecision || 'none'}`,
    `Checks on the head: ${s.checks.length ? '' : 'none'}`, ...s.checks.map(c => `- ${c.name}: ${c.result}${c.required ? ' (required)' : ''}`),
    `Merge method: ${s.method || 'set by the merge queue'}`, `Merge queue required: ${s.queue ? 'Yes' : 'No'}`, '', action,
    'Before the call, Taskboard reads the pull request again and stops when a value changed. GitHub refuses the call when the head moved. Taskboard never uses an administrator merge and never bypasses branch rules.'].join('\n');
}

// The reason why the card no longer matches the pull request, or undefined. The base commit can move: GitHub merges
// onto the base as it is at approval, and a base that the rules require to be merged first makes inspectMerge throw.
export async function changed(task: Task, expected: PrMergeState): Promise<string | undefined> {
  let now: PrMergeState;
  try { now = await inspectMerge(task, { repo: expected.repository, number: expected.number, head: expected.headCommit, method: expected.method ?? undefined }); }
  catch (e) { return `${e instanceof Error ? e.message : String(e)} Ask the task to run tb git pr-merge-request again.`; }
  const diff = (['headCommit', 'base', 'method', 'queue', 'nodeId'] as const).filter(k => now[k] !== expected[k]);
  return diff.length ? `These values changed after the card was made: ${diff.map(k => `${k} ${expected[k]} -> ${now[k]}`).join(', ')}. Ask the task to run tb git pr-merge-request again.` : undefined;
}

const ENQUEUE = `mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { position state } }
}`;
const MERGE = `mutation($id: ID!, $head: GitObjectID!, $method: PullRequestMergeMethod!) {
  mergePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head, mergeMethod: $method }) { pullRequest { state headRefOid mergeCommit { oid } } }
}`;

// Checks the values again and calls GitHub once: it adds the pull request to the merge queue, or it merges it.
export async function mergePullRequest(task: Task, expected: PrMergeState): Promise<{ state: 'merged' | 'queued'; output: string; mergeCommit?: string; position?: number }> {
  const reason = await changed(task, expected);
  if (reason) throw new Error(reason);
  const where = `${expected.repository}#${expected.number}`;
  if (expected.queue) {
    const r = await ghJson<{ data: { enqueuePullRequest: { mergeQueueEntry: { position: number; state: string } | null } } }>(
      ['api', 'graphql', '-f', `query=${ENQUEUE}`, '-f', `id=${expected.nodeId}`, '-f', `head=${expected.headCommit}`], task.cwd, 'Adding the pull request to the merge queue');
    const entry = r.data?.enqueuePullRequest?.mergeQueueEntry;
    if (!entry) throw new Error(`GitHub did not return a merge queue entry for ${where}.`);
    return { state: 'queued', position: entry.position, output: `${where} at ${expected.headCommit} is in the merge queue of ${expected.base} at position ${entry.position} (${entry.state}). GitHub merges it when the queue checks pass. ${expected.url}` };
  }
  const r = await ghJson<{ data: { mergePullRequest: { pullRequest: { state: string; headRefOid: string; mergeCommit: { oid: string } | null } } } }>(
    ['api', 'graphql', '-f', `query=${MERGE}`, '-f', `id=${expected.nodeId}`, '-f', `head=${expected.headCommit}`, '-f', `method=${String(expected.method).toUpperCase()}`], task.cwd, 'Merging the pull request');
  const pr = r.data?.mergePullRequest?.pullRequest;
  if (pr?.state !== 'MERGED') throw new Error(`GitHub did not report ${where} as merged (state ${pr?.state || 'unknown'}).`);
  const mergeCommit = pr.mergeCommit?.oid;
  return { state: 'merged', mergeCommit, output: `${where} at ${expected.headCommit} merged into ${expected.base} with ${expected.method}${mergeCommit ? ` as ${mergeCommit}` : ''}. ${expected.url}` };
}

// ---------- the merge queue after Approve ----------
const OUTCOME = `query($id: ID!) { node(id: $id) { ... on PullRequest {
  state isInMergeQueue mergeCommit { oid } mergeQueueEntry { position state }
  timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } } }
} } }`;
// Reads where a queued pull request is now: still in the queue, merged, or out of the queue with GitHub's reason.
export async function queueOutcome(r: PrMergeRecord): Promise<{ state: 'queued' | 'merged' | 'removed-from-queue'; text: string; mergeCommit?: string; position?: number }> {
  const data = await ghJson<{ data: { node: { state: string; isInMergeQueue: boolean; mergeCommit: { oid: string } | null; mergeQueueEntry: { position: number; state: string } | null;
    timelineItems: { nodes: { createdAt: string; reason: string | null }[] } } | null } }>(['api', 'graphql', '-f', `query=${OUTCOME}`, '-f', `id=${r.nodeId}`], TB_DIR, 'Reading the merge queue');
  const pr = data.data?.node;
  const where = `${r.repository}#${r.number}`;
  if (!pr) throw new Error(`GitHub did not return ${where}.`);
  if (pr.state === 'MERGED') return { state: 'merged', mergeCommit: pr.mergeCommit?.oid, text: `The merge queue merged ${where} at ${r.headCommit} into ${r.base}${pr.mergeCommit ? ` as ${pr.mergeCommit.oid}` : ''}. ${r.url}` };
  if (pr.isInMergeQueue) return { state: 'queued', position: pr.mergeQueueEntry?.position, text: '' };
  const event = pr.timelineItems.nodes[0];
  const reason = event && (!r.queuedAt || Date.parse(event.createdAt) >= Date.parse(r.queuedAt) - 60_000) && event.reason ? `GitHub gives this reason: ${event.reason}.` : 'GitHub gives no reason.';
  return { state: 'removed-from-queue', text: pr.state === 'CLOSED'
    ? `${where} was closed without a merge, and it left the merge queue of ${r.base}. ${reason} ${r.url}`
    : `${where} left the merge queue of ${r.base} without a merge. ${reason} Read the checks of the queue entry on GitHub. To try again, run tb git pr-merge-request with the reviewed head. ${r.url}` };
}

const POLL_MS = () => Number(process.env.TASKBOARD_PR_QUEUE_POLL_MS) || 60_000;
const following = new Map<string, ReturnType<typeof setTimeout>>();
// Marks the record queued, and reads the pull request every POLL_MS until GitHub merges it or removes it. The time
// limit: check_response_timeout_minutes for each entry up to this one in the queue, plus 30 minutes. After it, the
// record is unknown. onDone gets the record at its final state.
export function queued(r: PrMergeRecord, position: number | undefined, output: string, onDone: (r: PrMergeRecord) => void) {
  const minutes = (r.queueTimeoutMinutes || 60) * Math.max(1, position || 1) + 30;
  r.queuedAt = new Date().toISOString(); r.queuePosition = position; r.followUntil = new Date(Date.now() + minutes * 60_000).toISOString();
  finish(r, 'queued', output);
  follow(r, onDone);
}
export function follow(r: PrMergeRecord, onDone: (r: PrMergeRecord) => void) {
  if (r.state !== 'queued' || following.has(r.id)) return;
  const tick = async () => {
    following.delete(r.id);
    if (r.state !== 'queued') return;
    try {
      const o = await queueOutcome(r);
      if (o.state !== 'queued') { finish(r, o.state, o.text, o.mergeCommit); onDone(r); return; }
      if (o.position !== undefined && o.position !== r.queuePosition) { r.queuePosition = o.position; save(); }
    } catch (e) { console.error('pr merge queue read', r.id, e instanceof Error ? e.message : e); }
    if (!r.followUntil || Date.now() > Date.parse(r.followUntil)) {
      finish(r, 'unknown', `${r.result || ''}\nTaskboard stopped reading the merge queue at ${new Date().toISOString()}, and the pull request was still in it or could not be read. Read it with gh pr view ${r.number} --repo ${r.repository}.`.trim());
      onDone(r); return;
    }
    following.set(r.id, setTimeout(tick, POLL_MS()).unref());
  };
  following.set(r.id, setTimeout(tick, POLL_MS()).unref());
}

// ---------- tb git pr-ready-request ----------
// Reads the draft pull request. It throws when the head is not the commit that the task named, or the pull request is
// not a draft.
export async function inspectReady(task: Task, input: { repo?: unknown; number?: unknown; head?: unknown }): Promise<PrReadyState> {
  const { repo, pr, where } = await readPullRequest(task, input, 'tb git pr-ready-request');
  if (!pr.isDraft) throw new Error(`${where} is not a draft. It is ready for review now.`);
  return { taskId: task.id, repository: repo.nameWithOwner, number: pr.number, url: pr.url, title: pr.title, nodeId: pr.id, head: pr.headRefName, headCommit: pr.headRefOid, base: pr.baseRefName };
}
export function readyCardDetail(s: PrReadyState, taskNum: number): string {
  return [`Task: #${taskNum}`, `Repository: ${s.repository}`, `Pull request: #${s.number} ${s.url}`, `Title: ${s.title}`,
    `Head: ${s.head} at ${s.headCommit}`, `Base: ${s.base}`, 'Draft: Yes', '',
    'Approve marks the draft ready for review, once. It merges nothing. GitHub can start checks and review requests for a ready pull request.',
    'Before the call, Taskboard reads the pull request again and stops when the head changed.'].join('\n');
}
export async function readyChanged(task: Task, expected: PrReadyState): Promise<string | undefined> {
  let now: PrReadyState;
  try { now = await inspectReady(task, { repo: expected.repository, number: expected.number, head: expected.headCommit }); }
  catch (e) { return `${e instanceof Error ? e.message : String(e)} Ask the task to run tb git pr-ready-request again.`; }
  return now.nodeId !== expected.nodeId ? 'The pull request changed after the card was made. Ask the task to run tb git pr-ready-request again.' : undefined;
}
const MARK_READY = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft headRefOid } } }`;
// Checks the values again and marks the pull request ready for review. The mutation takes no head commit, so the
// result reports the head that GitHub returns, and a warning when it differs from the card.
export async function markReady(task: Task, expected: PrReadyState): Promise<string> {
  const reason = await readyChanged(task, expected);
  if (reason) throw new Error(reason);
  const r = await ghJson<{ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: boolean; headRefOid: string } } } }>(
    ['api', 'graphql', '-f', `query=${MARK_READY}`, '-f', `id=${expected.nodeId}`], task.cwd, 'Marking the pull request ready');
  const pr = r.data?.markPullRequestReadyForReview?.pullRequest;
  const where = `${expected.repository}#${expected.number}`;
  if (!pr || pr.isDraft) throw new Error(`GitHub did not report ${where} as ready for review.`);
  return pr.headRefOid === expected.headCommit
    ? `${where} is ready for review at head ${pr.headRefOid}. Wait for its checks, then run tb git pr-merge-request. ${expected.url}`
    : `WARNING: ${where} is ready for review, but its head is ${pr.headRefOid}, not ${expected.headCommit}. Review the new head before a merge. ${expected.url}`;
}

// ---------- records ----------
type Saved = { id: string; at: string; approvalId?: string; state: string; result?: string; doneAt?: string };
function recordStore<S, R extends S & Saved>(file: string) {
  const path = join(TB_DIR, file);
  const records: R[] = (() => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; } })();
  const save = () => writeFileSync(path, JSON.stringify(records.slice(-500), null, 2), { mode: 0o600 });
  return {
    save,
    all: () => records.slice().reverse(),
    get: (id: string) => records.find(r => r.id === id),
    record(state: S, id: string, approvalId: string): R {
      const r = { ...state, id, at: new Date().toISOString(), approvalId, state: 'pending' } as unknown as R;
      records.push(r); save(); return r;
    },
    finish(r: R, state: R['state'], result: string, more: Partial<R> = {}) {
      Object.assign(r, more); r.state = state; r.result = safe(result); r.doneAt = new Date().toISOString(); save();
    },
    reopen(r: R) {
      if (r.state !== 'denied') return false;
      r.state = 'pending'; r.result = undefined; r.doneAt = undefined; save(); return true;
    },
  };
}
const merges = recordStore<PrMergeState, PrMergeRecord>('pr-merges.json');
const save = merges.save;
export const { all, get, record, reopen } = merges;
export function finish(r: PrMergeRecord, state: PrMergeRecord['state'], result: string, mergeCommit?: string) {
  merges.finish(r, state, result, mergeCommit ? { mergeCommit } : {});
}
export const ready = recordStore<PrReadyState, PrReadyRecord>('pr-ready.json');
