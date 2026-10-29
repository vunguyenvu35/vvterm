import {Modal} from '../ui/Modal'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {errMsg} from '../util'

const KOFI = 'https://ko-fi.com/vunguyenvu'

export const DONATE_NETWORKS = [
  {id: 'tron', name: 'USDT · Tron', chain: 'TRC20', address: 'TMXXHRNG7qauoFWJKYbqEbd4FGgt3DgjBK', qr: '/donate/usdt-tron.png'},
  {id: 'bsc', name: 'USDT · BSC', chain: 'BEP20', address: '0x4bdfd1d6456c28d06e3f8456ddac59e6168e5153', qr: '/donate/usdt-bsc.png'},
]

/** Support VVTerm: Ko-fi, the suggested amounts, and the USDT addresses as QR codes with a Copy button. */
export function SupportPanel({onClose}: {onClose(): void}) {
  const be = useBackend()
  const toast = useToast()
  const copy = (address: string, name: string) =>
    void be.system.writeClipboard(address).then(() => toast.info(name + ' address copied')).catch(e => toast.error(errMsg(e)))

  return (
    <Modal title="Support VVTerm" wide onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <div style={{display: 'grid', gap: 16, justifyItems: 'center', textAlign: 'center'}}>
        <div className="muted">VVTerm is free and open source, built and maintained in spare time. If it saves you time, you can help keep it going.</div>
        <div style={{display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center'}}>
          {[['☕', '$3', 'a cup of coffee'], ['🍜', '$10', 'a lunch'], ['🚀', '$25', 'fuel new features']].map(([icon, amount, what]) => (
            <div key={amount} style={{minWidth: 140, padding: '12px 16px', borderRadius: 12, border: '1px solid var(--line, #2c3244)'}}>
              <div style={{fontSize: 26}} aria-hidden="true">{icon}</div>
              <b>{amount}</b>
              <div className="muted">{what}</div>
            </div>
          ))}
        </div>
        <button className="primary" onClick={() => void be.system.openUrl(KOFI)}>Support on Ko-fi</button>
        <div className="muted">Prefer crypto? Scan a code or copy an address, and check the network before you send.</div>
        <div style={{display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'center'}}>
          {DONATE_NETWORKS.map(n => (
            <div key={n.id} style={{display: 'grid', gap: 8, justifyItems: 'center', maxWidth: 320}}>
              <b>{n.name} <span className="muted">({n.chain})</span></b>
              <img src={n.qr} width={170} height={170} alt={`QR code of the ${n.name} address`} style={{borderRadius: 10, background: '#fff'}} />
              <code style={{wordBreak: 'break-all', fontSize: 11, userSelect: 'text'}}>{n.address}</code>
              <button aria-label={`Copy ${n.name} address`} onClick={() => copy(n.address, n.name)}>Copy address</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}
