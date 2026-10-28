import {useEffect, useRef, useState} from 'react'
import type {Snippet} from '../types'
import {IconBraces, IconEnterKey} from '../ui/Icons'

/** Dropdown in the title bar: pick a snippet and type it into the focused pane without leaving the terminal. */
export function SnippetPicker({snippets, disabled, onRun}: {snippets: Snippet[]; disabled: boolean; onRun(s: Snippet, execute: boolean): void}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div className="snippet-picker" ref={box}>
      <button className="icon" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-label="Run snippet" title="Snippets" onClick={() => setOpen(o => !o)}>
        <IconBraces /> <span className="picker-label">Snippets</span>
      </button>
      {open && (
        <div className="picker-menu" role="menu" aria-label="Snippets">
          {snippets.length === 0 && <div className="muted picker-empty">No snippets yet</div>}
          {snippets.map(s => (
            <div key={s.id} className="picker-item" role="menuitem">
              <button className="link-row" onClick={() => { onRun(s, true); setOpen(false) }} title={s.script}>
                <b>{s.label}</b>
                <span className="muted">{s.description || s.script.split('\n')[0]}</span>
              </button>
              <button className="icon ghost" aria-label={`Paste ${s.label} without Enter`} title="Paste without pressing Enter" onClick={() => { onRun(s, false); setOpen(false) }}><IconEnterKey size={15} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
