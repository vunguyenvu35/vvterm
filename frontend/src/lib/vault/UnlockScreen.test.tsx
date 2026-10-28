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
