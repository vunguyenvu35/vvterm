import {useEffect, useRef, useState} from 'react'
import {IconSearch, IconTag} from '../ui/Icons'

interface Props {
  /** every tag any host has */
  tags: string[]
  selected: string[]
  onChange(tags: string[]): void
}

/**
 * The tag filter of the host list: an icon that opens a list of tags to tick (a search box when there are many) and
 * "Clear selection". Hosts that have any of the ticked tags stay.
 */
export function TagMenu({tags, selected, onChange}: Props) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const wrap = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc, true) }
  }, [open])

  const shown = tags.filter(t => t.toLowerCase().includes(q.trim().toLowerCase()))
  const toggle = (t: string) => onChange(selected.includes(t) ? selected.filter(x => x !== t) : [...selected, t])
  return (
    <span className="add-menu tag-menu" ref={wrap}>
      <button className={'icon' + (selected.length ? ' on' : '')} aria-label="Filter by tag" aria-haspopup="dialog" aria-expanded={open}
        title={selected.length ? 'Tags: ' + selected.join(', ') : 'Filter by tag'} onClick={() => setOpen(o => !o)}>
        <IconTag size={17} />{selected.length > 0 && <span className="tag-count" aria-hidden="true">{selected.length}</span>}
      </button>
      {open && (
        <div className="menu-pop right tag-pop" role="dialog" aria-label="Filter by tag">
          <label className="side-search">
            <IconSearch size={15} />
            <input aria-label="Search tags" placeholder="Search tags" value={q} autoFocus onChange={e => setQ(e.target.value)} />
          </label>
          <div className="tag-list" role="group" aria-label="Tags">
            {shown.map(t => (
              <button key={t} role="checkbox" aria-checked={selected.includes(t)} className={'tag-row' + (selected.includes(t) ? ' on' : '')} onClick={() => toggle(t)}>
                <i className="tag-radio" aria-hidden="true" /> <span>{t}</span>
              </button>
            ))}
            {shown.length === 0 && <div className="side-empty">{tags.length ? 'No tags match.' : 'No tags yet. Add some when you edit a host.'}</div>}
          </div>
          <button className="tag-clear" disabled={selected.length === 0} onClick={() => onChange([])}>Clear selection</button>
        </div>
      )}
    </span>
  )
}
