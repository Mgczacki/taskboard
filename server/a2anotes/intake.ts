// A2A Notes supplies the current approval and verifies the sender of a reply.
// Taskboard uses local task metadata and a target that the user approved.
export interface ApprovedTarget { task: string | null; hash: string }

export function accepted(m: any): boolean {
  return m.direction === 'in' && m.state === 'approved' &&
    m.approval?.hash === m.hash && m.allowed_actions?.includes('reply') === true;
}

export function agentAudience(m: any): boolean {
  return m.audience === 'agent' || m.audience === 'both';
}

export function destination(m: any, target: ApprovedTarget | undefined, exists: (id: string) => boolean) {
  const reply = m.reply_to_local?.metadata?.['taskboard.task_id'];
  const valid = (id: unknown): id is string => typeof id === 'string' && id !== 'controller' && exists(id);
  if (target && target.hash === m.hash) {
    if (!valid(target.task)) return { reason: 'The approved target does not identify a local task.' };
    if (valid(reply) && reply !== target.task) return { reason: 'The reply and approved target identify different tasks.' };
    return { task: target.task, reason: 'The user approved this target.' };
  }
  if (valid(reply)) return { task: reply, reason: 'The verified reply identifies its originating task.' };
  return { reason: 'No unique local task is known.' };
}

export function trustedAgent(m: any): boolean {
  // trusted comes from the service trust record, which matches the transport address.
  return m.direction === 'in' && m.state === 'held' && agentAudience(m) &&
    m.trusted === true && m.approver === 'reviewer' && m.allowed_actions?.includes('approve') === true;
}
