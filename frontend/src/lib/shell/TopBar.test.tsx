import {render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {TopBar} from './TopBar'
import {newTab} from '../layout'

const base = {snippets: [], onRunSnippet: vi.fn(), onSplit: vi.fn(), onNew: vi.fn(), onSettings: vi.fn()}

describe('TopBar', () => {
  it('the Vaults tab does not reuse the .home page-container class (regression: it stretched to 220px)', () => {
    render(<TopBar tabs={[]} active="home" onHome={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} {...base} />)
    expect(screen.getByRole('tab', {name: 'Vaults'})).not.toHaveClass('home')
  })

  it('selects and closes terminal tabs without selecting them on close', async () => {
    const t = newTab('h1', 'web-1')
    const onSelect = vi.fn(), onClose = vi.fn()
    render(<TopBar tabs={[t]} active="home" onHome={vi.fn()} onSelect={onSelect} onClose={onClose} {...base} />)
    await userEvent.click(screen.getByLabelText('Close web-1'))
    expect(onClose).toHaveBeenCalledWith(t.id)
    expect(onSelect).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('tab', {name: /web-1/}))
    expect(onSelect).toHaveBeenCalledWith(t.id)
  })

  it('split buttons are only enabled inside a terminal tab', async () => {
    const t = newTab('h1', 'web-1')
    const onSplit = vi.fn()
    const {rerender} = render(<TopBar tabs={[t]} active="home" onHome={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} {...base} onSplit={onSplit} />)
    expect(screen.getByLabelText('Split right')).toBeDisabled()
    rerender(<TopBar tabs={[t]} active={t.id} onHome={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} {...base} onSplit={onSplit} />)
    await userEvent.click(screen.getByLabelText('Split down'))
    expect(onSplit).toHaveBeenCalledWith('col')
  })
})

import {Nav} from './Nav'

describe('Nav', () => {
  it('every item has an accessible name and tooltip even when labels are hidden on narrow windows', () => {
    render(<Nav page="hosts" onPage={vi.fn()} onData={vi.fn()} onSettings={vi.fn()} onLock={vi.fn()} />)
    const names = screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))
    expect(names).toEqual(['Hosts', 'Keychain', 'Port Forwarding', 'Snippets', 'Import / Export', 'Settings', 'Lock vault'])
    for (const b of screen.getAllByRole('button')) expect(b).toHaveAttribute('title', b.getAttribute('aria-label')!)
    expect(screen.getByRole('button', {name: 'Hosts'})).toHaveAttribute('aria-current', 'page')
  })
})

import {Brand} from '../ui/Brand'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

describe('Brand wordmark', () => {
  it('keeps the two V letters apart (regression: tight letter-spacing made "VV" read as "W")', () => {
    const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8')
    const rule = css.match(/\.wordmark \.vv \{([^}]*)\}/)![1]
    const spacing = rule.match(/letter-spacing:\s*(-?[\d.]+)em/)
    expect(spacing, 'the .vv rule sets a letter-spacing').not.toBeNull()
    expect(Number(spacing![1])).toBeGreaterThanOrEqual(0)
  })

  it('renders logo and wordmark in one flex row with the accessible name VVTerm', () => {
    render(<Brand size="lg" heading />)
    const el = screen.getByRole('heading', {name: 'VVTerm'})
    expect(el).toHaveClass('brand-lockup', 'lg')
    expect(el.querySelector('img')).not.toBeNull()
    expect(el.querySelector('.wordmark')).toHaveTextContent('VVTerm_')
  })
})

describe('TopBar: double click zooms the window like a Mac app', () => {
  const t = newTab('h1', 'web-1')
  const mount = (onToggleMaximise = vi.fn()) => {
    render(<TopBar tabs={[t]} active="home" onHome={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} {...base} onToggleMaximise={onToggleMaximise} />)
    return onToggleMaximise
  }

  it('toggles on the empty part of the bar', async () => {
    const toggle = mount()
    await userEvent.dblClick(document.querySelector('.topbar .spacer')!)
    expect(toggle).toHaveBeenCalledTimes(1)
    await userEvent.dblClick(document.querySelector('.topbar .traffic-space')!)
    expect(toggle).toHaveBeenCalledTimes(2)
  })

  it('does not toggle when the double click lands on a tab or a button', async () => {
    const toggle = mount()
    await userEvent.dblClick(screen.getByRole('tab', {name: 'Vaults'}))
    await userEvent.dblClick(screen.getByRole('tab', {name: /web-1/}))
    await userEvent.dblClick(screen.getByLabelText('Open settings'))
    await userEvent.dblClick(screen.getByLabelText('New connection'))
    expect(toggle).not.toHaveBeenCalled()
  })

  it('works without a handler (browser mode)', async () => {
    render(<TopBar tabs={[]} active="home" onHome={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} {...base} />)
    await userEvent.dblClick(document.querySelector('.topbar .spacer')!)
  })
})
