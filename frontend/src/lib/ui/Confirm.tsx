import {createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState} from 'react'

interface Options {
  confirmLabel?: string
  /** a destructive action: the confirm button is red */
  danger?: boolean
}
type Ask = (message: string, options?: Options) => Promise<boolean>

interface Request extends Required<Options> {
  message: string
  resolve(answer: boolean): void
}

/**
 * Without a provider (unit tests of single components) it falls back to the browser's confirm(). The app
 * always has a provider: the WKWebView window of a desktop app does not show confirm() at all and answers
 * "no", which silently disabled every action that asks first.
 */
const Ctx = createContext<Ask>(async message => window.confirm(message))
export const useConfirm = () => useContext(Ctx)

/** An in-app confirmation dialog: Enter confirms, Esc or a click outside cancels. */
export function ConfirmProvider({children}: {children: ReactNode}) {
  const [req, setReq] = useState<Request | null>(null)
  const current = useRef<Request | null>(null)
  current.current = req
  const okRef = useRef<HTMLButtonElement>(null)

  const ask = useCallback<Ask>((message, options = {}) => new Promise<boolean>(resolve => {
    current.current?.resolve(false) // a newer question replaces an unanswered one
    setReq({message, confirmLabel: options.confirmLabel ?? 'OK', danger: !!options.danger, resolve})
  }), [])

  const answer = useCallback((value: boolean) => {
    current.current?.resolve(value)
    setReq(null)
  }, [])

  useEffect(() => {
    if (!req) return
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      e.preventDefault()
      e.stopImmediatePropagation() // the panels and windows underneath must not also react to this key
      answer(e.key === 'Enter')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req, answer])

  return (
    <Ctx.Provider value={ask}>
      {children}
      {req && (
        <div className="modal-back confirm-back" role="presentation" onMouseDown={e => e.target === e.currentTarget && answer(false)}>
          <div className="modal confirm" role="alertdialog" aria-modal="true" aria-label="Confirm" aria-describedby="confirm-msg">
            <div className="modal-body"><p id="confirm-msg" className="confirm-msg">{req.message}</p></div>
            <div className="modal-foot">
              <button onClick={() => answer(false)}>Cancel</button>
              <button ref={okRef} className={req.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>{req.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}
