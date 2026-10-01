// The user's rules files (server/rules.ts): free text for the controller and for every task session. Each file shows
// its first lines as a preview; the preview opens an editor for the whole file. A saved file reaches the next new session.
import { useEffect, useState } from 'react';
import type { RulesFile, RulesKind } from '../api';
import { api } from '../api';

const TITLE: Record<RulesKind, string> = { controller: 'Controller rules', task: 'Task session rules' };
const WHO: Record<RulesKind, string> = {
  controller: 'The controller reads these rules when it starts. A new controller session uses the saved text.',
  task: 'Every task session that Taskboard starts receives these rules. A resumed conversation keeps the text that it started with. When the rules do not fit on the agent\'s command line, the agent gets a copy in its task folder to read.',
};

export function RulesFiles() {
  const [files, setFiles] = useState<RulesFile[]>([]);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<RulesKind | null>(null);
  useEffect(() => { api.rules().then(setFiles).catch(e => setErr(String((e as Error).message || e))); }, []);
  const saved = (f: RulesFile) => setFiles(fs => fs.map(x => x.kind === f.kind ? f : x));
  const editing = files.find(f => f.kind === open);
  return <>
    <h3 className="set-h">Rules files</h3>
    <p className="sub">Free text that tells the agents how to work. Taskboard adds it next to a project's own CLAUDE.md or AGENTS.md and does not change those files.</p>
    {err && <div className="banner" role="alert">{err}</div>}
    {files.map(f => <div key={f.kind} className="ctl-box" data-rules={f.kind}>
      <b>{TITLE[f.kind]}</b>
      <div className="sub">{WHO[f.kind]}</div>
      <button className="btn ghost" title="Open the editor" aria-label={`Edit the ${TITLE[f.kind].toLowerCase()}`} onClick={() => setOpen(f.kind)}
        style={{ display: 'block', width: '100%', textAlign: 'left', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono, monospace)', fontSize: 12, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6 }}>
        {f.preview.lines.length ? f.preview.lines.join('\n') + (f.preview.more ? '\n…' : '') : <span className="sub">No rules yet. Click to write them.</span>}
      </button>
      <div className="sub">{f.chars} of {f.max} characters{f.updated ? ` · saved ${new Date(f.updated).toLocaleString()}` : ''} · <code>{f.file}</code></div>
    </div>)}
    {editing && <RulesEditor file={editing} onClose={() => setOpen(null)} onSaved={saved} />}
  </>;
}

function RulesEditor({ file, onClose, onSaved }: { file: RulesFile; onClose: () => void; onSaved: (f: RulesFile) => void }) {
  const [text, setText] = useState(file.text);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const changed = text !== file.text;
  const close = () => { if (!changed || confirmDiscard()) onClose(); };
  const save = async () => {
    setBusy(true); setErr('');
    try { onSaved(await api.saveRules(file.kind, text)); onClose(); } catch (e) { setErr(String((e as Error).message || e)); }
    setBusy(false);
  };
  return <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="modal" role="dialog" aria-label={TITLE[file.kind]} style={{ width: 'min(860px, 94vw)' }}>
      <header><h2>{TITLE[file.kind]}</h2><button className="btn ghost icon" title="Close" onClick={close}>✕</button></header>
      <div className="body">
        <div className="sub">{WHO[file.kind]} Sessions that run now keep their old text.</div>
        <textarea aria-label={`${TITLE[file.kind]} text`} autoFocus rows={22} value={text} spellCheck={false}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
          style={{ width: '100%', fontFamily: 'var(--mono, monospace)', fontSize: 12.5 }} />
        <div className="sub">{text.length} of {file.max} characters · <code>{file.file}</code></div>
        {err && <div className="banner" role="alert">{err}</div>}
      </div>
      <footer><span style={{ flex: 1 }} /><button className="btn" onClick={close}>Cancel</button><button className="btn primary" disabled={busy || !changed || text.length > file.max} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button></footer>
    </div>
  </div>;
}

// a browser confirm only when there is unsaved text; the editor never opens one otherwise
function confirmDiscard() { return window.confirm('Close the editor and lose the changes?'); }
