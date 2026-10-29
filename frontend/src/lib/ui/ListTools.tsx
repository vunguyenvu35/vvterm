import {useEffect, useRef, useState} from 'react'
import {IconSearch, IconSort} from './Icons'
import {ViewMenu, type ViewMode} from '../hosts/ViewMenu'

/** A choice remembered per viewer (a convenience: if storage fails the default is used and nothing breaks). */
export function usePref<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const v = localStorage.getItem(key) as T | null; return v && allowed.includes(v) ? v : fallback } catch { return fallback }
  })
  const set = (v: T) => {
    setValue(v)
    try { localStorage.setItem(key, v) } catch { /* not remembered */ }
  }
  return [value, set]
}

export interface SortOption<T extends string> {value: T; label: string}

/** Sort menu: an icon button that opens a small menu with a check on the current order (like the Grid / List switch). */
export function SortMenu<T extends string>({value, options, onChange}: {value: T; options: SortOption<T>[]; onChange(v: T): void}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc, true) }
  }, [open])
  const current = options.find(o => o.value === value)
  return (
    <span className="add-menu sort-menu" ref={wrap}>
      <button className="icon" aria-label="Sort" aria-haspopup="menu" aria-expanded={open} title={'Sort: ' + (current?.label ?? '')} onClick={() => setOpen(o => !o)}>
        <IconSort size={17} />
      </button>
      {open && (
        <div className="menu-pop right" role="menu" aria-label="Sort">
          {options.map(o => (
            <button key={o.value} role="menuitemradio" aria-checked={value === o.value} onClick={() => { setOpen(false); onChange(o.value) }}>
              <span>{o.label}</span>{value === o.value && <span className="tick" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

interface ToolbarProps<S extends string> {
  /** the accessible name and the hint of the search box, e.g. "snippets" */
  what: string
  query: string
  onQuery(q: string): void
  sort: S
  sortOptions: SortOption<S>[]
  onSort(s: S): void
  view: ViewMode
  onView(v: ViewMode): void
  /** more controls at the left of the bar (filter chips, a New button…) */
  children?: React.ReactNode
}

/** The bar every list page has: search, filters (children), Sort and Grid / List. */
export function ListToolbar<S extends string>(p: ToolbarProps<S>) {
  return (
    <div className="toolbar list-toolbar">
      <div className="search-box small grow">
        <IconSearch size={14} />
        <input aria-label={`Search ${p.what}`} placeholder={`Search ${p.what}`} value={p.query} onChange={e => p.onQuery(e.target.value)} />
      </div>
      {p.children}
      <SortMenu value={p.sort} options={p.sortOptions} onChange={p.onSort} />
      <ViewMenu value={p.view} onChange={p.onView} />
    </div>
  )
}

/** A filter chip that is on or off (the same look as the environment chips of the host list). */
export function FilterChip({label, on, onToggle, dot}: {label: string; on: boolean; onToggle(): void; dot?: string}) {
  return (
    <span role="button" aria-pressed={on} tabIndex={0} className={'chip' + (on ? ' on' : '')} onClick={onToggle} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle())}>
      {dot && <i className={'dot ' + dot} />} {label}
    </span>
  )
}

export const VIEWS = ['grid', 'list'] as const

/** Compare for names: case and accents do not matter, numbers count as numbers ("web-2" before "web-10"). */
export const byName = (a: string, b: string) => a.localeCompare(b, undefined, {sensitivity: 'base', numeric: true})
