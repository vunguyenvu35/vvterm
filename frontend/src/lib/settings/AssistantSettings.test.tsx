import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {AssistantSettings} from './AssistantSettings'
import {host, makeFake, Providers} from '../../test/fakeBackend'
import type {AiProvider, McpTool} from '../types'

type Fake = ReturnType<typeof makeFake>

const prov = (o: Partial<AiProvider> = {}): AiProvider => ({id: 'claude', name: 'Claude Code', status: {state: 'ready', version: '2.1.0', detail: '', hint: ''}, enabled: false, default: false, model: '', supports_mcp: true, supports_images: false, custom: false, ...o})

function setup(mutate?: (be: Fake) => void) {
  const be = makeFake({hosts: [host({id: 'h1', label: 'web-1'})]})
  be.state.ai.providers = [prov(), prov({id: 'codex', name: 'Codex CLI', supports_mcp: false, supports_images: false}), prov({id: 'gemini', name: 'Gemini CLI', status: {state: 'needs_signin', version: '0.4', detail: 'not signed in', hint: 'gemini'}})]
  be.state.ai.settings = {...be.state.ai.settings, default_provider: ''}
  mutate?.(be)
  render(<Providers be={be}><AssistantSettings /></Providers>)
  return be
}
const calls = (be: Fake, name: string) => be.state.calls.filter(c => c[0] === name)
const row = (id: string) => screen.findByTestId('provider-' + id)

describe('AssistantSettings: providers', () => {
  it('lists the detected providers with their state and nothing is on by default', async () => {
    setup()
    const claude = await row('claude')
    expect(within(claude).getByText('Ready')).toBeInTheDocument()
    expect(within(claude).getByText('2.1.0')).toBeInTheDocument()
    expect(within(claude).getByRole('switch', {name: 'Enable Claude Code'})).not.toBeChecked()
    const gemini = await row('gemini')
    expect(within(gemini).getByText('Needs sign-in')).toBeInTheDocument()
    expect(within(gemini).getByText('gemini')).toBeInTheDocument()
    expect(within(gemini).getByRole('switch', {name: 'Enable Gemini CLI'})).toBeDisabled()
  })

  it('turning one on runs the isolation test and shows when it fails', async () => {
    const be = setup(b => { b.state.ai.enableError.codex = 'Codex CLI was not enabled: isolation self-test failed: the agent used a tool' })
    await userEvent.click(within(await row('codex')).getByRole('switch', {name: 'Enable Codex CLI'}))
    expect(await within(await row('codex')).findByRole('alert')).toHaveTextContent('isolation self-test failed')
    expect(within(await row('codex')).getByRole('switch', {name: 'Enable Codex CLI'})).not.toBeChecked()
    await userEvent.click(within(await row('claude')).getByRole('switch', {name: 'Enable Claude Code'}))
    await waitFor(() => expect(within(screen.getByTestId('provider-claude')).getByRole('switch', {name: 'Enable Claude Code'})).toBeChecked())
    expect(calls(be, 'assistant.setProviderEnabled')).toContainEqual(['assistant.setProviderEnabled', 'claude', true])
  })

  it('an enabled provider shows the models loaded from the provider and saves the default one', async () => {
    const be = setup(b => { b.state.ai.providers[0] = prov({enabled: true, default: true}) })
    const claude = await row('claude')
    await userEvent.click(await within(claude).findByRole('combobox', {name: /^Default model of Claude Code/}))
    expect(screen.getByRole('option', {name: 'Opus 5.5'})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', {name: 'Sonnet 5.5'}))
    await waitFor(() => expect(calls(be, 'assistant.setProviderModel')).toContainEqual(['assistant.setProviderModel', 'claude', 'sonnet']))
    expect(calls(be, 'assistant.models').length).toBeGreaterThan(0)
  })

  it('shows that models are loading, then a failure with Retry', async () => {
    let open!: () => void
    const be = setup(b => {
      b.state.ai.providers[0] = prov({enabled: true, default: true})
      b.state.ai.modelsGate = new Promise<void>(r => { open = r })
      b.state.ai.models.claude = {models: [{id: '', name: 'Default (CLI decides)'}], error: 'timed out', can_list: true}
    })
    const claude = await row('claude')
    expect(within(claude).getByText(/Loading the models from the provider/)).toBeInTheDocument()
    expect(within(claude).getByRole('combobox', {name: /^Default model of Claude Code/})).toBeDisabled()
    act(() => open())
    expect(await within(claude).findByText(/Models could not be loaded: timed out/)).toBeInTheDocument()
    be.state.ai.models.claude = {models: [{id: '', name: 'Default (CLI decides)'}, {id: 'opus', name: 'Opus 5.5'}], error: '', can_list: true}
    await userEvent.click(within(claude).getByRole('button', {name: 'Retry'}))
    await waitFor(() => expect(within(screen.getByTestId('provider-claude')).queryByText(/could not be loaded/)).toBeNull())
    expect(calls(be, 'assistant.models').filter(c => c[2] === true)).toHaveLength(1)
  })

  it('says when a provider cannot list its models', async () => {
    setup(b => {
      b.state.ai.providers[1] = prov({id: 'codex', name: 'Codex CLI', enabled: true})
      b.state.ai.models.codex = {models: [{id: '', name: 'Default (CLI decides)'}], error: '', can_list: false}
    })
    expect(await within(await row('codex')).findByText(/uses its default one/)).toBeInTheDocument()
  })

  it('names the company that receives the redacted text and can make one the default', async () => {
    const be = setup(b => { b.state.ai.providers = [prov({enabled: true, default: true}), prov({id: 'codex', name: 'Codex CLI', enabled: true})] })
    expect(within(await row('claude')).getByText(/sent to Anthropic/)).toBeInTheDocument()
    expect(within(await row('codex')).getByText(/sent to OpenAI/)).toBeInTheDocument()
    await userEvent.click(within(await row('codex')).getByRole('button', {name: 'Make default'}))
    expect(calls(be, 'assistant.setDefaultProvider')).toEqual([['assistant.setDefaultProvider', 'codex']])
  })

  it('Refresh runs detection again', async () => {
    const be = setup()
    await userEvent.click(await screen.findByRole('button', {name: 'Refresh'}))
    await waitFor(() => expect(calls(be, 'assistant.refreshProviders')).toHaveLength(1))
  })

  it('adds a command of its own: the arguments are split and it still needs the test to be switched on', async () => {
    const be = setup()
    await userEvent.click(await screen.findByRole('button', {name: 'Add a command…'}))
    await userEvent.type(screen.getByLabelText('Provider name'), 'My AI')
    await userEvent.type(screen.getByLabelText('Provider command'), 'mytool')
    await userEvent.type(screen.getByLabelText('Provider arguments'), '--ask "{{prompt}" -v')
    await userEvent.click(screen.getByRole('button', {name: 'Add'}))
    await waitFor(() => expect(calls(be, 'assistant.saveCustomProvider')).toHaveLength(1))
    expect(calls(be, 'assistant.saveCustomProvider')[0][1]).toEqual({name: 'My AI', command: 'mytool', args: ['--ask', '{prompt}', '-v'], prompt_via: 'stdin'})
  })
})

describe('AssistantSettings: first paint', () => {
  it('draws the page at once and fills in what is still being looked for', async () => {
    const be = setup(b => { b.state.ai.checking = 2 })
    // the sections are there before the tools have been found
    expect(await screen.findByRole('region', {name: 'AI providers'})).toBeInTheDocument()
    expect(await within(await row('claude')).findByText('Checking…')).toBeInTheDocument()
    expect(screen.getByRole('region', {name: 'MCP servers'})).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).toBeNull()
    await waitFor(() => expect(within(screen.getByTestId('provider-claude')).getByText('Ready')).toBeInTheDocument(), {timeout: 4000})
    expect(be.state.ai.checking).toBeLessThan(0) // it asked again until the answer was known
  })
})

describe('AssistantSettings: privacy', () => {
  it('says redaction cannot be turned off and offers no switch for it', async () => {
    setup()
    const sec = await screen.findByRole('region', {name: 'AI privacy'})
    expect(within(sec).getByText(/cannot be switched off/)).toBeInTheDocument()
    expect(within(sec).queryByRole('switch', {name: /redact/i})).toBeNull()
  })

  it('saves the number of lines and extra patterns', async () => {
    const be = setup()
    const lines = await screen.findByLabelText('Lines shared')
    await userEvent.clear(lines)
    await userEvent.type(lines, '300')
    await userEvent.tab()
    await waitFor(() => expect(be.state.ai.settings.lines).toBe(300))
    const pats = screen.getByLabelText('Extra redaction patterns')
    await userEvent.type(pats, 'EMP-\\d{{6}')
    await userEvent.tab()
    await waitFor(() => expect(be.state.ai.settings.patterns).toEqual(['EMP-\\d{6}']))
  })

  it('auto-run of read-only commands is a separate opt-in', async () => {
    const be = setup()
    const sw = await screen.findByRole('switch', {name: 'Run read-only commands by itself'})
    expect(sw).not.toBeChecked()
    await userEvent.click(sw)
    await waitFor(() => expect(be.state.ai.settings.auto_run).toBe(true))
  })
})

describe('AssistantSettings: the host list', () => {
  it('is loaded once with the page and read again when the window is focused or the main window changed something', async () => {
    const be = setup()
    await userEvent.click(await screen.findByRole('button', {name: 'Add server'}))
    expect(within(screen.getByRole('group', {name: 'Hosts'})).getByLabelText('web-1')).toBeInTheDocument()
    be.state.hosts.push(host({id: 'h2', label: 'db-1'}))
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(await within(screen.getByRole('group', {name: 'Hosts'})).findByLabelText('db-1')).toBeInTheDocument()
    be.state.hosts.push(host({id: 'h3', label: 'cache-1'}))
    act(() => be.emit('bridge:changed', 'HostService'))
    expect(await within(screen.getByRole('group', {name: 'Hosts'})).findByLabelText('cache-1')).toBeInTheDocument()
  })

  it('a host list that cannot be read does not break the page or show an error', async () => {
    const be = makeFake()
    be.hosts.listHosts = async () => { throw new Error('VVTerm cannot reach its backend from this window.') }
    render(<Providers be={be}><AssistantSettings /></Providers>)
    await userEvent.click(await screen.findByRole('button', {name: 'Add server'}))
    expect(screen.queryByText(/cannot reach its backend/)).toBeNull()
    expect(within(screen.getByRole('group', {name: 'Hosts'})).getByLabelText('All hosts')).toBeChecked()
  })
})

describe('AssistantSettings: MCP servers', () => {
  const tool = (o: Partial<McpTool>): McpTool => ({name: 'search', description: 'find docs', read_only: true, mode: 'allow', new: true, ...o})
  const open = async () => { await userEvent.click(await screen.findByRole('button', {name: 'Add server'})) }
  const dlg = () => screen.getByRole('dialog', {name: 'Add MCP server'})

  it('adds a server: secrets are sent to be stored and are not shown again', async () => {
    const be = setup()
    await open()
    await userEvent.type(screen.getByLabelText('Server name'), 'Docs')
    await userEvent.type(screen.getByLabelText('Server command'), 'npx')
    await userEvent.type(screen.getByLabelText('Server arguments'), '-y @acme/docs-mcp')
    await userEvent.click(within(dlg()).getByRole('button', {name: 'Add'}))
    await userEvent.type(screen.getByLabelText('Environment name'), 'API_KEY')
    await userEvent.type(screen.getByLabelText('Environment value'), 'sk-live-secret')
    await userEvent.click(within(dlg()).getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(calls(be, 'assistant.mcp.save')).toHaveLength(1))
    expect(calls(be, 'assistant.mcp.save')[0][1]).toMatchObject({name: 'Docs', type: 'stdio', command: 'npx', args: ['-y', '@acme/docs-mcp'], env: {API_KEY: 'sk-live-secret'}, enabled: false, trusted: false})
    const row = await screen.findByTestId('mcp-Docs')
    expect(row).toHaveTextContent('npx -y @acme/docs-mcp')
    expect(row).not.toHaveTextContent('sk-live-secret')
    // editing shows the name with a saved marker, never the value
    await userEvent.click(within(row).getByRole('button', {name: 'Edit'}))
    expect(screen.getByLabelText('Environment name')).toHaveValue('API_KEY')
    expect(screen.getByLabelText('Environment value')).toHaveValue('')
    expect(screen.getByLabelText('Environment value')).toHaveAttribute('placeholder', expect.stringContaining('saved'))
    expect(document.body.innerHTML).not.toContain('sk-live-secret')
  })

  it('replaces or removes a saved value', async () => {
    const be = setup(b => { b.state.ai.mcp = [{id: 'm1', name: 'Docs', type: 'stdio', command: 'npx', args: [], url: '', env: ['A', 'B'], headers: [], enabled: true, trusted: false, host_ids: [], providers: [], status: '', reviewed: 0}] })
    await userEvent.click(within(await screen.findByTestId('mcp-Docs')).getByRole('button', {name: 'Edit'}))
    const values = screen.getAllByLabelText('Environment value')
    await userEvent.type(values[0], 'new-value')
    await userEvent.click(screen.getByRole('button', {name: 'Remove B'}))
    await userEvent.click(screen.getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(calls(be, 'assistant.mcp.save')).toHaveLength(1))
    expect(calls(be, 'assistant.mcp.save')[0][1]).toMatchObject({id: 'm1', env: {A: 'new-value'}, remove_env: ['B']})
  })

  it('tests the connection; new tools wait for a mode and can be approved with the suggested ones', async () => {
    const be = setup(b => {
      b.state.ai.mcp = [{id: 'm1', name: 'Docs', type: 'http', command: '', args: [], url: 'https://mcp.example.com', env: [], headers: [], enabled: true, trusted: false, host_ids: [], providers: [], status: '', reviewed: 0}]
      b.state.ai.tools.m1 = [tool({}), tool({name: 'delete', description: 'remove', read_only: false, mode: 'ask'})]
    })
    await userEvent.click(within(await screen.findByTestId('mcp-Docs')).getByRole('button', {name: 'Edit'}))
    await userEvent.click(screen.getByRole('button', {name: 'Save and test connection'}))
    const tools = await screen.findByLabelText('Tools')
    expect(within(tools).getAllByText('new')).toHaveLength(2)
    expect(within(tools).getByText('read-only')).toBeInTheDocument()
    await userEvent.click(within(tools).getByRole('button', {name: 'Approve new tools with the suggested modes'}))
    await waitFor(() => expect(calls(be, 'assistant.mcp.approveNew')).toEqual([['assistant.mcp.approveNew', 'm1']]))
  })

  it('a tool mode is chosen one by one', async () => {
    const be = setup(b => {
      b.state.ai.mcp = [{id: 'm1', name: 'Docs', type: 'http', command: '', args: [], url: 'https://mcp.example.com', env: [], headers: [], enabled: true, trusted: false, host_ids: [], providers: [], status: '', reviewed: 0}]
      b.state.ai.tools.m1 = [tool({new: false, mode: 'allow'})]
    })
    await userEvent.click(within(await screen.findByTestId('mcp-Docs')).getByRole('button', {name: 'Edit'}))
    await userEvent.click(screen.getByRole('button', {name: 'Save and test connection'}))
    await userEvent.click(await screen.findByRole('combobox', {name: /^Mode of search/}))
    await userEvent.click(screen.getByRole('option', {name: 'Off'}))
    await waitFor(() => expect(calls(be, 'assistant.mcp.setTool')).toContainEqual(['assistant.mcp.setTool', 'm1', 'search', 'off']))
  })

  it('a server that cannot start shows why', async () => {
    setup(b => { b.state.ai.mcp = [{id: 'm1', name: 'Docs', type: 'stdio', command: 'nope', args: [], url: '', env: [], headers: [], enabled: true, trusted: false, host_ids: [], providers: [], status: '', reviewed: 0}] })
    await userEvent.click(within(await screen.findByTestId('mcp-Docs')).getByRole('button', {name: 'Edit'}))
    await userEvent.click(screen.getByRole('button', {name: 'Save and test connection'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot start the server')
  })

  it('limits a server to chosen hosts and providers; a provider without MCP is marked', async () => {
    const be = setup()
    await open()
    await userEvent.type(screen.getByLabelText('Server name'), 'Docs')
    await userEvent.type(screen.getByLabelText('Server command'), 'x')
    const hosts = within(screen.getByRole('group', {name: 'Hosts'}))
    await userEvent.click(hosts.getByLabelText('web-1'))
    const provs = within(screen.getByRole('group', {name: 'Providers'}))
    expect(provs.getByText(/Codex CLI \(no MCP\)/)).toBeInTheDocument()
    await userEvent.click(provs.getByLabelText('Claude Code'))
    await userEvent.click(within(dlg()).getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(calls(be, 'assistant.mcp.save')).toHaveLength(1))
    expect(calls(be, 'assistant.mcp.save')[0][1]).toMatchObject({host_ids: ['h1'], providers: ['claude']})
  })

  it('trusting a server is an explicit choice', async () => {
    const be = setup()
    await open()
    await userEvent.type(screen.getByLabelText('Server name'), 'Docs')
    await userEvent.type(screen.getByLabelText('Server command'), 'x')
    expect(screen.getByRole('switch', {name: 'Trusted'})).not.toBeChecked()
    await userEvent.click(screen.getByRole('switch', {name: 'Trusted'}))
    await userEvent.click(within(dlg()).getByRole('button', {name: 'Save'}))
    await waitFor(() => expect(calls(be, 'assistant.mcp.save')[0][1]).toMatchObject({trusted: true}))
  })

  it('imports a server from another tool: names only are listed', async () => {
    const be = setup(b => { b.state.ai.importable = [{ref: 'claude:github', source: 'claude', name: 'github', type: 'stdio', command: 'npx', args: ['gh-mcp'], url: '', env: ['GITHUB_TOKEN'], headers: []}] })
    await userEvent.click(await screen.findByRole('button', {name: 'Import from other tools…'}))
    const d = await screen.findByRole('dialog', {name: 'Import MCP servers'})
    expect(await within(d).findByText('github')).toBeInTheDocument()
    expect(within(d).getByText(/Secrets to move: GITHUB_TOKEN/)).toBeInTheDocument()
    await userEvent.click(within(d).getByRole('button', {name: 'Import'}))
    expect(await within(d).findByText('Imported')).toBeInTheDocument()
    expect(calls(be, 'assistant.mcp.import')).toEqual([['assistant.mcp.import', 'claude:github']])
  })

  it('switches a server on or off and deletes it', async () => {
    const be = setup(b => { b.state.ai.mcp = [{id: 'm1', name: 'Docs', type: 'stdio', command: 'npx', args: [], url: '', env: [], headers: [], enabled: false, trusted: false, host_ids: [], providers: [], status: 'Connected', reviewed: 1}] })
    const row = await screen.findByTestId('mcp-Docs')
    expect(within(row).getByText('Connected')).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('switch', {name: 'Enable Docs'}))
    await waitFor(() => expect(calls(be, 'assistant.mcp.save')[0][1]).toMatchObject({id: 'm1', enabled: true}))
    await userEvent.click(within(screen.getByTestId('mcp-Docs')).getByRole('button', {name: 'Delete'}))
    await waitFor(() => expect(calls(be, 'assistant.mcp.remove')).toEqual([['assistant.mcp.remove', 'm1']]))
  })
})
