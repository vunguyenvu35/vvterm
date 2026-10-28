import type {ReactNode} from 'react'
import {Brand} from '../ui/Brand'
import {IconBraces, IconData, IconForward, IconGear, IconKey, IconLock, IconServer} from '../ui/Icons'

export type Page = 'hosts' | 'keychain' | 'forwards' | 'snippets'

interface Props {
  page: Page
  onPage(p: Page): void
  onData(): void
  /** the Settings window is open */
  settingsOpen?: boolean
  onSettings(): void
  onLock(): void
}

function Item(p: {icon: ReactNode; label: string; active?: boolean; onClick(): void}) {
  return (
    <button className={'nav-item' + (p.active ? ' active' : '')} aria-label={p.label} title={p.label} aria-current={p.active ? 'page' : undefined} onClick={p.onClick}>
      {p.icon}<span>{p.label}</span>
    </button>
  )
}

/** Left navigation. Pages switch the main area; Import/Export, Sync and Settings open panels. */
export function Nav(p: Props) {
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav-brand"><Brand /></div>
      <div className="nav-group">
        <Item icon={<IconServer />} label="Hosts" active={p.page === 'hosts'} onClick={() => p.onPage('hosts')} />
        <Item icon={<IconKey />} label="Keychain" active={p.page === 'keychain'} onClick={() => p.onPage('keychain')} />
        <Item icon={<IconForward />} label="Port Forwarding" active={p.page === 'forwards'} onClick={() => p.onPage('forwards')} />
        <Item icon={<IconBraces />} label="Snippets" active={p.page === 'snippets'} onClick={() => p.onPage('snippets')} />
      </div>
      <div className="nav-group bottom">
        <Item icon={<IconData />} label="Import / Export" onClick={p.onData} />
        <Item icon={<IconGear />} label="Settings" active={!!p.settingsOpen} onClick={p.onSettings} />
        <Item icon={<IconLock />} label="Lock vault" onClick={p.onLock} />
      </div>
    </nav>
  )
}
