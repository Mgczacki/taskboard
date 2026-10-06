import type { Task } from '../api';
import type { Account } from './Accounts';

export function canvasAccountName(task: Pick<Task, 'account' | 'agent'>, accounts: Pick<Account, 'id' | 'name'>[]) {
  const id = task.account || `${task.agent}-default`;
  return accounts.find(account => account.id === id)?.name || id;
}

export function CanvasAccountChip({ task, accounts }: { task: Pick<Task, 'account' | 'agent'>; accounts: Pick<Account, 'id' | 'name'>[] }) {
  const name = canvasAccountName(task, accounts);
  return <span className="chip canvas-account" title={name}>{name}</span>;
}

export function CanvasFailureChip({ task, accounts }: { task: Pick<Task, 'account' | 'agent' | 'lastFailure'>; accounts: Pick<Account, 'id' | 'name'>[] }) {
  const failure = task.lastFailure;
  if (!failure || failure.account === (task.account || `${task.agent}-default`)) return null;
  const name = failure.name || accounts.find(account => account.id === failure.account)?.name || failure.account;
  if (!name) return null;
  return <span className="chip canvas-failure" title={`${failure.reason} Failed on ${name}.`}>Failed on {name}</span>;
}
