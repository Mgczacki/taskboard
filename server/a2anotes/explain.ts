// Plain words for the dashboard message card (web/src/components/MessageCard.tsx) and `tb pending list`:
// - what each message check flag of A2A Notes means and what the user can do about it
// - why a send failed, from the error that A2A Notes returned
// The flag codes come from a2a-notes checks.ts (sender_note, internal_term, local_path, secret, code_term,
// agent_detail, ask_changed, command, check_failed). A code that is not in this list keeps the reason of A2A Notes.

export interface Flag { code?: string; text?: string; reason?: string; start?: number; end?: number }
export type FlagAction = 'recheck' | 'remove-flagged' | 'send-back' | 'approve-anyway';
export interface FlagNote { code: string; title: string; text: string; todo: string; actions: FlagAction[] }

const NOTES: Record<string, Omit<FlagNote, 'code' | 'text'> & { what: string }> = {
  check_failed: {
    title: 'The message check did not finish',
    what: 'The model check command of A2A Notes stopped before it gave a result. A2A Notes did not check the text of this draft for notes that the reader cannot use.',
    todo: 'Run the check again. If it fails again, read the body yourself, then approve it or send it back.',
    actions: ['recheck', 'approve-anyway', 'send-back'],
  },
  ask_changed: {
    title: 'The body asks for something different from the instruction',
    what: 'The task saved an instruction with the draft: the request that asked for this message. The body asks the reader for a different thing.',
    todo: 'If the body is correct, approve it. If not, send it back and ask the task to write the request again. A2A Notes does not let the dashboard change the saved instruction.',
    actions: ['approve-anyway', 'send-back'],
  },
  sender_note: { title: 'A note for the sender', what: 'A sentence is a plan or a note of the sender. The reader cannot use it.', todo: 'Remove the flagged text, or send the draft back.', actions: ['remove-flagged', 'send-back'] },
  internal_term: { title: 'An internal term', what: 'A sentence uses a term that the reader probably does not know.', todo: 'Remove the flagged text, or send the draft back for plain words.', actions: ['remove-flagged', 'send-back'] },
  local_path: { title: 'A local file path', what: 'A sentence has a path on this computer. The reader cannot open it.', todo: 'Remove the flagged text, or send the draft back.', actions: ['remove-flagged', 'send-back'] },
  secret: { title: 'Possible secret', what: 'A sentence looks like it contains a token, a key, or a password.', todo: 'Remove the flagged text or send the draft back. Do not send a secret.', actions: ['remove-flagged', 'send-back'] },
  code_term: { title: 'A code name', what: 'A sentence uses a code identifier that the reader may not know.', todo: 'Remove the flagged text, or send the draft back for plain words.', actions: ['remove-flagged', 'send-back'] },
  agent_detail: { title: 'A detail for the agent', what: 'The body uses a detail name from the agent file. The person who reads the body may not know it.', todo: 'Remove the flagged text, or send the draft back.', actions: ['remove-flagged', 'send-back'] },
  command: { title: 'A command', what: 'A sentence contains a command line.', todo: 'Remove the flagged text, or send the draft back.', actions: ['remove-flagged', 'send-back'] },
};

export function explainFlag(f: Flag): FlagNote {
  const code = f.code || 'other';
  const n = NOTES[code];
  // the reason of A2A Notes names the exact verbs and nouns for ask_changed; keep it after the general text
  if (!n) return { code, title: 'The message check flagged this text', text: f.reason || '', todo: 'Remove the flagged text, or send the draft back.', actions: ['remove-flagged', 'send-back'] };
  return { code, title: n.title, text: [n.what, code === 'ask_changed' ? f.reason : ''].filter(Boolean).join(' '), todo: n.todo, actions: n.actions };
}

// The check state of a draft in one sentence. state comes from body_check.state: checking, done or failed.
export function checkSummary(m: { check?: { verdict?: string } | null; review?: { verdict?: string; reason?: string } | null; body_check?: { state?: string; flags?: Flag[] } | null }): string {
  const verdict = m.review?.verdict || m.check?.verdict;
  const flags = m.body_check?.flags || [];
  if (!verdict) return 'The checks are still running. Nobody can approve the draft until they finish.';
  const safety = verdict === 'communication' ? 'The safety check found no risk.'
    : verdict === 'uncertain' ? 'The safety check is not sure about this text.'
    : verdict === 'action-request' ? 'The safety check found a request for access, money, secrets or production changes.'
    : 'The safety check holds this text. Nobody can approve it.';
  const body = m.body_check?.state === 'failed' ? ' The message check did not finish.'
    : m.body_check?.state === 'checking' ? ' The message check is still running.'
    : flags.length ? ` The message check flagged ${flags.length} item${flags.length === 1 ? '' : 's'}.` : ' The message check found nothing.';
  return safety + body;
}

// Why a send did not happen, in plain words. message is the A2A Notes reason ("The message was not sent: <slack error>").
const SLACK: Record<string, string> = {
  channel_not_found: 'Slack did not find the direct message channel with the recipient.',
  user_not_found: 'Slack did not find the recipient in the workspace.',
  user_disabled: 'The recipient account is deactivated in Slack.',
  cannot_dm_bot: 'The recipient is a bot. Slack does not let you send it a direct message.',
  invalid_auth: 'The Slack sign-in of A2A Notes is no longer valid. Connect Slack again on the Settings page.',
  not_authed: 'A2A Notes is not signed in to Slack. Connect Slack on the Settings page.',
  token_revoked: 'The Slack sign-in of A2A Notes was revoked. Connect Slack again on the Settings page.',
  missing_scope: 'The Slack sign-in of A2A Notes lacks a permission. Connect Slack again on the Settings page.',
  ratelimited: 'Slack asked A2A Notes to wait. The service retries at the recorded time.',
  msg_too_long: 'The message is too long for Slack.',
};
export function explainSendError(code: string, message: string): string {
  if (code === 'not_connected') return 'A2A Notes is not signed in to Slack. Connect Slack on the Settings page, then send again.';
  if (code === 'service_unavailable') return 'The A2A Notes service is not running. Start it on the Settings page, then send again.';
  if (code === 'delivery_uncertain') return 'Slack did not confirm delivery. A2A Notes checks the conversation. It does not post again while delivery remains uncertain.';
  if (code === 'hash_changed') return 'The draft changed after you read it. Read the new version on its card.';
  const slack = Object.keys(SLACK).find(k => message.includes(k));
  return slack ? `${SLACK[slack]} (Slack error ${slack}.)` : message;
}
