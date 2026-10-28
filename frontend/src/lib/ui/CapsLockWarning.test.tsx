import {act, fireEvent, render, screen} from '@testing-library/react'
import {CapsLockWarning} from './CapsLockWarning'

function mount() {
  render(
    <>
      <input aria-label="Master password" type="password" />
      <input aria-label="Name" type="text" />
      <CapsLockWarning />
    </>,
  )
}
const key = (type: 'keydown' | 'keyup', caps: boolean) => act(() => { window.dispatchEvent(new KeyboardEvent(type, {key: 'a', modifierCapsLock: caps, bubbles: true})) })

describe('CapsLockWarning', () => {
  it('says so in a password field while Caps Lock is on, and goes away when it is off', () => {
    mount()
    screen.getByLabelText('Master password').focus()
    expect(screen.queryByRole('status')).toBeNull()
    key('keydown', true)
    expect(screen.getByRole('status')).toHaveTextContent('Caps Lock is on')
    key('keyup', false)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('only in password fields, and not after the field lost the focus', () => {
    mount()
    screen.getByLabelText('Name').focus()
    key('keydown', true)
    expect(screen.queryByRole('status')).toBeNull()
    screen.getByLabelText('Master password').focus()
    fireEvent.focusIn(screen.getByLabelText('Master password'))
    key('keydown', true)
    expect(screen.getByRole('status')).toBeInTheDocument()
    screen.getByLabelText('Master password').blur()
    fireEvent.focusOut(screen.getByLabelText('Master password'))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('sits inside the field, at its right edge and centred vertically', () => {
    mount()
    const input = screen.getByLabelText('Master password')
    input.getBoundingClientRect = () => ({top: 100, bottom: 140, left: 20, right: 320, width: 300, height: 40, x: 20, y: 100, toJSON() {}}) as DOMRect
    input.focus()
    key('keydown', true)
    const pill = screen.getByRole('status')
    expect(pill).toHaveStyle({top: '108px'}) // 100 + (40 - 24) / 2
    expect(pill.style.right).toBe(window.innerWidth - 320 + 10 + 'px')
  })

  it('is quiet when the platform cannot tell', () => {
    mount()
    screen.getByLabelText('Master password').focus()
    act(() => { window.dispatchEvent(Object.assign(new KeyboardEvent('keydown', {key: 'a'}), {getModifierState: undefined})) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('the webview\'s own indicator and autofill button are hidden by the stylesheet', async () => {
    const {readFileSync} = await import('node:fs')
    const {join} = await import('node:path')
    const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8')
    expect(css).toMatch(/::-webkit-caps-lock-indicator[^}]*display: none/)
    expect(css).toMatch(/::-webkit-credentials-auto-fill-button/)
  })
})
