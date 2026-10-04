// When an approval card (approvals.ts) must close although nobody clicked it, and what the task status becomes then.
// A permit can expire in three places: the 5 second timer in index.ts, GET /api/permits/:id (the open card polls it
// every 2 s, and so does `tb permit result --wait`), and permits.run or controllerRule. Before, only the timer closed
// the card, and only for a permit that the timer itself expired. A permit that a read expired kept a pending card in
// the stack, the Waiting page and the "to approve" count until the next restart. index.ts now calls permitCardClose
// on each permit change, so the card closes in the same moment as the permit, whoever expired it.
import type { Approval } from './approvals.ts';
import type { Permit } from './permits.ts';
import type { Task } from './store.ts';

// hh:mm in the server's time zone, for the card result
export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// How to close the card of a permit that ended without a decision on the card, or undefined when the card stays.
// A denied or run permit is closed by approvals.decide itself, so only an expiry closes the card here.
export function permitCardClose(p: Pick<Permit, 'state' | 'expiresAt' | 'error'>, card?: Pick<Approval, 'state'>): { state: 'expired'; result: string } | undefined {
  if (!card || card.state !== 'pending' || p.state !== 'expired') return;
  return { state: 'expired', result: p.error || `The permit expired at ${clock(p.expiresAt)}. Nothing ran.` };
}

// The text on a card that closes because its task was archived
export const archivedResult = (num: number) => `Task #${num} was archived before a decision. Nothing ran.`;

// The approval cards of an archived task that close: all open cards except Message cards, which belong to the
// message in the Inbox (server/a2anotes/cards.ts) and close when the message is decided there.
export const cardsToCloseOnArchive = (open: Approval[]) => open.filter(a => a.action !== 'mail-in' && a.action !== 'mail-out');

export const CARD_ASKS = ['Approve:', 'Approve permit ', 'Approve scope request ', 'Approve push '];
type StatusPatch = Pick<Task, 'status' | 'ask' | 'statusSource'>;
// The status of a task after its approval cards changed, or undefined when it stays. A task waits on a card when its
// status is needs-you and its ask starts with one of CARD_ASKS, the asks that index.ts sets with a card. open counts
// the pending and the running cards of the task: a running card still sets the status itself (applyScope reads the ask
// of a scope request while its card runs).
// With no open card left, the task does not wait on the user any more:
//   - a refused command card was denied (refusalDenied): unread, as before
//   - the last card expired or closed without a decision: working, and the status source says why. The agent is in
//     its turn while it waits in `tb scope request`. When the turn has ended, the transcript check in index.ts sets
//     the status from the transcript.
//   - any other end: working, "Your decision was sent back to the task.", as before
export function statusAfterCards(t: Pick<Task, 'status' | 'ask' | 'statusSource'>, o: { open: number; last?: Pick<Approval, 'state'> & { result?: string }; refusalDenied?: boolean }): StatusPatch | undefined {
  if (o.open || t.status !== 'needs-you') return;
  if (t.statusSource?.includes('auto mode refused') && o.refusalDenied)
    return { status: 'unread', ask: '', statusSource: 'The user denied the refused command.' };
  if (!CARD_ASKS.some(x => t.ask?.startsWith(x))) return;
  if (o.last && (o.last.state === 'expired' || o.last.state === 'unknown'))
    return { status: 'working', ask: '', statusSource: `The approval card closed without a decision. ${o.last.result || ''}`.trim() };
  return { status: 'working', ask: '', statusSource: 'Your decision was sent back to the task.' };
}
