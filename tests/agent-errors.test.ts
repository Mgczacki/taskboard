import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyHit, claudeKind, claudeTranscriptError, codexKind, codexRolloutError, continueDecision, errorFromScreen, kindFromText,
  MAX_TRIES, nextDue, screenSignature, shortLabel, stalled, type AgentError, type ContinueCheck,
} from '../server/agent-errors.ts';

// Real texts from this Mac (task 278 study, 2026-10-05). Conversation text is replaced by placeholders.
const CODEX_277 = [
  '• Each package completed the mock run. I will make one real model call per package to check token counts.',
  '',
  '■ Selected model is at capacity. Please try a different model.',
  '',
  '› continue',
  '',
  '  GPT-6-Sol medium · ~/project',
].join('\n');
const codexFailed = (at: string, message: string, info: string) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message, codex_error_info: info } } });
const codexStarted = (at: string) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } });
const codexDone = (at: string) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't0', last_agent_message: 'Done.' } });
const claudeError = (at: string, error: string, text: string, extra: object = {}) => JSON.stringify({ type: 'assistant', timestamp: at, isApiErrorMessage: true, error, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const claudeUser = (at: string, text: string) => JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: text } });
const claudeReply = (at: string, text: string) => JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

test('the Codex "■" error line of task 277 reads as overloaded; a reply or a prompt that quotes it does not', () => {
  assert.deepEqual(errorFromScreen('codex', CODEX_277), { kind: 'overloaded', text: 'Selected model is at capacity. Please try a different model.', source: 'screen' });
  // the remote compaction error of task 243
  assert.equal(errorFromScreen('codex', '■ Error running remote compact task: Selected model is at capacity. Please try a different model.\n› \n')!.kind, 'overloaded');
  // a reply that quotes the text starts with "•", not "■"
  assert.equal(errorFromScreen('codex', '• The task stopped with "■ Selected model is at capacity." earlier.\n› '), null);
  // a prompt that quotes it
  assert.equal(errorFromScreen('codex', '› Why did "Selected model is at capacity" show on task 277?\n'), null);
  // the agent works again below the error line: old history, not the current state
  assert.equal(errorFromScreen('codex', '■ Selected model is at capacity. Please try a different model.\n› continue\n• Working (3s • esc to interrupt)\n'), null);
  // an interrupt uses the same mark
  assert.equal(errorFromScreen('codex', '■ Conversation interrupted - tell the model what to do differently.\n› '), null);
});

test('retries on the screen are read with their attempt; the auto mode check and a reply are not', () => {
  assert.deepEqual(errorFromScreen('claude', '✻ API error · Retrying in 1s · attempt 1/10\n'), { kind: 'server_error', text: 'API error', source: 'screen', retrying: true, retryIn: '1s', attempt: 1, maxAttempts: 10 });
  const r = errorFromScreen('claude', '✶ Overloaded · Retrying in 4s · attempt 3/10')!;
  assert.equal(r.kind, 'overloaded'); assert.equal(r.attempt, 3);
  assert.equal(errorFromScreen('claude', '✻ Auto mode check unavailable · next try in 1s · attempt 1/10'), null);
  assert.equal(errorFromScreen('claude', '⏺ The spinner shows "Retrying in 1s" and an attempt count when the API fails.'), null);
  assert.deepEqual(errorFromScreen('codex', '• Reconnecting... 2/5\n'), { kind: 'network', text: 'Reconnecting', source: 'screen', retrying: true, attempt: 2, maxAttempts: 5, retryIn: undefined });
  assert.equal(errorFromScreen('codex', '■ stream disconnected - retrying sampling request (3/5 in 800ms)...')!.attempt, 3);
  // Claude Code draws gaps with cursor-forward escapes in terminal.log
  assert.equal(errorFromScreen('claude', '✻\x1b[1CAPI\x1b[1Cerror\x1b[1C·\x1b[1CRetrying\x1b[1Cin\x1b[1C1s\x1b[1C·\x1b[1Cattempt\x1b[1C1/10')!.attempt, 1);
});

test('error kinds from the texts and fields the agents use', () => {
  assert.equal(kindFromText('API Error: Repeated 529 Overloaded errors. The API is at capacity'), 'overloaded');
  assert.equal(kindFromText('API Error: Connection lost mid-response. The response above may be incomplete.'), 'network');
  assert.equal(kindFromText('API Error: The response stopped arriving.'), 'network');
  assert.equal(kindFromText('429 Too Many Requests'), 'rate_limited');
  assert.equal(kindFromText('Prompt is too long'), 'context');
  assert.equal(kindFromText('exceeded retry limit, last status: 502 Bad Gateway'), 'server_error');
  assert.equal(claudeKind('authentication_failed', 'Login expired · Please run /login'), 'auth');
  assert.equal(claudeKind('billing_error', 'Credit balance is too low'), 'credit');
  assert.equal(claudeKind('rate_limit', "You've hit your limit · resets 5pm"), 'limit');
  assert.equal(claudeKind('rate_limit', 'API Error: 429 rate_limit_error'), 'rate_limited');
  assert.equal(claudeKind('overloaded', 'API Error: 529'), 'overloaded');
  assert.equal(codexKind('server_overloaded', 'Selected model is at capacity. Please try a different model.'), 'overloaded');
  assert.equal(codexKind('usage_limit_exceeded', 'Your workspace is out of credits.'), 'credit');
  assert.equal(codexKind('context_window_exceeded', ''), 'context');
});

test('the transcript readers find the newest failed turn and nothing after a new prompt', () => {
  const t1 = '2026-10-05T08:07:54.794Z';
  assert.deepEqual(codexRolloutError([codexDone('2026-10-05T08:00:00Z'), codexStarted('2026-10-05T08:03:45Z'), codexFailed(t1, 'Selected model is at capacity. Please try a different model.', 'server_overloaded')]),
    { kind: 'overloaded', text: 'Selected model is at capacity. Please try a different model.', source: 'transcript', at: t1 });
  assert.equal(codexRolloutError([codexFailed(t1, 'x', 'server_overloaded'), codexStarted('2026-10-05T08:10:00Z')]), null);
  assert.equal(codexRolloutError([codexDone(t1)]), null);
  assert.deepEqual(codexRolloutError([codexFailed(t1, 'Your workspace is out of credits.', 'usage_limit_exceeded')]), { limit: 'credit', text: 'Your workspace is out of credits.', at: t1 });

  const at = '2026-10-04T10:00:00Z';
  assert.deepEqual(claudeTranscriptError([claudeUser('2026-10-04T09:59:00Z', 'do it'), claudeError(at, 'server_error', 'API Error: Connection lost mid-response. The response above may be incomplete.')]),
    { kind: 'network', text: 'API Error: Connection lost mid-response. The response above may be incomplete.', source: 'transcript', at });
  // a prompt after the error: the agent went on
  assert.equal(claudeTranscriptError([claudeError(at, 'server_error', 'API Error: x'), claudeUser('2026-10-04T10:05:00Z', 'continue')]), null);
  // a subagent error does not stop the main agent
  assert.equal(claudeTranscriptError([claudeReply('2026-10-04T09:00:00Z', 'ok'), claudeError(at, 'server_error', 'API Error: The response stopped arriving.', { isSidechain: true })]), null);
  // a reply that quotes an API error is a normal reply
  assert.equal(claudeTranscriptError([claudeReply(at, 'API Error: Repeated 529 Overloaded errors is what the user saw.')]), null);
});

test('a long tool run is not a stall; a model that does not answer for the stall time is', () => {
  const base = { status: 'working', quietMs: 30 * 60000, limitMs: 10 * 60000, questionOpen: false };
  assert.equal(stalled({ ...base, state: 'tool' }), false);       // a build or test still runs
  assert.equal(stalled({ ...base, state: 'busy' }), true);        // waits for the model and nothing changed
  assert.equal(stalled({ ...base, state: 'busy', quietMs: 9 * 60000 }), false);
  assert.equal(stalled({ ...base, state: 'busy', questionOpen: true }), false);
  assert.equal(stalled({ ...base, state: 'busy', status: 'idle' }), false);
  assert.equal(stalled({ ...base, state: 'finished' }), false);
  // the spinner time and word change while a model waits; the signature does not. New tokens change it.
  const a = screenSignature('⏺ text\n✻ Pondering… (2m 3s · ↓ 1.2k tokens · esc to interrupt)\n❯ ');
  assert.equal(screenSignature('⏺ text\n✶ Thinking… (5m 9s · ↓ 1.2k tokens · esc to interrupt)\n❯ '), a);
  assert.notEqual(screenSignature('⏺ text\n✶ Thinking… (5m 9s · ↓ 1.9k tokens · esc to interrupt)\n❯ '), a);
  assert.equal(screenSignature('• Working (1m 23s • esc to interrupt)'), screenSignature('• Working (9m 2s • esc to interrupt)'));
});

test('the state machine: retrying, stopped, resumed, and the limit of tries for one episode', () => {
  let now = Date.parse('2026-10-05T08:00:00Z');
  const retry = { kind: 'overloaded' as const, text: 'Overloaded', source: 'screen' as const, retrying: true, attempt: 3, maxAttempts: 10 };
  let e = applyHit(undefined, retry, now, true);
  assert.equal(e.phase, 'retrying'); assert.equal(shortLabel(e), 'Retrying (attempt 3/10)'); assert.equal(e.auto, undefined);
  const stop = { kind: 'overloaded' as const, text: 'Selected model is at capacity.', source: 'transcript' as const };
  e = applyHit(e, stop, now, true);
  assert.equal(e.phase, 'stopped'); assert.equal(shortLabel(e), 'Stopped: model at capacity'); // task 277
  assert.equal(shortLabel(applyHit(undefined, { kind: 'overloaded', text: 'API Error: Repeated 529 Overloaded errors.', source: 'hook' }, now, false)), 'Stopped: model overloaded');
  assert.equal(e.auto!.nextAt, new Date(now + 60000).toISOString());   // the first try after 1 minute
  assert.equal(e.since, new Date(now).toISOString());
  // the same stop read again (the hook, then the transcript) does not plan a new try
  const again = applyHit(e, stop, now + 5000, true);
  assert.equal(again.auto!.nextAt, e.auto!.nextAt); assert.equal(again.count, 1);
  // five tries: 1, 2, 5, 10, 10 minutes; then auto-continue stops
  const waits: number[] = [];
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    e = { ...e, phase: 'resumed', auto: { tries } };   // Taskboard typed the message `tries` times
    e = applyHit(e, stop, now, true);
    waits.push((Date.parse(e.auto!.nextAt!) - now) / 60000);
  }
  assert.deepEqual(waits, [1, 2, 5, 10, 10]);
  e = applyHit({ ...e, phase: 'resumed', auto: { tries: MAX_TRIES } }, stop, now, true);
  assert.equal(e.auto!.nextAt, undefined); assert.match(e.auto!.off!, /5 times/);
  // a kind that needs a person plans nothing
  assert.equal(applyHit(undefined, { kind: 'auth', text: 'Login expired', source: 'transcript' }, now, true).auto, undefined);
  assert.equal(applyHit(undefined, stop, now, false).auto, undefined);
  assert.equal(nextDue(now, MAX_TRIES), null);
});

test('auto-continue types only into an empty box of a task that stopped on a model error', () => {
  const now = Date.parse('2026-10-05T08:10:00Z');
  const err: AgentError = { kind: 'overloaded', text: 'x', source: 'transcript', phase: 'stopped', since: '', seen: '', count: 1, auto: { tries: 0, nextAt: '2026-10-05T08:09:00Z' } };
  const base: ContinueCheck = { enabled: true, status: 'stopped', error: err, accountLimited: false, questionOpen: false, waitsOnUser: false, box: 'empty', now };
  assert.equal(continueDecision(base).act, 'type');
  // a draft that a person typed (task 277 holds "continue" in the box): never type over it, and stop for this episode
  assert.deepEqual(continueDecision({ ...base, box: 'draft' }), { act: 'off', reason: 'A person typed in the input box. Taskboard does not type over a draft.' });
  assert.equal(continueDecision({ ...base, box: 'question' }).act, 'wait');   // a dialog: wait
  assert.equal(continueDecision({ ...base, now: Date.parse('2026-10-05T08:08:00Z') }).act, 'wait'); // not due
  assert.equal(continueDecision({ ...base, accountLimited: true }).act, 'off');
  assert.equal(continueDecision({ ...base, questionOpen: true }).act, 'off');
  assert.equal(continueDecision({ ...base, waitsOnUser: true }).act, 'off');
  assert.equal(continueDecision({ ...base, enabled: false }).act, 'off');
  assert.equal(continueDecision({ ...base, error: { ...err, kind: 'stalled' } }).act, 'off');
  assert.equal(continueDecision({ ...base, error: { ...err, kind: 'context' } }).act, 'off');
  assert.equal(continueDecision({ ...base, error: { ...err, auto: { tries: MAX_TRIES } } }).act, 'off');
  assert.equal(continueDecision({ ...base, status: 'working' }).act, 'wait');
});
