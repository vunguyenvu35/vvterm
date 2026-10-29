import {imeColours} from './TerminalPane'

describe('text composed with an input method', () => {
  it('is shown at the cursor with the theme colours inverted: foreground as background and the other way round', () => {
    const el = document.createElement('div')
    imeColours(el, {foreground: '#3ecf8e', background: '#0f1117'})
    expect(el.style.getPropertyValue('--ime-bg')).toBe('#3ecf8e')
    expect(el.style.getPropertyValue('--ime-fg')).toBe('#0f1117')
  })

  it('falls back to white on black for a theme without colours, and ignores a missing element', () => {
    const el = document.createElement('div')
    imeColours(el, {})
    expect(el.style.getPropertyValue('--ime-bg')).toBe('#ffffff')
    expect(el.style.getPropertyValue('--ime-fg')).toBe('#000000')
    expect(() => imeColours(null, {})).not.toThrow()
  })
})
