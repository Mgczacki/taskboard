// The user changes an outgoing draft in Inbox before it is sent. The route (POST /api/mail/:id/edit) accepts only the
// dashboard. An edit replaces the subject, body and attachments, computes a new hash, and removes the review and the
// approval: the review runs again on the new text and the permission levels decide again who approves it. The text
// before the edit stays in `versions` (the last 10), so the user can compare and restore it. After the first edit
// by the user, the controller and the tasks cannot dismiss or restore the draft (userEdited).
import { unlinkSync } from 'node:fs';
import { hashMessage, validText, type MailFile, type MailStore, type Message, type MessageVersion } from './store.ts';
import { needsBodyFile } from './presentation.ts';
import { stageBytes, verifyFile } from './files.ts';

export const VERSION_LIMIT = 10;

// Why the user cannot edit this message now. Null when the user can edit it.
export function editBlocked(m: Message): string | null {
  if (m.direction !== 'outbox') return 'Only outgoing drafts can be edited.';
  if (m.sentAt) return 'Slack confirmed this post. A sent message cannot be changed.';
  if (m.sending && m.error) return 'Delivery is uncertain. Check the Slack conversation. The message cannot be changed.';
  if (m.sending) return 'Taskboard is sending this message now. It cannot be changed.';
  if (m.rejectedAt) return 'This draft was rejected. Ask for a new draft.';
  if (m.dismissedAt) return 'Restore this draft before you edit it.';
  return null;
}

export const userEdited = (m: Message) => !!m.edits?.length;

const attachments = (files: MailFile[] = []) => files.filter(f => !f.longBody);
const remove = (files: MailFile[]) => { for (const f of files) { try { unlinkSync(f.path); } catch { /* already removed */ } } };

// input.files: the ids of the attachments to send, from the current draft or from a stored version (to restore one).
// Taskboard makes the long body file (message.md) again from the new body.
export function editDraft(store: MailStore, id: string, input: { subject: unknown; body: unknown; files: unknown; hash: unknown }, by: 'user' | 'proposer' = 'user') {
  const subject = validText(input.subject, 200, 'subject'), body = validText(input.body, 262144, 'message body');
  const current = store.get(id);
  const blocked = editBlocked(current); if (blocked) throw new Error(blocked);
  if (input.hash !== current.hash) throw new Error('The message changed. Read it again before editing.');
  const ids = input.files;
  if (!Array.isArray(ids) || ids.length > 5 || ids.some(x => typeof x !== 'string')) throw new Error('Choose up to five files');
  if (new Set(ids).size !== ids.length) throw new Error('Choose each file once');
  const known = new Map([...attachments(current.files), ...(current.versions || []).flatMap(v => v.files)].map(f => [f.id, f]));
  const files: MailFile[] = ids.map(x => { const f = known.get(x); if (!f) throw new Error('Choose a file from this draft'); verifyFile(f); return { ...f }; });
  const created: MailFile[] = [];
  if (needsBodyFile(body)) {
    if (files.length >= 5) throw new Error('A long message needs one free file slot');
    const long = { ...stageBytes(Buffer.from(body), 'message.md'), longBody: true };
    created.push(long); files.push(long);
  }
  const hash = hashMessage(subject, body, current.to, files);
  if (hash === current.hash) { remove(created); return { message: current, changed: false }; }
  let unused: MailFile[] = [];
  try {
    const message = store.update(id, m => {
      const late = editBlocked(m); if (late) throw new Error(late);
      if (m.hash !== current.hash) throw new Error('The message changed. Read it again before editing.');
      const at = new Date().toISOString();
      const previous: MessageVersion = { subject: m.subject, body: m.body, files: attachments(m.files), hash: m.hash,
        author: userEdited(m) ? 'user' : m.proposedBy?.actor || 'user', replacedAt: at, review: m.review, approval: m.approval };
      const before = [...(m.files || []), ...(m.versions || []).flatMap(v => v.files)];
      m.versions = [...(m.versions || []), previous].slice(-VERSION_LIMIT);
      if (by === 'user') m.edits = [...(m.edits || []), { at, by: 'user' as const, hash }].slice(-100);
      m.subject = subject; m.body = body; m.files = files; m.hash = hash;
      delete m.review; delete m.quality; delete m.approval; delete m.error;
      // a file stays on disk while the draft or a stored version uses it
      const kept = new Set([...files, ...m.versions.flatMap(v => v.files)].map(f => f.path));
      unused = before.filter((f, i) => !kept.has(f.path) && before.findIndex(x => x.path === f.path) === i);
    });
    remove(unused);
    return { message, changed: true };
  } catch (error) { remove(created); throw error; }
}
