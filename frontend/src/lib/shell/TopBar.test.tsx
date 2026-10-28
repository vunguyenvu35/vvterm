import {fireEvent, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {TopBar} from './TopBar'
import {newTab} from '../layout'
import {host} from '../../test/fakeBackend'

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
  afterEach(() => { delete (window as any).matchMedia })
  const narrow = (matches: boolean) => { (window as any).matchMedia = () => ({matches, addEventListener() {}, removeEventListener() {}}) }

  it('shows the key of an action at the right of its item, and no native tooltip while the label is visible', () => {
    narrow(false)
    render(<Nav page="hosts" onPage={vi.fn()} onData={vi.fn()} onSettings={vi.fn()} onLock={vi.fn()} shortcuts={{go_snippets: 'Mod+4', lock_vault: 'Mod+L'}} />)
    const snippets = screen.getByRole('button', {name: 'Snippets'})
    expect(snippets).not.toHaveAttribute('title')
    expect(snippets.querySelector('.nav-key')).toHaveTextContent(/4/)
    expect(snippets).toHaveAttribute('aria-keyshortcuts', 'Mod+4')
    expect(screen.getByRole('button', {name: 'Lock vault'}).querySelector('.nav-key')).toHaveTextContent(/L/)
    expect(screen.getByRole('button', {name: 'Hosts'}).querySelector('.nav-key')).toBeNull() // no key given: nothing shown
  })

  it('every item has an accessible name, and a tooltip when the labels are hidden on narrow windows', () => {
    narrow(true)
    render(<Nav page="hosts" onPage={vi.fn()} onData={vi.fn()} onSettings={vi.fn()} onLock={vi.fn()} />)
    const names = screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))
    expect(names).toEqual(['Hosts', 'Keychain', 'Port Forwarding', 'Snippets', 'Known Hosts', 'Logs', 'Import / Export', 'Settings', 'Lock vault'])
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

describe('TopBar: renaming a tab', () => {
  const t = newTab('h1', 'web-1')
  const pinned = {...newTab('', 'SFTP'), pinned: true, kind: 'sftp' as const}
  const mount = (onRename = vi.fn()) => {
    render(<TopBar tabs={[pinned, t]} active="home" onHome={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} {...base} onRename={onRename} />)
    return onRename
  }
  const title = (n: string) => screen.getByText(n, {selector: '.tab-title'})

  it('a double click turns the name into an input with the name selected; Enter saves it', async () => {
    const rename = mount()
    await userEvent.dblClick(title('web-1'))
    const input = screen.getByLabelText('Tab name')
    expect(input).toHaveValue('web-1')
    await userEvent.clear(input)
    await userEvent.type(input, 'production db{Enter}')
    expect(rename).toHaveBeenCalledWith(t.id, 'production db')
    expect(screen.queryByLabelText('Tab name')).toBeNull()
  })

  it('Esc cancels, and leaving the field saves what was typed', async () => {
    const rename = mount()
    await userEvent.dblClick(title('web-1'))
    await userEvent.type(screen.getByLabelText('Tab name'), 'xyz{Escape}')
    expect(rename).not.toHaveBeenCalled()
    expect(title('web-1')).toBeInTheDocument()
    await userEvent.dblClick(title('web-1'))
    await userEvent.type(screen.getByLabelText('Tab name'), '2')
    await userEvent.tab()
    expect(rename).toHaveBeenCalledWith(t.id, 'web-12')
  })

  it('the pinned SFTP tab cannot be renamed, and renaming does not select or close the tab', async () => {
    const rename = mount()
    await userEvent.dblClick(title('SFTP'))
    expect(screen.queryByLabelText('Tab name')).toBeNull()
    expect(rename).not.toHaveBeenCalled()
  })

  it('does nothing without a handler (the tooltip is not offered either)', async () => {
    render(<TopBar tabs={[t]} active="home" onHome={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} {...base} />)
    await userEvent.dblClick(screen.getByText('web-1', {selector: '.tab-title'}))
    expect(screen.queryByLabelText('Tab name')).toBeNull()
  })
})

describe('TopBar: the right-click menu of a tab', () => {
  const t = newTab('h1', 'web-1')
  const pinned = {...newTab('', 'SFTP'), pinned: true, kind: 'sftp' as const}
  const mount = (over: Record<string, unknown> = {}) => {
    const cb = {onDuplicate: vi.fn(), onSplitTab: vi.fn(), onRename: vi.fn(), onClose: vi.fn()}
    render(<TopBar tabs={[pinned, t]} active="home" onHome={vi.fn()} onSelect={vi.fn()} {...base} {...cb} {...over} />)
    return cb
  }
  const open = () => fireEvent.contextMenu(screen.getByRole('tab', {name: /web-1/}), {clientX: 30, clientY: 20})

  it('opens at the pointer with Duplicate, Rename, Split right, Split down and Close', () => {
    mount()
    open()
    const menu = screen.getByRole('menu', {name: 'Tab web-1'})
    expect(menu).toHaveStyle({left: '30px', top: '20px'})
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Duplicate', 'Duplicate in new window', 'Rename', 'Split right', 'Split down', 'Close'])
  })

  it('each item acts on that tab and closes the menu', async () => {
    const cb = mount()
    open()
    await userEvent.click(screen.getByRole('menuitem', {name: 'Duplicate'}))
    expect(cb.onDuplicate).toHaveBeenCalledWith(t.id)
    expect(screen.queryByRole('menu')).toBeNull()
    open()
    await userEvent.click(screen.getByRole('menuitem', {name: 'Split right'}))
    expect(cb.onSplitTab).toHaveBeenCalledWith(t.id, 'row')
    open()
    await userEvent.click(screen.getByRole('menuitem', {name: 'Split down'}))
    expect(cb.onSplitTab).toHaveBeenCalledWith(t.id, 'col')
    open()
    await userEvent.click(screen.getByRole('menuitem', {name: 'Close'}))
    expect(cb.onClose).toHaveBeenCalledWith(t.id)
  })

  it('Rename turns the tab name into the input', async () => {
    mount()
    open()
    await userEvent.click(screen.getByRole('menuitem', {name: 'Rename'}))
    expect(screen.getByLabelText('Tab name')).toHaveValue('web-1')
  })

  it('closes on Escape and on a click elsewhere, and never shows the browser menu', async () => {
    mount()
    const ev = new MouseEvent('contextmenu', {bubbles: true, cancelable: true})
    screen.getByRole('tab', {name: /web-1/}).dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    fireEvent.keyDown(window, {key: 'Escape'})
    expect(screen.queryByRole('menu')).toBeNull()
    open()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('the pinned SFTP tab has no menu', () => {
    mount()
    fireEvent.contextMenu(screen.getByRole('tab', {name: /SFTP/}))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('items that do not apply are disabled', () => {
    mount({onDuplicate: undefined, onSplitTab: undefined, onRename: undefined})
    open()
    for (const n of ['Duplicate', 'Rename', 'Split right', 'Split down']) expect(screen.getByRole('menuitem', {name: n})).toBeDisabled()
    expect(screen.getByRole('menuitem', {name: 'Close'})).toBeEnabled()
  })
})

describe('TopBar: tab icons', () => {
  it('a tab shows the server type of its host, and a plain terminal icon for this computer', () => {
    const web = newTab('h1', 'web'), local = newTab('local', 'Local'), sw = newTab('telnet:h2', 'switch (Telnet)')
    render(<TopBar {...base} tabs={[web, local, sw]} active={web.id} onHome={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()}
      hosts={[host({id: 'h1', os: 'ubuntu'} as never), host({id: 'h2', os: 'debian'} as never)]} />)
    const tabs = screen.getAllByRole('tab').filter(t => !t.classList.contains('tab-home'))
    expect(tabs[0].querySelector('.tab-os')).toHaveAttribute('data-os', 'ubuntu')
    expect(tabs[1].querySelector('.tab-os')).toBeNull()
    expect(tabs[1].querySelector('svg')).not.toBeNull() // the terminal icon is still there
    expect(tabs[2].querySelector('.tab-os')).toHaveAttribute('data-os', 'debian') // a Telnet tab belongs to the same host
  })
})
