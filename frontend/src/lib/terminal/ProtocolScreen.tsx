import {useState} from 'react'
import {ConnectScreen} from './ConnectScreen'
import type {Host} from '../types'

export type Protocol = 'ssh' | 'telnet'

interface Props {
  host: Host
  onContinue(p: Protocol): void
  onClose(): void
}

/** "Choose protocol": SSH, or Telnet when the host has it (unencrypted, so never the default). */
export function ProtocolScreen({host, onContinue, onClose}: Props) {
  const [choice, setChoice] = useState<Protocol>('ssh')
  const options: {id: Protocol | 'mosh'; name: string; cmd: string; port: number; off?: string}[] = [
    {id: 'ssh', name: 'SSH', cmd: `ssh ${host.hostname}`, port: host.port},
    {id: 'mosh', name: 'Mosh', cmd: `mosh ${host.hostname}`, port: host.port, off: 'Not supported yet'},
    {id: 'telnet', name: 'Telnet', cmd: `telnet ${host.hostname}`, port: host.telnet_port || 23, off: host.telnet_enabled ? undefined : 'Turn it on in the host'},
  ]
  return (
    <ConnectScreen label={host.label} os={host.os} subtitle={host.hostname} step="choose"
      footer={<>
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={() => onContinue(choice)}>Continue</button>
      </>}>
      <h3 className="connect-title">Choose protocol</h3>
      <div className="proto-list" role="radiogroup" aria-label="Protocol">
        {options.map(o => (
          <button key={o.id} role="radio" aria-checked={choice === o.id} aria-disabled={!!o.off} title={o.off} className={'proto ' + o.id + (choice === o.id ? ' on' : '') + (o.off ? ' off' : '')}
            onClick={() => { if (!o.off) setChoice(o.id as Protocol) }} onDoubleClick={() => { if (!o.off) onContinue(o.id as Protocol) }}>
            <span className="proto-main"><b>{o.name}</b><em>{o.cmd}</em></span>
            <span className="proto-port">{o.off ? <em>{o.off}</em> : <>port: <u>{o.port}</u></>}</span>
          </button>
        ))}
      </div>
      {choice === 'telnet' && <div className="muted telnet-warning" role="note">Telnet is not encrypted: what you type, the password included, crosses the network in clear text.</div>}
    </ConnectScreen>
  )
}
