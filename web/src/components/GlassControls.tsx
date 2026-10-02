// The controls of the see-through controller terminal (controllerView.ts): presets, the see-through slider, blur, text
// strength and tint, with the line of the contrast guard. The popover of the controller bar and the Settings page use it.
import { useEffect, useMemo, useState } from 'react';
import {
  BLUR_MAX, GLASS_PRESETS, GLASS_STEP, TEXT_STRENGTHS, TINTS, glassAlpha, glassSetting, onGlassChange, presetOf, readableNote, readableText,
  setGlass, setPreset, type Glass, type Readable, type TextStrength, type Tint,
} from '../controllerView';
import { readColor, type RGBA } from '../terminalTheme';
import { keysText, useKeymap } from '../keys';

// the saved setting, kept up to date with the other controls, the keys and the other windows
export function useGlass(): Glass {
  const [g, setG] = useState(glassSetting);
  useEffect(() => onGlassChange(() => setG(glassSetting())), []);
  return g;
}

// The page colours that can be behind the panel: the backgrounds, and the text colours that can fill a whole letter.
const BEHIND = ['--bg', '--bg2', '--panel', '--text', '--muted'];
// The contrast guard for the current theme. It runs again when the theme changes (the 'tb-theme' event).
export function useReadable(g: Glass): Readable {
  const [theme, setTheme] = useState(0);
  useEffect(() => { const on = () => setTheme(n => n + 1); addEventListener('tb-theme', on); return () => removeEventListener('tb-theme', on); }, []);
  return useMemo(() => {
    const c = (n: string, d: RGBA): RGBA => readColor(n) || d;
    const page = g.tint === 'page';
    const tint = page ? c('--bg', [13, 17, 23, 255]) : c('--term-bg', [10, 12, 15, 255]);
    const fg = page ? c('--text', [230, 237, 243, 255]) : c('--term-fg', [214, 218, 224, 255]);
    const behind = BEHIND.map(n => readColor(n)).filter(Boolean) as RGBA[];
    return readableText(fg, tint, behind.length ? behind : [tint], glassAlpha(g), g.text);
  }, [g.see, g.text, g.tint, theme]);
}

export function GlassControls({ g, r }: { g: Glass; r: Readable }) {
  useKeymap();
  const preset = presetOf(g);
  const note = readableNote(r, g.text, g.see);
  return <div className="glass-ctl">
    <div className="glass-presets" role="group" aria-label="Presets">
      {GLASS_PRESETS.map(p => <button key={p.id} type="button" className={`btn ${preset?.id === p.id ? 'on' : ''}`} aria-pressed={preset?.id === p.id} onClick={() => setPreset(p.id)}
        title={p.see ? `${p.see}% see-through, blur ${p.blur} px` : 'The opaque terminal'}>{p.label}</button>)}
    </div>
    <label className="glass-row"><span>See-through</span>
      <input type="range" min={0} max={100} step={GLASS_STEP} value={g.see} onChange={e => setGlass({ see: Number(e.target.value) })} aria-valuetext={`${g.see}%`} />
      <b>{g.see}%</b></label>
    <label className="glass-row"><span>Blur</span>
      <input type="range" min={0} max={BLUR_MAX} step={1} value={g.blur} onChange={e => setGlass({ blur: Number(e.target.value) })} aria-valuetext={`${g.blur} px`} disabled={!g.see} />
      <b>{g.blur} px</b></label>
    <div className="glass-row"><span>Text</span>
      <select aria-label="Text strength" title="Keeps the text readable over the page: a soft shadow, bold letters or an outline in the tint color" value={g.text} onChange={e => setGlass({ text: e.target.value as TextStrength })}>{TEXT_STRENGTHS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
      <label className="glass-tint" title="The color mixed into the see-through background">Tint <select value={g.tint} onChange={e => setGlass({ tint: e.target.value as Tint })}>{TINTS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label></div>
    {note && <div className={`glass-note ${!r.enough ? 'bad' : r.raised ? 'raised' : ''}`} role="status">{note}</div>}
    <div className="glass-keys">More see-through {keysText('glassMore')} · less {keysText('glassLess')} · on or off {keysText('glassToggle')}</div>
  </div>;
}
