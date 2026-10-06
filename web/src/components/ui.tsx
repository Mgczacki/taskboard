import type { Status, Task } from '../api';
import { AGENT_NAME, ATTN, STATUS_LABEL, api, fmtWait } from '../api';
import { useEffect, useState } from 'react';
import { keyLabel } from '../keys';
import { errorDetail, errorTone } from '../agentErrorText';
import { TaskFileText } from './TaskFileText';

// the first key of an action in keys.ts (nothing when the user removed its keys); the caller calls useKeymap()
export const Kbd = ({ id }: { id: string }) => keyLabel(id) ? <kbd>{keyLabel(id)}</kbd> : null;
export const Dot = ({ s }: { s: Status }) => <span className={`dot ${s}`} title={STATUS_LABEL[s]} />;
export const AgentChip = ({ a }: { a: Task['agent'] }) => <span className={`chip agent-${a}`}>{AGENT_NAME[a]}</span>;
export const ByController = ({ t }: { t: Task }) => t.parent === 'controller' ? <span className="chip byctl" title="Started by the controller with tb new">↳ Controller</span> : null;
// where the session runs, separate from its status: a terminal Taskboard does not own (imported while running)
export const WhereChip = ({ t }: { t: Task }) => t.openElsewhere ? <span className="chip wchip" title={`Running in another terminal (${t.openElsewhere.tty}, process ${t.openElsewhere.pid}). Status is read from its transcript.`}>⧉ {t.openElsewhere.tty.replace(/^\/dev\//, '')}</span> : null;
// the agent asked the user for help in the task browser (tb browser ask); Done in the Browser tab answers it
export const BrowserAskChip = ({ t }: { t: Task }) => t.browserAsk ? <span className="chip bw-askchip" title={`The agent asks you in the Browser tab: ${t.browserAsk}`}><i />Waits for you in the browser</span> : null;
export const MachineChip = ({ t }: { t: Task }) => t.machine ? <span className="chip mchip" title={`Runs on ${t.machine.name}`}><span className="mdot" />{t.machine.name}</span> : null;
// a model or API error of the task (server/agent-error-watch.ts): "Stopped: model overloaded" or, in a calm color,
// "Retrying (attempt 3/10)" while the agent still retries by itself
export const ErrorChip = ({ t }: { t: Task }) => {
  const tone = errorTone(t);
  return tone ? <span className={`chip errchip ${tone}`} title={errorDetail(t.agentError!)}>{t.errorLabel}</span> : null;
};
// the text that Continue and auto-continue type (Settings > Agent errors), "continue" until the settings are read
export function useAutoMessage(): string {
  const [message, setMessage] = useState('continue');
  useEffect(() => { let live = true; api.info().then(i => { if (live) setMessage(i.settings.agentErrors?.message || 'continue'); }).catch(() => {}); return () => { live = false; }; }, []);
  return message;
}
// the same in one character, for the narrow sidebar rows: "!" for a stop, "↻" for a retry; the tooltip has the text
export const ErrorMark = ({ t }: { t: Task }) => {
  const tone = errorTone(t);
  return tone ? <span className={`errmark ${tone}`} title={`${t.errorLabel}. ${errorDetail(t.agentError!)}`} aria-label={t.errorLabel}>{tone === 'stopped' ? '!' : '↻'}</span> : null;
};
export const StatusLabel = ({ s }: { s: Status }) => <span className={`st-label ${s}`}>{STATUS_LABEL[s]}</span>;

// The three lines every task shows in the same place: goal (your words), where the agent is, what it waits for.
// fixed: the block keeps one height while the agent works (the task panel and triage put a terminal below it, and each
// change of height resizes that terminal and its tmux window). Goal and Now show at most 2 lines and Now always takes 2;
// Waiting always takes 1 line. The full text is in the tooltip.
export function ThreeLines({ t, fixed = false }: { t: Task; fixed?: boolean }) {
  const waiting = ATTN.includes(t.status) ? (t.ask || t.stopReason || '') : '';
  const now = t.now || (t.status === 'working' ? 'Working on it…' : '—');
  return (
    <div className={`three ${fixed ? 'fixed' : ''}`}>
      <div><b>Goal</b><span title={fixed ? t.goal || t.title : undefined}><TaskFileText taskId={t.id} text={t.goal || t.title} /></span></div>
      <div className="now"><b>Now</b><span title={fixed ? now : undefined}><TaskFileText taskId={t.id} text={now} /></span></div>
      {waiting ? <div className="w"><b>Waiting</b><span title={fixed ? waiting : undefined}><TaskFileText taskId={t.id} text={waiting} /> <em>· {fmtWait(t.waitMin)}</em></span></div>
        : fixed && <div className="w none"><b>Waiting</b><span>—</span></div>}
    </div>
  );
}
