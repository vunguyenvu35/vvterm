import {registerPane, toTerminalInput, writeToPane} from './panes'

describe('pane registry', () => {
  it('writes to a registered pane and stops after unregister', () => {
    const got: string[] = []
    const off = registerPane('p1', t => { got.push(t); return true })
    expect(writeToPane('p1', 'ls\r')).toBe(true)
    expect(got).toEqual(['ls\r'])
    off()
    expect(writeToPane('p1', 'x')).toBe(false)
  })

  it('reports false for unknown panes and for panes that refuse input', () => {
    expect(writeToPane('nope', 'x')).toBe(false)
    const off = registerPane('p2', () => false)
    expect(writeToPane('p2', 'x')).toBe(false)
    off()
  })

  it('a stale unregister does not remove a newer registration', () => {
    const off1 = registerPane('p3', () => true)
    const off2 = registerPane('p3', () => true)
    off1()
    expect(writeToPane('p3', 'x')).toBe(true)
    off2()
  })
})

describe('toTerminalInput', () => {
  it('turns newlines into carriage returns and presses Enter once when running', () => {
    expect(toTerminalInput('a\nb\n', true)).toBe('a\rb\r')
    expect(toTerminalInput('a\r\nb', true)).toBe('a\rb\r')
    expect(toTerminalInput('single', true)).toBe('single\r')
  })
  it('leaves the last line on the prompt when not running', () => {
    expect(toTerminalInput('a\nb\n', false)).toBe('a\rb')
    expect(toTerminalInput('single\n\n', false)).toBe('single')
  })
})
