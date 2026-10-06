import { useEffect, useMemo, useState } from 'react';
import { openDocumentLink, type DocumentLink } from '../documentLinks';

// Keep explicit Markdown links, URLs, and paths intact. Only bare names reach the resolver.
export function taskTextParts(value: string): { text: string; name?: string }[] {
  const parts: { text: string; name?: string }[] = [];
  const protectedText = /\[[^\]]+\]\([^)]+\)|(?:https?:\/\/|file:\/\/|~\/|\/|\.\/|\.\.\/|[\w.-]+\/)[^\s<>()]+/g;
  const bareName = /(^|[^\w./\\-])([\w-][\w.-]*\.[A-Za-z][A-Za-z\d]{0,9})(?=$|[^\w/\\.-])/g;
  const plain = (chunk: string) => {
    let start = 0;
    for (const match of chunk.matchAll(bareName)) {
      const at = match.index! + match[1].length;
      if (at > start) parts.push({ text: chunk.slice(start, at) });
      parts.push({ text: match[2], name: match[2] });
      start = at + match[2].length;
    }
    if (start < chunk.length) parts.push({ text: chunk.slice(start) });
  };
  let start = 0;
  for (const match of value.matchAll(protectedText)) {
    plain(value.slice(start, match.index));
    parts.push({ text: match[0] });
    start = match.index! + match[0].length;
  }
  plain(value.slice(start));
  return parts;
}

export function TaskFileText({ taskId, text }: { taskId: string; text: string }) {
  const parts = useMemo(() => taskTextParts(text), [text]);
  const [found, setFound] = useState<Record<string, DocumentLink>>({});
  useEffect(() => {
    let live = true;
    setFound({});
    for (const name of new Set(parts.map(p => p.name).filter((n): n is string => !!n))) {
      fetch(`/api/tasks/${encodeURIComponent(taskId)}/task-text-file?name=${encodeURIComponent(name)}`)
        .then(async response => response.ok ? await response.json() as DocumentLink : null)
        .then(link => { if (live && link) setFound(current => ({ ...current, [name]: link })); })
        .catch(() => {});
    }
    return () => { live = false; };
  }, [taskId, parts]);
  return <>{parts.map((part, i) => {
    const link = part.name && found[part.name];
    return link ? <span key={i} className="task-file-link" role="link" tabIndex={0} title={`Open ${link.path}`}
      onClick={event => { event.stopPropagation(); openDocumentLink(link); }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); openDocumentLink(link); } }}>{part.text}</span>
      : part.text;
  })}</>;
}
