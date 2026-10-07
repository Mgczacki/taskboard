import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'tb-answer-history-'));
process.env.TASKBOARD_DIR = join(root, 'state');
process.env.TASKBOARD_VAULT = join(root, 'vault');
mkdirSync(process.env.TASKBOARD_DIR, { recursive: true });
mkdirSync(join(process.env.TASKBOARD_VAULT, 'tasks'), { recursive: true });
const store = await import('../server/store.ts');
const history = await import('../server/answer-history.ts');
const { trimTerminalLog } = await import('../server/terminal-log.ts');
const create = (agent: store.Agent) => {
  const id = `${agent}-${Math.random().toString(16).slice(2)}`;
  const transcript = join(root, id + '.jsonl'); writeFileSync(transcript, '');
  return store.create({ id, num: 1, title: 'Questions', agent, status: 'working', cwd: root, folder: root, session: id, sessionId: id, transcript, desc: '' });
};
const line = (t: store.Task, value: object) => appendFileSync(t.transcript!, JSON.stringify(value) + '\n');
const marker = (id: string, answer = 'The build passed.') => `Work is complete.\nTASKBOARD_ANSWER ${id}: ${answer}`;

test('the parser accepts one last line and rejects quotations, code, long text and open fences', () => {
  const id = 'abcdef012345';
  assert.deepEqual(history.parseAnswer(marker(id)), { id, answer: 'The build passed.' });
  assert.equal(history.parseAnswer(`> TASKBOARD_ANSWER ${id}: Quoted`), null);
  assert.equal(history.parseAnswer(`\`\`\`\nTASKBOARD_ANSWER ${id}: Code`), null);
  assert.equal(history.parseAnswer(`TASKBOARD_ANSWER ${id}: Example\nMore prose`), null);
  assert.equal(history.parseAnswer(`TASKBOARD_ANSWER ${id}: ${'x'.repeat(241)}`), null);
});

test('Codex captures only a completed reply to its question, once across resume', () => {
  const t = create('codex'); const q = history.prepare(t, 'What passed?');
  line(t, { type: 'event_msg', payload: { type: 'user_message', message: q.text } });
  line(t, { type: 'event_msg', payload: { type: 'agent_message', message: marker(q.id) } });
  assert.equal(history.scan(t), 0, 'streamed output is not final');
  line(t, { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: marker(q.id) }, timestamp: '2026-10-07T12:00:00Z' });
  assert.equal(history.scan(t), 1);
  assert.equal(history.scan(t), 0);
  assert.equal(history.answers(t.id)[0].question, 'What passed?');
  assert.equal(history.transcriptRecord(t.id, q.id, 'answer')?.text, marker(q.id));
  assert.equal(history.transcriptRecord(t.id, q.id, 'question')?.text, q.text);
  line(t, { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: marker(q.id) } });
  assert.equal(history.scan(t), 0, 'repeated output has the same question ID');
  const persisted = JSON.parse(readFileSync(join(store.taskDir(t.id), 'answer-history.json'), 'utf8'));
  assert.equal(persisted.answers.length, 1);
});

test('Claude ignores user and tool text, then stores a final answer', () => {
  const t = create('claude'); const q = history.prepare(t, 'Where is the file?');
  line(t, { type: 'user', message: { content: q.text } });
  line(t, { type: 'assistant', message: { content: [{ type: 'text', text: marker(q.id) }], stop_reason: 'tool_use' } });
  assert.equal(history.scan(t), 0);
  line(t, { type: 'assistant', message: { content: [{ type: 'text', text: marker(q.id, 'It is in outbox.') }], stop_reason: 'end_turn' }, timestamp: '2026-10-07T12:01:00Z' });
  assert.equal(history.scan(t), 1);
  assert.equal(history.answers(t.id)[0].answer, 'It is in outbox.');
});

test('Codex finds the user question in a response_item record', () => {
  const t = create('codex'); const q = history.prepare(t, 'Which item?');
  line(t, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: q.text }] } });
  line(t, { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: marker(q.id, 'The first item.') } });
  assert.equal(history.scan(t), 1);
  assert.equal(history.transcriptRecord(t.id, q.id, 'question')?.text, q.text);
  assert.ok(history.answers(t.id)[0].questionOffset < history.answers(t.id)[0].answerOffset);
});

test('unanswered questions and Taskboard notices make no entries', () => {
  const t = create('codex'); const q = history.prepare(t, 'What is the status?');
  line(t, { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'I need more time.' } });
  line(t, { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'TASKBOARD_ANSWER deadbeefdead: Approved.' } });
  assert.equal(history.scan(t), 0);
  assert.equal(history.answers(t.id).length, 0);
  history.cancel(t.id, q.id);
});

test('an incomplete line survives the next scan and a shorter transcript resets its cursor', () => {
  const t = create('codex'); const q = history.prepare(t, 'Why?');
  const event = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: marker(q.id, 'Because it is done.') } });
  appendFileSync(t.transcript!, event.slice(0, 30));
  assert.equal(history.scan(t), 0);
  appendFileSync(t.transcript!, event.slice(30) + '\n');
  assert.equal(history.scan(t), 1);
  assert.equal(history.scan(t), 0);
  writeFileSync(t.transcript!, '');
  assert.equal(history.scan(t), 0);
  assert.equal(history.answers(t.id).length, 1);
});

test('the transcript jump survives terminal log truncation', () => {
  const t = create('codex'); const q = history.prepare(t, 'What remains?');
  line(t, { type: 'event_msg', payload: { type: 'user_message', message: q.text } });
  line(t, { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: marker(q.id, 'One check remains.') } });
  assert.equal(history.scan(t), 1);
  const terminal = store.terminalLog(t.id);
  writeFileSync(terminal, Buffer.alloc(11 * 1024 * 1024, 65));
  assert.equal(trimTerminalLog(terminal), true);
  assert.equal(history.transcriptRecord(t.id, q.id, 'answer')?.text, marker(q.id, 'One check remains.'));
});

test('the scanner reads an answer after a one MiB record', () => {
  const t = create('codex'); const q = history.prepare(t, 'How many?');
  line(t, { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(1024 * 1024) } });
  line(t, { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: marker(q.id, 'Three.') } });
  assert.equal(history.scan(t), 1);
  assert.equal(history.answers(t.id)[0].answer, 'Three.');
});

test.after(() => rmSync(root, { recursive: true, force: true }));
