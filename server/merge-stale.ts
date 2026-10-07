// The words for a merge card (action git-merge) whose branch head or master head moved after the card was made.
// The card holds the two heads that the user saw (task-git.ts MergeState). The check of the card (index.ts POST
// /api/git/merge-request) reads the heads again and calls staleFacts here. Before, the only text was "The branch or
// master moved", Approve did nothing, and Deny was the only action that closed the card. In task 381 the task read
// that Deny as a rejection of its work. "Ask task to refresh" on the card (approvals.ts refresh) closes the card in
// state stale. refreshResult is the result of that card and the message to the task.
import type { MergeState } from './task-git.ts';

const short = (head: string) => head.slice(0, 8);

// Which head moved, with the old and the new value, or undefined when the card still matches.
export function staleFacts(card: MergeState, now: MergeState): string | undefined {
  const master = card.target !== now.target, branch = card.source !== now.source;
  if (card.branch !== now.branch) return `The task worktree is on another branch now. The card shows ${card.branch}. The worktree is on ${now.branch}.`;
  if (master && branch) return `Local master and the task branch moved after this card was made. The card shows master ${short(card.target)} and branch head ${short(card.source)}. Master is now ${short(now.target)}. The branch head is now ${short(now.source)}.`;
  if (master) return `Local master moved after this card was made. The card shows master ${short(card.target)}. Master is now ${short(now.target)}. The branch head did not change (${short(now.source)}).`;
  if (branch) return `The task branch moved after this card was made. The card shows branch head ${short(card.source)}. The branch head is now ${short(now.source)}. Master did not change (${short(now.target)}).`;
  return undefined;
}

// The facts when the check itself cannot read the heads (for example the worktree has local changes).
export const checkFailed = (reason: string) => `Taskboard cannot compare this card with the branch and master now. ${reason}`;

// The result of a card that the user closed with "Ask task to refresh". The task gets this text.
// worktree: the name of an attached worktree (tb git --worktree), when the card is for one.
export function refreshResult(facts: string, worktree?: string): string {
  const wt = worktree ? ` --worktree ${worktree}` : '';
  return `The user closed this merge card because it is stale. This is not a denial. The user did not reject the branch. Nothing was merged. ${facts} `
    + `Run tb git rebase${wt}, or inspect the change if you must. Then run tb git merge-request${wt}. Taskboard makes a new card with the current branch head and master head. The user must approve that new card.`;
}
