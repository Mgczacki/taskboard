// New task: title, first prompt, folder, agent, and working copy.
import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react';
import { AGENTS, AGENT_NAME, api } from '../api';
import type { Agent, Group, SpinOffExchange } from '../api';
import { loadAccounts, usageText, type Account } from './Accounts';

export function NewTask({ onClose, onStarted, initialFolder, initialMachine = 'local', groups = [], initialGroup, spinOff }: { onClose: () => void; onStarted: (id: string, group: string, choice?: string) => void; initialFolder?: string; initialMachine?: string; groups?: Group[]; initialGroup?: string; spinOff?: SpinOffExchange }) {
  const [title, setTitle] = useState(spinOff?.question.slice(0, 80) || '');
  const [desc, setDesc] = useState(spinOff ? `Start a new task from this Ask exchange about task #${spinOff.sourceNum}. Read task #${spinOff.sourceNum}'s log if you need more context. Do not send a message to the source task.\n\nQuestion:\n${spinOff.question}\n\nAnswer:\n${spinOff.answer}` : '');
  // Images pasted into the description (⌘V / Ctrl+V). The server saves them in the task folder and lists their paths in the first prompt.
  const [images, setImages] = useState<{ type: string; data: string; url: string }[]>([]);
  const [agent, setAgent] = useState<Agent | 'auto'>('claude');
  const [folder, setFolder] = useState(initialFolder || '');
  const [group, setGroup] = useState(initialGroup || '');
  const [q, setQ] = useState('');
  const [workingCopy, setWorkingCopy] = useState<'auto' | 'folder' | 'worktree'>('auto');
  const [branch, setBranch] = useState('');
  const [folders, setFolders] = useState<{ used: { path: string; uses: number; last: string; pinned?: boolean }[]; found: string[] }>({ used: [], found: [] });
  const [busy, setBusy] = useState(false);
  const [accts, setAccts] = useState<Account[]>([]);
  const [account, setAccount] = useState('auto');
  const [machine, setMachine] = useState(initialMachine);
  const [machineList, setMachineList] = useState<{ id: string; name: string; online: boolean; latency?: number; local?: boolean }[]>([]);
  useEffect(() => { fetch('/api/machines').then(r => r.json()).then(setMachineList).catch(() => {}); }, []);
  useEffect(() => { loadAccounts().then(setAccts).catch(() => {}); api.info().then(i => setAgent(i.settings.newTaskDefaultAgent || 'claude')).catch(() => {}); }, []);
  useEffect(() => { setAccount('auto'); }, [agent]);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'recent' | 'browse'>('recent');
  const [br, setBr] = useState<{ path: string; home: string; parent: string | null; git: boolean; dirs: { name: string; git: boolean }[] } | null>(null);
  const [brErr, setBrErr] = useState('');
  const [hidden, setHidden] = useState(false);
  const browse = (path: string, h = hidden) => fetch(`/api/browse?path=${encodeURIComponent(path)}${h ? '&hidden=1' : ''}${machine !== 'local' ? '&machine=' + encodeURIComponent(machine) : ''}`)
    .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error); setBr(j); setBrErr(''); }).catch(e => setBrErr(String(e.message || e)));
  useEffect(() => { setBr(null); if (mode === 'browse') browse('~'); }, [machine]);
  // "/Users/me/code/app" → ~ › code › app, each part clickable
  const crumbs = (path: string, home: string) => {
    const inHome = path === home || path.startsWith(home + '/');
    const rest = (inHome ? path.slice(home.length) : path).split('/').filter(Boolean);
    const out = [{ name: inHome ? '~' : '/', path: inHome ? home : '/' }];
    rest.forEach((n, i) => out.push({ name: n, path: (inHome ? home : '') + '/' + rest.slice(0, i + 1).join('/') }));
    return out;
  };
  const titleRef = useRef<HTMLInputElement>(null);

  const load = () => api.foldersOn(machine).then(f => { setFolders(f); setFolder(x => x && machine === initialMachine ? x : (f.used[0]?.path || f.found[0] || '')); });
  useEffect(() => { load(); }, [machine]);
  useEffect(() => { titleRef.current?.focus(); }, []);

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'new';
  const f = q.trim().toLowerCase();
  const pinned = folders.used.filter(x => x.pinned && (!f || x.path.toLowerCase().includes(f)));
  const used = folders.used.filter(x => !x.pinned && (!f || x.path.toLowerCase().includes(f)));
  const found = folders.found.filter(x => !f || x.toLowerCase().includes(f));
  const typed = (q.startsWith('~') || q.startsWith('/')) && ![...folders.used.map(x => x.path), ...folders.found].includes(q) ? q : '';

  const cmd = useMemo(() => {
    if (agent === 'auto' && account === 'auto') return 'Taskboard chooses an agent and account when the task starts.';
    const cwd = workingCopy === 'folder' ? folder : `${folder}-wt/${slug}-N`;
    return (workingCopy === 'folder' ? '' : workingCopy === 'auto' ? `For a Git repository, create a worktree at ${cwd}; otherwise use ${folder}.\n` : `git -C ${folder} worktree add ${cwd} -b ${branch || 'task/' + slug + '-N'}\n`) +
      `tmux -L taskboard new-session -d -s task-N -c ${cwd} \\\n  -e TASK_ID=… -e TASK_DIR=~/AgentVault/tasks/… \\\n  ${agent === 'auto' ? (accts.find(a => a.id === account)?.agent === 'claude' ? 'claude …' : accts.find(a => a.id === account)?.agent === 'codex' ? 'codex …' : 'agy …') : agent === 'claude' ? 'claude --settings ~/.taskboard/claude-settings.json --session-id <uuid> …' : agent === 'codex' ? 'codex -c notify=[…] …' : 'agy --add-dir ~/AgentVault -i'} "<your prompt>"`;
  }, [folder, workingCopy, branch, slug, agent, account, accts]);

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter(f => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type));
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) { setErr(`${f.name || 'The image'} is larger than 10 MB.`); continue; }
      const r = new FileReader();
      r.onload = () => { const url = String(r.result); setImages(x => x.length >= 10 ? x : [...x, { type: f.type, data: url.slice(url.indexOf(',') + 1), url }]); };
      r.readAsDataURL(f);
    }
  };

  const go = async () => {
    if (!title.trim() || !folder) { setErr('A title and a folder are needed.'); return; }
    setBusy(true); setErr('');
    try {
      const t = await api.create({ title: title.trim(), desc: desc.trim() || title.trim(), agent, folder, worktree: workingCopy === 'auto' ? undefined : workingCopy === 'worktree', branch: workingCopy === 'worktree' ? (branch || undefined) : undefined, account: machine === 'local' ? account : 'auto', machine, group: group || undefined, images: images.length ? images.map(({ type, data }) => ({ type, data })) : undefined, spinOff });
      onStarted(t.id, group, agent === 'auto' ? `${AGENT_NAME[t.agent]} on ${accts.find(a => a.id === t.account)?.name || t.account}` : undefined);
    } catch (e) { setErr(String((e as Error).message || e)); setBusy(false); }
  };
  const row = (path: string, meta: string, pin?: boolean) => (
    <div key={path} className={`fp-item ${path === folder ? 'on' : ''}`} onClick={() => setFolder(path)}>
      <span className={`pin ${pin ? 'on' : ''}`} title={pin ? 'Unpin' : 'Pin'} onClick={e => { e.stopPropagation(); api.pin(path, !pin).then(load); }}>{pin ? '★' : '☆'}</span>
      <span className="p">{path}</span><span className="u">{meta}</span>
    </div>
  );

  return (
    <div className="scrim open" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); if (e.key === 'Escape') onClose(); }}>
      <div className="modal">
        <header><h2>{spinOff ? `New task from Ask #${spinOff.sourceNum}` : 'New task'}</h2><button className="btn ghost icon" onClick={onClose}>✕</button></header>
        <div className="body">
          <div className="field"><label>Title</label><input ref={titleRef} type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Short name shown on the board" /></div>
          <div className="field"><label>Task description · sent to the agent as its first prompt</label><textarea value={desc} readOnly={!!spinOff} onChange={e => setDesc(e.target.value)} onPaste={spinOff ? undefined : onPaste} placeholder="What should the agent do? Paste images with ⌘V." />
            {images.length > 0 && <div className="nt-images">{images.map((im, i) => <div key={i} className="nt-image"><img src={im.url} alt={`Pasted image ${i + 1}`} /><button className="btn ghost icon" title="Remove this image" onClick={() => setImages(x => x.filter((_, j) => j !== i))}>✕</button></div>)}</div>}</div>
          <div className="field"><label>Machine</label><div className="seg mseg">{machineList.map(m => <button key={m.id} disabled={!m.online} className={machine === m.id ? 'on' : ''} onClick={() => setMachine(m.id)}><span className={`mdot ${m.online ? '' : 'off'}`} />{m.name}{m.local ? ' (this Mac)' : m.online ? ` · ${m.latency ?? '?'} ms` : ' · offline'}</button>)}</div>
            {machineList.length <= 1 && <div className="help">Only this Mac is connected. Add another machine with ＋ next to “Machines” in the sidebar.</div>}</div>
          <div className="field"><label htmlFor="new-task-group">Group</label><select id="new-task-group" className="acct-sel" value={group} onChange={e => setGroup(e.target.value)}>
            <option value="">No group</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select></div>
          <div className="field"><label>Start in folder{machine !== 'local' ? ` on ${machineList.find(m => m.id === machine)?.name}` : ''}</label>
            <div className="fp-chosen">{folder ? <><span className="sub">Selected</span> <code>{folder}</code></> : <span className="sub">No folder selected yet</span>}
              <div className="seg" style={{ marginLeft: 'auto' }}><button className={mode === 'recent' ? 'on' : ''} onClick={() => setMode('recent')}>Recent &amp; pinned</button><button className={mode === 'browse' ? 'on' : ''} onClick={() => { setMode('browse'); if (!br) browse(folder || '~'); }}>Browse…</button></div></div>
            {mode === 'browse' ? <div className="fp fb">
              <div className="fb-top">
                <button className="btn" disabled={!br?.parent} onClick={() => br?.parent && browse(br.parent)} title="Parent folder">↑ Up</button>
                <button className="btn" onClick={() => browse('~')} title="Home folder">⌂ Home</button>
                <div className="fb-crumbs">{br && crumbs(br.path, br.home).map(c => <span key={c.path} className="crumb" onClick={() => browse(c.path)}>{c.name}</span>)}</div>
                <label className="opt" style={{ marginLeft: 'auto' }}><input type="checkbox" checked={hidden} onChange={e => { setHidden(e.target.checked); if (br) browse(br.path, e.target.checked); }} /> hidden</label>
              </div>
              {brErr && <div className="banner stopped">{brErr}</div>}
              <div className="fp-list">
                {br && br.dirs.length === 0 && <div className="empty">No subfolders.</div>}
                {br?.dirs.map(d => { const full = br.path.replace(/\/$/, '') + '/' + d.name; return (
                  <div key={d.name} className={`fp-item ${full === folder ? 'on' : ''}`} onClick={() => browse(full)} title="Open this folder">
                    <span className="pin">📁</span><span className="p">{d.name}</span>{d.git && <span className="u">git</span>}
                    <button className="btn fb-use" onClick={e => { e.stopPropagation(); setFolder(full); }}>Choose</button>
                  </div>); })}
              </div>
              {br && <div className="fb-foot"><span className="sub">In <code>{br.path}</code>{br.git ? ' · git repository' : ''}</span><button className="btn primary" onClick={() => setFolder(br.path)}>Use this folder</button></div>}
            </div> :
            <div className="fp">
              <div className="fp-top"><input value={q} onChange={e => { setQ(e.target.value); if (e.target.value.startsWith('~') || e.target.value.startsWith('/')) setFolder(e.target.value); }} placeholder="Filter, or type a path like ~/code/project" /></div>
              <div className="fp-list">
                {typed && <><div className="fp-group">Typed path</div>{row(typed, 'new')}</>}
                {pinned.length > 0 && <><div className="fp-group">Pinned</div>{pinned.map(x => row(x.path, `${x.uses} tasks`, true))}</>}
                {used.length > 0 && <><div className="fp-group">Used before · most used first</div>{used.map(x => row(x.path, `${x.uses} tasks`))}</>}
                {found.length > 0 && <><div className="fp-group">Git repositories found</div>{found.map(x => row(x, 'git'))}</>}
              </div>
            </div>}
          </div>
          <div className="row2">
            <div className="field"><label>Agent</label><div className="seg"><button className={agent === 'auto' ? 'on' : ''} onClick={() => setAgent('auto')}>Auto</button>{AGENTS.map(a => <button key={a} className={agent === a ? 'on' : ''} onClick={() => setAgent(a)}>{AGENT_NAME[a]}</button>)}</div></div>
            <div className="field"><label>Working copy</label>
              <label className="opt"><input type="radio" checked={workingCopy === 'auto'} onChange={() => setWorkingCopy('auto')} /> New worktree for a Git repository</label>
              <label className="opt"><input type="radio" checked={workingCopy === 'folder'} onChange={() => setWorkingCopy('folder')} /> Use the folder as is</label>
              <label className="opt"><input type="radio" checked={workingCopy === 'worktree'} onChange={() => setWorkingCopy('worktree')} /> New git worktree on branch <input type="text" value={branch} placeholder={`task/${slug}-N`} onChange={e => { setBranch(e.target.value); setWorkingCopy('worktree'); }} style={{ width: 160, padding: '3px 6px', font: '11.5px var(--mono)' }} /></label>
            </div>
          </div>
          <div className="field"><label>Account</label>
            <select className="acct-sel" value={account} onChange={e => setAccount(e.target.value)}>
              <option value="auto">Automatic: choose by usage and task capacity</option>
              {accts.filter(a => agent === 'auto' || a.agent === agent).map(a => <option key={a.id} value={a.id} disabled={!a.status.signedIn}>{a.name}{a.status.signedIn ? '' : ' (not signed in)'}{a.limited ? ' · at its limit' : ''} · {a.running} running{usageText(a) ? ' · ' + usageText(a) : ''}</option>)}
            </select>
            <div className="help">Add accounts and sign in on the Accounts page.</div>
          </div>
          <div className="field"><label>What the server will run</label><div className="cmd">{cmd}</div></div>
          {err && <div className="banner stopped">{err}</div>}
        </div>
        <footer><span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Starting…' : <>Start agent <kbd style={{ color: '#cfd9ff', borderColor: '#7b95ea' }}>⌘⏎</kbd></>}</button></footer>
      </div>
    </div>
  );
}
