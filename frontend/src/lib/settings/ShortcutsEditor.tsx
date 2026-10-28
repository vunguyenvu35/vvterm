import {useEffect, useState} from 'react'
import {ACTIONS, ActionDef, FIXED_SHORTCUTS, capture, comboFromEvent, conflictFor, defaultOf, effective, formatCombo, validateCombo} from '../shortcuts/shortcuts'
import {KeyCombo} from '../shortcuts/KeyCombo'

/** after the first step is pressed, how long to wait for a second one before it is kept as a one-step shortcut */
export const CHORD_WAIT_MS = 1200

interface Props {
  /** the user's overrides (action id -> combo) */
  overrides: Record<string, string>
  onChange(next: Record<string, string>): void
}

/**
 * Lists every action with its shortcut. Click a shortcut, press the new keys: the combination is checked
 * (needs a modifier, no duplicates, Escape reserved) before it is saved. Press a second key shortly after the
 * first to make a two-step shortcut (⌘K, then M); wait, and it stays a one-step shortcut. Only differences from the
 * defaults are stored, so a later release can change a default for everyone who never customised it.
 */
export function ShortcutsEditor({overrides, onChange}: Props) {
  const [recording, setRecording] = useState<string | null>(null)
  /** the first step of a shortcut being recorded, while a second one may still come */
  const [first, setFirst] = useState('')
  const [error, setError] = useState('')
  const eff = effective(overrides)
  const groups = Array.from(new Set(ACTIONS.map(a => a.group)))

  const set = (a: ActionDef, combo: string) => {
    const next = {...overrides}
    if (combo === defaultOf(a)) delete next[a.id]
    else next[a.id] = combo
    onChange(next)
  }

  useEffect(() => {
    if (!recording) return
    capture.active = true
    const action = ACTIONS.find(a => a.id === recording)!
    let step1 = ''
    let timer = 0
    const finish = (combo: string) => {
      window.clearTimeout(timer)
      setError('')
      setFirst('')
      setRecording(null)
      set(action, combo)
    }
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { window.clearTimeout(timer); setFirst(''); setRecording(null); setError(''); return }
      const combo = comboFromEvent(e)
      if (!combo) return // only modifiers so far
      if (step1) { // the second step: any key, a modifier is not needed
        const whole = step1 + ' ' + combo
        const bad = validateCombo(whole)
        if (bad) { setError(bad); return }
        const other = conflictFor(whole, action.id, eff)
        if (other) { window.clearTimeout(timer); step1 = ''; setFirst(''); setError(`Already used by “${other.label}”. Change that one first.`); return }
        return finish(whole)
      }
      const bad = validateCombo(combo)
      if (bad) { setError(bad); return }
      const other = conflictFor(combo, action.id, eff)
      if (other) { setError(`Already used by “${other.label}”. Change that one first.`); return }
      setError('')
      step1 = combo
      setFirst(combo)
      // no second key soon: it is a one-step shortcut
      timer = window.setTimeout(() => finish(combo), CHORD_WAIT_MS)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', onKey, true); capture.active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides])

  const changed = Object.keys(overrides).filter(id => ACTIONS.some(a => a.id === id && overrides[id] !== defaultOf(a)))

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
            const custom = overrides[a.id] && overrides[a.id] !== defaultOf(a)
            return (
              <div key={a.id} className="sc-row">
                <span>{a.label}</span>
                <span className="sc-keys">
                  {isRec ? (
                    <span className="key-capture" role="status">
                      {first ? <>{formatCombo(first)}, then press another key… <small>or wait to keep it as it is</small></> : <>Press the new shortcut… <small>Esc to cancel</small></>}
                    </span>
                  ) : (
                    <button className={'key-chip' + (custom ? ' custom' : '')} aria-label={`Change shortcut for ${a.label}, now ${formatCombo(eff[a.id])}`}
                      onClick={() => { setError(''); setFirst(''); setRecording(a.id) }}><KeyCombo combo={eff[a.id]} /></button>
                  )}
                  {custom && !isRec && <button className="icon ghost" aria-label={`Reset shortcut for ${a.label}`} title={`Default: ${formatCombo(defaultOf(a))}`} onClick={() => { set(a, defaultOf(a)) }}>Reset</button>}
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
