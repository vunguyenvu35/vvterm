import {installSecureInputGuard} from './secureInput'

describe('installSecureInputGuard', () => {
  let off: () => void
  let active = true
  beforeEach(() => {
    vi.useFakeTimers()
    active = true
    document.body.innerHTML = '<form><input id="pw" type="password"><input id="other" type="text"><button id="btn">OK</button><p id="empty">text</p></form>'
    off = installSecureInputGuard(document, () => active)
  })
  afterEach(() => { off(); vi.useRealTimers(); document.body.innerHTML = '' })
  const sink = () => document.querySelector('[data-secure-input-sink]') as HTMLInputElement | null
  const pw = () => document.getElementById('pw') as HTMLInputElement
  const settle = () => vi.advanceTimersByTime(5)

  it('puts the focus on a hidden read-only text field when the password field loses it to nothing (a click on empty space)', () => {
    pw().focus()
    pw().blur()
    settle()
    expect(document.activeElement).toBe(sink())
    expect(sink()!.readOnly).toBe(true)
    expect(sink()!.getAttribute('aria-hidden')).toBe('true')
    expect(sink()!.type).toBe('text') // a text field: that is what makes WebKit release secure input
  })

  it('does nothing when the focus goes to another element', () => {
    pw().focus()
    document.getElementById('other')!.focus()
    settle()
    expect(document.activeElement?.id).toBe('other')
    pw().focus()
    document.getElementById('btn')!.focus()
    settle()
    expect(document.activeElement?.id).toBe('btn')
  })

  it('does nothing for other fields, and nothing while the window is not the active one (the field gets its focus back with the window)', () => {
    const other = document.getElementById('other') as HTMLInputElement
    other.focus(); other.blur(); settle()
    expect(document.activeElement).toBe(document.body)
    active = false
    pw().focus(); pw().blur(); settle()
    expect(document.activeElement).toBe(document.body)
  })

  it('does not take the focus back from something that took it in the meantime', () => {
    pw().focus()
    pw().blur()
    document.getElementById('other')!.focus() // before the timer runs
    settle()
    expect(document.activeElement?.id).toBe('other')
  })

  it('removes itself and its field when switched off', () => {
    off()
    expect(sink()).toBeNull()
    pw().focus(); pw().blur(); settle()
    expect(document.activeElement).toBe(document.body)
    off = installSecureInputGuard(document, () => active)
  })
})
