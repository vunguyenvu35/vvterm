import {ReactNode, useEffect} from 'react'
import {IconClose} from './Icons'

export function Modal(props: {title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [props.onClose])
  return (
    <div className="modal-back" role="presentation" onMouseDown={e => e.target === e.currentTarget && props.onClose()}>
      <div className={'modal' + (props.wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="modal-head">
          <span>{props.title}</span>
          <button className="ghost icon" aria-label="Close" onClick={props.onClose}><IconClose size={16} /></button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function Field(props: {label: string; children: ReactNode}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  )
}

/**
 * Right-docked panel (Termius-style) for creating/editing things without leaving the page.
 * Same contract as Modal: role="dialog", Escape closes.
 */
export function SidePanel(props: {title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [props.onClose])
  return (
    <aside className={'side-panel' + (props.wide ? ' wide' : '')} role="dialog" aria-label={props.title}>
      <div className="side-head">
        <span>{props.title}</span>
        <button className="ghost icon" aria-label="Close" onClick={props.onClose}><IconClose size={16} /></button>
      </div>
      <div className="side-body">{props.children}</div>
      {props.footer && <div className="side-foot">{props.footer}</div>}
    </aside>
  )
}

/** A titled card section inside a SidePanel. */
export function Section(props: {title?: string; children: ReactNode}) {
  return (
    <section className="card-section">
      {props.title && <h4>{props.title}</h4>}
      {props.children}
    </section>
  )
}
