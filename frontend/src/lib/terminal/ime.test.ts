import {composedInput, imeColours} from './TerminalPane'

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

describe('what is typed reaches the shell composed', () => {
  it('turns Vietnamese typed in pieces into whole letters', () => {
    expect(composedInput('vie\u0323\u0302t')).toBe('vi\u1ec7t')
    expect(composedInput('vie\u0302\u0323t')).toBe('vi\u1ec7t')
    expect(composedInput('go\u0303 tie\u0302\u0301ng')).toBe('g\u00f5 ti\u1ebfng')
  })

  it('leaves plain text, composed text and control sequences alone', () => {
    for (const s of ['ls -la', 'vi\u1ec7t', '\x1b[A', '\x1b[200~paste\x1b[201~', '\r', '\x03', '']) expect(composedInput(s)).toBe(s)
  })

  it('also fixes pasted text that carries pieces, and keeps the escape sequences around it', () => {
    expect(composedInput('\x1b[200~vie\u0323\u0302t\x1b[201~')).toBe('\x1b[200~vi\u1ec7t\x1b[201~')
  })
})
