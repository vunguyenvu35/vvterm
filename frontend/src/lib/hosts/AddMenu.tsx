import {useEffect, useRef, useState} from 'react'
import {IconChevron, IconData, IconFolderPlus} from '../ui/Icons'

/**
 * The caret next to "New host": other ways to add hosts. New group, and Import (an ~/.ssh/config, a backup,
 * a JSON file), which opens the Import / Export panel. Keyboard: Enter or Space opens, arrows move, Esc closes.
 */
export function AddMenu({onGroup, onImport}: {onGroup(): void; onImport(): void}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, true)
    wrap.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc, true) }
  }, [open])

  const pick = (fn: () => void) => () => { setOpen(false); fn() }
  const move = (e: React.KeyboardEvent) => {
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus() }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
  }

  return (
    <span className="add-menu" ref={wrap}>
      <button className="split-caret" aria-label="More ways to add hosts" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <IconChevron size={14} />
      </button>
      {open && (
        <div className="menu-pop" role="menu" aria-label="Add" onKeyDown={move}>
          <button role="menuitem" onClick={pick(onGroup)}><IconFolderPlus size={16} /> New group</button>
          <button role="menuitem" onClick={pick(onImport)}><IconData size={16} /> Import</button>
        </div>
      )}
    </span>
  )
}
