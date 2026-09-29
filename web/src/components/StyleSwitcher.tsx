// Style menu in the top bar. Hovering a style previews it; clicking keeps it; ⌃⌥Y (keys.ts: nextStyle) cycles.
import { useEffect, useState } from 'react';
import { THEMES, applyTheme, currentTheme } from '../themes';
import { hit, keyLabel, useKeymap } from '../keys';

const Swatch = ({ c }: { c: readonly string[] }) => <span className="tbs-sw">{c.map((x, i) => <i key={i} style={{ background: x }} />)}</span>;

export function StyleSwitcher() {
  const [cur, setCur] = useState(currentTheme());
  const [open, setOpen] = useState(false);
  useKeymap();
  const t = THEMES.find(x => x.id === cur) || THEMES[0];

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (hit(e, 'nextStyle')) {
        e.preventDefault(); e.stopPropagation();
        const i = THEMES.findIndex(x => x.id === currentTheme());
        const next = THEMES[(i + 1) % THEMES.length].id; applyTheme(next); setCur(next);
      }
    };
    addEventListener('keydown', on, true); return () => removeEventListener('keydown', on, true);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.tbs')) { setOpen(false); applyTheme(cur, false); } };
    addEventListener('mousedown', close); return () => removeEventListener('mousedown', close);
  }, [open, cur]);

  return (
    <div className={`tbs ${open ? 'open' : ''}`}>
      <button className="tbs-btn" onClick={() => setOpen(o => !o)} title="Change the visual style (⌃⌥Y cycles)"><span className="tbs-lbl">Style</span><Swatch c={t.c} /><b>{t.name}</b><span className="tbs-car">▾</span></button>
      {open && <div className="tbs-menu" onMouseLeave={() => applyTheme(cur, false)} onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); applyTheme(cur, false); } }}>
        {(['Dark', 'Light'] as const).map(g => <div key={g}>
          <div className="tbs-h">{g}</div>
          {THEMES.filter(x => x.group === g).map(x => (
            <button key={x.id} className={`tbs-i ${x.id === cur ? 'on' : ''}`} onMouseEnter={() => applyTheme(x.id, false)} onFocus={() => applyTheme(x.id, false)} onClick={() => { applyTheme(x.id); setCur(x.id); setOpen(false); }}>
              <Swatch c={x.c} /><span className="tbs-n">{x.name}{x.id === cur && <em>✓ in use</em>}</span><span className="tbs-d">{x.desc}</span>
            </button>
          ))}
        </div>)}
        <div className="tbs-f"><span>Hover to preview · click to keep</span>{keyLabel('nextStyle') && <span><kbd>{keyLabel('nextStyle')}</kbd> next style</span>}</div>
      </div>}
    </div>
  );
}
