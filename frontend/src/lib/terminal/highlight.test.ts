import {CellLike, createHighlighter, findHighlights, HighlightTerm, LineLike, MarkerLike, readLine} from './highlight'

const spans = (text: string) => findHighlights(text).map(h => `${h.rule}:${text.slice(h.start, h.end)}`)

describe('findHighlights', () => {
  it('finds URLs, and does not also colour the IP or the path inside them', () => {
    expect(spans('see https://example.com/a/b?x=1 for details')).toEqual(['url:https://example.com/a/b?x=1'])
    expect(spans('curl http://10.0.0.5:8080/health')).toEqual(['url:http://10.0.0.5:8080/health'])
  })

  it('finds IPv4 addresses with an optional port, and refuses impossible ones', () => {
    expect(spans('inet 162.43.38.146 netmask')).toEqual(['ipv4:162.43.38.146'])
    expect(spans('listen 127.0.0.1:2202')).toEqual(['ipv4:127.0.0.1:2202'])
    expect(spans('version 1.2.3 and 999.1.1.1')).toEqual([])
  })

  it('finds IPv6 and MAC-style addresses, but not a clock time', () => {
    expect(spans('fe80::1:2:3:4')).toContain('address:fe80::1:2:3:4')
    expect(spans('link/ether aa:bb:cc:dd:ee:ff')).toEqual(['address:aa:bb:cc:dd:ee:ff'])
    expect(spans('at 16:32:27')).toEqual(['datetime:16:32:27'])
  })

  it('finds dates and times', () => {
    expect(spans('2026-10-28 16:32:27 boot')).toEqual(['datetime:2026-10-28 16:32:27'])
    expect(spans('Last login: Wed Oct 28 16:32:32 2026')).toEqual(['datetime:16:32:32'])
  })

  it('finds the words that say how it went, ignoring case and word boundaries', () => {
    expect(spans('ERROR: connection refused')).toEqual(['error:ERROR', 'error:refused'])
    expect(spans('Permission denied (publickey)')).toEqual(['error:denied'])
    expect(spans('ls: cannot access x: No such file or directory')).toEqual(['error:cannot', 'error:No such file or directory'])
    expect(spans('Warning: deprecated option')).toEqual(['warning:Warning', 'warning:deprecated'])
    expect(spans('Successfully started, all tests passed. Done')).toEqual(['success:Successfully', 'success:started', 'success:passed', 'success:Done'])
    expect(spans('errorless broker okay terror')).toEqual([]) // inside other words: no
  })

  it('finds paths, but not URL slashes or dates like 12/31', () => {
    expect(spans('cd /var/log/nginx')).toEqual(['path:/var/log/nginx'])
    expect(spans('~/projects/app and ./run.sh and ../x')).toEqual(['path:~/projects/app', 'path:./run.sh', 'path:../x'])
    expect(spans('root@host:~# ls /etc/ssh/sshd_config')).toEqual(['path:/etc/ssh/sshd_config'])
    expect(spans('(see /usr/bin/env)')).toEqual(['path:/usr/bin/env'])
    expect(spans('on 12/31 and 1/2')).toEqual([])
  })

  it('never overlaps, keeps the order of the line, and the first rule wins', () => {
    const all = findHighlights('2026-10-28 ERROR https://x.org/err 10.0.0.1 /tmp/a failed')
    for (let i = 1; i < all.length; i++) expect(all[i].start).toBeGreaterThanOrEqual(all[i - 1].end)
    expect(all.map(h => h.rule)).toEqual(['datetime', 'error', 'url', 'ipv4', 'path', 'error'])
  })

  it('handles empty and very long lines', () => {
    expect(findHighlights('')).toEqual([])
    expect(findHighlights('x'.repeat(100_000))).toEqual([])
    expect(findHighlights('a '.repeat(5000) + 'error').length).toBe(0) // past the length cap: left alone, not slow
  })
})

// ---- a fake terminal ----

function cell(chars: string, width: number, plain: boolean): CellLike {
  return {getChars: () => chars, getWidth: () => width, isFgDefault: () => plain}
}
function makeLine(text: string, coloured: number[] = []): LineLike {
  const cells: CellLike[] = []
  let i = 0
  for (const ch of Array.from(text)) {
    const wide = /[　-鿿]/.test(ch)
    cells.push(cell(ch, wide ? 2 : 1, !coloured.includes(i)))
    if (wide) cells.push(cell('', 0, true))
    i += ch.length
  }
  return {length: cells.length, getCell: x => cells[x]}
}

function makeTerm(lines: string[], opts: {cursorY?: number; type?: string; coloured?: Record<number, number[]>} = {}) {
  const data = lines.map((l, i) => makeLine(l, opts.coloured?.[i]))
  const decorations: Array<{line: number; x: number; width: number; color: string; disposed: boolean}> = []
  const markers: MarkerLike[] = []
  const term: HighlightTerm & {cursor: number} = {
    cursor: opts.cursorY ?? lines.length,
    buffer: {active: {type: opts.type ?? 'normal', baseY: 0, get cursorY() { return term.cursor }, getLine: y => data[y]}},
    registerMarker: offset => {
      const m: MarkerLike = {line: term.cursor + offset, dispose() { m.line = -1 }}
      markers.push(m)
      return m
    },
    registerDecoration: o => {
      const d = {line: o.marker.line, x: o.x, width: o.width, color: o.foregroundColor, disposed: false}
      decorations.push(d)
      return {dispose() { d.disposed = true }}
    },
  }
  return {term, decorations, data}
}
const live = (d: ReturnType<typeof makeTerm>['decorations']) => d.filter(x => !x.disposed).map(x => `${x.line}:${x.x}+${x.width}`)

describe('readLine', () => {
  it('maps characters to columns, with wide characters taking two', () => {
    const r = readLine(makeLine('a漢b'))
    expect(r.text).toBe('a漢b')
    expect(r.columnOf).toEqual([0, 1, 3])
  })
  it('turns empty cells into spaces', () => {
    const line: LineLike = {length: 3, getCell: x => cell(x === 1 ? '' : 'x', 1, true)}
    expect(readLine(line).text).toBe('x x')
  })
})

describe('createHighlighter', () => {
  it('colours finished lines only: the line the cursor is on is left alone', () => {
    const {term, decorations} = makeTerm(['ssh 10.0.0.1 failed', 'root@host:~# typing error'], {cursorY: 1})
    createHighlighter(term).scan()
    expect(live(decorations)).toEqual(['0:4+8', '0:13+6'])
    expect(decorations.map(d => d.color)).toEqual(['#e5c07b', '#ef5b5b'])
  })

  it('looks at each line once, picking up new lines as the cursor moves down', () => {
    const t = makeTerm(['one error', 'two error', 'three error'], {cursorY: 1})
    const hl = createHighlighter(t.term)
    hl.scan()
    hl.scan()
    expect(t.decorations).toHaveLength(1)
    t.term.cursor = 3
    hl.scan()
    expect(t.decorations.map(d => d.line)).toEqual([0, 1, 2])
  })

  it('leaves words a program coloured itself, and everything in the alternate screen', () => {
    const own = makeTerm(['error ok'], {cursorY: 1, coloured: {0: [0, 1, 2, 3, 4]}})
    createHighlighter(own.term).scan()
    expect(live(own.decorations)).toEqual(['0:6+2']) // "ok" had the default colour, "error" did not
    const vim = makeTerm(['error everywhere'], {cursorY: 1, type: 'alternate'})
    createHighlighter(vim.term).scan()
    expect(vim.decorations).toHaveLength(0)
  })

  it('places colours by column even after wide characters', () => {
    const t = makeTerm(['漢字 error'], {cursorY: 1})
    createHighlighter(t.term).scan()
    expect(live(t.decorations)).toEqual(['0:5+5'])
  })

  it('dispose removes every colour and stops; reset starts again from the top', () => {
    const t = makeTerm(['an error here', 'and a warning'], {cursorY: 2})
    const hl = createHighlighter(t.term)
    hl.scan()
    expect(live(t.decorations)).toHaveLength(2)
    hl.dispose()
    expect(live(t.decorations)).toHaveLength(0)
    hl.scan()
    expect(t.decorations).toHaveLength(2) // nothing new while off
    hl.reset()
    hl.scan()
    expect(live(t.decorations)).toHaveLength(2)
  })

  it('does nothing when the cursor is still on the first line, or the buffer is empty', () => {
    const t = makeTerm(['error'], {cursorY: 0})
    createHighlighter(t.term).scan()
    expect(t.decorations).toHaveLength(0)
  })

  it('works through a long scroll in bounded steps', () => {
    const lines = Array.from({length: 1000}, (_, i) => `line ${i} error`)
    const t = makeTerm(lines, {cursorY: 1000})
    const hl = createHighlighter(t.term)
    hl.scan()
    expect(t.decorations.length).toBeLessThanOrEqual(400) // one scan never takes more than a bounded slice
    hl.scan()
    hl.scan()
    expect(t.decorations).toHaveLength(1000)
  })
})
