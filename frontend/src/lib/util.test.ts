import {b64ToBytes, envColor, errMsg, formatAddr, joinArgs, parseTags, splitArgs} from './util'

describe('util', () => {
  it('decodes base64 including non-UTF8 bytes', () => {
    expect(Array.from(b64ToBytes(btoa('hi\x00\xff')))).toEqual([104, 105, 0, 255])
    expect(b64ToBytes('').length).toBe(0)
  })
  it('normalises errors from Wails (string) and exceptions', () => {
    expect(errMsg('boom')).toBe('boom')
    expect(errMsg(new Error('bad'))).toBe('bad')
    expect(errMsg({code: 1})).toBe('{"code":1}')
  })
  it('parses and de-duplicates tags', () => {
    expect(parseTags(' a, b ,,a ,c')).toEqual(['a', 'b', 'c'])
    expect(parseTags('')).toEqual([])
  })
  it('formats addresses', () => {
    expect(formatAddr({hostname: 'h', port: 22, username: 'u'})).toBe('u@h')
    expect(formatAddr({hostname: 'h', port: 2222})).toBe('h:2222')
  })
  it('maps env to colour tokens', () => {
    expect(envColor('prod')).toContain('env-prod')
    expect(envColor(undefined)).toContain('env-none')
    expect(envColor('' as never)).toContain('env-none')
  })
})

describe('command line arguments', () => {
  it('splitArgs keeps quoted text together', () => {
    expect(splitArgs('-y @acme/docs --name "My Docs" --x=\'a b\' --y="c d"')).toEqual(['-y', '@acme/docs', '--name', 'My Docs', '--x=a b', '--y=c d'])
    expect(splitArgs('""  x')).toEqual(['', 'x'])
    expect(splitArgs('   ')).toEqual([])
    expect(splitArgs('a  b')).toEqual(['a', 'b'])
  })
  it('joinArgs quotes what needs it and round-trips', () => {
    const args = ['-y', 'my pkg', 'plain', 'say "hi"']
    expect(joinArgs(args)).toBe('-y "my pkg" plain "say \\"hi\\""')
    expect(splitArgs(joinArgs(args))).toEqual(args)
  })
})
