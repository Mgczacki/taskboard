// A2A Notes supplies the current approval and verifies the sender of a reply.
// Taskboard uses local task metadata and a target that the user approved.
export interface ApprovedTarget { task: string | null; hash: string; machine?: string }

export function accepted(m: any): boolean {
  return m.direction === 'in' && m.state === 'approved' &&
    m.approval?.hash === m.hash && m.allowed_actions?.includes('reply') === true;
}

export function agentAudience(m: any): boolean {
  return m.audience === 'agent' || m.audience === 'both';
}

export function ownerMessage(m: any): boolean {
  return accepted(m) && m.owner_message === true && m.from === m.to && typeof m.from === 'string' &&
    ['human_reply', 'human_message'].includes(m.source) && m.approval?.by === 'person' && m.approval.actor === m.from;
}

export function destination(m: any, target: ApprovedTarget | undefined, exists: (id: string) => boolean, resolve?: (selector: string) => string | undefined, machine?: string) {
  const replyMachine = m.reply_to_local?.metadata?.['taskboard.machine_id'];
  if (machine && typeof replyMachine === 'string' && replyMachine !== machine) return { reason: 'The original task belongs to another machine.' };
  if (machine && target?.machine && target.machine !== machine) return { reason: 'The approved target belongs to another machine.' };
  const reply = m.reply_to_local?.metadata?.['taskboard.task_id'];
  const valid = (id: unknown): id is string => typeof id === 'string' && (id !== 'controller' || ownerMessage(m)) && exists(id);
  if (target && target.hash === m.hash) {
    if (!valid(target.task)) return { reason: 'The approved target does not identify a local task.' };
    if (valid(reply) && reply !== target.task) return { reason: 'The reply and approved target identify different tasks.' };
    return { task: target.task, reason: 'The user approved this target.' };
  }
  if (ownerMessage(m) && m.source === 'human_message' && typeof m.direct_target === 'string') {
    const task = resolve?.(m.direct_target);
    return valid(task) ? { task, reason: 'The owner explicitly addressed this local task.' } : { reason: 'The task number or registered alias does not identify an active local task.' };
  }
  if (valid(reply)) return { task: reply, reason: 'The verified reply identifies its originating task.' };
  return { reason: 'No unique local task is known.' };
}

export function trustedAgent(m: any): boolean {
  // trusted comes from the service trust record, which matches the transport address.
  return m.direction === 'in' && m.state === 'held' && agentAudience(m) &&
    m.trusted === true && m.approver === 'reviewer' && m.allowed_actions?.includes('approve') === true;
}
