// The server and Settings use the same list. Unknown types never receive automatic approval.
export const PERMISSION_TYPES = [
  { id: 'new', label: 'Create tasks' },
  { id: 'send', label: 'Messages and documents between agents' },
  { id: 'status', label: 'Change task status' },
  { id: 'kill', label: 'Archive tasks', note: 'Archive requests from group managers always need the user.' },
  { id: 'move', label: 'Move tasks' },
  { id: 'git-merge', label: 'Merge into local master' },
  { id: 'git-push', label: 'Pushes' },
  { id: 'forcePush', label: 'Force pushes', manual: 'Force pushes need a user decision in every mode.' },
  { id: 'github-pr', label: 'Open pull requests', manual: 'Only the user can approve this card.' },
  { id: 'github-pr-merge', label: 'Merge pull requests', manual: 'Only the user can approve this card.' },
  { id: 'github-pr-ready', label: 'Mark draft pull requests ready' },
  { id: 'release', label: 'Release Taskboard', manual: 'Releases need a user decision in every mode.' },
  { id: 'restart', label: 'Restart Taskboard', manual: 'Restarts need a user decision in every mode.' },
  { id: 'rollback', label: 'Roll back Taskboard', manual: 'Only the user runs a rollback. There is no approval card.' },
  { id: 'permit', label: 'Run commands', note: 'Includes supervised runs. Command validation and request limits still apply.' },
  { id: 'external', label: 'Deployment and catalog permits' },
  { id: 'scope', label: 'Scope requests', note: 'Includes worktrees and read access. Scope validation and limits still apply.' },
  { id: 'mail-in', label: 'Incoming A2A mail' },
  { id: 'mail-out', label: 'Send A2A mail to people' },
  { id: 'plan', label: 'Plan cards', manual: 'The user must answer this question.' },
  { id: 'tool-refusal', label: 'Refused tool calls', manual: 'This card cannot grant permission. The user can dismiss it.' },
  { id: 'pending:command', label: 'Agent command questions', note: 'Approves pwd, git status, or git branch --show-current once under the low-risk rule. Other tool requests stay manual.' },
  { id: 'pending:choice', label: 'Agent choice questions', manual: 'The user must select an answer.' },
  { id: 'pending:text', label: 'Agent text questions', manual: 'The user must supply an answer.' },
  { id: 'pending:dialog', label: 'Agent dialogs', manual: 'The user must decide access and installation questions.' },
  { id: 'pending:plan', label: 'Agent plan questions', manual: 'The user must decide the plan.' },
  { id: 'pending:signin', label: 'Agent sign-in questions', manual: 'The user must sign in.' },
  { id: 'pending:unknown', label: 'Unknown agent questions', manual: 'Taskboard cannot identify an answer.' },
] as const;
export type PermissionType = typeof PERMISSION_TYPES[number]['id'];
export type PermissionAutoApprove = Record<PermissionType, boolean>;
export const manualReason = (id: string) => {
  const row = PERMISSION_TYPES.find(row => row.id === id);
  return !row ? 'Unknown permission type.' : 'manual' in row ? row.manual : undefined;
};
export function readPermissionAutoApprove(saved: unknown): PermissionAutoApprove {
  const values = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
  return Object.fromEntries(PERMISSION_TYPES.map(row => [row.id, !manualReason(row.id) && values[row.id] === true])) as PermissionAutoApprove;
}
export function checkPermissionPatch(value: unknown): asserts value is Partial<PermissionAutoApprove> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Permissions must be an object.');
  for (const [id, on] of Object.entries(value)) {
    if (!PERMISSION_TYPES.some(row => row.id === id) || typeof on !== 'boolean') throw new Error(`Invalid permission: ${id}. Use true or false.`);
    if (on && manualReason(id)) throw new Error(`${id} must stay manual. ${manualReason(id)}`);
  }
}
export function permissionType(card: { action: string; payload?: unknown }): string {
  if (card.action === 'git-push' && (card.payload as { state?: { forcePush?: boolean } } | undefined)?.state?.forcePush) return 'forcePush';
  return card.action;
}
export function cardNeedsManual(card: { action: string; payload?: unknown }): boolean {
  if (manualReason(permissionType(card))) return true;
  const payload = card.payload as { stage?: string; managerArchive?: boolean } | undefined;
  if (card.action === 'kill' && payload?.managerArchive) return true;
  return card.action === 'mail-out' && (payload?.stage === 'checking' || payload?.stage === 'held');
}
export const permissionEnabled = (settings: PermissionAutoApprove, type: string) => !manualReason(type) && settings[type as PermissionType] === true;
export const MARIO_PERMISSIONS = { ...readPermissionAutoApprove(undefined), 'git-push': true, new: true, permit: true, send: true };
