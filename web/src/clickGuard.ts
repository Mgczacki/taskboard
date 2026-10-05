// Protection of card buttons against a click that was meant for something else. Observed on 5 October 2026: refused
// command cards were denied 2.8 s after they appeared, and the user had not meant to deny them. A card can appear
// under the pointer (the stack shows again, or the front card changes), so a click aimed at the page lands on it.
// The rules, for the approval cards (ApprovalCard.tsx, Permits.tsx) in the stack and on the Waiting page:
//   - a card keeps its buttons off for ARM_MS after it shows in a place, after it becomes the front card of the stack,
//     and after the server changes it (the caller gives a new key). The card shows a thin bar that runs down meanwhile.
//   - a click counts only when its pointerdown was on the same button, after the buttons came on. A pointerdown that
//     started before (on the page below, or on the old front card) does not count. A keyboard click (detail 0) has no
//     pointerdown and counts once the buttons are on.
//   - Deny on a card that appeared less than NEW_CARD_MS ago needs a second click on the same button within CONFIRM_MS.
//     The age is read at the click (confirm is a function), so a card that waited long enough needs one click.
// Each decision sends where it came from (DecisionOrigin, server/approvals.ts) for the audit.
import { createElement, useEffect, useRef, useState } from 'react';
import type { DecisionOrigin } from './api';

export const ARM_MS = 1500;
export const CONFIRM_MS = 4000;
export const NEW_CARD_MS = 10_000;

export type Down = { at: number; target: string };
// true when this click is a decision: the buttons are on, and the pointerdown was on this button after they came on
export function clickAllowed(o: { armedAt: number; now: number; down?: Down; target: string; keyboard: boolean }): boolean {
  if (o.now < o.armedAt) return false;
  if (o.keyboard) return true;
  return !!o.down && o.down.target === o.target && o.down.at >= o.armedAt;
}
// true when a Deny on this card needs a second click: the card appeared, or the server changed it, less than NEW_CARD_MS ago
export const needsConfirm = (cardTime: string | undefined, now = Date.now()) => !!cardTime && now - Date.parse(cardTime) < NEW_CARD_MS;
// the time that the card appeared for the user: a reopen or an update in place counts as a new card
export const cardTime = (a: { created: string; updated?: string; reopened?: { at: string } }) => a.reopened?.at || a.updated || a.created;

export interface CardGuard {
  armed: boolean;
  // the props of a guarded button. confirm: the first click only asks for a second click (Confirm deny).
  button: (target: string, run: (origin: DecisionOrigin) => void, o?: { confirm?: () => boolean; className?: string }) => {
    className: string; 'aria-disabled': boolean; onPointerDown: (e: React.PointerEvent) => void; onClick: (e: React.MouseEvent) => void;
  };
  // the target that waits for its second click, or null
  confirming: string | null;
  bar: React.ReactNode;
}

// key: a new key starts the guard again (a new card, a new front card, a card that the server changed)
export function useCardGuard(key: string, from: DecisionOrigin['from']): CardGuard {
  const shownAt = useRef(performance.now());
  const [armed, setArmed] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const down = useRef<Down | undefined>(undefined);
  useEffect(() => {
    shownAt.current = performance.now(); down.current = undefined; setArmed(false); setConfirming(null);
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, [key]);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirming]);
  const button: CardGuard['button'] = (target, run, o = {}) => ({
    className: `${o.className || 'btn'}${armed ? '' : ' guard-off'}${confirming === target ? ' confirm' : ''}`,
    'aria-disabled': !armed,
    onPointerDown: e => { down.current = { at: e.timeStamp, target }; },
    onClick: e => {
      const now = performance.now();
      const ok = clickAllowed({ armedAt: shownAt.current + ARM_MS, now, down: down.current, target, keyboard: e.detail === 0 });
      const pointerMs = down.current?.target === target ? Math.round(now - down.current.at) : undefined;
      down.current = undefined;
      if (!ok) return;
      if (o.confirm?.() && confirming !== target) { setConfirming(target); return; }
      setConfirming(null);
      run({ from, target, shownMs: Math.round(now - shownAt.current), ...(pointerMs !== undefined ? { pointerMs } : {}) });
    },
  });
  const bar = armed ? null : createElement('div', { className: 'card-arm', style: { animationDuration: `${ARM_MS}ms` }, title: 'The buttons come on in a moment, so that a click meant for something else does not decide this card.' });
  return { armed, button, confirming, bar };
}
