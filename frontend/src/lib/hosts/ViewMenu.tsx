import {useEffect, useRef, useState} from 'react'
import {IconGrid, IconList} from '../ui/Icons'

export type ViewMode = 'grid' | 'list'
const KEY = 'vvterm.hostsView'

/** The remembered view (a per-viewer convenience: any failure of storage means "grid"). */
export function loadView(): ViewMode {
  try { return localStorage.getItem(KEY) === 'list' ? 'list' : 'grid' } catch { return 'grid' }
}
export function saveView(v: ViewMode) {
  try { localStorage.setItem(KEY, v) } catch { /* private window: it just will not be remembered */ }
}

/** Grid / List switch of the host list: an icon button that opens a small menu with a check on the current view. */
export function ViewMenu({value, onChange}: {value: ViewMode; onChange(v: ViewMode): void}) {
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

  const item = (v: ViewMode, label: string, icon: JSX.Element) => (
    <button role="menuitemradio" aria-checked={value === v} onClick={() => { setOpen(false); onChange(v) }}>
      {icon} <span>{label}</span>{value === v && <span className="tick" aria-hidden="true">✓</span>}
    </button>
  )
  return (
    <span className="add-menu view-menu" ref={wrap}>
      <button className="icon" aria-label="View" aria-haspopup="menu" aria-expanded={open} title={value === 'grid' ? 'Grid view' : 'List view'} onClick={() => setOpen(o => !o)}>
        {value === 'grid' ? <IconGrid size={17} /> : <IconList size={17} />}
      </button>
      {open && (
        <div className="menu-pop right" role="menu" aria-label="View">
          {item('grid', 'Grid', <IconGrid size={16} />)}
          {item('list', 'List', <IconList size={16} />)}
        </div>
      )}
    </span>
  )
}
