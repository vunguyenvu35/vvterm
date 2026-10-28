import {KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {createPortal} from 'react-dom'

export interface SelectOption {
  value: string
  label: string
  /** secondary text shown under the label */
  hint?: string
  disabled?: boolean
}

interface Props {
  /** accessible name; also the name of the hidden native <select> kept in sync (forms, tests, autofill) */
  label: string
  value: string
  onChange(value: string): void
  options: SelectOption[]
  placeholder?: string
  className?: string
  disabled?: boolean
}

/**
 * Custom dropdown replacing the native macOS popup. Keyboard: Arrow keys / Home / End move, Enter or
 * Space select, Esc closes, typing jumps to a matching option. The menu is portaled and positioned
 * with fixed coordinates so scrolling containers (side panels) never clip it, and it flips upward
 * when there is no room below.
 */
export function Select({label, value, onChange, options, placeholder, className = '', disabled}: Props) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const typed = useRef({text: '', at: 0})
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{left: number; width: number; top?: number; bottom?: number; maxHeight: number}>({left: 0, width: 0, maxHeight: 280})

  const current = useMemo(() => options.find(o => o.value === value), [options, value])
  const enabled = useMemo(() => options.map((o, i) => (o.disabled ? -1 : i)).filter(i => i >= 0), [options])

  const openMenu = () => {
    if (disabled) return
    const sel = options.findIndex(o => o.value === value)
    setActive(sel >= 0 && !options[sel].disabled ? sel : (enabled[0] ?? 0))
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }
  const choose = (i: number) => {
    const o = options[i]
    if (!o || o.disabled) return
    if (o.value !== value) onChange(o.value)
    close()
  }

  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const r = trigger.current.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    const up = below < 180 && above > below
    setPos({
      left: r.left, width: Math.max(r.width, 200),
      ...(up ? {bottom: window.innerHeight - r.top + 6} : {top: r.bottom + 6}),
      maxHeight: Math.max(120, Math.min(300, up ? above : below)),
    })
    menu.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false)
    }
    const away = () => setOpen(false)
    document.addEventListener('mousedown', outside)
    window.addEventListener('resize', away)
    window.addEventListener('blur', away)
    return () => {
      document.removeEventListener('mousedown', outside)
      window.removeEventListener('resize', away)
      window.removeEventListener('blur', away)
    }
  }, [open])

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView?.({block: 'nearest'})
  }, [open, active, id])

  const move = (dir: 1 | -1) => {
    const at = enabled.indexOf(active)
    const next = enabled[Math.max(0, Math.min(enabled.length - 1, (at < 0 ? 0 : at) + dir))]
    if (next !== undefined) setActive(next)
  }

  const onTriggerKey = (e: KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openMenu() }
  }

  const onMenuKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break
      case 'ArrowUp': e.preventDefault(); move(-1); break
      case 'Home': e.preventDefault(); setActive(enabled[0] ?? 0); break
      case 'End': e.preventDefault(); setActive(enabled[enabled.length - 1] ?? 0); break
      case 'Enter': case ' ': e.preventDefault(); choose(active); break
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break // do not also close a panel behind
      case 'Tab': close(false); break
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          const now = Date.now()
          typed.current.text = (now - typed.current.at > 600 ? '' : typed.current.text) + e.key.toLowerCase()
          typed.current.at = now
          const hit = enabled.find(i => options[i].label.toLowerCase().startsWith(typed.current.text))
          if (hit !== undefined) setActive(hit)
        }
    }
  }

  return (
    <div className={'select-wrap ' + className}>
      <button ref={trigger} type="button" className={'select-trigger' + (open ? ' open' : '')} role="combobox" disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={`${label}, ${current?.label ?? placeholder ?? 'none'}`}
        onClick={() => (open ? close(false) : openMenu())} onKeyDown={onTriggerKey}>
        <span className={'select-value' + (current ? '' : ' placeholder')}>{current?.label ?? placeholder ?? ''}</span>
        <svg className="select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {/* hidden native control: same value, so labels, form autofill and tests keep working */}
      <select className="select-native" aria-label={label} aria-hidden="true" tabIndex={-1} disabled={disabled} value={value} onChange={e => onChange(e.target.value)}>
        {!current && <option value={value}>{placeholder ?? ''}</option>}
        {options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
      {open && createPortal(
        <div ref={menu} id={id} className="select-menu" role="listbox" aria-label={label} tabIndex={-1}
          aria-activedescendant={`${id}-${active}`} onKeyDown={onMenuKey}
          style={{left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight}}>
          {options.map((o, i) => (
            <div key={o.value} id={`${id}-${i}`} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
              className={'select-option' + (i === active ? ' active' : '') + (o.value === value ? ' selected' : '') + (o.disabled ? ' disabled' : '')}
              onMouseMove={() => !o.disabled && setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => choose(i)}>
              <span className="opt-text">{o.label}{o.hint && <small>{o.hint}</small>}</span>
              {o.value === value && (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>
              )}
            </div>
          ))}
        </div>, document.body)}
    </div>
  )
}
