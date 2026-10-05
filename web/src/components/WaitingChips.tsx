// The waiting indicator in the top bar: "N waiting on you · longest X" and, when more than one kind of item waits, one
// chip for each kind (waitingChips in waitingSummary.ts). Each part is a button. waitTarget picks where its click goes;
// App.tsx `act` goes there. The component has no state, so a test can call it and click its buttons.
import type { Approval, PendingItem, Task } from '../api';
import { fmtWait } from '../api';
import { chipText, rowMatches, targetText, waitingChips, waitTarget, type WaitFilter, type WaitRow, type WaitTarget } from '../waitingSummary';

export function WaitingChips({ queue, tasks, approvals, pending, rows, act, triageKey }: {
  queue: Task[]; tasks: Task[]; approvals: Approval[]; pending: PendingItem[];
  // the rows of the Waiting page (waitingRows in Waiting.tsx)
  rows: WaitRow[];
  act: (target: WaitTarget, kind: WaitFilter | 'all') => void;
  // the label of the Triage key, or '' when it has no key
  triageKey?: string;
}) {
  const chips = waitingChips(queue, approvals, pending);
  // the "to approve" count is not in the main count, so its chip shows also when it is the only kind
  const showChips = chips.length > 1 || chips[0]?.kind === 'decide';
  const all = waitTarget(rows, 'all');
  const mainName = `${queue.length} ${queue.length === 1 ? 'task waits' : 'tasks wait'} on you, the longest for ${queue.length ? fmtWait(queue[0].waitMin) : ''}. ${targetText(all)}`;
  return <div className={`attn-wrap ${showChips ? 'has-chips' : ''}`} role="group" aria-label="What waits on you">
    {queue.length
      ? <button type="button" className="attn" onClick={() => act(all, 'all')} aria-label={mainName} title={`${mainName}${triageKey ? ` Triage key: ${triageKey}.` : ''}`}>{queue.length} waiting on you<span className="sep">·</span><span className="long">longest {fmtWait(queue[0].waitMin)}</span>{triageKey && <kbd>{triageKey}</kbd>}</button>
      : <span className="attn quiet">Nothing waiting</span>}
    {showChips && chips.map(({ kind, n }) => {
      const target = waitTarget(rows.filter(r => rowMatches(kind, r, tasks, pending)), kind);
      const name = `${chipText(kind, n)}. ${targetText(target)}`;
      return <button type="button" key={kind} className={`attn-chip ak-${kind}`} onClick={() => act(target, kind)} aria-label={name} title={name}>{chipText(kind, n)}</button>;
    })}
  </div>;
}
