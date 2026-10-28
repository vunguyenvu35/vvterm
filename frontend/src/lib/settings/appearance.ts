import {useEffect, useState} from 'react'
import type {ThemeMode} from '../types'

export type Appearance = 'light' | 'dark'

const query = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null)

/** The appearance to apply: an explicit choice, or the OS preference (kept live) for "auto". */
export function useAppearance(mode: ThemeMode): Appearance {
  const [systemDark, setSystemDark] = useState(() => query()?.matches ?? true)
  useEffect(() => {
    const q = query()
    if (!q || mode !== 'auto') return
    setSystemDark(q.matches)
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [mode])
  if (mode === 'auto') return systemDark ? 'dark' : 'light'
  return mode
}
