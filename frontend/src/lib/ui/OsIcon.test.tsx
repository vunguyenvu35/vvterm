import {render, screen} from '@testing-library/react'
import {OS_INFO, OsIcon, osName} from './OsIcon'

// the values the Go side can store (domain.KnownOS): every one needs an icon
const BACKEND_KNOWN = ['ubuntu', 'debian', 'raspbian', 'kali', 'centos', 'rhel', 'fedora', 'rocky', 'almalinux', 'amazon', 'suse', 'alpine', 'arch', 'freebsd', 'openbsd', 'netbsd', 'macos', 'windows', 'linux']

describe('OsIcon', () => {
  it('has a name, colour and mark for every server type the backend can store', () => {
    expect(Object.keys(OS_INFO).sort()).toEqual([...BACKEND_KNOWN].sort())
    for (const [id, i] of Object.entries(OS_INFO)) {
      expect(i.name, id).toBeTruthy()
      expect(i.color, id).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('names the server type, and is empty while it is unknown', () => {
    expect(osName('ubuntu')).toBe('Ubuntu')
    expect(osName('freebsd')).toBe('FreeBSD')
    expect(osName('')).toBe('')
    expect(osName(undefined)).toBe('')
    expect(osName('plan9')).toBe('')
  })

  it('draws the distribution mark, or the generic server icon when unknown', () => {
    const {container, rerender} = render(<OsIcon os="debian" />)
    expect(container.querySelector('[data-os="debian"] svg[data-glyph="debian"]')).not.toBeNull()
    rerender(<OsIcon />)
    expect(container.querySelector('[data-os]')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    rerender(<OsIcon os="plan9" />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('[data-glyph]')).toBeNull()
  })
})

describe('OsIcon glyphs', () => {
  it('draws a logo for every server type (never the generic icon for a known one)', () => {
    for (const os of Object.keys(OS_INFO)) {
      const {container, unmount} = render(<OsIcon os={os} />)
      expect(container.querySelector(`svg[data-glyph="${os}"]`), os).not.toBeNull()
      expect(container.querySelector('svg')?.children.length, os).toBeGreaterThan(0)
      unmount()
    }
  })
})
