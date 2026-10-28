import {PointerEvent as ReactPointerEvent, useEffect, useRef, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {Switch} from '../ui/Switch'
import {Select} from '../ui/Select'
import {errMsg} from '../util'
import {ThemePicker} from './ThemePicker'
import {resolveTerminalTheme} from '../terminal/themes'
import {SyncPanel} from '../panels/SyncPanel'
import {IconArrowUpRight, IconUser} from '../ui/Icons'
import {ShortcutsEditor} from './ShortcutsEditor'
import type {Appearance} from './appearance'
import type {CursorStyle, Settings, ThemeMode, VaultStatus} from '../types'

type Cat = 'general' | 'account' | 'terminal' | 'security' | 'sync' | 'shortcuts'
const CATS: {id: Cat; label: string}[] = [
  {id: 'general', label: 'General'}, {id: 'account', label: 'Account'}, {id: 'terminal', label: 'Terminal'},
  {id: 'security', label: 'Security'}, {id: 'sync', label: 'Sync'}, {id: 'shortcuts', label: 'Shortcuts'},
]

const FONTS = [
  {label: 'Menlo', value: "Menlo, Monaco, 'Courier New', monospace"},
  {label: 'SF Mono', value: "'SF Mono', Menlo, monospace"},
  {label: 'JetBrains Mono', value: "'JetBrains Mono', Menlo, monospace"},
  {label: 'Monaco', value: 'Monaco, Menlo, monospace'},
  {label: 'Courier New', value: "'Courier New', monospace"},
]

const REPO = 'https://github.com/vunguyenvu35/vvterm'
const LINKS: [string, string][] = [
  ['Documentation', REPO + '#readme'],
  ['Request a feature', REPO + '/issues/new'],
  ['Report a bug', REPO + '/issues/new'],
  ['Release notes', REPO + '/blob/main/RELEASE_NOTES.md'],
  ['Support on Ko-fi', 'https://ko-fi.com/vunguyenvu'],
]

interface Props {
  settings: Settings
  appearance: Appearance
  vault: VaultStatus
  onSettings(s: Settings): void
  onVault(): void
  onChanged(): void
  onClose(): void
  /** Rendered inside its own native window (the Settings process): no floating chrome, the OS provides it. */
  native?: boolean
}

/**
 * Settings as its own window (like Termius): a floating window with a title bar, a menu on the left
 * (categories, theme, help links, version) and cards on the right. The dots work like macOS: red closes,
 * yellow rolls the window up to its title bar, green maximises (double-click the title bar too). Drag the
 * title bar to move it and the bottom-right corner to resize. Wails v2 can only create one OS window, so
 * this is an in-app window layer rather than a second native window. Changes apply immediately.
 */
export function SettingsWindow({settings: s, appearance, vault, onSettings, onVault, onChanged, onClose, native = false}: Props) {
  const be = useBackend()
  const toast = useToast()
  const [cat, setCat] = useState<Cat>('general')
  const [version, setVersion] = useState('')
  const [scroll, setScroll] = useState(String(s.scrollback))
  const [auto, setAuto] = useState(String(vault.auto_lock_minutes))
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [name, setName] = useState(s.account_name)
  const [email, setEmail] = useState(s.account_email)
  const [err, setErr] = useState('')
  const [offset, setOffset] = useState({x: 0, y: 0})
  const [maximized, setMaximized] = useState(false)
  const [rolledUp, setRolledUp] = useState(false)
  const drag = useRef<{sx: number; sy: number; ox: number; oy: number} | null>(null)

  useEffect(() => { void be.system.info().then(i => setVersion(i.version)).catch(() => {}) }, [be])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (native) return // a real window is closed with its own red button
      if (e.key === 'Escape' && !document.querySelector('.select-menu') && !document.querySelector('.key-capture')) onClose() // a dropdown or a recording eats its own Esc
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, native])

  const startDrag = (e: ReactPointerEvent) => {
    if (maximized || (e.target as HTMLElement).closest('button')) return
    drag.current = {sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y}
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const moveDrag = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const limitX = window.innerWidth / 2, limitY = window.innerHeight / 2
    setOffset({x: Math.max(-limitX, Math.min(limitX, d.ox + e.clientX - d.sx)), y: Math.max(-limitY, Math.min(limitY, d.oy + e.clientY - d.sy))})
  }
  const endDrag = () => { drag.current = null }
  const toggleMax = () => { setMaximized(m => !m); setRolledUp(false); setOffset({x: 0, y: 0}) }

  const update = async (patch: Partial<Settings>) => {
    try { onSettings(await be.settings.save({...s, ...patch})) } catch (e) { toast.error(errMsg(e)) }
  }
  const guard = async (fn: () => Promise<void>, ok: string) => {
    setErr('')
    try { await fn(); toast.info(ok) } catch (e) { setErr(errMsg(e)) }
  }

  const term = resolveTerminalTheme(s.terminal_theme, appearance).theme
  const fontKnown = FONTS.some(f => f.value === s.font_family)
  const initial = (s.account_name.trim() || s.account_email.trim() || '?')[0].toUpperCase()

  return (
    <div className={'win-back' + (maximized ? ' maximized' : '') + (native ? ' native' : '')} role="presentation">
      <div className={'win' + (maximized ? ' max' : '') + (rolledUp ? ' rolled' : '') + (native ? ' native' : '')} role="dialog" aria-label="Settings"
        style={maximized || native ? undefined : {transform: `translate(${offset.x}px, ${offset.y}px)`}}>
        <div className="win-title" {...(native ? {onDoubleClick: (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest('button')) void be.system.toggleMaximise() }} : {onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onDoubleClick: toggleMax})}>
          {/* maximised, the window covers the app and the native macOS buttons sit at the top left: the in-app dots give way to Restore / Close on the right */}
          {!maximized && !native && <span className="win-dots">
            <button className="dot close" aria-label="Close settings" title="Close" onClick={onClose} />
            <button className="dot min" aria-label={rolledUp ? 'Unroll settings' : 'Minimize settings'} title={rolledUp ? 'Show' : 'Minimize'} onClick={() => setRolledUp(r => !r)} />
            <button className="dot max" aria-label={maximized ? 'Restore settings' : 'Maximize settings'} title={maximized ? 'Restore' : 'Maximize'} onClick={toggleMax} />
          </span>}
          <span className="win-name">Settings</span>
          {maximized && (
            <span className="win-actions">
              <button className="win-act" aria-label="Restore settings" title="Restore" onClick={toggleMax}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="3" width="13" height="13" rx="2" /><path d="M16 21H5a2 2 0 0 1-2-2V8" /></svg>
              </button>
              <button className="win-act" aria-label="Close settings" title="Close" onClick={onClose}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </span>
          )}
        </div>

        {!rolledUp && (
          <div className="win-body">
            <nav className="win-nav" aria-label="Settings menu">
              <div role="tablist" aria-orientation="vertical" className="win-tabs">
                {CATS.map(c => (
                  <button key={c.id} role="tab" aria-selected={cat === c.id} className={'settings-tab' + (cat === c.id ? ' active' : '')} onClick={() => { setCat(c.id); setErr('') }}>
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="win-sep" />
              <div className="win-row">
                <span>Theme</span>
                <Select className="inline" label="Theme" value={s.theme} onChange={v => update({theme: v as ThemeMode})}
                  options={[{value: 'auto', label: 'Auto'}, {value: 'light', label: 'Light'}, {value: 'dark', label: 'Dark'}]} />
              </div>
              {LINKS.map(([label, url]) => (
                <button key={label} className="win-link" onClick={() => be.system.openUrl(url)}>{label}<IconArrowUpRight size={15} /></button>
              ))}
              <div className="spacer" />
              <div className="win-row version"><span>Version</span><b data-testid="app-version">{version || '…'}</b></div>
            </nav>

            <div className="win-content">
              {cat === 'general' && (
                <>
                  <section className="card-section">
                    <h4>Interface</h4>
                    <div className="setting-row">
                      <div><b>Zoom</b><div className="muted">Make the whole interface larger or smaller (80% to 160%).</div></div>
                      <div className="stepper">
                        <button aria-label="Zoom out" disabled={s.zoom <= 80} onClick={() => update({zoom: Math.max(80, s.zoom - 10)})}>−</button>
                        <output aria-label="Zoom level" className="zoom-level">{s.zoom}%</output>
                        <button aria-label="Zoom in" disabled={s.zoom >= 160} onClick={() => update({zoom: Math.min(160, s.zoom + 10)})}>+</button>
                        <button aria-label="Reset zoom" disabled={s.zoom === 100} onClick={() => update({zoom: 100})}>Reset</button>
                      </div>
                    </div>
                    <div className="setting-row">
                      <div><b>Reduce motion</b><div className="muted">Turn off animations and transitions.</div></div>
                      <Switch label="Reduce motion" checked={s.reduce_motion} onChange={v => update({reduce_motion: v})} />
                    </div>
                  </section>
                  <section className="card-section">
                    <h4>Behaviour</h4>
                    <div className="setting-row">
                      <div><b>Confirm before closing a tab</b><div className="muted">Ask first, because closing a terminal or SFTP tab ends its connection.</div></div>
                      <Switch label="Confirm before closing a tab" checked={s.confirm_close} onChange={v => update({confirm_close: v})} />
                    </div>
                  </section>
                </>
              )}

              {cat === 'account' && (
                <>
                  <section className="card-section account-card">
                    <h4>Profile</h4>
                    <div className="profile">
                      <span className="avatar" aria-hidden="true">{s.account_name || s.account_email ? initial : <IconUser size={26} />}</span>
                      <div className="profile-fields">
                        <input aria-label="Display name" className="control wide" placeholder="Display name" value={name} onChange={e => setName(e.target.value)} />
                        <input aria-label="Email" className="control wide" placeholder="Email (optional)" value={email} onChange={e => setEmail(e.target.value)} />
                      </div>
                    </div>
                    <div><button className="primary" disabled={name.trim() === s.account_name && email.trim() === s.account_email}
                      onClick={() => guard(async () => { onSettings(await be.settings.save({...s, account_name: name, account_email: email})) }, 'Profile saved')}>Save profile</button></div>
                    <div className="muted">Stored only on this Mac, in your settings file. It is not sent anywhere.</div>
                  </section>
                  <section className="card-section">
                    <h4>Plan</h4>
                    <div className="setting-row">
                      <div><b>Local</b> <span className="badge">free · open source</span><div className="muted">All features are available without an account.</div></div>
                    </div>
                  </section>
                  <section className="card-section">
                    <h4>Cloud account</h4>
                    <div className="setting-row">
                      <div><b>Sign in</b><div className="muted">Accounts, hosted backup and team sharing are planned. Until then your data stays on this Mac, and you can sync it through your own Git repository (Sync tab).</div></div>
                      <button disabled title="Not available yet">Sign in</button>
                    </div>
                    <div className="setting-row">
                      <div><b>Team sharing</b><div className="muted">Share hosts and snippets with a team.</div></div>
                      <span className="badge">coming later</span>
                    </div>
                  </section>
                </>
              )}

              {cat === 'terminal' && (
                <>
                  <section className="card-section">
                    <h4>Terminal theme</h4>
                    <ThemePicker value={s.terminal_theme} appearance={appearance} onChange={id => update({terminal_theme: id})} />
                  </section>
                  <section className="card-section">
                    <h4>Text and cursor</h4>
                    <div className="setting-row">
                      <b>Font</b>
                      <Select className="control" label="Font family" value={s.font_family} onChange={v => update({font_family: v})}
                        options={[...(fontKnown ? [] : [{value: s.font_family, label: 'Custom'}]), ...FONTS.map(f => ({value: f.value, label: f.label}))]} />
                    </div>
                    <div className="setting-row">
                      <b>Font size</b>
                      <div className="stepper">
                        <button aria-label="Decrease font size" disabled={s.font_size <= 8} onClick={() => update({font_size: s.font_size - 1})}>−</button>
                        <input aria-label="Font size" className="control" type="number" min={8} max={40} value={s.font_size} onChange={e => update({font_size: Number(e.target.value)})} />
                        <button aria-label="Increase font size" disabled={s.font_size >= 40} onClick={() => update({font_size: s.font_size + 1})}>+</button>
                      </div>
                    </div>
                    <div className="setting-row">
                      <b>Cursor</b>
                      <div className="segmented" role="radiogroup" aria-label="Cursor style">
                        {(['block', 'bar', 'underline'] as CursorStyle[]).map(c => (
                          <button key={c} role="radio" aria-checked={s.cursor_style === c} className={s.cursor_style === c ? 'on' : ''} onClick={() => update({cursor_style: c})}>{c}</button>
                        ))}
                      </div>
                    </div>
                    <div className="setting-row">
                      <b>Blinking cursor</b>
                      <Switch label="Blinking cursor" checked={s.cursor_blink} onChange={v => update({cursor_blink: v})} />
                    </div>
                    <div className="setting-row">
                      <div><b>Scrollback</b><div className="muted">Lines kept per terminal (500 to 100000).</div></div>
                      <input aria-label="Scrollback lines" className="control narrow" type="number" value={scroll}
                        onChange={e => setScroll(e.target.value)} onBlur={() => update({scrollback: Number(scroll)})}
                        onKeyDown={e => e.key === 'Enter' && update({scrollback: Number(scroll)})} />
                    </div>
                  </section>
                  <section className="card-section">
                    <h4>Preview</h4>
                    <pre className="term-preview" data-testid="term-preview" style={{background: term.background, color: term.foreground, fontFamily: s.font_family, fontSize: s.font_size}}>
                      <span style={{color: term.green}}>demo@app-server</span>:<span style={{color: term.blue}}>~</span>$ ls -la{'\n'}
                      <span style={{color: term.blue}}>drwxr-xr-x</span> <span style={{color: term.yellow}}>5</span> demo  <span style={{color: term.cyan}}>projects</span>{'\n'}
                      <span style={{color: term.red}}>error:</span> permission denied <span style={{background: term.selectionBackground}}> selected text </span>{'\n'}
                      <span style={{color: term.green}}>demo@app-server</span>:<span style={{color: term.blue}}>~</span>$ <span style={{background: term.cursor, color: term.background}}>{s.cursor_style === 'block' ? ' ' : ''}</span>
                    </pre>
                  </section>
                </>
              )}

              {cat === 'security' && (
                <>
                  <section className="card-section">
                    <h4>Vault</h4>
                    <div className="setting-row">
                      <div><b>Auto-lock</b><div className="muted">Minutes of inactivity before the vault locks (0 = never).</div></div>
                      <div className="fixed-row">
                        <input aria-label="Auto-lock minutes" className="control narrow" value={auto} onChange={e => setAuto(e.target.value)} />
                        <button onClick={() => guard(async () => { await be.vault.setAutoLock(Number(auto)); onVault() }, 'Auto-lock updated')}>Apply</button>
                      </div>
                    </div>
                    <div className="setting-row">
                      <div><b>Unlock with the macOS Keychain</b><div className="muted">Stores the vault key in your Keychain. It does not require Touch ID yet.</div></div>
                      <Switch label="Keychain unlock" checked={vault.keychain_enabled}
                        onChange={v => guard(async () => { await (v ? be.vault.enableBiometric() : be.vault.disableBiometric()); onVault() }, v ? 'Keychain unlock enabled' : 'Keychain unlock disabled')} />
                    </div>
                  </section>
                  <section className="card-section">
                    <h4>Change master password</h4>
                    <input aria-label="Current password" type="password" className="control wide" placeholder="Current password" value={oldPw} onChange={e => setOldPw(e.target.value)} />
                    <input aria-label="New password" type="password" className="control wide" placeholder="New password (12+ characters)" value={newPw} onChange={e => setNewPw(e.target.value)} />
                    <div><button disabled={!oldPw || newPw.length < 12}
                      onClick={() => guard(async () => { await be.vault.changePassword(oldPw, newPw); setOldPw(''); setNewPw('') }, 'Master password changed')}>Change password</button></div>
                    <div className="muted">Forgot it? Lock the vault: the unlock screen offers a reset.</div>
                  </section>
                  {err && <div className="error" role="alert">{err}</div>}
                </>
              )}

              {cat === 'sync' && <SyncPanel page vault={vault} onClose={() => {}} onChanged={onChanged} />}

              {cat === 'shortcuts' && <ShortcutsEditor overrides={s.shortcuts ?? {}} onChange={shortcuts => update({shortcuts})} />}

              {err && cat === 'account' && <div className="error" role="alert">{err}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
