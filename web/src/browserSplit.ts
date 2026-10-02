// The browser of a task inside its Canvas window (Canvas.tsx): whether it is open there, and where the terminal goes
// (a strip at the bottom, or a column at the side). Saved for each task in localStorage 'tb-split-<task id>'.
export type SplitSide = 'bottom' | 'side';
export interface Split { open: boolean; side: SplitSide }

export const NO_SPLIT: Split = { open: false, side: 'bottom' };
const STORE = (id: string) => `tb-split-${id}`;

// a missing or broken value is a closed browser with the terminal at the bottom
export const parseSplit = (raw: string | null): Split => {
  try {
    const v = JSON.parse(raw || 'null');
    return { open: v?.open === true, side: v?.side === 'side' ? 'side' : 'bottom' };
  } catch { return NO_SPLIT; }
};
export const readSplit = (id: string): Split => { try { return parseSplit(localStorage.getItem(STORE(id))); } catch { return NO_SPLIT; } };
export const writeSplit = (id: string, s: Split) => { try { localStorage.setItem(STORE(id), JSON.stringify(s)); } catch { /* storage off */ } };
// Open the browser in the Canvas window of this task (the task panel's More menu, TaskBrowser.tsx). The event tells a
// Canvas that is on screen to read the saved value again.
export const openBrowserSplit = (id: string) => {
  writeSplit(id, { ...readSplit(id), open: true });
  window.dispatchEvent(new CustomEvent('tb-split', { detail: id }));
};
