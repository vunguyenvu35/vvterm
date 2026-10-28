import {useCallback, useEffect, useState} from 'react'
import {Section, SidePanel} from '../ui/Modal'
import {Select} from '../ui/Select'
import {useBackend} from '../backend'
import {errMsg} from '../util'

export const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]

/** "/dev/cu.usbserial-1410" → "cu.usbserial-1410" for tab titles. */
export const portName = (path: string) => path.replace(/^\/dev\//, '')

/** Docked panel to open a serial port (USB adapter, router console, board) in a terminal tab. */
export function SerialPanel({onClose, onConnect}: {onClose(): void; onConnect(path: string, baud: number): void}) {
  const be = useBackend()
  const [ports, setPorts] = useState<string[] | null>(null)
  const [port, setPort] = useState('')
  const [baud, setBaud] = useState('115200')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    setErr('')
    try {
      const list = (await be.serial.ports()) ?? []
      setPorts(list)
      setPort(p => (list.includes(p) ? p : list[0] ?? ''))
    } catch (e) {
      setPorts([])
      setErr(errMsg(e))
    }
  }, [be])
  useEffect(() => { void refresh() }, [refresh])

  return (
    <SidePanel title="Serial" onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!port} onClick={() => onConnect(port, Number(baud))}>Connect</button></>}>
      <Section title="Port">
        {ports === null && <div className="muted">Looking for serial ports…</div>}
        {ports && ports.length === 0 && <div className="muted">No serial ports found. Plug the device in, then refresh.</div>}
        {ports && ports.length > 0 && <Select label="Serial port" value={port} onChange={setPort} options={ports.map(p => ({value: p, label: portName(p), hint: p}))} />}
        <button onClick={refresh}>Refresh</button>
      </Section>
      <Section title="Speed">
        <Select label="Baud rate" value={baud} onChange={setBaud} options={BAUD_RATES.map(b => ({value: String(b), label: String(b), hint: b === 115200 ? 'common default' : b === 9600 ? 'classic default' : undefined}))} />
        <div className="muted">8 data bits, no parity, 1 stop bit: what almost every device uses.</div>
      </Section>
      {err && <div className="error" role="alert">{err}</div>}
    </SidePanel>
  )
}
