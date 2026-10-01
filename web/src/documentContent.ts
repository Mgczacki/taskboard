import { openDocumentLink, type DocumentLink } from './documentLinks';
import { markdownCommand } from './bangCommand';
import { beginHold } from './holdRun';

type Link =
  | { kind: 'document'; document: DocumentLink }
  | { kind: 'vault-document'; path: string; heading?: string }
  | { kind: 'local'; path: string }
  | { kind: 'web'; url: string }
  | { kind: 'refused'; error: string };

const modifier = (event: MouseEvent) => /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
const hint = () => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Command-click' : 'Control-click';
function showError(root: HTMLElement, message: string) {
  root.querySelector('.doc-link-message')?.remove();
  const notice = document.createElement('div');
  notice.className = 'doc-link-message';
  notice.setAttribute('role', 'alert');
  notice.textContent = message;
  root.appendChild(notice);
  setTimeout(() => notice.remove(), 8000);
}

export function decorateDocument(root: HTMLElement, source: string): () => void {
  const links = new WeakMap<HTMLAnchorElement, Promise<Link>>();
  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const path = image.getAttribute('src') || '';
    image.src = `/api/document-image?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`;
  }
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = anchor.getAttribute('href') || '';
    anchor.classList.add('doc-link');
    anchor.title = `${hint()} to open ${href}`;
    const lookup = fetch(`/api/document-link?source=${encodeURIComponent(source)}&href=${encodeURIComponent(href)}`)
      .then(async response => response.ok ? await response.json() as Link : { kind: 'refused', error: 'Taskboard could not read this link.' } as Link)
      .catch(() => ({ kind: 'refused', error: 'Taskboard could not read this link.' } as Link));
    links.set(anchor, lookup);
    lookup.then(link => { if (anchor.isConnected) anchor.title = `${hint()} to open ${link.kind === 'document' ? link.document.path : link.kind === 'web' ? link.url : link.kind === 'refused' ? href : link.path}`; });
  }
  const click = async (event: MouseEvent) => {
    const anchor = (event.target as Element).closest('a[href]') as HTMLAnchorElement | null;
    if (!anchor || !root.contains(anchor)) return;
    event.preventDefault();
    if (!modifier(event)) return;
    event.stopPropagation();
    const href = anchor.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
    if (/\.svg(?:$|[?#])/i.test(href)) {
      window.open(`/api/document-image?source=${encodeURIComponent(source)}&path=${encodeURIComponent(href.split(/[?#]/)[0])}`, '_blank', 'noopener');
      return;
    }
    const link = await links.get(anchor);
    if (!link) return;
    if (link.kind === 'document') openDocumentLink(link.document);
    else if (link.kind === 'vault-document') dispatchEvent(new CustomEvent('taskboard:vault-document', { detail: link }));
    else if (link.kind === 'web') window.open(link.url, '_blank', 'noopener');
    else if (link.kind === 'local') {
      try {
        const response = await fetch('/api/open-local-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: link.path }) });
        if (!response.ok) showError(root, (await response.json()).error || 'Taskboard could not open this file.');
      } catch { showError(root, 'Taskboard could not open this file.'); }
    } else showError(root, link.error);
  };
  root.addEventListener('click', click, true);
  const stopHold = holdToRun(root, source);
  return () => { root.removeEventListener('click', click, true); stopHold(); };
}

// Hold to run (bangCommand.ts): a "! <command>" in a task's inbox or outbox document goes to that task's prompt.
function holdToRun(root: HTMLElement, source: string): () => void {
  const taskId = /\/tasks\/([^/]+)\/(?:inbox|outbox)\//.exec(source)?.[1];
  if (!taskId) return () => {};
  const hint = 'Hold the mouse button for 3 seconds to type this command into the task prompt and run it';
  for (const code of root.querySelectorAll<HTMLElement>('code')) if (code.textContent?.trimStart().startsWith('!') || /(?:^|\n)\s*!/.test(code.textContent || '')) code.title = hint;
  const down = (event: MouseEvent) => {
    if (event.button !== 0 || modifier(event) || event.altKey || event.shiftKey) return;
    const hit = textAt(event.clientX, event.clientY);
    if (!hit || !root.contains(hit.node) || hit.node.parentElement?.closest('a')) return;
    const code = hit.node.parentElement?.closest('code');
    const inline = !!code && !code.closest('pre');
    const block = code || hit.node.parentElement?.closest('p, li, td, th');
    if (!block || !root.contains(block)) return;
    // the offset of the pointer in the whole text of the block
    let offset = 0;
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n && n !== hit.node; n = walk.nextNode()) offset += n.textContent?.length || 0;
    const command = markdownCommand(block.textContent || '', offset + hit.offset, inline);
    if (command) beginHold(event, taskId, command);
  };
  root.addEventListener('mousedown', down);
  return () => root.removeEventListener('mousedown', down);
}
// The text node and character under the point, only when the point is on that character (not in the space beside it).
function textAt(x: number, y: number): { node: Text; offset: number } | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const at = doc.caretPositionFromPoint ? doc.caretPositionFromPoint(x, y) : (() => { const r = document.caretRangeFromPoint?.(x, y); return r ? { offsetNode: r.startContainer, offset: r.startOffset } : null; })();
  if (!at || at.offsetNode.nodeType !== Node.TEXT_NODE) return null;
  const node = at.offsetNode as Text;
  // the caret is between two characters: find the one whose box holds the point
  for (const offset of [at.offset, at.offset - 1]) {
    if (offset < 0 || offset >= node.length) continue;
    const range = document.createRange();
    range.setStart(node, offset); range.setEnd(node, offset + 1);
    for (const box of range.getClientRects()) if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return { node, offset };
  }
  return null;
}
