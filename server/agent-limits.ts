// Errors that mean an account cannot run a task: no credit, a billing problem, a reached usage limit, or an expired
// sign-in. The agents print them in the terminal; Codex also writes them into its session (rollout) file.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Agent } from './store.ts';

// credit: no credit or balance left, or a billing problem. limit: a usage limit until a reset. login: signed out.
export type LimitKind = 'credit' | 'limit' | 'login';
export interface LimitHit { kind: LimitKind; text: string; at?: string; neverWorked?: boolean }

// Each pattern must match from the start of a line, after the marks the CLIs put in front of an error, so that a
// prompt or a reply that only mentions these words does not match.
const LEAD = String.raw`^[\s■⚠⎿│●✗×!-]*`;
const line = (body: string) => new RegExp(LEAD + `(${body})[^\\n]*`, 'im');
const PATTERNS: Record<Agent, [LimitKind, RegExp][]> = {
  // Observed with Codex 0.160.0 on tasks 163 and 164: "■ Your workspace is out of credits. Ask your workspace owner to
  // refill in order to continue." and the dialog "Usage limit reached  Request a limit increase from your owner to
  // continue using codex. Request increase?". The "You've hit your usage limit" text is from earlier Codex versions.
  codex: [
    ['credit', line(String.raw`Your workspace is out of credits|You(?:'|’)re out of credits|Your credit balance is (?:too low|empty)`)],
    ['limit', line(String.raw`Usage limit reached|You(?:'|’)ve hit your usage limit`)],
  ],
  // Claude Code texts as its documentation and earlier versions show them; not observed on this machine.
  claude: [
    ['credit', line(String.raw`(?:API Error: )?Credit balance is too low|Your credit balance is too low|billing_error`)],
    ['limit', line(String.raw`Claude AI usage limit reached|You(?:'|’)ve hit your (?:usage )?limit|\d+-hour limit reached|Weekly limit reached`)],
    ['login', line(String.raw`OAuth token has expired|Invalid API key|Please run /login`)],
  ],
  // Observed with agy on task 33: "⚠ Individual quota reached. Please upgrade your subscription to increase your limits."
  antigravity: [
    ['limit', line(String.raw`Individual quota reached|RESOURCE_EXHAUSTED`)],
    ['credit', line(String.raw`You(?:'|’)re out of (?:AI )?credits|Insufficient (?:AI )?credits`)],
  ],
};

// The first limit error on the screen, or null. `screen` is the visible screen of the agent.
export function limitFromScreen(agent: Agent, screen: string): LimitHit | null {
  for (const [kind, re] of PATTERNS[agent] || []) {
    const m = screen.match(re);
    if (m) return { kind, text: m[0].replace(new RegExp(LEAD), '').replace(/\s{2,}/g, ' ').trim().slice(0, 200) };
  }
  return null;
}

// The newest turn result in a Codex rollout file, read from its last 512 KB. A turn that failed for credit or a limit
// ends with a task_complete event whose error has codex_error_info "usage_limit_exceeded" (Codex 0.160.0), after a
// token_count event whose rate_limits has rate_limit_reached_type (for example "workspace_member_credits_depleted").
// neverWorked is true when no turn in that part of the file ended without an error.
export function codexRolloutLimit(path: string): LimitHit | null {
  let text: string;
  try {
    const size = statSync(path).size, start = Math.max(0, size - 524288), buf = Buffer.alloc(size - start);
    const fd = openSync(path, 'r'); try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    text = buf.toString('utf8');
  } catch { return null; }
  let last: any, reached: string | undefined, worked = false;
  for (const l of text.split('\n')) {
    if (!l.includes('"task_complete"') && !l.includes('"rate_limit_reached_type"')) continue;
    let o: any; try { o = JSON.parse(l); } catch { continue; }
    const p = o.payload || {};
    if (p.type === 'task_complete') { last = o; if (!p.error) worked = true; }
    else if (p.rate_limits) reached = p.rate_limits.rate_limit_reached_type || undefined;
  }
  const err = last?.payload?.error;
  if (!err) return null;
  const info = String(err.codex_error_info || '');
  const message = String(err.message || '');
  const credit = /credit|billing|payment/i.test(reached || '') || /out of credits|credit balance|billing|payment/i.test(message);
  if (!credit && !/usage_limit|rate_limit|quota/i.test(info) && !/usage limit/i.test(message)) return null;
  return { kind: credit ? 'credit' : 'limit', text: `${message || 'Usage limit reached.'}${reached ? ` (${reached})` : ''}`.slice(0, 200), at: last.timestamp, neverWorked: !worked };
}
