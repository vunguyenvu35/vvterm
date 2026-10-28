import {render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {formatMode, parseMode, PermissionsDialog} from './Permissions'

describe('permission modes', () => {
  it('reads and writes rwx strings', () => {
    expect(parseMode('-rw-r--r--')).toBe(0o644)
    expect(parseMode('drwxr-xr-x')).toBe(0o755)
    expect(parseMode('-rwx------')).toBe(0o700)
    expect(parseMode('')).toBe(0o644)
    expect(formatMode(0o640)).toBe('rw-r-----')
  })
})

describe('PermissionsDialog', () => {
  it('shows the current bits, changes them with the grid or the octal box, and saves', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()
    render(<PermissionsDialog name="a.log" mode="-rw-r--r--" onSave={onSave} onClose={onClose} />)
    expect(screen.getByLabelText('Octal permissions')).toHaveValue('644')
    expect(screen.getByLabelText('Owner write')).toBeChecked()
    expect(screen.getByLabelText('Group write')).not.toBeChecked()
    await userEvent.click(screen.getByLabelText('Group write'))
    await userEvent.click(screen.getByLabelText('Others read'))
    expect(screen.getByLabelText('Octal permissions')).toHaveValue('660')
    await userEvent.clear(screen.getByLabelText('Octal permissions'))
    await userEvent.type(screen.getByLabelText('Octal permissions'), '755')
    expect(screen.getByLabelText('Owner execute')).toBeChecked()
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(onSave).toHaveBeenCalledWith(0o755)
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the dialog open and says why when saving fails', async () => {
    const onClose = vi.fn()
    render(<PermissionsDialog name="a" mode="-rw-r--r--" onSave={() => Promise.reject(new Error('permission denied'))} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
    expect(onClose).not.toHaveBeenCalled()
  })
})
