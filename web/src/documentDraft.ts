// Unsent text about a document: the comment for its task and the BTW question. The text is saved in localStorage under
// the document path and its review version, so the Inbox page, the floating viewer and the document window of the
// same browser show the same draft, and the draft is still there after a view closes.
import { useCallback, useEffect, useState } from 'react';

export type DraftKind = 'comment' | 'btw';
const EVENT = 'taskboard:document-draft';
export const draftKey = (kind: DraftKind, path: string, version?: number | null) => `tb-doc-${kind}:${version || 0}:${path}`;

export function readDraft(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
export function writeDraft(key: string, text: string) {
  try { if (text) localStorage.setItem(key, text); else localStorage.removeItem(key); } catch { /* storage is full or off: the draft lives in the view only */ }
  dispatchEvent(new CustomEvent(EVENT, { detail: { key, text } }));
}
// A new review version starts without a draft: the unsent text of the version before moves to it.
export function moveDraft(from: string, to: string) {
  const text = readDraft(from);
  if (!text || from === to || readDraft(to)) return;
  writeDraft(to, text); writeDraft(from, '');
}

// The draft and its setter. Another view (this window or another one) that changes the draft changes it here too.
export function useDraft(kind: DraftKind, path?: string, version?: number | null): [string, (text: string) => void] {
  const key = path ? draftKey(kind, path, version) : '';
  const [state, setState] = useState({ key, text: key ? readDraft(key) : '' });
  useEffect(() => {
    if (!key) return;
    const other = (e: StorageEvent) => { if (e.key === key) setState({ key, text: e.newValue || '' }); };
    const here = (e: Event) => { const d = (e as CustomEvent<{ key: string; text: string }>).detail; if (d.key === key) setState({ key, text: d.text }); };
    addEventListener('storage', other); addEventListener(EVENT, here);
    return () => { removeEventListener('storage', other); removeEventListener(EVENT, here); };
  }, [key]);
  const set = useCallback((text: string) => { setState({ key, text }); if (key) writeDraft(key, text); }, [key]);
  // the first draw after the path or version changes reads the saved text of the new key
  return [state.key === key ? state.text : key ? readDraft(key) : '', set];
}
