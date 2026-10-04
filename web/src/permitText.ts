// The words on a permit card (PermitDetails in components/Permits.tsx). A permit that can no longer run says when and
// how it ended, in plain words, and never that it waits: "Expired at 11:23 PM", "Denied at 11:20 PM".
import type { Permit } from './api';

const time = (iso?: string) => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
// open: the card can still take a decision (Run, Deny)
export function permitHeadline(p: Pick<Permit, 'state' | 'expiresAt' | 'decidedAt' | 'finishedAt' | 'error'>): { state: string; open: boolean; when: string; note?: string } {
  switch (p.state) {
    case 'pending': return { state: 'Waits for your decision', open: true, when: `Expires at ${time(p.expiresAt)}` };
    case 'running': return { state: 'Running', open: false, when: p.decidedAt ? `Approved at ${time(p.decidedAt)}` : '' };
    case 'expired': return { state: `Expired at ${time(p.error ? p.finishedAt : p.expiresAt)}`, open: false, when: '', note: `${p.error || 'Nobody decided in time.'} Nothing ran. No action is possible on this card.` };
    case 'denied': return { state: `Denied at ${time(p.decidedAt || p.finishedAt)}`, open: false, when: '', note: 'Nothing ran. No action is possible on this card.' };
    case 'succeeded': return { state: `Done at ${time(p.finishedAt)}`, open: false, when: '' };
    case 'failed': return { state: `Failed at ${time(p.finishedAt)}`, open: false, when: '' };
    default: return { state: 'Result unknown', open: false, when: '' };
  }
}
// the state of one step: a step that did not start says so, instead of "cancelled"
export const stepWord = (state: string) => state === 'cancelled' ? 'not run' : state;
