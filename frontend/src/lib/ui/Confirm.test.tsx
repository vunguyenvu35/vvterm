import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ConfirmProvider, useConfirm} from './Confirm'

function Ask({message = 'Delete it?', opts}: {message?: string; opts?: Parameters<ReturnType<typeof useConfirm>>[1]}) {
  const confirm = useConfirm()
  return (
    <>
      <button onClick={async () => { document.title = String(await confirm(message, opts)) }}>ask</button>
      <button onClick={async () => { document.title = 'first:' + String(await confirm('first')) }}>ask-first</button>
    </>
  )
}
const mount = (ui = <Ask />) => render(<ConfirmProvider>{ui}</ConfirmProvider>)
const dialog = () => screen.getByRole('alertdialog', {name: 'Confirm'})
const answered = (v: string) => waitFor(() => expect(document.title).toBe(v))

afterEach(() => { document.title = ''; vi.restoreAllMocks() })

describe('in-app confirmation', () => {
  it('shows the question and resolves true on the confirm button, with a custom label', async () => {
    mount(<Ask opts={{confirmLabel: 'Delete', danger: true}} />)
    await userEvent.click(screen.getByText('ask'))
    expect(dialog()).toHaveTextContent('Delete it?')
    expect(screen.getByRole('button', {name: 'Delete'})).toHaveClass('danger')
    await userEvent.click(screen.getByRole('button', {name: 'Delete'}))
    await answered('true')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('resolves false on Cancel, on Esc and on a click outside', async () => {
    mount()
    await userEvent.click(screen.getByText('ask'))
    await userEvent.click(screen.getByRole('button', {name: 'Cancel'}))
    await answered('false')
    document.title = ''
    await userEvent.click(screen.getByText('ask'))
    await userEvent.keyboard('{Escape}')
    await answered('false')
    document.title = ''
    await userEvent.click(screen.getByText('ask'))
    await userEvent.click(document.querySelector('.confirm-back')!)
    await answered('false')
  })

  it('Enter confirms, and the confirm button has the focus', async () => {
    mount()
    await userEvent.click(screen.getByText('ask'))
    expect(screen.getByRole('button', {name: 'OK'})).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await answered('true')
  })

  it('keeps Esc and Enter away from whatever is underneath', async () => {
    const under = vi.fn()
    window.addEventListener('keydown', under)
    mount()
    await userEvent.click(screen.getByText('ask'))
    await userEvent.keyboard('{Escape}')
    await answered('false')
    window.removeEventListener('keydown', under)
    expect(under).not.toHaveBeenCalled()
  })

  it('a newer question replaces an unanswered one, which counts as "no"', async () => {
    mount()
    await userEvent.click(screen.getByText('ask-first'))
    await userEvent.click(screen.getByText('ask')) // clicking behind the dialog is possible via script/keyboard
    await answered('first:false')
    expect(dialog()).toHaveTextContent('Delete it?')
  })

  it('without a provider it falls back to window.confirm', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Ask />)
    await userEvent.click(screen.getByText('ask'))
    await answered('true')
    expect(spy).toHaveBeenCalledWith('Delete it?')
  })
})
