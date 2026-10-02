// The card for a question or dialog that a task waits on (server/pending.ts). The card shows on the Waiting page and
// (short form) in the notification stack. Canvas windows and the task panel show only PendingMarker. Each answer shows
// what Taskboard sends. A risky option (installs software, gives wide access, asks for credit, ends the session) shows a
// tag with its risk. It opens a confirm step first when Settings has that step on for its risk kind (confirmRisk in
// server/machine.ts; by default off for wide access only). The server refuses the option without the step when the
// setting is on, and refuses it from the controller always.
import { useState, type ReactNode } from 'react';
import type { PendingItem, PendingOption, PendingRisk } from '../api';
import { api, fmtWait, loadConfirmRisk, RISK_SETTING, useStoreValue } from '../api';
import { showInStack } from '../stack';
import { AgentChip } from './ui';

export const KIND_LABEL: Record<PendingItem['kind'], string> = {
  command: 'Command permission', choice: 'Choice', text: 'Question', dialog: 'Dialog', plan: 'Plan approval', signin: 'Sign in', unknown: 'Unknown prompt',
};
const SOURCE_LABEL: Record<PendingItem['source'], string> = {
  'claude-hook': 'From the Claude Code hook. The terminal also shows this question, and an answer there closes this card.',
  screen: 'Read from the terminal screen. Taskboard reads the screen again before it types, and types nothing if the prompt changed.',
  'turn-end': 'The last message of the turn. Your answer is typed as the next prompt.',
};
const RISK_LABEL: Record<PendingRisk, string> = { 'wide-access': 'Gives wide access', installs: 'Installs software', spends: 'Asks for more credit', exits: 'Ends the agent session' };
const RISK_TEXT: Record<PendingRisk, string> = {
  'wide-access': 'This option adds a rule. After it, the agent can do this kind of action without a question.',
  installs: 'This option downloads or installs software. It can change the program for every task on this Mac.',
  spends: 'This option asks for more credit or a higher limit.',
  exits: 'This option ends the agent session of this task. The task stops until you resume it.',
};
const minutes = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

export function PendingCard({ item, compact, openTask, toast }: { item: PendingItem; compact?: boolean; openTask: (id: string) => void; toast: (s: string) => void }) {
  const confirmRisk = useStoreValue(s => s.confirmRisk);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState<PendingOption | null>(null);
  const [ack, setAck] = useState(false);
  const [groupOn, setGroupOn] = useState(false);
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set((item.sameIn || []).map(s => s.id)));
  const [form, setForm] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const group = groupOn ? (item.sameIn || []).filter(s => groupIds.has(s.id)) : [];
  const count = 1 + group.length;
  const d = item.details || {};
  const locked = busy || item.state !== 'pending';

  const send = async (body: { option?: string; text?: string; confirm?: boolean }) => {
    setBusy(true); setError('');
    try {
      const r = await api.answerPending(item.id, { ...body, ...(group.length ? { group: group.map(g => g.id) } : {}) });
      toast(`#${item.taskNum}: ${r.answer ? `answered "${r.answer.label}"` : 'answered'}. ${r.result || ''}`.trim());
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // the setting was turned on in another window: read it again and show the confirm step
      const o = item.options.find(x => x.key === body.option);
      if (o?.risk && !body.confirm && /confirm step/.test(message)) { void loadConfirmRisk(); setConfirm(o); setAck(false); }
      // the server removed the card: the toast shows why after the card is gone
      else if (/^This card is out of date/.test(message)) { setError(message); toast(`#${item.taskNum}: ${message}`); }
      else setError(message);
    }
    finally { setBusy(false); }
  };
  const asks = (o: PendingOption) => !!o.risk && confirmRisk[RISK_SETTING[o.risk]] !== false;
  const choose = (o: PendingOption) => {
    if (asks(o)) { setConfirm(o); setAck(false); return; }
    void send({ option: o.key, ...(o.deny && text.trim() ? { text } : {}) });
  };
  const safe = item.options.find(o => !o.risk && !o.deny) || item.options.find(o => !o.risk);
  const sendForm = () => {
    const answers: Record<string, string> = {};
    for (const q of item.questions || []) {
      const picked = [...(form[q.question] || []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])];
      if (!picked.length) { setError(`Answer "${q.question}" first.`); return; }
      answers[q.question] = picked.join(', ');
    }
    void send({ option: 'form', text: JSON.stringify(answers) });
  };
  const selectedRisky = item.options.find(o => o.selected && o.risk);
  // one failure shows once: the server keeps it in item.result, and the click that failed gets the same text
  const failure = item.state === 'pending' && item.result ? item.result : error;
  const terminalStep = failure === item.result && item.needsTerminal;

  return <div className={`pcard kind-${item.kind} ${item.state} ${compact ? 'compact' : ''}`} data-pending={item.id}>
    <div className="pc-h">
      <span className={`dot ${item.kind === 'unknown' ? 'review' : 'needs-you'}`} />
      <button className="pc-num" onClick={() => openTask(item.taskId)} title="Open the task panel">#{item.taskNum}</button>
      <b className="pc-ti">{item.taskTitle}</b><AgentChip a={item.agent} /><span className="chip">{KIND_LABEL[item.kind]}</span>
      <span className="pc-sp" /><span className="pc-age">waiting {fmtWait(minutes(item.createdAt))}</span>
    </div>
    {!compact && <div className="pc-src">{SOURCE_LABEL[item.source]}</div>}
    {item.header && <span className="chip pc-header">{item.header}</span>}
    <p className="pc-q">{item.question}</p>
    {!compact && (d.command || d.cwd || d.reason || d.title) && <dl className="pc-d">
      {d.title && <><dt>Tool</dt><dd>{d.title}</dd></>}
      {d.command && <><dt>Command</dt><dd><pre>{d.command}</pre></dd></>}
      {d.cwd && <><dt>Folder</dt><dd className="mono">{d.cwd}</dd></>}
      {d.reason && <><dt>Reason</dt><dd>{d.reason}</dd></>}
    </dl>}
    {compact && d.command && <pre className="pc-cmd">{d.command}</pre>}
    {d.plan && <pre className={`pc-plan ${compact ? 'short' : ''}`}>{d.plan}</pre>}
    {item.repeats && <div className="pc-note">Asked again ({item.repeats.count === 2 ? '2nd' : item.repeats.count === 3 ? '3rd' : `${item.repeats.count}th`} time in this task). Your last answer: {item.repeats.lastAnswer}. Taskboard does not answer it again by itself.</div>}
    {selectedRisky && !compact && <div className="pc-note">The selected row on the screen is "{selectedRisky.label}". Enter in the terminal would choose it. Taskboard never presses Enter for a row that you did not choose.</div>}
    {item.screen && (!item.answerable || (!compact && item.source === 'screen')) && <details className="pc-screen" open={!item.answerable}><summary>Screen rows that Taskboard read</summary><pre>{item.screen.excerpt}</pre></details>}
    {item.screen?.partial && <div className="pc-note info">The terminal is too short to show the whole list. The card shows the rows on the screen. Open the terminal for the other rows.</div>}
    {item.kind === 'signin' && <div className="pc-note info">Taskboard does not sign in for you. Open the terminal and sign in there. This card closes when the dialog is gone.</div>}
    {!item.answerable && item.kind !== 'signin' && <div className="pc-note info">Taskboard does not answer this prompt. Open the terminal to answer it.</div>}
    {item.answerable && item.options.length > 0 && <div className="pc-opts">{item.options.map(o =>
      <button key={o.key} className={`btn pc-opt ${o.risk ? 'risky' : ''}`} disabled={locked} onClick={() => choose(o)}>
        <span className="pc-ol"><span className="l">{o.risk ? '⚠ ' : ''}{o.label}</span>{o.selected && <span className="pc-def">selected on screen</span>}{o.description && <span className="d">{o.description}</span>}{o.risk && <span className="d pc-risk">{RISK_LABEL[o.risk]}{asks(o) ? ' · needs a confirm step' : ' · sent at once, no confirm step'}</span>}</span>
        <span className="pc-send">{o.send}{count > 1 ? ` · for ${count} tasks` : ''}</span>
      </button>)}</div>}
    {item.answerable && item.questions && <div className="pc-form">{item.questions.map(q => <fieldset key={q.question}>
      <legend>{q.header ? `${q.header}: ` : ''}{q.question}{q.multiSelect ? ' (choose one or more)' : ''}</legend>
      {q.options.map(o => <label key={o.label} className="opt"><input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}-${q.question}`} disabled={locked}
        checked={(form[q.question] || []).includes(o.label)} onChange={e => setForm(f => ({ ...f, [q.question]: q.multiSelect ? (e.target.checked ? [...(f[q.question] || []), o.label] : (f[q.question] || []).filter(x => x !== o.label)) : [o.label] }))} /> {o.label}{o.description && <span className="sub"> · {o.description}</span>}</label>)}
      <input type="text" className="pc-other" placeholder="Or type your own answer" disabled={locked} value={other[q.question] || ''} onChange={e => setOther(x => ({ ...x, [q.question]: e.target.value }))} />
    </fieldset>)}<div className="pc-row"><span className="sub">Sends: hook answers, several choices joined by ", "</span><span className="pc-sp" /><button className="btn primary" disabled={locked} onClick={sendForm}>Send answers</button></div></div>}
    {item.answerable && item.text && <div className="pc-text">
      <textarea rows={item.text.mode === 'deny' || compact ? 2 : 3} placeholder={item.text.placeholder} disabled={locked} value={text} onChange={e => setText(e.target.value)} />
      {item.text.mode !== 'deny' && <div className="pc-row"><span className="sub">Sends: {item.text.send}</span><span className="pc-sp" /><button className={`btn ${item.text.mode === 'answer' ? 'primary' : ''}`} disabled={locked || !text.trim()} onClick={() => void send({ text })}>{item.text.mode === 'change' ? 'Send changes' : 'Send answer'}</button></div>}
    </div>}
    {!compact && item.answerable && !!item.sameIn?.length && <div className="pc-group">
      <div><b>The same prompt waits in {item.sameIn.length} other task{item.sameIn.length === 1 ? '' : 's'}:</b> {item.sameIn.map(s => <button key={s.id} className="btn ghost pc-link" onClick={() => openTask(s.taskId)}>#{s.taskNum}</button>)}</div>
      <label className="opt"><input type="checkbox" checked={groupOn} disabled={locked} onChange={e => setGroupOn(e.target.checked)} /> Answer these tasks together with #{item.taskNum}</label>
      {groupOn && <div className="pc-glist">
        {item.sameIn.map(s => <label key={s.id} className="opt"><input type="checkbox" checked={groupIds.has(s.id)} disabled={locked} onChange={e => setGroupIds(g => { const n = new Set(g); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} /> #{s.taskNum}</label>)}
        <span className="sub">Your click answers #{item.taskNum} and each checked task. Taskboard checks each task on its own and reports each result. Clear a task to answer it on its own card.</span>
        <button className="btn ghost" onClick={() => setGroupOn(false)}>Split into single answers</button>
      </div>}
    </div>}
    {failure && !busy && <div className="pc-note bad" role="alert">{failure}{terminalStep && <> <button className="btn ghost pc-link" onClick={() => openTask(item.taskId)}>Open terminal</button></>}</div>}
    {busy && <div className="pc-note info">Sending…</div>}
    <div className="pc-f">
      <button className="btn ghost" onClick={() => openTask(item.taskId)}>Open terminal</button>
      {item.source === 'screen' && !item.answerable && item.kind === 'unknown' && <button className="btn ghost" onClick={() => void api.hidePending(item.id).catch(e => setError(String((e as Error).message || e)))} title="Hide this card. A different screen makes a new card.">Not a question</button>}
    </div>
    {confirm && <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) setConfirm(null); }}>
      <div className="modal pc-confirm" role="dialog" aria-modal="true">
        <header><h2>⚠ {RISK_LABEL[confirm.risk!]}</h2><button className="btn ghost icon" onClick={() => setConfirm(null)}>✕</button></header>
        <div className="body">
          <p><b>#{item.taskNum} · {confirm.label}</b></p>
          <p>{RISK_TEXT[confirm.risk!]}</p>
          {d.command && <pre className="pc-cmd">{d.command}</pre>}
          <p className="sub">Taskboard sends: <code>{confirm.send}</code>{count > 1 ? ` to ${count} tasks: ${[item.taskNum, ...group.map(g => g.taskNum)].map(n => '#' + n).join(', ')}` : ''}</p>
          <label className="opt"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> I read the warning. I want this option for {[item.taskNum, ...group.map(g => g.taskNum)].map(n => '#' + n).join(', ')}.</label>
        </div>
        <footer>{safe && <button className="btn" onClick={() => { setConfirm(null); choose(safe); }}>Choose "{safe.label}" instead</button>}<span style={{ flex: 1 }} /><button className="btn" onClick={() => setConfirm(null)}>Cancel</button><button className="btn primary" disabled={!ack || busy} onClick={() => { const o = confirm; setConfirm(null); void send({ option: o.key, confirm: true }); }}>Confirm</button></footer>
      </div>
    </div>}
  </div>;
}

// The marker for the open cards of one task, in a Canvas window header and in the task panel. It is one button in a
// row that is already there, so the terminal does not move. With children (the status label of a Canvas window
// header or of the thin panel bar), the marker makes that label the button and adds no width. Without children it
// shows "Answer". The button brings the card to the front of the notification stack (or selects it on the Waiting
// page), where the user answers it.
export function PendingMarker({ taskId, small, children }: { taskId: string; small?: boolean; children?: ReactNode }) {
  // only the cards: a change of a task does not draw this again
  const pending = useStoreValue(s => s.pending);
  const items = pending.filter(i => i.taskId === taskId);
  if (!items.length) return <>{children}</>;
  const q = items[0].question.replace(/\s+/g, ' ').trim();
  return <button className={`${small ? 'b' : 'btn'} pc-mark ${children ? 'label' : ''}`} onClick={e => { e.stopPropagation(); showInStack(taskId); }} onPointerDown={e => e.stopPropagation()}
    title={`Waiting: ${q}${items.length > 1 ? ` (and ${items.length - 1} more)` : ''}\nOpens the card in the notification stack.`}>
    {children || <><span className="dot needs-you" />Answer</>}{items.length > 1 ? ` (${items.length})` : ''}
  </button>;
}
