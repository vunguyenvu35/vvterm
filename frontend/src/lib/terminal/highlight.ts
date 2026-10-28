/**
 * Output highlighting, like Termius: URLs, IP addresses, paths, dates and the words that tell you how a
 * command went (error, warning, success) get a colour, so a screen of log lines can be read at a glance.
 *
 * It only paints; it never changes what is in the terminal. A line is looked at once, after it is
 * complete (the cursor has moved below it), so what you are typing is never recoloured under your fingers.
 * Colours a program chose itself (ls --color, git, syntax highlighters) are left alone, and so is the
 * full-screen mode of vim, less and htop.
 */

export interface Highlight {
  start: number
  end: number
  color: string
  rule: string
}

interface Rule {
  id: string
  re: RegExp
  color: string
  /** capture group holding the part to colour (default: the whole match) */
  group?: number
}

// Earlier rules win where two overlap: a URL is a URL even though it contains an IP and a path.
export const RULES: Rule[] = [
  {id: 'url', re: /\bhttps?:\/\/[^\s<>"'`)\]]+/g, color: '#5ac8fa'},
  {id: 'datetime', re: /\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?\b|\b\d{2}:\d{2}:\d{2}\b/g, color: '#c678dd'},
  {id: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?\b/g, color: '#e5c07b'},
  {id: 'address', re: /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b/gi, color: '#e5c07b'},
  {id: 'error', re: /\b(?:error|errors|fail(?:ed|ure|ures)?|fatal|denied|refused|critical|panic|segfault|cannot|unable|exception|no such file or directory|not found)\b/gi, color: '#ef5b5b'},
  {id: 'warning', re: /\b(?:warn|warning|warnings|deprecated|caution)\b/gi, color: '#f0b429'},
  {id: 'success', re: /\b(?:success|successful|successfully|passed|done|ok|enabled|started)\b/gi, color: '#3ecf8e'},
  // an absolute, home-relative or ./ ../ path (not the slashes of a URL or of a date like 12/31)
  {id: 'path', re: /(?:^|[\s(=:"'])((?:~|\.{1,2})?\/[\w.@%+=,~-]+(?:\/[\w.@%+=,~-]*)*)/g, color: '#61afef', group: 1},
]

const MAX_LINE = 2000

/** Every highlight in a line, without overlaps (the higher rule wins), left to right. */
export function findHighlights(text: string): Highlight[] {
  const chosen: Highlight[] = []
  const free = (s: number, e: number) => chosen.every(h => e <= h.start || s >= h.end)
  const t = text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(t))) {
      if (m[0].length === 0) { rule.re.lastIndex++; continue }
      const part = rule.group ? m[rule.group] : m[0]
      if (!part) continue
      const start = m.index + (rule.group ? m[0].indexOf(part) : 0)
      const end = start + part.length
      if (free(start, end)) chosen.push({start, end, color: rule.color, rule: rule.id})
    }
  }
  return chosen.sort((a, b) => a.start - b.start)
}

// ---- applying it to an xterm.js terminal (only the parts of the API it needs) ----

export interface CellLike {
  getChars(): string
  getWidth(): number
  isFgDefault(): boolean
}
export interface LineLike {
  length: number
  getCell(x: number): CellLike | undefined
}
export interface MarkerLike {
  line: number
  dispose(): void
}
export interface DecorationLike {
  dispose(): void
}
export interface HighlightTerm {
  buffer: {active: {type: string; baseY: number; cursorY: number; getLine(y: number): LineLike | undefined}}
  registerMarker(offset: number): MarkerLike | undefined
  registerDecoration(o: {marker: MarkerLike; x: number; width: number; foregroundColor: string}): DecorationLike | undefined
}

/** The text of a row and, for each character, the column it starts in (wide characters take two columns). */
export function readLine(line: LineLike): {text: string; columnOf: number[]; plain: boolean[]} {
  let text = ''
  const columnOf: number[] = []
  const plain: boolean[] = [] // per character: does it still have the default colour?
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    const chars = cell.getChars()
    if (cell.getWidth() === 0) continue // the second half of a wide character
    const c = chars === '' ? ' ' : chars
    for (let k = 0; k < c.length; k++) {
      columnOf.push(x)
      plain.push(cell.isFgDefault())
    }
    text += c
  }
  return {text, columnOf, plain}
}

const MAX_LINES_PER_SCAN = 400

/** Paints new complete lines as they appear. `scan()` is cheap to call often; `dispose()` removes every colour. */
export function createHighlighter(term: HighlightTerm) {
  let last: MarkerLike | undefined // the last line that was looked at
  const live: DecorationLike[] = []
  let off = false

  const scan = () => {
    if (off) return
    const buf = term.buffer?.active
    if (!buf || buf.type === 'alternate') return // full-screen programs draw their own colours
    const cursorAbs = buf.baseY + buf.cursorY
    const from = last && last.line >= 0 ? last.line + 1 : 0
    const to = Math.min(cursorAbs - 1, from + MAX_LINES_PER_SCAN - 1) // only lines the cursor has left
    if (to < from) return
    for (let y = from; y <= to; y++) {
      const line = buf.getLine(y)
      if (!line) continue
      const {text, columnOf, plain} = readLine(line)
      for (const h of findHighlights(text)) {
        // a program that coloured this word itself keeps its colour
        if (plain.slice(h.start, h.end).some(p => !p)) continue
        const marker = term.registerMarker(y - cursorAbs)
        if (!marker) continue
        const x = columnOf[h.start]
        const lastChar = columnOf[h.end - 1]
        const width = lastChar - x + 1 + (line.getCell(lastChar)?.getWidth() === 2 ? 1 : 0)
        const d = term.registerDecoration({marker, x, width, foregroundColor: h.color})
        if (d) live.push(d)
      }
    }
    last?.dispose()
    last = term.registerMarker(to - cursorAbs)
  }

  return {
    scan,
    /** switch off: remove every colour and stop looking */
    dispose() {
      off = true
      live.splice(0).forEach(d => d.dispose())
      last?.dispose()
      last = undefined
    },
    /** switch on again: look at everything from the start of the buffer */
    reset() {
      live.splice(0).forEach(d => d.dispose())
      last?.dispose()
      last = undefined
      off = false
    },
  }
}
