// A desktop notification and a sound for a card that arrives while the Taskboard window does not have focus
// (Settings > Notifications; saved per browser or app, both off by default). The page finds the arrived cards with
// arrivals in stack.ts. The notification uses the web Notification API, as notifyIfNeeded in api.ts does for a task
// that starts to need the user. The Mac app (desktop/main.cjs) shows these notifications as macOS notifications. Its
// Dock badge and menu-bar item count tasks, not cards, so they do not change here.
import { useEffect, useRef } from 'react';
import type { Approval, PendingItem } from './api';
import { arrivals, liveApprovals, seenCards, stackEntries, type Seen, type StackEntry } from './stack';

const NOTIFY_KEY = 'tb-card-notify', SOUND_KEY = 'tb-card-sound';
const read = (k: string) => { try { return localStorage.getItem(k) === 'on'; } catch { return false; } };
const write = (k: string, on: boolean) => { try { localStorage.setItem(k, on ? 'on' : 'off'); } catch { /* storage off */ } };
export const cardNotify = () => read(NOTIFY_KEY);
export const setCardNotify = (on: boolean) => write(NOTIFY_KEY, on);
export const cardSound = () => read(SOUND_KEY);
export const setCardSound = (on: boolean) => write(SOUND_KEY, on);

// the title and text of the notification for the arrived cards
export function alertText(arrived: StackEntry[]): { title: string; body: string } {
  const first = arrived[0];
  const what = first.approval ? first.approval.summary : first.item ? `#${first.item.taskNum} ${first.item.taskTitle}: ${first.item.question}` : '';
  const title = arrived.length === 1 ? (first.approval ? 'A card waits on you' : 'A question waits on you') : `${arrived.length} cards wait on you`;
  return { title, body: what.slice(0, 180) };
}

// two short tones, about 0.3 s, made in the page (no sound file)
function beep() {
  try {
    const ctx = new AudioContext();
    [880, 660].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.15;
      g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.start(t); o.stop(t + 0.15);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch { /* no audio */ }
}

export function alertArrivals(arrived: StackEntry[]) {
  if (!arrived.length || document.hasFocus()) return;
  if (cardNotify() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const { title, body } = alertText(arrived);
    const n = new Notification(title, { body, tag: 'tb-card' });
    // a click on the notification brings the window to the front, where the stack already shows the card
    n.onclick = () => { window.focus(); n.close(); };
  }
  if (cardSound()) beep();
}

// App.tsx mounts this on every page, also on the Waiting page, where the stack is off. It reads the full lists, so a
// permit card also alerts on the Permits page.
// loaded: the store got both card lists once (cardsLoaded in api.ts).
export function useCardAlerts(approvals: Approval[], pending: PendingItem[], loaded: boolean) {
  const seen = useRef<Seen | null>(null);
  const entries = stackEntries(liveApprovals(approvals), pending);
  const now = seenCards(entries);
  const key = JSON.stringify(now);
  useEffect(() => {
    if (!loaded) return;
    alertArrivals(arrivals(seen.current, entries));
    seen.current = now;
  }, [key, loaded]);
}
