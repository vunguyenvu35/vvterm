import {ACTIONS, capture, comboFromEvent, conflictFor, effective, formatCombo, keyOf, matches, validateCombo} from './shortcuts'

const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)

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
