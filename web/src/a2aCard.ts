// What a message card on the Inbox page shows (web/src/components/A2ANotes.tsx). The label comes only from the
// message state and the buttons only from allowed_actions, as A2A Notes returns them in the last list response.
export interface CardInput { state: string; direction: 'in' | 'out'; allowed_actions: string[]; body_flags: number | null }
export interface CardControls { label: string; approve: boolean; reject: boolean; removeFlagged: boolean; send: boolean; sendLabel: string; route: boolean }

export const stateLabel: Record<string, string> = { draft: 'Draft', approved: 'Approved', sending: 'Sending', sent: 'Sent', delivery_uncertain: 'Delivery uncertain', rejected: 'Rejected',
  held: 'Waiting for approval', failed: 'Could not be read', quarantined: 'Quarantine' };

export function cardControls(m: CardInput): CardControls {
  const can = (action: string) => m.allowed_actions.includes(action);
  return {
    label: stateLabel[m.state] || m.state,
    approve: can('approve'),
    reject: can('reject'),
    removeFlagged: m.direction === 'out' && can('revise') && !!m.body_flags,
    send: can('send'),
    sendLabel: m.state === 'delivery_uncertain' ? 'Check and send' : 'Send',
    route: can('release_to_agent'),
  };
}

// The list polls every 10 seconds and loads again after each action. Two loads can overlap, and the older response
// can arrive last. Each load takes a number from start(); the page keeps a response only when latest(number) is true.
export function loadOrder() {
  let last = 0;
  return { start: () => ++last, latest: (n: number) => n === last };
}

// A key that changes when a dashboard approval card for a message (server/a2anotes/cards.ts) changes state. An
// approval on such a card changes the message in A2A Notes, so the Inbox list loads again when this key changes.
export function messageCardsKey(approvals: { id: string; action: string; state: string }[]) {
  return approvals.filter(a => a.action === 'mail-out' || a.action === 'mail-in').map(a => `${a.id}:${a.state}`).join(',');
}
