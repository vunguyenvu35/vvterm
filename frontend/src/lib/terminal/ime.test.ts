import {composedInput, followReplacements, imeColours} from './TerminalPane'

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

describe('a word replaced by the input method (insertReplacementText)', () => {
  // a stand-in for the Terminal: its hidden text box, onData and input; `shell` is the line the shell ends up with
  function fakeTerm() {
    const textarea = document.createElement('textarea')
    const subs: Array<(d: string) => void> = []
    let shell = ''
    const emit = (d: string) => {
      for (const ch of d) shell = ch === '\x7f' ? Array.from(shell).slice(0, -1).join('') : shell + ch
      subs.forEach(f => f(d))
    }
    return {
      textarea, emit, line: () => shell,
      onData: (cb: (d: string) => void) => { subs.push(cb); return {dispose: () => { subs.splice(subs.indexOf(cb), 1) }} },
      input: (d: string) => emit(d),
    }
  }
  type Fake = ReturnType<typeof fakeTerm>
  // what the log of macOS Vietnamese showed: the first letter goes through as text, every key then replaces the word
  const word = (t: Fake, steps: string[]) => {
    t.emit(steps[0])
    for (const w of steps.slice(1)) t.textarea.dispatchEvent(new InputEvent('input', {inputType: 'insertReplacementText', data: w}))
  }

  it('turns "g t v" into "gõ tiếng việt": only what differs is sent', () => {
    const t = fakeTerm()
    followReplacements(t)
    word(t, ['G', 'Go', 'G\u00f5']); t.emit(' ')
    word(t, ['t', 'ti', 'tie', 'tien', 'tieng', 'ti\u00e9ng']); t.emit(' ')
    word(t, ['v', 'vi', 'vie', 'vi\u00ea', 'vi\u1ec7', 'vi\u1ec7t'])
    expect(t.line()).toBe('G\u00f5 ti\u00e9ng vi\u1ec7t')
  })

  it('sends a backspace for each letter that changed, then the new ones', () => {
    const sent: string[] = []
    const t = fakeTerm()
    t.input = (d: string) => { sent.push(d) }
    followReplacements(t)
    t.emit('t')
    t.textarea.dispatchEvent(new InputEvent('input', {inputType: 'insertReplacementText', data: 'tieng'}))
    t.textarea.dispatchEvent(new InputEvent('input', {inputType: 'insertReplacementText', data: 'ti\u00e9ng'}))
    expect(sent).toEqual(['ieng', '\x7f\x7f\x7f\u00e9ng'])
  })

  it('does nothing for a replacement that changes nothing, and for other input', () => {
    const t = fakeTerm()
    followReplacements(t)
    word(t, ['a', 'ab', 'ab'])
    t.textarea.dispatchEvent(new InputEvent('input', {inputType: 'insertText', data: 'z'}))
    expect(t.line()).toBe('ab')
  })

  it('composes pieces (NFD) and stops when undone', () => {
    const t = fakeTerm()
    const off = followReplacements(t)
    word(t, ['v', 'vie\u0323\u0302t'])
    expect(t.line()).toBe('vi\u1ec7t')
    off()
    t.textarea.dispatchEvent(new InputEvent('input', {inputType: 'insertReplacementText', data: 'xyz'}))
    expect(t.line()).toBe('vi\u1ec7t')
  })

  it('does nothing without the hidden text box', () => {
    expect(() => followReplacements({onData: () => ({dispose() {}}), input() {}})()).not.toThrow()
  })
})
