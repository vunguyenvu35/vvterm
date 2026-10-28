import {ACTIONS, capture, comboFromEvent, conflictFor, effective, formatCombo, isChord, keyOf, matches, stepKeys, stepMatches, validateCombo} from './shortcuts'

const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

describe('two-step shortcuts', () => {
  it('are one or two steps separated by a space; only the first needs a modifier', () => {
    expect(isChord('Mod+K M')).toBe(true)
    expect(isChord('Mod+K')).toBe(false)
    for (const c of ['Mod+K M', 'Ctrl+K Ctrl+M', 'Mod+K Shift+M', 'Mod+K 1', 'Mod+K F5']) expect(validateCombo(c), c).toBeNull()
    for (const c of ['K M', 'Mod+K M N', 'Mod+K ', 'Mod+K Escape', 'Mod+K Hyper+M']) expect(validateCombo(c), c).not.toBeNull()
  })

  it('one event never matches a two-step shortcut; each step matches by itself', () => {
    const k = ev({key: 'k', code: 'KeyK', ctrlKey: true})
    expect(matches(k, 'Mod+K M', false)).toBe(false)
    expect(stepMatches(k, 'Mod+K', false)).toBe(true)
    expect(stepMatches(ev({key: 'm', code: 'KeyM'}), 'M', false)).toBe(true)
    expect(stepMatches(ev({key: 'm', code: 'KeyM', shiftKey: true}), 'M', false)).toBe(false)
  })

  it('conflict with a single shortcut on the same first step, in both directions; chords may share a first step', () => {
    const map = {zoom_in: 'Mod+K M', lock_vault: 'Mod+L'}
    expect(conflictFor('Mod+K', 'zoom_out', map)?.id).toBe('zoom_in')
    expect(conflictFor('Mod+K M', 'zoom_out', map)?.id).toBe('zoom_in')
    expect(conflictFor('Mod+K N', 'zoom_out', map)).toBeNull()
    expect(conflictFor('Mod+L N', 'zoom_out', map)?.id).toBe('lock_vault') // Mod+L would fire first
  })

  it('are written out step by step, and as separate keys for drawing key caps', () => {
    expect(formatCombo('Mod+K M', true)).toBe('⌘K M')
    expect(formatCombo('Mod+K Ctrl+M', false)).toBe('Ctrl+K Ctrl+M')
    expect(stepKeys('Mod+Shift+T', true)).toEqual(['⇧', '⌘', 'T'])
    expect(stepKeys('Mod+Shift+T', false)).toEqual(['Ctrl', 'Shift', 'T'])
  })
})

describe('shortcuts', () => {
  it('has unique action ids and unique valid default combos', () => {
    const ids = ACTIONS.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    const combos = ACTIONS.map(a => a.default.toLowerCase())
    expect(new Set(combos).size).toBe(combos.length)
    for (const a of ACTIONS) expect(validateCombo(a.default), a.id).toBeNull()
  })

  it('effective() merges overrides over defaults and ignores empty ones', () => {
    const m = effective({lock_vault: 'Alt+J', zoom_in: ''})
    expect(m.lock_vault).toBe('Alt+J')
    expect(m.zoom_in).toBe(ACTIONS.find(a => a.id === 'zoom_in')!.default)
    expect(Object.keys(effective(undefined))).toHaveLength(ACTIONS.length)
  })

  it('keyOf maps physical keys (so Option/Shift layouts do not matter) and ignores bare modifiers', () => {
    expect(keyOf({key: 'Control', code: 'ControlLeft'})).toBeNull()
    expect(keyOf({key: 'Dead', code: 'KeyE'})).toBeNull()
    expect(keyOf({key: 'å', code: 'KeyA'})).toBe('A')
    expect(keyOf({key: '=', code: 'Equal'})).toBe('=')
    expect(keyOf({key: '5', code: 'Digit5'})).toBe('5')
    expect(keyOf({key: ' ', code: 'Space'})).toBe('Space')
    expect(keyOf({key: 'F5', code: 'F5'})).toBe('F5')
    expect(keyOf({key: 'Escape', code: 'Escape'})).toBeNull()
  })

  it('builds combos with Mod = Cmd on macOS and Ctrl elsewhere', () => {
    const e = ev({key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true})
    expect(comboFromEvent(e, false)).toBe('Mod+Shift+K')
    expect(comboFromEvent(e, true)).toBe('Ctrl+Shift+K') // on a Mac the Control key is its own modifier
    const m = ev({key: 'k', code: 'KeyK', metaKey: true, altKey: true})
    expect(comboFromEvent(m, true)).toBe('Mod+Alt+K')
    expect(comboFromEvent(m, false)).toBe('Meta+Alt+K')
    expect(comboFromEvent(ev({key: 'Shift', code: 'ShiftLeft', shiftKey: true}), false)).toBeNull()
  })

  it('matches ignores modifier order and case, and rejects extra modifiers', () => {
    const e = ev({key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true})
    expect(matches(e, 'Shift+Mod+d', false)).toBe(true)
    expect(matches(e, 'Mod+D', false)).toBe(false)
    expect(matches(ev({key: 'd', code: 'KeyD'}), 'Mod+D', false)).toBe(false)
  })

  it('validates like the backend', () => {
    expect(validateCombo('Mod+K')).toBeNull()
    expect(validateCombo('F5')).toBeNull()
    expect(validateCombo('K')).toMatch(/Ctrl, Alt/)
    expect(validateCombo('Shift+K')).toMatch(/Ctrl, Alt/)
    expect(validateCombo('Mod+Escape')).toMatch(/reserved/)
    expect(validateCombo('Foo+K')).toMatch(/invalid modifier/)
    expect(validateCombo('Mod+Mod+K')).toMatch(/invalid modifier/)
    expect(validateCombo('Mod+ä')).toMatch(/unsupported key/)
  })

  it('finds the action that already owns a combo, except the one being edited', () => {
    const map = effective({})
    expect(conflictFor('Mod+,', 'lock_vault', map)?.id).toBe('open_settings')
    expect(conflictFor('mod+,', 'open_settings', map)).toBeNull()
    expect(conflictFor('Alt+Q', 'lock_vault', map)).toBeNull()
  })

  it('formats for macOS and other platforms', () => {
    expect(formatCombo('Mod+Shift+K', true)).toBe('⇧⌘K')
    expect(formatCombo('Ctrl+Alt+ArrowUp', true)).toBe('⌃⌥↑')
    expect(formatCombo('Mod+Shift+K', false)).toBe('Ctrl+Shift+K')
    expect(formatCombo('Meta+Tab', false)).toBe('Win+Tab')
    expect(formatCombo('F5', false)).toBe('F5')
  })

  it('exposes a capture flag that starts off', () => {
    expect(capture.active).toBe(false)
  })
})
