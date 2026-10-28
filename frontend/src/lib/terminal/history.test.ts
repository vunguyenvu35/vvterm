import {clearHistory, createLineTracker, getHistory, MAX_HISTORY, recordCommand, subscribeHistory} from './history'

beforeEach(() => clearHistory())

describe('createLineTracker', () => {
  it('reports each line finished with Enter, applying Backspace', () => {
    const t = createLineTracker()
    expect(t('ls -l')).toEqual([])
    expect(t('a\x7f\r')).toEqual(['ls -l'])
    expect(t('pwd\rwhoami\r')).toEqual(['pwd', 'whoami'])
  })
  it('drops a line on Ctrl-C and Ctrl-U, ignores arrows, empty lines and control keys', () => {
    const t = createLineTracker()
    expect(t('abc\x03\r')).toEqual([])
    expect(t('abc\x15ls\r')).toEqual(['ls'])
    expect(t('\x1b[A\x1b[B\r')).toEqual([])
    expect(t('  \r')).toEqual([])
    expect(t('x\x1b[1;5Cy\r')).toEqual(['xy'])
  })
})

describe('command history', () => {
  it('keeps newest first, moves a repeated command up and trims it', () => {
    recordCommand('ls')
    recordCommand('  pwd  ')
    recordCommand('ls')
    expect(getHistory()).toEqual(['ls', 'pwd'])
  })
  it('keeps at most MAX_HISTORY commands, refuses empty and huge lines, and tells subscribers', () => {
    const seen = vi.fn()
    const off = subscribeHistory(seen)
    for (let i = 0; i < MAX_HISTORY + 20; i++) recordCommand('cmd ' + i)
    expect(getHistory()).toHaveLength(MAX_HISTORY)
    expect(getHistory()[0]).toBe('cmd ' + (MAX_HISTORY + 19))
    recordCommand('')
    recordCommand('x'.repeat(5000))
    expect(getHistory()).toHaveLength(MAX_HISTORY)
    off()
    seen.mockClear()
    recordCommand('after')
    expect(seen).not.toHaveBeenCalled()
  })
  it('is stored in localStorage', () => {
    recordCommand('uptime')
    expect(JSON.parse(localStorage.getItem('vvterm.history')!)).toEqual(['uptime'])
    clearHistory()
    expect(getHistory()).toEqual([])
  })
})
