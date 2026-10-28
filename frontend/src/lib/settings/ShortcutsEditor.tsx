import {useEffect, useState} from 'react'
import {ACTIONS, ActionDef, FIXED_SHORTCUTS, capture, comboFromEvent, conflictFor, effective, formatCombo, validateCombo} from '../shortcuts/shortcuts'

interface Props {
  /** the user's overrides (action id -> combo) */
  overrides: Record<string, string>
  onChange(next: Record<string, string>): void
}

/**
 * Lists every action with its shortcut. Click a shortcut, press the new keys: the combination is checked
 * (needs a modifier, no duplicates, Escape reserved) before it is saved. Only differences from the
 * defaults are stored, so a later release can change a default for everyone who never customised it.
 */
export function ShortcutsEditor({overrides, onChange}: Props) {
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState('')
  const eff = effective(overrides)
  const groups = Array.from(new Set(ACTIONS.map(a => a.group)))

  const set = (a: ActionDef, combo: string) => {
    const next = {...overrides}
    if (combo === a.default) delete next[a.id]
    else next[a.id] = combo
    onChange(next)
  }

  useEffect(() => {
    if (!recording) return
    capture.active = true
    const action = ACTIONS.find(a => a.id === recording)!
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); setError(''); return }
      const combo = comboFromEvent(e)
      if (!combo) return // only modifiers so far
      const bad = validateCombo(combo)
      if (bad) { setError(bad); return }
      const other = conflictFor(combo, action.id, eff)
      if (other) { setError(`Already used by “${other.label}”. Change that one first.`); return }
      setError('')
      setRecording(null)
      set(action, combo)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); capture.active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides])

  const changed = Object.keys(overrides).filter(id => ACTIONS.some(a => a.id === id && overrides[id] !== a.default))

  return (
    <section className="card-section shortcuts">
      <div className="setting-row">
        <h4>Keyboard shortcuts</h4>
        <button disabled={changed.length === 0} onClick={() => { setRecording(null); setError(''); onChange({}) }}>Reset all</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {groups.map(g => (
        <div key={g} className="sc-group">
          <div className="sc-title">{g}</div>
          {ACTIONS.filter(a => a.group === g).map(a => {
            const isRec = recording === a.id
            const custom = overrides[a.id] && overrides[a.id] !== a.default
            return (
              <div key={a.id} className="sc-row">
                <span>{a.label}</span>
                <span className="sc-keys">
                  {isRec ? (
                    <span className="key-capture" role="status">Press the new shortcut… <small>Esc to cancel</small></span>
                  ) : (
                    <button className={'key-chip' + (custom ? ' custom' : '')} aria-label={`Change shortcut for ${a.label}, now ${formatCombo(eff[a.id])}`}
                      onClick={() => { setError(''); setRecording(a.id) }}>{formatCombo(eff[a.id])}</button>
                  )}
                  {custom && !isRec && <button className="icon ghost" aria-label={`Reset shortcut for ${a.label}`} title={`Default: ${formatCombo(a.default)}`} onClick={() => { set(a, a.default) }}>Reset</button>}
                </span>
              </div>
            )
          })}
        </div>
      ))}
      <div className="sc-group">
        <div className="sc-title">Fixed</div>
        {FIXED_SHORTCUTS.map(f => (
          <div key={f.label} className="sc-row fixed"><span>{f.label}</span><span className="sc-keys"><kbd>{f.keys}</kbd></span></div>
        ))}
      </div>
    </section>
  )
}
