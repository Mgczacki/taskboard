// The text of a refused-command card (server/approvals.ts action tool-refusal): which check refused the tool call,
// where its rules are set, and what the user can do. Taskboard makes the card in two places:
//   - server/events.ts recordCommandRefusal: the agent's own permission check refused a tool call. The payload has the
//     tool call id. Claude Code auto mode (the transcript says "denied by the Claude Code auto mode classifier"), the
//     Codex sandbox or approval review, or Taskboard's review of Antigravity tool calls.
//   - server/index.ts POST /api/permits: Taskboard refused a `tb permit` for a command that needs its own request (a
//     push, a release, a restart, a task Git command). The payload has no id.
// The setting names were checked in the installed help: `claude auto-mode --help` (Claude Code 2.1.289) and
// `codex --help` (codex-cli 0.160.0). Taskboard starts Codex with these flags in server/agents.ts.
import type { Agent, Approval } from './api';

export interface RefusalText { who: string; where: string; todo: string; command: string }
export function refusalText(a: Pick<Approval, 'payload' | 'detail'>, agent?: Agent): RefusalText {
  const command = a.payload?.command || a.detail.split('\n')[0] || '';
  if (!a.payload?.id) return {
    who: 'Taskboard refused this command, because it needs its own request.',
    where: 'The detail above names the command to use instead.',
    todo: 'Tell the task to use that command, or run the step yourself.',
    command,
  };
  const todo = 'Taskboard cannot approve this. It was refused by the agent\'s own permission check. To allow it, add a rule in the agent\'s settings, run the step yourself, or tell the task what to do.';
  if (agent === 'codex') return {
    who: 'Codex refused this tool call (its sandbox or its approval review).',
    where: 'Rules: the Codex sandbox and approval settings, `-s` / `--sandbox` and `-a` / `--ask-for-approval`, and `approvals_reviewer` in ~/.codex/config.toml. Taskboard starts Codex with `-a on-request -s workspace-write`, and with `approvals_reviewer="auto_review"` when Settings > Review tool requests automatically is on.',
    todo, command,
  };
  if (agent === 'antigravity') return {
    who: 'Taskboard\'s review of Antigravity tool calls refused this tool call.',
    where: 'Rules: Settings > Review tool requests automatically.',
    todo: 'To allow it, turn off that setting for this step, run the step yourself, or tell the task what to do.',
    command,
  };
  return {
    who: 'Claude Code auto mode refused this tool call (its permission classifier).',
    where: 'Rules: the autoMode section of ~/.claude/settings.json, with the lists allow, soft_deny and environment. Run `claude auto-mode config` to see the rules in effect.',
    todo, command,
  };
}
