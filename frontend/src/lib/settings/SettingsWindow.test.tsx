import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {useState} from 'react'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {SettingsWindow} from './SettingsWindow'
import {Switch} from '../ui/Switch'
import {makeFake, Providers} from '../../test/fakeBackend'
import type {Settings, VaultStatus} from '../types'

const vaultSt: VaultStatus = {exists: true, unlocked: true, keychain_enabled: false, auto_lock_minutes: 15}

function Harness({be, vault = vaultSt, onVault = vi.fn(), onClose}: {be: ReturnType<typeof makeFake>; vault?: VaultStatus; onVault?: () => void; onClose: () => void}) {
  const [s, setS] = useState<Settings>(be.state.settings)
  return <SettingsWindow settings={s} appearance="dark" vault={vault} onSettings={setS} onVault={onVault} onChanged={vi.fn()} onClose={onClose} />
}

function setup(over: Partial<Settings> = {}, vault = vaultSt) {
  const be = makeFake({settings: {...makeFake().state.settings, ...over}})
  const onVault = vi.fn(), onClose = vi.fn()
  render(<Providers be={be}><Harness be={be} vault={vault} onVault={onVault} onClose={onClose} /></Providers>)
  return {be, onVault, onClose}
}
const tab = (n: string) => userEvent.click(screen.getByRole('tab', {name: n}))

describe('SettingsWindow', () => {
  it('is a window with a title bar, not a page', () => {
    setup()
    const win = screen.getByRole('dialog', {name: 'Settings'})
    expect(within(win).getByText('Settings', {selector: '.win-name'})).toBeInTheDocument()
    expect(document.querySelector('.win-back')).not.toBeNull()
  })

  it('has categories on the left and theme, help links and version below them (Termius layout)', async () => {
    setup()
    const nav = screen.getByRole('navigation', {name: 'Settings menu'})
    expect(within(nav).getAllByRole('tab').map(t => t.querySelector('span')?.textContent)).toEqual(['General', 'Account', 'Terminal', 'Security', 'AI assistant', 'Sync', 'Shortcuts', 'Storage'])
    expect(within(nav).getByRole('combobox', {name: /^Theme,/})).toBeInTheDocument()
    for (const l of ['Documentation', 'Request a feature', 'Report a bug', 'Release notes', 'Support VVTerm']) {
      expect(within(nav).getByRole('button', {name: new RegExp(l)})).toBeInTheDocument()
    }
    expect(await screen.findByTestId('app-version')).toHaveTextContent('1.1.0-test')
  })

  it('closes with the red dot and with Escape', async () => {
    const {onClose} = setup()
    await userEvent.click(screen.getByRole('button', {name: 'Close settings'}))
    expect(onClose).toHaveBeenCalledTimes(1)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('Escape closes an open dropdown first and not the window', async () => {
    const {onClose} = setup()
    await userEvent.click(screen.getByRole('combobox', {name: /^Theme,/}))
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the window can be dragged by its title bar but not by its buttons', () => {
    setup()
    const win = screen.getByRole('dialog', {name: 'Settings'})
    const bar = document.querySelector('.win-title') as HTMLElement
    fireEvent.pointerDown(bar, {clientX: 100, clientY: 100, pointerId: 1})
    fireEvent.pointerMove(bar, {clientX: 160, clientY: 130, pointerId: 1})
    expect(win.style.transform).toBe('translate(60px, 30px)')
    fireEvent.pointerUp(bar, {pointerId: 1})
    fireEvent.pointerMove(bar, {clientX: 400, clientY: 400, pointerId: 1})
    expect(win.style.transform).toBe('translate(60px, 30px)') // released: no more movement
    fireEvent.pointerDown(screen.getByRole('button', {name: 'Close settings'}), {clientX: 5, clientY: 5, pointerId: 1})
    fireEvent.pointerMove(bar, {clientX: 500, clientY: 500, pointerId: 1})
    expect(win.style.transform).toBe('translate(60px, 30px)')
  })

  it('changes the app theme to Auto, Light or Dark from the sidebar dropdown and saves immediately', async () => {
    const {be} = setup()
    for (const mode of ['auto', 'light', 'dark']) {
      await userEvent.selectOptions(screen.getByLabelText('Theme'), mode)
      await waitFor(() => expect(be.state.settings.theme).toBe(mode))
    }
  })

  it('the theme dropdown opens the custom menu', async () => {
    const {be} = setup()
    await userEvent.click(screen.getByRole('combobox', {name: /^Theme,/}))
    await userEvent.click(screen.getByRole('option', {name: 'Light'}))
    await waitFor(() => expect(be.state.settings.theme).toBe('light'))
  })

  it('picks a terminal theme, filters by dark/light, and can go back to "match app"', async () => {
    const {be} = setup()
    await tab('Terminal')
    const group = screen.getByRole('radiogroup', {name: 'Terminal theme'})
    expect(within(group).getByRole('radio', {name: /Match app theme/})).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(within(group).getByRole('radio', {name: 'Dracula'}))
    await waitFor(() => expect(be.state.settings.terminal_theme).toBe('dracula'))
    expect(within(group).getByRole('radio', {name: 'Dracula'})).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('button', {name: 'Light'}))
    expect(within(group).queryByRole('radio', {name: 'Dracula'})).toBeNull()
    expect(within(group).getByRole('radio', {name: 'Solarized Light'})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'All'}))
    await userEvent.click(within(group).getByRole('radio', {name: /Match app theme/}))
    await waitFor(() => expect(be.state.settings.terminal_theme).toBe('auto'))
  })

  it('"Match app theme" always shows the automatic choice, not the selected theme', async () => {
    setup({terminal_theme: 'nord'})
    await tab('Terminal')
    const match = screen.getByRole('radio', {name: /Match app theme/})
    expect(match).toHaveTextContent('VVTerm Dark') // appearance=dark
    expect(match).not.toHaveTextContent('Nord')
  })

  it('the preview uses the chosen theme colours, font and size', async () => {
    setup({terminal_theme: 'nord', font_size: 18})
    await tab('Terminal')
    expect(screen.getByTestId('term-preview')).toHaveStyle({background: '#2e3440', fontSize: '18px'})
  })

  it('font (custom dropdown), size stepper, cursor, blinking and scrollback all persist', async () => {
    const {be} = setup()
    await tab('Terminal')
    await userEvent.click(screen.getByRole('combobox', {name: /^Font family,/}))
    await userEvent.click(screen.getByRole('option', {name: 'JetBrains Mono'}))
    await waitFor(() => expect(be.state.settings.font_family).toContain('JetBrains Mono'))
    await userEvent.click(screen.getByLabelText('Increase font size'))
    await waitFor(() => expect(be.state.settings.font_size).toBe(14))
    await userEvent.click(screen.getByLabelText('Decrease font size'))
    await waitFor(() => expect(be.state.settings.font_size).toBe(13))
    await userEvent.click(screen.getByRole('radio', {name: 'bar'}))
    await waitFor(() => expect(be.state.settings.cursor_style).toBe('bar'))
    await userEvent.click(screen.getByRole('switch', {name: 'Blinking cursor'}))
    await waitFor(() => expect(be.state.settings.cursor_blink).toBe(false))
    const sb = screen.getByLabelText('Scrollback lines')
    await userEvent.clear(sb)
    await userEvent.type(sb, '2500{Enter}')
    await waitFor(() => expect(be.state.settings.scrollback).toBe(2500))
  })

  it('stepper stops at the limits', async () => {
    setup({font_size: 8})
    await tab('Terminal')
    expect(screen.getByLabelText('Decrease font size')).toBeDisabled()
  })

  it('shows a backend validation error as a toast and keeps the old value', async () => {
    const {be} = setup()
    await tab('Terminal')
    be.settings.save = async () => { throw 'scrollback must be between 500 and 100000 lines' }
    const sb = screen.getByLabelText('Scrollback lines')
    await userEvent.clear(sb)
    await userEvent.type(sb, '5{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('scrollback must be')
    expect(be.state.settings.scrollback).toBe(10000)
  })

  it('security: "ask on open" shows only with Touch ID turned on, and can be switched off', async () => {
    setup()
    await tab('Security')
    expect(screen.queryByRole('switch', {name: 'Ask on open'})).toBeNull()
  })

  it('security: with Touch ID on, "ask on open" is a switch that is saved', async () => {
    const {be} = setup({biometric_on_open: true}, {...vaultSt, biometric_available: true, keychain_enabled: true})
    await tab('Security')
    await userEvent.click(screen.getByRole('switch', {name: 'Ask on open'}))
    await waitFor(() => expect(be.state.settings.biometric_on_open).toBe(false))
  })

  it('Ctrl+1…8 jump to a category and Ctrl+Tab goes round them, with the keys shown on the tabs', async () => {
    setup()
    const key = (init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})) })
    const on = () => screen.getByRole('tab', {selected: true}).textContent
    expect(screen.getByRole('tab', {name: /^Security/})).toHaveTextContent('Ctrl+4')
    key({key: '4', code: 'Digit4', ctrlKey: true})
    expect(on()).toMatch(/^Security/)
    key({key: '8', code: 'Digit8', ctrlKey: true})
    expect(on()).toMatch(/^Storage/)
    key({key: 'Tab', code: 'Tab', ctrlKey: true}) // after the last one comes the first
    expect(on()).toMatch(/^General/)
    key({key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true}) // and back
    expect(on()).toMatch(/^Storage/)
  })

  it('security: a password hint can be saved', async () => {
    const {be, onVault} = setup()
    await tab('Security')
    const save = screen.getAllByRole('button', {name: 'Save'}).at(-1)!
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Password hint'), 'three random words')
    await userEvent.click(save)
    await waitFor(() => expect(be.state.vault.hint).toBe('three random words'))
    expect(onVault).toHaveBeenCalled()
  })

  it('security: auto-lock, keychain switch and password change', async () => {
    const {be, onVault} = setup()
    await tab('Security')
    const al = screen.getByLabelText('Auto-lock minutes')
    await userEvent.clear(al)
    await userEvent.type(al, '5')
    await userEvent.click(screen.getByRole('button', {name: 'Apply'}))
    await waitFor(() => expect(be.state.calls).toContainEqual(['vault.setAutoLock', 5]))
    await userEvent.click(screen.getByRole('switch', {name: 'Keychain unlock'}))
    await waitFor(() => expect(be.state.vault.keychain_enabled).toBe(true))
    expect(onVault).toHaveBeenCalled()

    const btn = screen.getByRole('button', {name: 'Change password'})
    await userEvent.type(screen.getByLabelText('Current password'), 'wrong one')
    await userEvent.type(screen.getByLabelText('New password'), 'short')
    expect(btn).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('New password'))
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new password')
    await userEvent.click(btn)
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect master password. Please check it and try again.')
    await userEvent.clear(screen.getByLabelText('Current password'))
    await userEvent.type(screen.getByLabelText('Current password'), be.state.password)
    await userEvent.click(btn)
    await waitFor(() => expect(be.state.password).toBe('a brand new password'))
  })

  it('sync is shown inside the window', async () => {
    const {be} = setup()
    await tab('Sync')
    expect(await screen.findByLabelText('Repository URL')).toHaveValue('git@example.com:me/sync.git')
    await userEvent.click(screen.getByRole('button', {name: 'Sync now'}))
    await waitFor(() => expect(be.state.calls.some(c => c[0] === 'sync.syncNow')).toBe(true))
  })

  it('help links open only the project pages', async () => {
    const {be} = setup()
    await userEvent.click(screen.getByRole('button', {name: /Report a bug/}))
    expect(be.state.calls).toContainEqual(['system.openUrl', 'https://github.com/vunguyenvu35/vvterm/issues/new'])
  })

  it('Support VVTerm opens Ko-fi and the USDT addresses (QR code, Copy)', async () => {
    const {be} = setup()
    await userEvent.click(screen.getByRole('button', {name: 'Support VVTerm'}))
    const dlg = await screen.findByRole('dialog', {name: 'Support VVTerm'})
    expect(within(dlg).getByText('TMXXHRNG7qauoFWJKYbqEbd4FGgt3DgjBK')).toBeInTheDocument()
    expect(within(dlg).getByText('0x4bdfd1d6456c28d06e3f8456ddac59e6168e5153')).toBeInTheDocument()
    expect(within(dlg).getAllByRole('img')).toHaveLength(2)
    await userEvent.click(within(dlg).getByRole('button', {name: 'Support on Ko-fi'}))
    expect(be.state.calls).toContainEqual(['system.openUrl', 'https://ko-fi.com/vunguyenvu'])
    await userEvent.click(within(dlg).getByRole('button', {name: 'Copy USDT · Tron address'}))
    await waitFor(() => expect(be.state.calls).toContainEqual(['system.writeClipboard', 'TMXXHRNG7qauoFWJKYbqEbd4FGgt3DgjBK']))
    await userEvent.keyboard('{Escape}') // closes the dialog, not the whole Settings window
    expect(screen.queryByRole('dialog', {name: 'Support VVTerm'})).toBeNull()
    expect(screen.getByRole('navigation', {name: 'Settings menu'})).toBeInTheDocument()
  })
})

describe('SettingsWindow: window controls', () => {
  const win = () => screen.getByRole('dialog', {name: 'Settings'})

  it('maximise fills the screen, restore goes back, and the title bar double-click does the same', async () => {
    setup()
    expect(win()).not.toHaveClass('max')
    await userEvent.click(screen.getByRole('button', {name: 'Maximize settings'}))
    expect(win()).toHaveClass('max')
    expect(win().closest('.win-back')).toHaveClass('maximized')
    expect(win().style.transform).toBe('') // no leftover drag offset while maximised
    await userEvent.click(screen.getByRole('button', {name: 'Restore settings'}))
    expect(win()).not.toHaveClass('max')
    fireEvent.doubleClick(document.querySelector('.win-title') as HTMLElement)
    expect(win()).toHaveClass('max')
    fireEvent.doubleClick(document.querySelector('.win-title') as HTMLElement)
    expect(win()).not.toHaveClass('max')
  })

  it('maximised, the in-app dots give way to Restore and Close on the right (the native macOS buttons own the top left)', async () => {
    const {onClose} = setup()
    expect(document.querySelector('.win-dots')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', {name: 'Maximize settings'}))
    expect(document.querySelector('.win-dots')).toBeNull()
    expect(screen.queryByRole('button', {name: 'Minimize settings'})).toBeNull()
    await userEvent.click(screen.getByRole('button', {name: 'Close settings'}))
    expect(onClose).toHaveBeenCalled()
  })

  it('minimise rolls the window up to its title bar and unrolls it again, keeping the chosen tab', async () => {
    setup()
    await tab('Security')
    await userEvent.click(screen.getByRole('button', {name: 'Minimize settings'}))
    expect(win()).toHaveClass('rolled')
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', {name: 'Close settings'})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Unroll settings'}))
    expect(win()).not.toHaveClass('rolled')
    expect(screen.getByRole('tab', {name: 'Security', selected: true})).toBeInTheDocument()
  })

  it('a maximised window cannot be dragged, and maximising resets its position', () => {
    setup()
    const bar = document.querySelector('.win-title') as HTMLElement
    fireEvent.pointerDown(bar, {clientX: 100, clientY: 100, pointerId: 1})
    fireEvent.pointerMove(bar, {clientX: 150, clientY: 150, pointerId: 1})
    fireEvent.pointerUp(bar, {pointerId: 1})
    expect(win().style.transform).toBe('translate(50px, 50px)')
    fireEvent.click(screen.getByRole('button', {name: 'Maximize settings'}))
    fireEvent.pointerDown(bar, {clientX: 100, clientY: 100, pointerId: 1})
    fireEvent.pointerMove(bar, {clientX: 300, clientY: 300, pointerId: 1})
    expect(win().style.transform).toBe('')
    fireEvent.click(screen.getByRole('button', {name: 'Restore settings'}))
    expect(win().style.transform).toBe('translate(0px, 0px)')
  })

  it('the window is resizable by CSS (corner handle) with sane limits', () => {
    const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8')
    const rule = css.match(/\n\.win \{ resize: both;([^}]*)\}/)![1]
    expect(rule).toMatch(/min-width:\s*640px/)
    expect(rule).toMatch(/max-width:\s*98vw/)
  })
})

describe('SettingsWindow: General', () => {
  it('opens on General with zoom, reduce motion and confirm-before-close', () => {
    setup()
    expect(screen.getByRole('tab', {name: 'General', selected: true})).toBeInTheDocument()
    expect(screen.getByLabelText('Zoom level')).toHaveTextContent('100%')
    expect(screen.getByRole('switch', {name: 'Confirm before closing a tab'})).toHaveAttribute('aria-checked', 'false') // closing a tab does not ask unless you want it to
    expect(screen.getByRole('switch', {name: 'Reduce motion'})).toHaveAttribute('aria-checked', 'false')
  })

  it('zoom steps by 10%, stops at 80% and 160%, and resets', async () => {
    const {be} = setup({zoom: 100})
    await userEvent.click(screen.getByRole('button', {name: 'Zoom in'}))
    await waitFor(() => expect(be.state.settings.zoom).toBe(110))
    await userEvent.click(screen.getByRole('button', {name: 'Reset zoom'}))
    await waitFor(() => expect(be.state.settings.zoom).toBe(100))
    expect(screen.getByRole('button', {name: 'Reset zoom'})).toBeDisabled()
    for (let i = 0; i < 2; i++) await userEvent.click(screen.getByRole('button', {name: 'Zoom out'}))
    await waitFor(() => expect(be.state.settings.zoom).toBe(80))
    expect(screen.getByRole('button', {name: 'Zoom out'})).toBeDisabled()
  })

  it('zoom in is disabled at 160%', () => {
    setup({zoom: 160})
    expect(screen.getByRole('button', {name: 'Zoom in'})).toBeDisabled()
  })

  it('the switches persist', async () => {
    const {be} = setup()
    await userEvent.click(screen.getByRole('switch', {name: 'Reduce motion'}))
    await waitFor(() => expect(be.state.settings.reduce_motion).toBe(true))
    await userEvent.click(screen.getByRole('switch', {name: 'Confirm before closing a tab'}))
    await waitFor(() => expect(be.state.settings.confirm_tab_close).toBe(true))
  })
})

describe('SettingsWindow: Account', () => {
  it('shows a local profile, the free plan and the not-yet features', async () => {
    setup()
    await tab('Account')
    expect(screen.getByLabelText('Display name')).toHaveValue('')
    expect(screen.getByText('free · open source')).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Sign in'})).toBeDisabled()
    expect(screen.getByText('coming later')).toBeInTheDocument()
    expect(screen.getByText(/stored only on this Mac/i)).toBeInTheDocument()
  })

  it('saves the profile only when it changed, and shows the initial as the avatar', async () => {
    const {be} = setup({account_name: 'Vu Nguyen', account_email: 'vu@example.com'})
    await tab('Account')
    const save = screen.getByRole('button', {name: 'Save profile'})
    expect(save).toBeDisabled()
    const name = screen.getByLabelText('Display name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Ada')
    expect(save).toBeEnabled()
    await userEvent.click(save)
    await waitFor(() => expect(be.state.settings.account_name).toBe('Ada'))
    expect(document.querySelector('.avatar')).toHaveTextContent('A')
  })

  it('reports an invalid email from the backend', async () => {
    const {be} = setup()
    be.settings.save = async () => { throw 'enter a valid email address' }
    await tab('Account')
    await userEvent.type(screen.getByLabelText('Email'), 'nope')
    await userEvent.click(screen.getByRole('button', {name: 'Save profile'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('valid email')
  })
})

describe('SettingsWindow: Shortcuts', () => {
  const chip = (label: string) => screen.getByRole('button', {name: new RegExp('^Change shortcut for ' + label)})
  const press = (opts: KeyboardEventInit & {key: string; code?: string}) => fireEvent.keyDown(window, opts)
  const WAIT = {timeout: 3000} // a one-step shortcut is kept after a short wait for a second step

  it('a second key right after the first makes a two-step shortcut (Ctrl+K, then M)', async () => {
    const {be} = setup()
    await tab('Shortcuts')
    await userEvent.click(chip('Lock the vault'))
    press({key: 'k', code: 'KeyK', ctrlKey: true})
    expect(screen.getByRole('status')).toHaveTextContent('then press another key')
    press({key: 'm', code: 'KeyM'}) // no modifier needed on the second step
    await waitFor(() => expect(be.state.settings.shortcuts).toEqual({lock_vault: 'Mod+K M'}))
    expect(chip('Lock the vault')).toHaveAccessibleName(/now Ctrl\+K M$/)
    expect(within(chip('Lock the vault')).getByText('then')).toBeInTheDocument()
  })

  it('a one-step shortcut cannot take the first step of a two-step one, and the other way round', async () => {
    setup({shortcuts: {zoom_in: 'Mod+K M'}})
    await tab('Shortcuts')
    await userEvent.click(chip('Lock the vault'))
    press({key: 'k', code: 'KeyK', ctrlKey: true})
    expect(await screen.findByRole('alert')).toHaveTextContent('Already used by “Zoom in”')
    // and a second chord may share the first step
    press({key: 'j', code: 'KeyJ', ctrlKey: true})
    press({key: 'x', code: 'KeyX'})
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('lists every action with its default and the fixed shortcuts', async () => {
    setup()
    await tab('Shortcuts')
    expect(chip('Open settings')).toHaveAccessibleName(/now Ctrl\+,$/)
    expect(chip('Zoom in')).toHaveAccessibleName(/now Ctrl\+=$/)
    expect(within(chip('Zoom in')).getAllByText(/^(Ctrl|=)$/)).toHaveLength(2) // one key cap for each key
    expect(screen.getByText('Esc')).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Reset all'})).toBeDisabled()
  })

  it('records a new shortcut and saves only the difference from the default', async () => {
    const {be} = setup()
    await tab('Shortcuts')
    await userEvent.click(chip('Lock the vault'))
    expect(screen.getByRole('status')).toHaveTextContent('Press the new shortcut')
    press({key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true})
    await waitFor(() => expect(be.state.settings.shortcuts).toEqual({lock_vault: 'Mod+Shift+K'}), WAIT) // kept once no second step comes
    expect(chip('Lock the vault')).toHaveAccessibleName(/now Ctrl\+Shift\+K$/)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('refuses a duplicate and says which action uses it', async () => {
    const {be} = setup()
    await tab('Shortcuts')
    await userEvent.click(chip('Lock the vault'))
    press({key: ',', code: 'Comma', ctrlKey: true}) // Open settings already uses Ctrl+,
    expect(await screen.findByRole('alert')).toHaveTextContent('Already used by “Open settings”')
    expect(be.state.settings.shortcuts).toEqual({})
    expect(screen.getByRole('status')).toBeInTheDocument() // still recording: try another key
  })

  it('refuses a plain key, accepts after a valid one', async () => {
    const {be} = setup()
    await tab('Shortcuts')
    await userEvent.click(chip('Lock the vault'))
    press({key: 'k', code: 'KeyK'})
    expect(await screen.findByRole('alert')).toHaveTextContent('Ctrl, Alt')
    press({key: 'j', code: 'KeyJ', altKey: true})
    await waitFor(() => expect(be.state.settings.shortcuts).toEqual({lock_vault: 'Alt+J'}), WAIT)
  })

  it('modifier-only presses are ignored; Esc cancels without touching the window', async () => {
    const {be, onClose} = setup()
    await tab('Shortcuts')
    await userEvent.click(chip('Lock the vault'))
    press({key: 'Control', code: 'ControlLeft', ctrlKey: true})
    expect(screen.queryByRole('alert')).toBeNull()
    press({key: 'Escape', code: 'Escape'})
    expect(screen.queryByRole('status')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(be.state.settings.shortcuts).toEqual({})
  })

  it('choosing the default again removes the override; reset and reset-all work', async () => {
    const {be} = setup({shortcuts: {lock_vault: 'Alt+J', zoom_in: 'Alt+Z'}})
    await tab('Shortcuts')
    await userEvent.click(screen.getByRole('button', {name: 'Reset shortcut for Lock the vault'}))
    await waitFor(() => expect(be.state.settings.shortcuts).toEqual({zoom_in: 'Alt+Z'}))
    await userEvent.click(screen.getByRole('button', {name: 'Reset all'}))
    await waitFor(() => expect(be.state.settings.shortcuts).toEqual({}))
    await userEvent.click(chip('Lock the vault'))
    press({key: 'l', code: 'KeyL', ctrlKey: true}) // the default: nothing to store
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), WAIT)
    expect(be.state.settings.shortcuts).toEqual({})
  })

  it('tells the global handler to stay quiet while recording', async () => {
    const {capture} = await import('../shortcuts/shortcuts')
    setup()
    await tab('Shortcuts')
    expect(capture.active).toBe(false)
    await userEvent.click(chip('Zoom out'))
    expect(capture.active).toBe(true)
    press({key: 'Escape', code: 'Escape'})
    await waitFor(() => expect(capture.active).toBe(false))
  })
})

describe('Switch', () => {
  it('toggles and exposes its state', async () => {
    const onChange = vi.fn()
    const {rerender} = render(<Switch label="Demo" checked={false} onChange={onChange} />)
    const sw = screen.getByRole('switch', {name: 'Demo'})
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<Switch label="Demo" checked onChange={onChange} />)
    expect(screen.getByRole('switch', {name: 'Demo'})).toHaveAttribute('aria-checked', 'true')
    rerender(<Switch label="Demo" checked disabled onChange={onChange} />)
    expect(screen.getByRole('switch', {name: 'Demo'})).toBeDisabled()
  })
})

describe('SettingsWindow: Highlight output', () => {
  it('is on by default in the Terminal tab and can be switched off', async () => {
    const {be} = setup()
    await tab('Terminal')
    const sw = screen.getByRole('switch', {name: 'Highlight output'})
    expect(sw).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(sw)
    await waitFor(() => expect(be.state.settings.highlight).toBe(false))
  })
})

describe('SettingsWindow: Storage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('clears the cache and says what was removed', async () => {
    const {be} = setup()
    await tab('Storage')
    await userEvent.click(screen.getByRole('button', {name: 'Clear cache'}))
    expect(await screen.findByText('Cache cleared: 3 files, 5.0 KB')).toBeInTheDocument()
    expect(be.state.calls.some(c => c[0] === 'settings.clearCache')).toBe(true)
  })

  it('asks before resetting, and a "no" changes nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const {be} = setup({zoom: 140})
    await tab('Storage')
    await userEvent.click(screen.getByRole('button', {name: 'Reset settings…'}))
    expect(be.state.calls.some(c => c[0] === 'settings.reset')).toBe(false)
    expect(be.state.settings.zoom).toBe(140)
  })

  it('resets the preferences, keeps the profile and shows the defaults again', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const {be, onVault} = setup({zoom: 140, scrollback: 2000, account_name: 'Vu'})
    await tab('Storage')
    await userEvent.click(screen.getByRole('button', {name: 'Reset settings…'}))
    expect(await screen.findByText('Settings reset to their defaults')).toBeInTheDocument()
    expect(be.state.settings.zoom).toBe(100)
    expect(be.state.settings.account_name).toBe('Vu')
    expect(onVault).toHaveBeenCalled()
    await tab('General')
    expect(screen.getByLabelText('Zoom level')).toHaveTextContent('100%')
  })
})

describe('SettingsWindow: Suggest commands', () => {
  it('is on, reads no host history by default, and the history switch waits for the first one', async () => {
    const {be} = setup()
    await tab('Terminal')
    const on = screen.getByRole('switch', {name: 'Suggest commands'})
    const host = screen.getByRole('switch', {name: "Suggest from the host's shell history"})
    expect(on).toHaveAttribute('aria-checked', 'true')
    expect(host).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(host)
    expect(be.state.settings.suggest_host).toBe(true)
    await userEvent.click(on)
    expect(be.state.settings.suggest).toBe(false)
    expect(screen.getByRole('switch', {name: "Suggest from the host's shell history"})).toBeDisabled()
  })
})
