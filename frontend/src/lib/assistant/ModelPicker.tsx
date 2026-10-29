import {KeyboardEvent, useEffect, useLayoutEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import {IconCheck, IconChevronUp} from '../ui/Icons'
import type {AiModelList, AiProvider} from '../types'

interface Props {
  providers: AiProvider[]
  provider: string
  onProvider(id: string): void
  models: AiModelList | null
  model: string
  onModel(id: string): void
  loading: boolean
  onRetry(): void
  disabled?: boolean
}

/**
 * Provider and model, chosen from a menu that opens above the chip under the message box (like other chat apps). The menu
 * is as wide as its text needs (not as wide as the chip), always inside the window, and shows each model's full description.
 */
export function ModelPicker(p: Props) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{left: number; bottom: number; width: number; maxHeight: number}>({left: 8, bottom: 8, width: 320, maxHeight: 360})
  const current = p.models?.models.find(m => m.id === p.model)
  const providerName = p.providers.find(x => x.id === p.provider)?.name ?? ''
  const label = p.loading ? 'Loading models…' : current && current.id !== '' ? current.name || current.id : p.models?.error ? 'Models unavailable' : 'Default'

  const place = () => {
    const r = trigger.current?.getBoundingClientRect()
    if (!r) return
    const margin = 8
    const width = Math.min(360, window.innerWidth - margin * 2)
    setPos({
      width, left: Math.max(margin, Math.min(r.left, window.innerWidth - width - margin)),
      bottom: window.innerHeight - r.top + 6, maxHeight: Math.max(160, r.top - margin - 6),
    })
  }
  useLayoutEffect(() => { if (open) place() }, [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('resize', place) }
  }, [open])
  // focus the chosen model when the menu opens
  useEffect(() => {
    if (open) (menu.current?.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus()
  }, [open, p.loading])

  const close = () => { setOpen(false); trigger.current?.focus() }
  const choose = (id: string) => { p.onModel(id); close() }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    if (items.length === 0) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next].focus()
  }

  return (
    <>
      <button ref={trigger} type="button" className={'ai-chip-picker' + (open ? ' open' : '')} disabled={p.disabled} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`Model: ${label}${providerName ? ', ' + providerName : ''}. Change`} title={providerName ? `${providerName} · ${label}` : label} onClick={() => setOpen(o => !o)}>
        <span className="ai-chip-picker-text">{label}</span>
        <IconChevronUp size={13} />
      </button>
      {open && createPortal(
        <div ref={menu} className="ai-picker-menu" role="dialog" aria-label="Provider and model" style={{left: pos.left, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight}} onKeyDown={onKey}>
          {p.providers.length > 1 && (
            <div className="ai-picker-group">
              <div className="ai-picker-title">Provider</div>
              <div className="ai-picker-providers" role="radiogroup" aria-label="Provider">
                {p.providers.map(x => (
                  <button key={x.id} role="radio" aria-checked={x.id === p.provider} className={x.id === p.provider ? 'on' : ''} onClick={() => p.onProvider(x.id)}>{x.name}</button>
                ))}
              </div>
            </div>
          )}
          <div className="ai-picker-group ai-picker-models">
            <div className="ai-picker-title">Model{providerName ? ` · ${providerName}` : ''}</div>
            {p.loading && <div className="ai-picker-note muted" role="status">Loading the models from the provider…</div>}
            {!p.loading && p.models?.error && (
              <div className="ai-picker-note ai-picker-error" role="status">
                <span>Models could not be loaded: {p.models.error}</span>
                <button onClick={p.onRetry}>Retry</button>
              </div>
            )}
            {!p.loading && p.models && !p.models.can_list && <div className="ai-picker-note muted">{providerName} cannot list its models, so it uses its default one.</div>}
            <div role="listbox" aria-label="Model">
              {(p.models?.models ?? []).map(m => (
                <button key={m.id || 'default'} role="option" aria-selected={m.id === p.model} className="ai-picker-option" onClick={() => choose(m.id)}>
                  <span className="ai-picker-option-text">
                    <b>{m.name || m.id}</b>
                    {m.description && <span className="muted">{m.description}</span>}
                  </span>
                  {m.id === p.model && <IconCheck size={15} />}
                </button>
              ))}
            </div>
          </div>
        </div>, document.body)}
    </>
  )
}
