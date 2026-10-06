import type { Task } from '../api';
import type { Account } from './Accounts';

export function canvasAccountName(task: Pick<Task, 'account' | 'agent'>, accounts: Pick<Account, 'id' | 'name'>[]) {
  const id = task.account || `${task.agent}-default`;
  return accounts.find(account => account.id === id)?.name || id;
}

export function canvasAccountSymbol(id: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(-3);
}

export function CanvasAccountChip({ task, accounts }: { task: Pick<Task, 'account' | 'agent'>; accounts: Pick<Account, 'id' | 'name'>[] }) {
  const id = task.account || `${task.agent}-default`;
  const name = canvasAccountName(task, accounts);
  return <span className="chip canvas-account" title={name} aria-label={`Account: ${name}`} data-name={name} tabIndex={0}>{canvasAccountSymbol(id)}</span>;
}

export function CanvasFailureChip({ task, accounts }: { task: Pick<Task, 'account' | 'agent' | 'lastFailure'>; accounts: Pick<Account, 'id' | 'name'>[] }) {
  const failure = task.lastFailure;
  if (!failure || failure.account === (task.account || `${task.agent}-default`)) return null;
  const name = failure.name || accounts.find(account => account.id === failure.account)?.name || failure.account;
  if (!name) return null;
  return <span className="chip canvas-failure" title={`${failure.reason} Failed on ${name}.`}>Failed on {name}</span>;
}
