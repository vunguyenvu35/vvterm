import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {UnlockScreen} from './UnlockScreen'
import {makeFake, Providers} from '../../test/fakeBackend'

const status = (o = {}) => ({exists: true, unlocked: false, keychain_enabled: false, auto_lock_minutes: 15, ...o})

function setup(s = status()) {
  const be = makeFake({vault: s})
  const done = vi.fn()
  render(<Providers be={be}><UnlockScreen status={s} onDone={done} /></Providers>)
  return {be, done}
}

describe('UnlockScreen', () => {
  it('unlocks with the right password', async () => {
    const {be, done} = setup()
    await userEvent.type(screen.getByLabelText('Master password'), 'correct horse battery')
    await userEvent.click(screen.getByRole('button', {name: 'Unlock'}))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(be.state.vault.unlocked).toBe(true)
  })

  it('shows the backend error for a wrong password and stays locked', async () => {
    const {done} = setup()
    await userEvent.type(screen.getByLabelText('Master password'), 'nope nope nope')
    await userEvent.click(screen.getByRole('button', {name: 'Unlock'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong master password')
    expect(done).not.toHaveBeenCalled()
  })

  it('creation requires 12+ characters and a matching confirmation', async () => {
    const {be, done} = setup(status({exists: false}))
    expect(screen.getByText(/cannot be recovered/i)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Master password'), 'short')
    await userEvent.type(screen.getByLabelText('Confirm password'), 'short')
    await userEvent.click(screen.getByRole('button', {name: 'Create vault'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 12')

    await userEvent.clear(screen.getByLabelText('Master password'))
    await userEvent.type(screen.getByLabelText('Master password'), 'a long master password')
    await userEvent.click(screen.getByRole('button', {name: 'Create vault'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match')

    await userEvent.clear(screen.getByLabelText('Confirm password'))
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a long master password')
    await userEvent.click(screen.getByRole('button', {name: 'Create vault'}))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(be.state.calls.filter(c => c[0] === 'vault.create')).toHaveLength(1)
  })

  it('offers keychain unlock only when enabled', async () => {
    setup()
    expect(screen.queryByRole('button', {name: 'Use keychain'})).toBeNull()
  })

  it('keychain unlock works', async () => {
    const {be, done} = setup(status({keychain_enabled: true}))
    await userEvent.click(screen.getByRole('button', {name: 'Use keychain'}))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(be.state.calls.some(c => c[0] === 'vault.unlockBiometric')).toBe(true)
  })
})

describe('UnlockScreen: forgot password', () => {
  it('is offered when unlocking but not when creating', () => {
    setup()
    expect(screen.getByRole('button', {name: 'Forgot password?'})).toBeInTheDocument()
  })

  it('is not offered on the create form', () => {
    setup(status({exists: false}))
    expect(screen.queryByRole('button', {name: 'Forgot password?'})).toBeNull()
  })

  it('explains honestly that the password cannot be recovered and what a reset keeps and erases', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', {name: 'Forgot password?'}))
    const box = screen.getByRole('group', {name: 'Forgot master password'})
    expect(box).toHaveTextContent('cannot be recovered')
    expect(box).toHaveTextContent('erases every saved key and password')
    expect(box).toHaveTextContent('keeps your hosts, groups, snippets')
    expect(box).toHaveTextContent('encrypted backup')
  })

  it('the reset button stays disabled until RESET is typed exactly', async () => {
    const {be} = setup()
    await userEvent.click(screen.getByRole('button', {name: 'Forgot password?'}))
    const btn = screen.getByRole('button', {name: 'Erase vault and start over'})
    expect(btn).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'reset')
    expect(btn).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Type RESET to confirm'))
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'RESET')
    expect(btn).toBeEnabled()
    expect(be.state.calls.some(c => c[0] === 'vault.resetVault')).toBe(false)
  })

  it('resets, tells the user what happened and turns into the create form', async () => {
    const {be, done} = setup()
    await userEvent.click(screen.getByRole('button', {name: 'Forgot password?'}))
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'RESET')
    await userEvent.click(screen.getByRole('button', {name: 'Erase vault and start over'}))
    await waitFor(() => expect(done).toHaveBeenCalled())
    expect(be.state.calls).toContainEqual(['vault.resetVault', 'RESET'])
    expect(be.state.vault.exists).toBe(false)
  })

  it('pressing Enter in the confirmation field resets only when RESET is typed, and never tries to unlock', async () => {
    const {be} = setup()
    await userEvent.click(screen.getByRole('button', {name: 'Forgot password?'}))
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'nope{Enter}')
    expect(be.state.calls.length).toBe(0)
  })

  it('Back returns to the unlock form and clears the confirmation', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', {name: 'Forgot password?'}))
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'RES')
    await userEvent.click(screen.getByRole('button', {name: 'Back'}))
    expect(screen.getByLabelText('Master password')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Forgot password?'}))
    expect(screen.getByLabelText('Type RESET to confirm')).toHaveValue('')
  })

  it('shows backend errors', async () => {
    const {be} = setup()
    be.vault.resetVault = async () => { throw 'boom' }
    await userEvent.click(screen.getByRole('button', {name: 'Forgot password?'}))
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'RESET')
    await userEvent.click(screen.getByRole('button', {name: 'Erase vault and start over'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })
})

describe('UnlockScreen: dragging the window', () => {
  it('has a drag strip, and a double click on it zooms the window', async () => {
    const be = makeFake()
    render(<Providers be={be}><UnlockScreen status={{exists: true, unlocked: false, keychain_enabled: false, auto_lock_minutes: 15}} onDone={vi.fn()} /></Providers>)
    const bar = screen.getByTestId('drag-bar')
    expect(bar.closest('.gate')).not.toBeNull()
    await userEvent.dblClick(bar)
    expect(be.state.calls.filter(c => c[0] === 'system.toggleMaximise')).toHaveLength(1)
  })

  it('the strip is part of the create-vault screen too', () => {
    const be = makeFake()
    render(<Providers be={be}><UnlockScreen status={{exists: false, unlocked: false, keychain_enabled: false, auto_lock_minutes: 15}} onDone={vi.fn()} /></Providers>)
    expect(screen.getByTestId('drag-bar')).toBeInTheDocument()
  })
})
