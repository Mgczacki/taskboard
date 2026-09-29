import { openDocumentLink, type DocumentLink } from './documentLinks';

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
  return () => root.removeEventListener('click', click, true);
}
