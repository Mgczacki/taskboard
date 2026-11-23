// The server and Settings use the same list. Every type starts manual, and the user can turn on any of them.
// Unknown types, such as refused-command cards and agent questions without an automatic answer, never receive automatic approval.
export const PERMISSION_TYPES = [
  { id: 'new', label: 'Create tasks' },
  { id: 'send', label: 'Messages and documents between agents' },
  { id: 'status', label: 'Change task status' },
  { id: 'kill', label: 'Archive tasks', note: 'Archive requests from group managers always need the user.' },
  { id: 'move', label: 'Move tasks' },
  { id: 'git-merge', label: 'Merge into local master' },
  { id: 'git-push', label: 'Pushes' },
  { id: 'forcePush', label: 'Force pushes' },
  { id: 'github-pr', label: 'Open pull requests' },
  { id: 'github-pr-merge', label: 'Merge pull requests' },
  { id: 'github-pr-ready', label: 'Mark draft pull requests ready' },
  { id: 'release', label: 'Release Taskboard', note: 'Approves the release card. The guard still checks the release command.' },
  { id: 'restart', label: 'Restart Taskboard' },
  { id: 'permit', label: 'Run commands', note: 'Includes supervised runs. Command validation and request limits still apply.' },
  { id: 'external', label: 'Deployment and catalog permits' },
  { id: 'scope', label: 'Scope requests', note: 'Includes worktrees and read access. Scope validation and limits still apply.' },
  { id: 'mail-in', label: 'Incoming A2A mail' },
  { id: 'mail-out', label: 'Send A2A mail to people', note: 'Messages that the content check holds always need the user.' },
  { id: 'plan', label: 'Plan cards', note: 'Each step of the plan uses the setting of its own type.' },
  { id: 'pending:command', label: 'Agent command questions', note: 'Approves pwd, git status, or git branch --show-current once. Other tool requests stay manual.' },
] as const;
export type PermissionType = typeof PERMISSION_TYPES[number]['id'];
export type PermissionAutoApprove = Record<PermissionType, boolean>;
const known = (id: string): id is PermissionType => PERMISSION_TYPES.some(row => row.id === id);
export function readPermissionAutoApprove(saved: unknown): PermissionAutoApprove {
  const values = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
  return Object.fromEntries(PERMISSION_TYPES.map(row => [row.id, values[row.id] === true])) as PermissionAutoApprove;
}
export function checkPermissionPatch(value: unknown): asserts value is Partial<PermissionAutoApprove> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Permissions must be an object.');
  for (const [id, on] of Object.entries(value)) {
    if (!known(id) || typeof on !== 'boolean') throw new Error(`Invalid permission: ${id}. Use true or false.`);
  }
}
export function permissionType(card: { action: string; payload?: unknown }): string {
  if (card.action === 'git-push' && (card.payload as { state?: { forcePush?: boolean } } | undefined)?.state?.forcePush) return 'forcePush';
  return card.action;
}
export function cardNeedsManual(card: { action: string; payload?: unknown }): boolean {
  if (!known(permissionType(card))) return true;
  const payload = card.payload as { stage?: string; managerArchive?: boolean } | undefined;
  if (card.action === 'kill' && payload?.managerArchive) return true;
  return card.action === 'mail-out' && (payload?.stage === 'checking' || payload?.stage === 'held');
}
export const permissionEnabled = (settings: PermissionAutoApprove, type: string) => known(type) && settings[type] === true;
