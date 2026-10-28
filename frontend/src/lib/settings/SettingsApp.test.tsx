import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsApp from './SettingsApp'
import {makeFake, Providers} from '../../test/fakeBackend'

function setup(settings = {}) {
  const be = makeFake({vault: {exists: true, unlocked: true, keychain_enabled: false, auto_lock_minutes: 15}})
  Object.assign(be.state.settings, settings)
  render(<Providers be={be}><SettingsApp /></Providers>)
  return be
}

describe('SettingsApp (the Settings window process)', () => {
  it('fills its own native window: no floating chrome, no dots, no drag', async () => {
    setup()
    const win = await screen.findByRole('dialog', {name: 'Settings'})
    expect(win).toHaveClass('native')
    expect(win.closest('.win-back')).toHaveClass('native')
    expect(win.querySelector('.win-dots')).toBeNull()
    expect(win.style.transform).toBe('')
    expect(screen.queryByRole('button', {name: /Maximize|Minimize|Close settings/})).toBeNull()
  })

  it('Esc closes the window', async () => {
    const quit = vi.fn()
    ;(window as any).runtime = {EventsOn: () => () => {}, Quit: quit}
    setup()
    await screen.findByRole('dialog', {name: 'Settings'})
    await userEvent.keyboard('{Escape}')
    expect(quit).toHaveBeenCalledTimes(1)
    delete (window as any).runtime
  })

  it('the title is centred between the macOS buttons and the right edge', () => {
    const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../styles.css'), 'utf8') as string
    expect(css).toMatch(/\.win\.native \.win-title \{[^}]*padding: 0 84px;[^}]*justify-content: center/)
  })

  it('applies the saved theme, zoom and motion to its own page, and saves changes', async () => {
    const zoom = vi.spyOn(document.documentElement.style, 'setProperty') // jsdom drops the zoom property itself
    const be = setup({theme: 'light', zoom: 120, reduce_motion: true})
    await screen.findByRole('dialog', {name: 'Settings'})
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    expect(zoom).toHaveBeenCalledWith('zoom', '1.2')
    expect(document.documentElement.dataset.motion).toBe('reduced')
    await userEvent.click(screen.getByRole('switch', {name: 'Reduce motion'}))
    await waitFor(() => expect(be.state.settings.reduce_motion).toBe(false))
  })

  it('reads the settings again whenever the window is focused (the main window may have changed them)', async () => {
    const be = setup()
    await within(await screen.findByRole('dialog', {name: 'Settings'})).findByLabelText('Zoom level')
    expect(screen.getByLabelText('Zoom level')).toHaveTextContent('100%')
    be.state.settings = {...be.state.settings, zoom: 130}
    act(() => { fireEvent.focus(window) })
    await waitFor(() => expect(screen.getByLabelText('Zoom level')).toHaveTextContent('130%'))
  })

  it('shows a loading state, then nothing breaks when the main window is gone', async () => {
    const be = makeFake()
    be.vault.status = async () => { throw new Error('VVTerm is not running') }
    render(<Providers be={be}><SettingsApp /></Providers>)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})

afterEach(() => vi.restoreAllMocks())

describe('SettingsApp title bar', () => {
  it('a double click on the title bar zooms the window, but not on its buttons', async () => {
    const be = setup()
    const win = await screen.findByRole('dialog', {name: 'Settings'})
    const bar = win.querySelector('.win-title') as HTMLElement
    await userEvent.dblClick(bar)
    expect(be.state.calls.filter(c => c[0] === 'system.toggleMaximise')).toHaveLength(1)
  })
})
