import type { Task } from '../api';
import { AGENT_NAME } from '../api';
import { usageText } from '../accountUsageText';
import type { Account } from './Accounts';

export const accountMoveReason = (a: Account) => !a.status.signedIn ? 'not signed in'
  : a.limited ? 'usage limit reached'
  : a.running >= a.maxParallel ? `at its limit of ${a.maxParallel} tasks`
  : '';

export function MoveAccountForm({ accounts, current, target, moving, error, status, openElsewhere, select, move, cancel }: {
  accounts: Account[]; current: string; target: string; moving: boolean; error: string;
  status: Task['status']; openElsewhere: boolean;
  select: (id: string) => void; move: () => void; cancel: () => void;
}) {
  const chosen = accounts.find(a => a.id === target);
  const reason = chosen ? accountMoveReason(chosen) : '';
  return <div className="banner">
    <label htmlFor="move-account">Move to account</label>
    <select id="move-account" className="acct-sel" value={target} disabled={moving} onChange={e => select(e.target.value)}>
      <option value="">Choose an account</option>
      {accounts.filter(a => a.id !== current).map(a => {
        const why = accountMoveReason(a);
        return <option key={a.id} value={a.id} disabled={!!why}>
          {a.name} · {AGENT_NAME[a.agent]} · {a.running}/{a.maxParallel} tasks · {usageText(a) || 'usage unknown'}{why ? ` · ${why}` : ''}
        </option>;
      })}
    </select>
    <span className="sub">The task keeps its files and worktree. A different agent continues with a handoff. Moving stops the current session.</span>
    <button className="btn primary" disabled={!target || !!reason || moving || openElsewhere} onClick={move}>{moving ? 'Moving…' : status === 'working' ? 'Stop and move' : 'Move and continue'}</button>
    {reason && <span role="status">Account {target} is {reason}.</span>}
    {error && <div className="field-err" role="alert">{error}</div>}
    {openElsewhere && <span>Move the session here from its other terminal first.</span>}
    <button className="btn ghost" disabled={moving} onClick={cancel}>Cancel</button>
  </div>;
}
