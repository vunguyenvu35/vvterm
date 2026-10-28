import '@testing-library/jest-dom/vitest'
import {cleanup} from '@testing-library/react'
import {afterEach, vi} from 'vitest'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? RO
window.confirm = () => true

// jsdom has no matchMedia; tests choose the OS appearance through setSystemDark().
let systemDark = true
const listeners = new Set<(e: {matches: boolean}) => void>()
;(globalThis as any).setSystemDark = (v: boolean) => { systemDark = v; listeners.forEach(l => l({matches: v})) }
window.matchMedia = ((q: string) => ({
  get matches() { return q.includes('dark') ? systemDark : !systemDark },
  media: q, onchange: null,
  addEventListener: (_: string, l: any) => listeners.add(l),
  removeEventListener: (_: string, l: any) => listeners.delete(l),
  addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as any

// jsdom has no PointerEvent: give pointer events the coordinates and id components rely on.
if (!(globalThis as any).PointerEvent) {
  ;(globalThis as any).PointerEvent = class PointerEvent extends MouseEvent {
    pointerId: number
    constructor(type: string, init: any = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 }
  }
}

// The test runtime may not give jsdom a usable localStorage: provide a small in-memory one.
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: k => (data.has(k) ? data.get(k)! : null),
    key: i => Array.from(data.keys())[i] ?? null,
    removeItem: k => { data.delete(k) },
    setItem: (k, v) => { data.set(k, String(v)) },
  }
}
try {
  if (typeof window.localStorage?.getItem !== 'function') throw new Error('no storage')
} catch {
  Object.defineProperty(window, 'localStorage', {value: memoryStorage(), configurable: true})
  Object.defineProperty(globalThis, 'localStorage', {value: window.localStorage, configurable: true})
}
