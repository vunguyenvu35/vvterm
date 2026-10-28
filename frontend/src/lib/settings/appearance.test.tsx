import {act, renderHook} from '@testing-library/react'
import {useAppearance} from './appearance'

declare const setSystemDark: (v: boolean) => void

describe('useAppearance', () => {
  afterEach(() => act(() => setSystemDark(true)))

  it('an explicit mode ignores the OS', () => {
    act(() => setSystemDark(false))
    expect(renderHook(() => useAppearance('dark')).result.current).toBe('dark')
    expect(renderHook(() => useAppearance('light')).result.current).toBe('light')
  })

  it('auto follows the OS and reacts when it changes', () => {
    act(() => setSystemDark(true))
    const {result} = renderHook(() => useAppearance('auto'))
    expect(result.current).toBe('dark')
    act(() => setSystemDark(false))
    expect(result.current).toBe('light')
    act(() => setSystemDark(true))
    expect(result.current).toBe('dark')
  })

  it('switching from auto to explicit stops following the OS', () => {
    const {result, rerender} = renderHook(({m}) => useAppearance(m), {initialProps: {m: 'auto' as 'auto' | 'light'}})
    rerender({m: 'light'})
    act(() => setSystemDark(true))
    expect(result.current).toBe('light')
  })
})
