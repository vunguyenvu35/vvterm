import {clearHistory, getHistory, MAX_HISTORY, recordCommand, subscribeHistory} from './history'

beforeEach(() => clearHistory())

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
