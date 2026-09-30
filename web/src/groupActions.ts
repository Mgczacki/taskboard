// Runs a group change from groupMove.ts and shows its notice with Undo. Used by the canvas, the Board and the task panel.
import { api, currentGroups } from './api';
import { applyChange, changeNotice, undoChange, type GroupChange } from './groupMove';

export type Toast = (s: string, action?: { label: string; fn: () => void }) => void;

export async function runGroupChange(c: GroupChange, toast: Toast) {
  try { await applyChange(c, api.updateGroup, api.moveGroupTask); }
  catch (e) { toast(`Could not change the groups of #${c.num}: ${(e as Error).message || e}`); return; }
  toast(changeNotice(c), { label: 'Undo', fn: () => {
    undoChange(c, currentGroups(), api.updateGroup).then(
      lost => toast(lost.length ? `Could not put #${c.num} back in ${lost.join(', ')}: the group was deleted.` : `Undone. #${c.num} is back where it was.`),
      e => toast(`Could not undo: ${(e as Error).message || e}`));
  } });
}
