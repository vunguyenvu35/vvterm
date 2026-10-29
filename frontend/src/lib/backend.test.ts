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

  it('reads the host list through the bridge too, and says in plain words when the backend is not reachable', async () => {
    const calls = install(c => (c[1] === 'ListHosts' ? '[{"id":"h1","label":"web-1"}]' : 'null'))
    const be = bridgeBackend()
    expect(await be.hosts.listHosts({})).toEqual([{id: 'h1', label: 'web-1'}])
    expect(calls[0][0]).toBe('HostService')
    expect(JSON.parse(calls[0][2])[0]).toMatchObject({query: '', group_id: '', env: '', tag: ''})
    // a call that has no binding in this window gets a message a person can act on, not a service name
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = async () => be.hosts.listGroups()
    await expect(missing()).rejects.toThrow(/cannot reach its backend.*open it again/i)
    await expect(missing()).rejects.not.toThrow(/usecase\./)
    expect(warn).toHaveBeenCalled()
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

describe('app window (Duplicate in new window)', () => {
  afterEach(() => { delete (window as any).go })
  it('is recognised by its own bound object, and every use case call goes to the main process', async () => {
    const {inTerminalWindow, installWindowBridge, wailsBackend, windowTarget} = await import('./backend')
    expect(inTerminalWindow()).toBe(false)
    const calls: [string, string, string][] = []
    ;(window as any).go = {app: {
      TerminalWindow: {
        Call: async (s: string, m: string, a: string) => { calls.push([s, m, a]); return m === 'Open' ? '"sid-1"' : m === 'ListHosts' ? '[{"id":"h1","label":"web"}]' : m === 'Lock' ? '' : 'null' },
        Target: async () => ({host_id: 'h1', title: 'web'}),
      },
      SystemService: {Info: async () => ({version: '1'})},
    }}
    expect(inTerminalWindow()).toBe(true)
    expect(await windowTarget()).toEqual({host_id: 'h1', title: 'web'})
    installWindowBridge()
    const be = wailsBackend() // the same backend as the main window's: only where the calls go differs
    expect(await be.session.open('h1', 80, 24)).toBe('sid-1')
    await be.session.write('sid-1', 'ls\r')
    expect(await be.hosts.listHosts({})).toEqual([{id: 'h1', label: 'web'}])
    await be.vault.lock() // an empty answer is fine
    await be.sftp.mkdir('s', '/x')
    await be.local.home()
    expect(calls.map(c => c[0] + '.' + c[1])).toEqual(['SessionService.Open', 'SessionService.Write', 'HostService.ListHosts', 'VaultService.Lock', 'SftpService.Mkdir', 'LocalService.Home'])
    expect(JSON.parse(calls[1][2])).toEqual(['sid-1', 'ls\r'])
    expect(await be.system.info()).toEqual({version: '1'}) // native things stay in this process
  })
})
