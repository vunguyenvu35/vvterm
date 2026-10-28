import {ReactNode, useEffect} from 'react'

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
          <button className="ghost icon" aria-label="Close" onClick={props.onClose}>✕</button>
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
