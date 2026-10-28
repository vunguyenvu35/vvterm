import {useState} from 'react'
import {TERMINAL_THEMES, TermTheme, resolveTerminalTheme} from '../terminal/themes'
import type {Appearance} from './appearance'

/** Mini terminal drawn with a theme's colours (two prompt lines and a row of accents). */
export function ThemeSwatch({t}: {t: TermTheme['theme']}) {
  const bar = (color: string, w: string) => <i style={{background: color, width: w}} />
  return (
    <span className="swatch" aria-hidden="true" style={{background: t.background, borderColor: t.selectionBackground}}>
      <span className="row1">{bar(t.green!, '70%')}</span>
      <span className="row2" style={{background: t.selectionBackground}}>{bar(t.foreground!, '40%')}{bar(t.foreground!, '24%')}</span>
      <span className="row3">{bar(t.green!, '22%')}{bar(t.blue!, '18%')}{bar(t.red!, '12%')}{bar(t.yellow!, '8%')}</span>
    </span>
  )
}

/** Two-column catalogue of terminal themes with live swatches; "Match app" follows light/dark. */
export function ThemePicker({value, appearance, onChange}: {value: string; appearance: Appearance; onChange(id: string): void}) {
  const [filter, setFilter] = useState<'all' | 'dark' | 'light'>('all')
  const auto = resolveTerminalTheme('auto', appearance) // what "match app" resolves to right now
  const list = TERMINAL_THEMES.filter(t => filter === 'all' || (filter === 'dark') === t.dark)

  return (
    <div>
      <div className="chips" role="group" aria-label="Theme filter">
        {(['all', 'dark', 'light'] as const).map(f => (
          <span key={f} role="button" tabIndex={0} aria-pressed={filter === f} className={'chip' + (filter === f ? ' on' : '')}
            onClick={() => setFilter(f)} onKeyDown={e => e.key === 'Enter' && setFilter(f)}>{f === 'all' ? 'All' : f === 'dark' ? 'Dark' : 'Light'}</span>
        ))}
      </div>
      <div className="theme-grid" role="radiogroup" aria-label="Terminal theme">
        <button role="radio" aria-checked={value === 'auto'} className={'theme-item' + (value === 'auto' ? ' on' : '')} onClick={() => onChange('auto')}>
          <ThemeSwatch t={auto.theme} />
          <span className="tname">Match app theme<small>{auto.name}</small></span>
        </button>
        {list.map(t => (
          <button key={t.id} role="radio" aria-checked={value === t.id} aria-label={t.name} className={'theme-item' + (value === t.id ? ' on' : '')} onClick={() => onChange(t.id)}>
            <ThemeSwatch t={t.theme} />
            <span className="tname">{t.name}<small>{t.dark ? 'dark' : 'light'}</small></span>
          </button>
        ))}
      </div>
    </div>
  )
}
