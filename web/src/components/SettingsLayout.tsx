// The frame of the Settings page: a side list of sections with a search box, and the section, group and item
// wrappers. The wrappers hide what the search does not match with the hidden attribute, so the hidden settings
// keep their unsaved text. Without a SettingsFilter provider (ControllerBox on the Accounts page) an item shows
// its children with no wrapper.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SettingsFilter } from '../settingsIndex';
import { SECTIONS } from '../settingsIndex';

const FilterContext = createContext<SettingsFilter | null>(null);
export const SettingsFilterProvider = FilterContext.Provider;
export const useSettingsFilter = () => useContext(FilterContext);

export const sectionAnchor = (id: string) => `set-${id}`;

export function SettingItem({ id, children }: { id: string; children: ReactNode }) {
  const f = useSettingsFilter();
  if (!f) return <>{children}</>;
  return <div className="set-item" data-setting={id} hidden={!f.shows(id)}>{children}</div>;
}

// A group of settings under one heading. `bare` groups hold components that draw their own boxes.
export function SettingGroup({ section, id, title, help, bare, children }: { section: string; id: string; title?: string; help?: ReactNode; bare?: boolean; children: ReactNode }) {
  const f = useSettingsFilter();
  return <div className="set-group" hidden={!!f && !f.groupShows(section, id)}>
    {title && <h4 className="set-h">{title}</h4>}
    {help && <p className="sub set-help">{help}</p>}
    {bare ? children : <div className="ctl-box set-card">{children}</div>}
  </div>;
}

export function SettingSection({ id, children }: { id: string; children?: ReactNode }) {
  const f = useSettingsFilter();
  const def = SECTIONS.find(s => s.id === id)!;
  return <section className="set-sec" id={sectionAnchor(id)} aria-labelledby={`${sectionAnchor(id)}-h`} hidden={!!f && f.count(id) === 0}>
    <h3 id={`${sectionAnchor(id)}-h`}>{def.title}</h3>
    <p className="sub set-help">{def.help}</p>
    {children}
  </section>;
}

// The section that #settings:<id> names, or null.
export const hashSection = () => { const m = /^#settings:(.+)$/.exec(decodeURIComponent(location.hash)); return m && SECTIONS.some(s => s.id === m[1]) ? m[1] : null; };

const scrollParent = (el: HTMLElement | null): HTMLElement | null => {
  for (let e = el?.parentElement; e; e = e.parentElement) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e;
  return null;
};

// The side list: the search box and a link to each section that has a visible setting. The link of the section at the
// top of the scrolled area is marked. A click scrolls to the section and puts #settings:<id> in the address.
export function SettingsNav({ query, setQuery, filter, pageRef }: { query: string; setQuery: (q: string) => void; filter: SettingsFilter; pageRef: React.RefObject<HTMLDivElement | null> }) {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  const search = useRef<HTMLInputElement>(null);
  const visible = SECTIONS.filter(s => filter.count(s.id) > 0);
  useEffect(() => {
    const box = scrollParent(pageRef.current);
    if (!box) return;
    const on = () => {
      const top = box.getBoundingClientRect().top;
      let current = visible[0]?.id || SECTIONS[0].id;
      for (const s of visible) { const el = document.getElementById(sectionAnchor(s.id)); if (el && el.getBoundingClientRect().top - top <= 40) current = s.id; }
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4 && visible.length) current = visible[visible.length - 1].id;
      setActive(current);
    };
    on();
    box.addEventListener('scroll', on, { passive: true });
    return () => box.removeEventListener('scroll', on);
  }, [filter.query, pageRef]);
  const go = (id: string) => {
    document.getElementById(sectionAnchor(id))?.scrollIntoView({ block: 'start' });
    history.replaceState(null, '', `#settings:${id}`);
    setActive(id);
  };
  return <aside className="set-nav" aria-label="Settings sections">
    <input ref={search} className="set-search" type="search" aria-label="Find a setting" placeholder="Find a setting" value={query}
      onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }} />
    {filter.query.trim() && <div className="sub set-count" role="status">{filter.total === 0 ? 'No setting matches.' : `${filter.total} ${filter.total === 1 ? 'setting matches' : 'settings match'}.`}</div>}
    <nav>{visible.map(s => <a key={s.id} href={`#settings:${s.id}`} className={active === s.id ? 'on' : ''} aria-current={active === s.id ? 'location' : undefined}
      onClick={e => { e.preventDefault(); go(s.id); }}>{s.title}{filter.query.trim() && <span className="n">{filter.count(s.id)}</span>}</a>)}</nav>
  </aside>;
}
