import {ReactNode, useEffect, useState} from 'react'
import {formatCombo} from '../shortcuts/shortcuts'
import {Brand} from '../ui/Brand'
import {IconBraces, IconClock, IconData, IconFingerprint, IconForward, IconGear, IconKey, IconLock, IconServer} from '../ui/Icons'

export type Page = 'hosts' | 'keychain' | 'forwards' | 'snippets' | 'knownhosts' | 'logs'

interface Props {
  page: Page
  onPage(p: Page): void
  onData(): void
  /** the Settings window is open */
  settingsOpen?: boolean
  onSettings(): void
  onLock(): void
  /** the key of every action (see lib/shortcuts): shown at the right of an item while the pointer is on it */
  shortcuts?: Record<string, string>
}

/** the window is so narrow that the labels are hidden (see the CSS): only then does an item need a tooltip */
function useIconsOnly(): boolean {
  const q = '(max-width: 1000px)'
  const [narrow, setNarrow] = useState(() => !!window.matchMedia?.(q).matches)
  useEffect(() => {
    const m = window.matchMedia?.(q)
    if (!m) return
    const on = () => setNarrow(m.matches)
    m.addEventListener?.('change', on)
    return () => m.removeEventListener?.('change', on)
  }, [])
  return narrow
}

function Item(p: {icon: ReactNode; label: string; active?: boolean; combo?: string; iconsOnly?: boolean; onClick(): void}) {
  return (
    <button className={'nav-item' + (p.active ? ' active' : '')} aria-label={p.label} title={p.iconsOnly ? p.label : undefined} aria-keyshortcuts={p.combo} aria-current={p.active ? 'page' : undefined} onClick={p.onClick}>
      {p.icon}<span>{p.label}</span>
      {p.combo && <kbd className="nav-key" aria-hidden="true">{formatCombo(p.combo)}</kbd>}
    </button>
  )
}

/** Left navigation. Pages switch the main area; Import/Export, Sync and Settings open panels. */
export function Nav(p: Props) {
  const k = p.shortcuts ?? {}
  const iconsOnly = useIconsOnly()
  return (
    <nav className="nav" aria-label="Main">
      <div className="nav-brand"><Brand /></div>
      <div className="nav-group">
        <Item icon={<IconServer />} label="Hosts" iconsOnly={iconsOnly} combo={k.go_hosts} active={p.page === 'hosts'} onClick={() => p.onPage('hosts')} />
        <Item icon={<IconKey />} label="Keychain" iconsOnly={iconsOnly} combo={k.go_keychain} active={p.page === 'keychain'} onClick={() => p.onPage('keychain')} />
        <Item icon={<IconForward />} label="Port Forwarding" iconsOnly={iconsOnly} combo={k.go_forwards} active={p.page === 'forwards'} onClick={() => p.onPage('forwards')} />
        <Item icon={<IconBraces />} label="Snippets" iconsOnly={iconsOnly} combo={k.go_snippets} active={p.page === 'snippets'} onClick={() => p.onPage('snippets')} />
        <Item icon={<IconFingerprint />} label="Known Hosts" iconsOnly={iconsOnly} combo={k.go_knownhosts} active={p.page === 'knownhosts'} onClick={() => p.onPage('knownhosts')} />
        <Item icon={<IconClock />} label="Logs" iconsOnly={iconsOnly} combo={k.go_logs} active={p.page === 'logs'} onClick={() => p.onPage('logs')} />
      </div>
      <div className="nav-group bottom">
        <Item icon={<IconData />} label="Import / Export" iconsOnly={iconsOnly} onClick={p.onData} />
        <Item icon={<IconGear />} label="Settings" iconsOnly={iconsOnly} combo={k.open_settings} active={!!p.settingsOpen} onClick={p.onSettings} />
        <Item icon={<IconLock />} label="Lock vault" iconsOnly={iconsOnly} combo={k.lock_vault} onClick={p.onLock} />
      </div>
    </nav>
  )
}
