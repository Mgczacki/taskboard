// The history line of a decided approval card (server/approvals.ts decidedBy): who approved or denied it. A card that
// the controller approved on the user's request shows the user's exact message from the controller chat.
import type { Approval } from './api';

export const controllerHistoryText = (userRequest: string) => `Approved by the controller on the user's request: "${userRequest}"`;
export function decidedByLine(a: Pick<Approval, 'state' | 'decidedBy'>): string {
  const d = a.decidedBy;
  if (!d) return '';
  if (d.by === 'controller') return d.userRequest ? controllerHistoryText(d.userRequest) : 'Approved by the controller under the low risk rule in Settings.';
  return a.state === 'denied' ? 'Denied by you.' : 'Approved by you.';
}
