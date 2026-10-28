import type {ITheme} from '@xterm/xterm'

/** A terminal colour theme. Palettes follow popular open-source schemes (approximated). */
export interface TermTheme {
  id: string
  name: string
  dark: boolean
  theme: ITheme
}

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const toHex = (c: number[]) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
/** Blend a toward b by t (0..1). */
export const mix = (a: string, b: string, t: number) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t))

interface Spec {
  bg: string; fg: string; cursor: string; sel: string
  red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string
}

function make(id: string, name: string, dark: boolean, s: Spec): TermTheme {
  const bright = (c: string) => mix(c, dark ? '#ffffff' : '#000000', dark ? 0.22 : 0.18)
  const black = dark ? mix(s.bg, '#ffffff', 0.16) : s.fg
  const white = dark ? s.fg : mix(s.bg, '#000000', 0.12)
  return {
    id, name, dark,
    theme: {
      background: s.bg, foreground: s.fg, cursor: s.cursor, cursorAccent: s.bg, selectionBackground: s.sel,
      black, red: s.red, green: s.green, yellow: s.yellow, blue: s.blue, magenta: s.magenta, cyan: s.cyan, white,
      brightBlack: mix(black, s.fg, 0.35), brightRed: bright(s.red), brightGreen: bright(s.green), brightYellow: bright(s.yellow),
      brightBlue: bright(s.blue), brightMagenta: bright(s.magenta), brightCyan: bright(s.cyan), brightWhite: dark ? '#ffffff' : s.fg,
    },
  }
}

export const TERMINAL_THEMES: TermTheme[] = [
  make('vvterm-dark', 'VVTerm Dark', true, {bg: '#0c0e12', fg: '#e6e8ee', cursor: '#5b8cff', sel: '#33415c', red: '#ef5b5b', green: '#3ecf8e', yellow: '#f0b429', blue: '#5b8cff', magenta: '#a78bfa', cyan: '#22d3ee'}),
  make('vvterm-light', 'VVTerm Light', false, {bg: '#ffffff', fg: '#1b1f2a', cursor: '#2f62e0', sel: '#cfdcff', red: '#d1242f', green: '#1a7f4b', yellow: '#9a6700', blue: '#2f62e0', magenta: '#7c4dff', cyan: '#0e7490'}),
  make('dracula', 'Dracula', true, {bg: '#282a36', fg: '#f8f8f2', cursor: '#f8f8f2', sel: '#44475a', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd'}),
  make('nord', 'Nord', true, {bg: '#2e3440', fg: '#d8dee9', cursor: '#d8dee9', sel: '#434c5e', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0'}),
  make('tokyo-night', 'Tokyo Night', true, {bg: '#1a1b26', fg: '#c0caf5', cursor: '#c0caf5', sel: '#283457', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff'}),
  make('one-dark', 'One Dark', true, {bg: '#282c34', fg: '#abb2bf', cursor: '#528bff', sel: '#3e4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2'}),
  make('gruvbox-dark', 'Gruvbox Dark', true, {bg: '#282828', fg: '#ebdbb2', cursor: '#ebdbb2', sel: '#504945', red: '#fb4934', green: '#b8bb26', yellow: '#fabd2f', blue: '#83a598', magenta: '#d3869b', cyan: '#8ec07c'}),
  make('gruvbox-light', 'Gruvbox Light', false, {bg: '#fbf1c7', fg: '#3c3836', cursor: '#3c3836', sel: '#d5c4a1', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a'}),
  make('solarized-dark', 'Solarized Dark', true, {bg: '#002b36', fg: '#839496', cursor: '#93a1a1', sel: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198'}),
  make('solarized-light', 'Solarized Light', false, {bg: '#fdf6e3', fg: '#657b83', cursor: '#586e75', sel: '#eee8d5', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198'}),
  make('night-owl', 'Night Owl', true, {bg: '#011627', fg: '#d6deeb', cursor: '#80a4c2', sel: '#1d3b53', red: '#ef5350', green: '#22da6e', yellow: '#addb67', blue: '#82aaff', magenta: '#c792ea', cyan: '#21c7a8'}),
  make('light-owl', 'Light Owl', false, {bg: '#fbfbfb', fg: '#403f53', cursor: '#90a7b2', sel: '#e0e0e0', red: '#de3d3b', green: '#08916a', yellow: '#b58900', blue: '#288ed7', magenta: '#d6438a', cyan: '#2aa298'}),
  make('kanagawa-wave', 'Kanagawa Wave', true, {bg: '#1f1f28', fg: '#dcd7ba', cursor: '#c8c093', sel: '#2d4f67', red: '#e46876', green: '#98bb6c', yellow: '#e6c384', blue: '#7e9cd8', magenta: '#957fb8', cyan: '#7aa89f'}),
  make('kanagawa-lotus', 'Kanagawa Lotus', false, {bg: '#f2ecbc', fg: '#545464', cursor: '#43436c', sel: '#c9cbd1', red: '#c84053', green: '#6f894e', yellow: '#77713f', blue: '#4d699b', magenta: '#b35b79', cyan: '#597b75'}),
  make('everforest-dark', 'Everforest Dark', true, {bg: '#2d353b', fg: '#d3c6aa', cursor: '#d3c6aa', sel: '#475258', red: '#e67e80', green: '#a7c080', yellow: '#dbbc7f', blue: '#7fbbb3', magenta: '#d699b6', cyan: '#83c092'}),
  make('everforest-light', 'Everforest Light', false, {bg: '#fdf6e3', fg: '#5c6a72', cursor: '#5c6a72', sel: '#e6e2cc', red: '#f85552', green: '#8da101', yellow: '#dfa000', blue: '#3a94c5', magenta: '#df69ba', cyan: '#35a77c'}),
  make('rose-pine', 'Rosé Pine', true, {bg: '#191724', fg: '#e0def4', cursor: '#9893a5', sel: '#403d52', red: '#eb6f92', green: '#9ccfd8', yellow: '#f6c177', blue: '#31748f', magenta: '#c4a7e7', cyan: '#ebbcba'}),
  make('rose-pine-dawn', 'Rosé Pine Dawn', false, {bg: '#faf4ed', fg: '#575279', cursor: '#9893a5', sel: '#dfdad9', red: '#b4637a', green: '#286983', yellow: '#ea9d34', blue: '#56949f', magenta: '#907aa9', cyan: '#d7827e'}),
  make('monokai', 'Monokai', true, {bg: '#272822', fg: '#f8f8f2', cursor: '#f8f8f0', sel: '#49483e', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4'}),
  make('aura', 'Aura', true, {bg: '#15141b', fg: '#edecee', cursor: '#a277ff', sel: '#3d375e', red: '#ff6767', green: '#61ffca', yellow: '#ffca85', blue: '#a277ff', magenta: '#f694ff', cyan: '#82e2ff'}),
  make('flexoki-dark', 'Flexoki Dark', true, {bg: '#100f0f', fg: '#cecdc3', cursor: '#cecdc3', sel: '#343331', red: '#d14d41', green: '#879a39', yellow: '#d0a215', blue: '#4385be', magenta: '#ce5d97', cyan: '#3aa99f'}),
  make('flexoki-light', 'Flexoki Light', false, {bg: '#fffcf0', fg: '#100f0f', cursor: '#100f0f', sel: '#e6e4d9', red: '#af3029', green: '#66800b', yellow: '#ad8301', blue: '#205ea6', magenta: '#a02f6f', cyan: '#24837b'}),
  make('github-light', 'GitHub Light', false, {bg: '#ffffff', fg: '#24292f', cursor: '#0969da', sel: '#b6e3ff', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83'}),
  make('hacker-green', 'Hacker Green', true, {bg: '#050a05', fg: '#33ff33', cursor: '#33ff33', sel: '#0f3d0f', red: '#ff3333', green: '#33ff33', yellow: '#cccc33', blue: '#3399ff', magenta: '#cc33cc', cyan: '#33cccc'}),
  make('hacker-blue', 'Hacker Blue', true, {bg: '#04101c', fg: '#29a8ff', cursor: '#29a8ff', sel: '#0a2a45', red: '#ff5577', green: '#33dd99', yellow: '#ddcc44', blue: '#29a8ff', magenta: '#aa66ff', cyan: '#33ddee'}),
  make('hacker-red', 'Hacker Red', true, {bg: '#14040a', fg: '#ff3355', cursor: '#ff3355', sel: '#4a0a1a', red: '#ff3355', green: '#44cc66', yellow: '#ddaa33', blue: '#5588ff', magenta: '#ff55aa', cyan: '#33ccbb'}),
]

export const DEFAULT_DARK = 'vvterm-dark'
export const DEFAULT_LIGHT = 'vvterm-light'

export function findTheme(id: string): TermTheme | undefined {
  return TERMINAL_THEMES.find(t => t.id === id)
}

/**
 * The theme to render: "auto" (or an unknown id, for example one removed in a later version)
 * follows the effective app appearance.
 */
export function resolveTerminalTheme(id: string, appMode: 'light' | 'dark'): TermTheme {
  const found = id !== 'auto' ? findTheme(id) : undefined
  return found ?? findTheme(appMode === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT)!
}
