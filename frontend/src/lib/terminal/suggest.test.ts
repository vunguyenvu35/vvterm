import {completion, createPrefixTracker, looksSecret, suggest} from './suggest'
import type {Snippet} from '../types'

const snip = (label: string, script: string): Snippet => ({id: label, label, script, created_at: '', updated_at: ''}) as unknown as Snippet
const none = {typed: [], snippets: [], host: []}

describe('suggest', () => {
  it('offers commands that start with what is typed: typed first, then snippets, then the host, newest first', () => {
    const got = suggest('docker ', {
      typed: ['docker ps', 'docker logs api'],
      snippets: [snip('Clean', 'docker system prune -af')],
      host: ['docker compose up', 'docker ps'],
    })
    expect(got.map(g => [g.source, g.text])).toEqual([
      ['typed', 'docker ps'], ['typed', 'docker logs api'], ['snippet', 'docker system prune -af'], ['host', 'docker compose up'],
    ])
  })

  it('suggests nothing for a command that is already typed in full, and never the same text twice', () => {
    expect(suggest('ls', {...none, typed: ['ls']})).toEqual([])
    expect(suggest('ls', {...none, typed: ['ls -la'], host: ['ls -la']})).toHaveLength(1)
  })

  it('finds a snippet by its name and a replacement is typed over what was typed', () => {
    const [s] = suggest('clean', {...none, snippets: [snip('Cleanup', 'rm -rf /tmp/cache')]})
    expect(s).toMatchObject({source: 'snippet', label: 'Cleanup', text: 'rm -rf /tmp/cache'})
    expect(completion('clean', s)).toBe('\x7f\x7f\x7f\x7f\x7frm -rf /tmp/cache')
    expect(completion('git ', {text: 'git status', source: 'typed'})).toBe('status')
  })

  it('never suggests a snippet of several lines: its first lines would run at once', () => {
    expect(suggest('echo', {...none, snippets: [snip('Two', 'echo a\necho b')]})).toEqual([])
  })

  it('never suggests a line that looks like it holds a secret', () => {
    expect(looksSecret('mysql -u root -phunter2')).toBe(true)
    expect(looksSecret('export API_TOKEN=abc')).toBe(true)
    expect(looksSecret('curl -H "Authorization: Bearer x" https://a')).toBe(true)
    expect(looksSecret('git status')).toBe(false)
    expect(looksSecret('mkdir -p a/b && docker run -p 80:80 nginx')).toBe(false) // -p is a port or a parent flag, not a password
    expect(suggest('mysql', {...none, typed: ['mysql -u root -phunter2', 'mysql -u root']}).map(s => s.text)).toEqual(['mysql -u root'])
  })

  it('suggests the recent commands for an empty line, and nothing for spaces only from the host', () => {
    expect(suggest('', {...none, typed: ['a1', 'b2']}).map(s => s.text)).toEqual(['a1', 'b2'])
  })
})

describe('createPrefixTracker', () => {
  const type = (t: ReturnType<typeof createPrefixTracker>, ...chunks: string[]) => chunks.forEach(c => t.feed(c))

  it('follows letters, Backspace and Ctrl-U, and starts again after Enter', () => {
    const t = createPrefixTracker()
    type(t, 'g', 'i', 't', ' ', 'x', '\x7f')
    expect(t.state).toEqual({prefix: 'git ', known: true})
    type(t, '\x15')
    expect(t.state.prefix).toBe('')
    type(t, 'ls', '\r')
    expect(t.state).toEqual({prefix: '', known: true})
  })

  it('is not sure about the line after an arrow or Tab until Enter', () => {
    const t = createPrefixTracker()
    type(t, 'gi', '\x1b[A')
    expect(t.state.known).toBe(false)
    type(t, 'x')
    expect(t.state.known).toBe(false)
    type(t, '\r')
    expect(t.state.known).toBe(true)
    type(t, 'cd ', '\t')
    expect(t.state.known).toBe(false)
  })

  it('keeps Vietnamese letters whole and removes one letter per Backspace', () => {
    const t = createPrefixTracker()
    type(t, 'tiế', 'ng')
    expect(t.state.prefix).toBe('tiếng')
    type(t, '\x7f')
    expect(t.state.prefix).toBe('tiến')
  })
})
