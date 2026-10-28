import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {BAUD_RATES, SerialPanel, portName} from './SerialPanel'
import {makeFake, Providers} from '../../test/fakeBackend'

function setup(ports?: string[]) {
  const be = makeFake(ports ? {serialPorts: ports} : {})
  const onConnect = vi.fn(), onClose = vi.fn()
  render(<Providers be={be}><SerialPanel onClose={onClose} onConnect={onConnect} /></Providers>)
  return {be, onConnect, onClose}
}

describe('SerialPanel', () => {
  it('lists the ports found, picks the first and defaults to 115200', async () => {
    const {onConnect} = setup()
    expect(await screen.findByRole('combobox', {name: /^Serial port, cu\.usbserial-1410/})).toBeInTheDocument()
    expect(screen.getByRole('combobox', {name: /^Baud rate, 115200/})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Connect'}))
    expect(onConnect).toHaveBeenCalledWith('/dev/cu.usbserial-1410', 115200)
  })

  it('connects to the chosen port at the chosen speed', async () => {
    const {onConnect} = setup()
    await userEvent.selectOptions(await screen.findByLabelText('Serial port'), '/dev/cu.usbmodem1101')
    await userEvent.selectOptions(screen.getByLabelText('Baud rate'), '9600')
    await userEvent.click(screen.getByRole('button', {name: 'Connect'}))
    expect(onConnect).toHaveBeenCalledWith('/dev/cu.usbmodem1101', 9600)
  })

  it('says so when there are no ports, disables Connect, and finds a device after Refresh', async () => {
    const {be} = setup([])
    expect(await screen.findByText(/No serial ports found/)).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Connect'})).toBeDisabled()
    be.state.serialPorts = ['/dev/cu.new']
    await userEvent.click(screen.getByRole('button', {name: 'Refresh'}))
    expect(await screen.findByRole('combobox', {name: /^Serial port, cu\.new/})).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Connect'})).toBeEnabled()
  })

  it('shows a backend error and stays usable', async () => {
    const be = makeFake()
    be.serial.ports = async () => { throw 'permission denied' }
    render(<Providers be={be}><SerialPanel onClose={vi.fn()} onConnect={vi.fn()} /></Providers>)
    expect(await screen.findByRole('alert')).toHaveTextContent('permission denied')
    expect(screen.getByRole('button', {name: 'Connect'})).toBeDisabled()
  })

  it('names ports and offers the usual speeds', () => {
    expect(portName('/dev/cu.usbserial-1410')).toBe('cu.usbserial-1410')
    expect(portName('COM3')).toBe('COM3')
    expect(BAUD_RATES).toContain(115200)
    expect(BAUD_RATES).toEqual([...BAUD_RATES].sort((a, b) => a - b))
  })
})
