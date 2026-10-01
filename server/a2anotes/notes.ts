// Notes from a task to you (`tb mail submit <subject> <body>`). They stay on this computer: no Slack, no A2A Notes.
// TB_DIR/task-notes.json keeps the last 1000. The Inbox shows them in Messages.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJson, savePrivate } from './files.ts';

export interface TaskNote { id: string; task: string; subject: string; body: string; created: string; seen?: string; dismissed?: string }
export class TaskNotes {
  constructor(readonly file: string) {}
  static in(dir: string) { return new TaskNotes(join(dir, 'task-notes.json')); }
  all(): TaskNote[] { return readJson<TaskNote[]>(this.file, []); }
  add(task: string, subject: unknown, body: unknown) {
    const clean = (v: unknown, limit: number, label: string) => {
      if (typeof v !== 'string' || !v.trim() || v.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) throw new Error(`Give the ${label} as text of at most ${limit} characters.`);
      return v.trim();
    };
    const note: TaskNote = { id: randomUUID(), task, subject: clean(subject, 200, 'subject'), body: clean(body, 20_000, 'body'), created: new Date().toISOString() };
    savePrivate(this.file, [...this.all(), note].slice(-1000));
    return note;
  }
  update(id: string, fn: (n: TaskNote) => void) {
    const list = this.all(); const n = list.find(x => x.id === id);
    if (!n) throw new Error('No note has this ID.');
    fn(n); savePrivate(this.file, list); return n;
  }
}
