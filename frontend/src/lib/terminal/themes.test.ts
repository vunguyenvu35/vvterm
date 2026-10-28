import {DEFAULT_DARK, DEFAULT_LIGHT, TERMINAL_THEMES, findTheme, mix, resolveTerminalTheme} from './themes'

const HEX = /^#[0-9a-f]{6}$/i
const luminance = (h: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('terminal theme catalogue', () => {
  it('has unique ids, names, and both dark and light themes', () => {
    const ids = TERMINAL_THEMES.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(TERMINAL_THEMES.map(t => t.name)).size).toBe(ids.length)
    expect(TERMINAL_THEMES.filter(t => t.dark).length).toBeGreaterThanOrEqual(10)
    expect(TERMINAL_THEMES.filter(t => !t.dark).length).toBeGreaterThanOrEqual(8)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/) // the backend accepts exactly these
  })

  it.each(TERMINAL_THEMES.map(t => [t.id, t] as const))('%s defines a full, valid palette', (_id, t) => {
    const keys = ['background', 'foreground', 'cursor', 'selectionBackground', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const
    for (const k of keys) expect(t.theme[k], `${t.id}.${k}`).toMatch(HEX)
  })

  it.each(TERMINAL_THEMES.map(t => [t.id, t] as const))('%s is readable: text contrasts with the background and "dark" is truthful', (_id, t) => {
    const bg = luminance(t.theme.background!)
    const fg = luminance(t.theme.foreground!)
    expect(Math.abs(bg - fg)).toBeGreaterThan(0.3)
    expect(t.dark).toBe(bg < 0.5)
  })

  it('blends colours', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#102030', '#102030', 0.7)).toBe('#102030')
  })

  it('finds and resolves themes; auto and unknown ids follow the appearance', () => {
    expect(findTheme('dracula')?.name).toBe('Dracula')
    expect(findTheme('nope')).toBeUndefined()
    expect(resolveTerminalTheme('nord', 'light').id).toBe('nord') // an explicit choice wins over the app mode
    expect(resolveTerminalTheme('auto', 'dark').id).toBe(DEFAULT_DARK)
    expect(resolveTerminalTheme('auto', 'light').id).toBe(DEFAULT_LIGHT)
    expect(resolveTerminalTheme('removed-in-a-later-version', 'dark').id).toBe(DEFAULT_DARK)
  })
})

describe('"Match app theme" looks like the app', () => {
  it('the default dark and light themes use the app background from styles.css and green text', async () => {
    const {readFileSync} = await import('node:fs')
    const {join} = await import('node:path')
    const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8')
    const dark = css.match(/:root \{[^}]*--bg: (#[0-9a-f]{6});[^}]*--text: (#[0-9a-f]{6});/s)!
    const light = css.match(/:root\[data-theme='light'\] \{[^}]*--bg: (#[0-9a-f]{6});[^}]*--text: (#[0-9a-f]{6});/s)!
    const d = findTheme('vvterm-dark')!.theme, l = findTheme('vvterm-light')!.theme
    expect([d.background, d.foreground]).toEqual([dark[1], '#3ecf8e'])
    expect([l.background, l.foreground]).toEqual([light[1], '#1a7f4b'])
  })
})
