// Dropping files from Finder onto a task puts them in that task's inbox.
import type { DragEvent } from 'react';
import { api } from './api';

export const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');

export async function uploadAll(id: string, files: FileList | File[], toast?: (s: string) => void) {
  const list = Array.from(files);
  try {
    for (const f of list) await api.upload(id, f);
    toast?.(`Put ${list.length === 1 ? list[0].name : list.length + ' files'} in the inbox.`);
  } catch (e) { toast?.(String((e as Error).message || e)); }
}
