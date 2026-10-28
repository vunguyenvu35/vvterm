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
  const options: {id: Protocol; name: string; cmd: string; port: number}[] = [
    {id: 'ssh', name: 'SSH', cmd: `ssh ${host.hostname}`, port: host.port},
  ]
  if (host.telnet_enabled) options.push({id: 'telnet', name: 'Telnet', cmd: `telnet ${host.hostname}`, port: host.telnet_port || 23})
  return (
    <ConnectScreen label={host.label} os={host.os} subtitle={host.hostname} step="choose"
      footer={<>
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={() => onContinue(choice)}>Continue</button>
      </>}>
      <h3 className="connect-title">Choose protocol</h3>
      <div className="proto-list" role="radiogroup" aria-label="Protocol">
        {options.map(o => (
          <button key={o.id} role="radio" aria-checked={choice === o.id} className={'proto ' + o.id + (choice === o.id ? ' on' : '')} onClick={() => setChoice(o.id)} onDoubleClick={() => onContinue(o.id)}>
            <span className="proto-main"><b>{o.name}</b><em>{o.cmd}</em></span>
            <span className="proto-port">port: <u>{o.port}</u></span>
          </button>
        ))}
      </div>
      {choice === 'telnet' && <div className="muted telnet-warning" role="note">Telnet is not encrypted: what you type, the password included, crosses the network in clear text.</div>}
    </ConnectScreen>
  )
}
