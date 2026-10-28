import {bridgeBackend, inSettingsWindow} from './backend'

type Call = [string, string, string]

function install(reply: (c: Call) => string | Promise<string>) {
  const calls: Call[] = []
  const w = window as any
  w.go = {
    app: {
      SettingsBridge: {Call: vi.fn(async (a: string, b: string, c: string) => { calls.push([a, b, c]); return reply([a, b, c]) })},
      SystemService: {Info: async () => ({version: '9.9.9'}), OpenURL: async () => {}},
    },
  }
  return calls
}

afterEach(() => { delete (window as any).go })

describe('Settings window backend (bridge)', () => {
  it('is recognised only where the bridge is bound', () => {
    expect(inSettingsWindow()).toBe(false)
    install(() => 'null')
    expect(inSettingsWindow()).toBe(true)
  })

  it('forwards settings, vault security and sync calls as JSON through the bridge', async () => {
    const calls = install(c => (c[1] === 'Get' ? '{"zoom":110}' : c[1] === 'Status' ? '{"exists":true}' : 'null'))
    const be = bridgeBackend()
    expect(await be.settings.get()).toEqual({zoom: 110})
    await be.settings.save({zoom: 120} as never)
    await be.vault.setAutoLock(5)
    await be.vault.changePassword('old', 'new')
    await be.vault.enableBiometric()
    await be.vault.resetVault('RESET')
    expect(await be.vault.status()).toEqual({exists: true})
    await be.sync.configure('git://x')
    await be.sync.join('pw')
    expect(calls).toEqual([
      ['SettingsService', 'Get', '[]'],
      ['SettingsService', 'Save', '[{"zoom":120}]'],
      ['VaultService', 'SetAutoLock', '[5]'],
      ['VaultService', 'ChangePassword', '["old","new"]'],
      ['VaultService', 'EnableBiometric', '[]'],
      ['VaultService', 'ResetVault', '["RESET"]'],
      ['VaultService', 'Status', '[]'],
      ['SyncService', 'Configure', '["git://x"]'],
      ['SyncService', 'JoinExisting', '["pw"]'],
    ])
  })

  it('an empty result is undefined, and errors from the main process reject', async () => {
    install(c => { if (c[1] === 'Save') throw 'zoom must be between 80 and 160'; return '' })
    const be = bridgeBackend()
    expect(await be.vault.setAutoLock(1)).toBeUndefined()
    await expect(be.settings.save({} as never)).rejects.toMatch(/zoom/)
  })

  it('keeps the version and help links local, and cannot open another Settings window', async () => {
    install(() => 'null')
    const be = bridgeBackend()
    expect(await be.system.info()).toEqual({version: '9.9.9'})
    await expect(be.system.openSettings()).rejects.toThrow()
  })
})

describe('toggleMaximise', () => {
  afterEach(() => { delete (window as any).runtime })
  it('zooms the native window through the Wails runtime', async () => {
    const toggle = vi.fn()
    ;(window as any).runtime = {EventsOn: () => () => {}, WindowToggleMaximise: toggle}
    const {wailsBackend} = await import('./backend')
    await wailsBackend().system.toggleMaximise()
    expect(toggle).toHaveBeenCalledTimes(1)
  })
  it('does nothing in a browser, where there is no runtime', async () => {
    const {wailsBackend} = await import('./backend')
    await expect(wailsBackend().system.toggleMaximise()).resolves.toBeUndefined()
  })
})

describe('terminal window backend', () => {
  afterEach(() => { delete (window as any).go })
  it('is recognised by its own bound object and sends sessions, settings and hosts through it', async () => {
    const {inTerminalWindow, terminalWindowBackend, windowTarget} = await import('./backend')
    expect(inTerminalWindow()).toBe(false)
    const calls: [string, string, string][] = []
    ;(window as any).go = {app: {
      TerminalWindow: {
        Call: async (s: string, m: string, a: string) => { calls.push([s, m, a]); return m === 'Open' ? '"sid-1"' : m === 'ListHosts' ? 'null' : 'null' },
        Target: async () => ({host_id: 'h1', title: 'web'}),
      },
      SystemService: {Info: async () => ({version: '1'})},
    }}
    expect(inTerminalWindow()).toBe(true)
    expect(await windowTarget()).toEqual({host_id: 'h1', title: 'web'})
    const be = terminalWindowBackend()
    expect(await be.session.open('h1', 80, 24)).toBe('sid-1')
    await be.session.write('sid-1', 'ls\r')
    await be.session.resize('sid-1', 100, 30)
    expect(await be.hosts.listHosts({})).toEqual([]) // null becomes an empty list
    expect(calls.map(c => c[1])).toEqual(['Open', 'Write', 'Resize', 'ListHosts'])
    expect(JSON.parse(calls[1][2])).toEqual(['sid-1', 'ls\r'])
    await expect(be.system.openWindow('h1', 'x')).rejects.toThrow()
    await expect(be.settings.save({} as never)).rejects.toThrow()
  })
})
