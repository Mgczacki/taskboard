// Checks of a limit mark. An account keeps its mark (Account.limited) until a turn on it succeeds, but pick() gives a
// marked account no task, so the mark of an unused account stayed after its limit reset (Claude default and Work
// Claude kept a weekly-limit mark from 5 October after the reset of 7 October). A check sends one small request to the
// provider through the account's own CLI, outside every task: the CLI runs in its print mode, with no tools, in a
// folder of its own, and without the TASK_ variables, so no hook reports it as a task.
// - Only a reply from a model clears the mark. A signed-in account, an empty usage bar or a reset time that passed
//   prove nothing about credit, so none of them clears it.
// - A limit or credit error from the provider keeps the mark. So does a timeout, a CLI error or a missing sign-in.
// - accounts.nextProbeAt gives the earliest time for the next check. tick() runs every 5 minutes and starts at most
//   one check, so no account is checked in a loop. The last check is saved on the account (Account.probe).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agyBin } from './config.ts';
import * as accounts from './accounts.ts';
import type { Account, Probe, ProbeResult } from './accounts.ts';
import { limitFromScreen } from './agent-limits.ts';
import { ASK_DIR } from './ask.ts';

// inside ASK_DIR, so importer.candidates() leaves an Antigravity conversation of a check off the Import page
export const PROBE_DIR = join(ASK_DIR, 'account-probe');
export const TICK_MS = 5 * 60000;
export const MANUAL_GAP_MS = 10 * 60000; // "Check now" is refused this long after the last check of the account
const TIMEOUT_MS = Number(process.env.TASKBOARD_PROBE_TIMEOUT_MS) || 90000;
const PROMPT = 'Reply with the word OK.';
const MAX_BUDGET_USD = '0.02';

// The request of each CLI. Sizes measured on 7 October 2026 on accounts without a mark:
// - Claude Code 2.1.293: 641 input tokens, 0.00013 USD. --system-prompt replaces the default system prompt, and
//   --no-session-persistence writes no session file. Haiku keeps the cost low (see the report for its limit).
// - Codex 0.160.0: 17,467 input tokens, of which 12,288 cached. --ephemeral writes no rollout file.
// - agy: 11,949 input tokens.
function command(a: Account): { bin: string; args: string[] } {
  if (a.agent === 'claude') return { bin: 'claude', args: ['-p', PROMPT, '--model', 'haiku', '--system-prompt', 'Reply with one word.', '--tools', '', '--strict-mcp-config',
    '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json', '--max-budget-usd', MAX_BUDGET_USD] };
  if (a.agent === 'codex') return { bin: 'codex', args: ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--json', '-c', 'mcp_servers={}',
    '--disable', 'apps', '--disable', 'plugins', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="low"', PROMPT] };
  return { bin: agyBin(), args: ['-p', PROMPT, '--output-format', 'json', '--print-timeout', '60s'] };
}

const jsonLines = (out: string) => out.split('\n').map(l => { try { return l.trim().startsWith('{') ? JSON.parse(l) : null; } catch { return null; } }).filter(Boolean) as any[];
const said = (text: unknown) => typeof text === 'string' && /\bok\b/i.test(text);
const short = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

// What the output of the CLI proves. accepted needs the success field of that CLI and the word OK from the model.
export function classify(agent: Account['agent'], stdout: string, stderr: string, code: number | null): { result: ProbeResult; note: string } {
  const lines = jsonLines(stdout);
  let reply = '', error = '';
  if (agent === 'claude') {
    const r = lines.reverse().find(o => o.type === 'result' || 'is_error' in o) || {};
    const text = typeof r.result === 'string' ? r.result : '';
    // Claude Code can print a limit message as the result text: such a result has no output tokens from a model
    if (r.is_error === false && r.subtype === 'success' && r.usage?.output_tokens > 0 && !limitFromScreen('claude', text)) reply = text; else error = text;
  } else if (agent === 'codex') {
    const failed = lines.find(o => o.type === 'turn.failed' || o.type === 'error');
    if (failed) error = String(failed.error?.message || failed.message || 'the turn failed');
    else if (lines.some(o => o.type === 'turn.completed')) reply = lines.filter(o => o.type === 'item.completed' && o.item?.type === 'agent_message').map(o => o.item.text).join(' ');
  } else {
    const r = lines.reverse().find(o => 'status' in o) || {};
    if (r.status === 'SUCCESS') reply = String(r.response || ''); else error = String(r.error || r.response || r.status || '');
  }
  if (code === 0 && said(reply)) return { result: 'accepted', note: 'A model answered the request.' };
  const all = `${error}\n${stderr}\n${lines.length ? '' : stdout}`;
  const hit = limitFromScreen(agent, all.split('\n').map(l => l.trim()).join('\n'));
  if (hit?.kind === 'login') return { result: 'failed', note: short(`The account is not signed in: ${hit.text}`) };
  if (hit || /usage limit|hit your (?:[\w-]+ )?limit|limit reached|rate.?limit|quota|out of credits|credit balance|credits?_depleted|billing|RESOURCE_EXHAUSTED|\b429\b/i.test(all))
    return { result: 'rejected', note: short(hit?.text || error || stderr || 'The provider refused the request.') };
  return { result: 'failed', note: short(error || stderr.split('\n').filter(l => l.trim()).pop() || (reply ? `Unexpected reply: ${reply}` : `The CLI ended with code ${code} and no answer.`)) };
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise(resolve => {
    mkdirSync(PROBE_DIR, { recursive: true });
    const child = spawn(bin, args, { cwd: PROBE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const term = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, TIMEOUT_MS);
    const kill = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS + 5000);
    child.stdout.on('data', d => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < 100_000) stderr += d; });
    const done = (code: number | null, err?: Error) => { clearTimeout(term); clearTimeout(kill); resolve({ stdout, stderr: err ? err.message : stderr, code, timedOut }); };
    child.on('error', e => done(null, e));
    child.on('close', code => done(code));
  });
}

let running: string | undefined; // the account whose check runs now: one check at a time on the whole machine
export const runningProbe = () => running;

// Send the request for one marked account and save the result. Throws when no check can start.
export async function probe(id: string, manual = false): Promise<Probe> {
  const a = accounts.get(id);
  if (!a) throw new Error('Unknown account.');
  if (!a.limited) throw new Error(`${a.name} has no limit mark, so there is nothing to check.`);
  if (running) throw new Error(`A check of ${accounts.get(running)?.name || running} runs now. Try again in two minutes.`);
  const last = a.probe ? Date.parse(a.probe.at) || 0 : 0;
  if (manual && Date.now() - last < MANUAL_GAP_MS) throw new Error(`${a.name} was checked ${accounts.ageText(Date.now() - last)} ago. Wait ${Math.round(MANUAL_GAP_MS / 60000)} minutes between checks.`);
  running = id;
  const started = Date.now();
  let outcome: { result: ProbeResult; note: string };
  try {
    if (!(await accounts.status(a, true)).signedIn) outcome = { result: 'failed', note: 'The account is not signed in, so no request was sent.' };
    else {
      await accounts.prepare(a);
      // the variables of a task are left out, so no hook or status line reports this request as a task
      const env: NodeJS.ProcessEnv = { ...process.env, ...accounts.envFor(a) };
      for (const k of ['TASK_ID', 'TASK_DIR', 'TASK_NUM', 'TASK_WORKTREE', 'TB_URL', 'TB_TOKEN_FILE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[k];
      if (a.isDefault) { delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME; }
      const { bin, args } = command(a);
      const r = await run(bin, args, env);
      outcome = r.timedOut ? { result: 'failed', note: `No answer in ${Math.round(TIMEOUT_MS / 1000)} seconds. The request was stopped.` } : classify(a.agent, r.stdout, r.stderr, r.code);
    }
  } catch (e) {
    outcome = { result: 'failed', note: short(e instanceof Error ? e.message : String(e)) };
  } finally { running = undefined; }
  const before = a.probe && a.limited && Date.parse(a.probe.at) >= Date.parse(a.limited.at) ? a.probe.failures : 0;
  const p: Probe = { at: new Date().toISOString(), ...outcome, ms: Date.now() - started, failures: outcome.result === 'accepted' ? 0 : before + 1, ...(manual ? { manual: true } : {}) };
  accounts.setProbe(a.id, p);
  // A mark that a task set while the request ran is newer than this answer: it stays.
  if (p.result === 'accepted' && a.limited && Date.parse(a.limited.at) <= started) accounts.clearLimited(a.id);
  console.log(`account check ${a.id}: ${p.result} (${p.note})`);
  return p;
}

// Start the check that is overdue the longest, if one is due and none runs. Returns the account it checked.
export async function tick(): Promise<string | undefined> {
  if (running || !accounts.probeEnabled()) return;
  const now = Date.now();
  const due = accounts.all().filter(a => a.limited && accounts.nextProbeAt(a)! <= now).sort((x, y) => accounts.nextProbeAt(x)! - accounts.nextProbeAt(y)!)[0];
  if (!due) return;
  try { await probe(due.id); } catch (e) { console.error(`account check ${due.id}:`, e); }
  return due.id;
}

// The first tick comes 2 minutes after the server starts; the saved time of each last check still applies after a restart.
export function start() {
  setTimeout(() => { void tick(); setInterval(() => void tick(), TICK_MS).unref(); }, 2 * 60000).unref();
}
