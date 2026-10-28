import {createContext, ReactNode, useCallback, useContext, useRef, useState} from 'react'

interface ToastApi {
  info(msg: string): void
  error(msg: string): void
}

const Ctx = createContext<ToastApi>({info() {}, error() {}})
export const useToast = () => useContext(Ctx)

export function ToastProvider({children}: {children: ReactNode}) {
  const [t, setT] = useState<{msg: string; err: boolean} | null>(null)
  const timer = useRef<number>()
  const show = useCallback((msg: string, err: boolean) => {
    setT({msg, err})
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setT(null), err ? 7000 : 3500)
  }, [])
  const api: ToastApi = {info: m => show(m, false), error: m => show(m, true)}
  return (
    <Ctx.Provider value={api}>
      {children}
      {t && <div role="status" className={'toast' + (t.err ? ' err' : '')}>{t.msg}</div>}
    </Ctx.Provider>
  )
}
