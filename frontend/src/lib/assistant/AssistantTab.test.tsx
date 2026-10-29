import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {AssistantTab} from './AssistantTab'
import {setPaneSession} from '../terminal/panes'
import {makeFake, Providers} from '../../test/fakeBackend'
import type {AiReply} from '../types'

type Fake = ReturnType<typeof makeFake>

function setup(init: Parameters<typeof makeFake>[0] = {}, mutate?: (be: Fake) => void) {
  const be = makeFake(init)
  mutate?.(be)
  setPaneSession('p1', 's1')
  const onOpenSettings = vi.fn()
  render(<Providers be={be}><AssistantTab paneId="p1" onOpenSettings={onOpenSettings} /></Providers>)
  return {be, onOpenSettings}
}
afterEach(() => { setPaneSession('p1', null); localStorage.clear() })

const asks = (be: Fake) => be.state.calls.filter(c => c[0] === 'assistant.ask')
const reply = (o: Partial<AiReply> = {}): AiReply => ({text: 'The disk is full.', commands: [], provider: 'claude', model: '', redacted: 0, ...o})
const ask = async (q: string) => {
  await userEvent.type(await screen.findByLabelText('Ask the assistant'), q)
  await userEvent.click(screen.getByRole('button', {name: 'Send'}))
}

describe('AssistantTab', () => {
  it('asks to enable a provider when none is on', async () => {
    const {onOpenSettings} = setup({}, be => { be.state.ai.providers = be.state.ai.providers.map(p => ({...p, enabled: false})) })
    expect(await screen.findByTestId('ai-setup')).toHaveTextContent('Ask an AI about what is on this terminal')
    await userEvent.click(screen.getByRole('button', {name: 'Enable a provider in Settings'}))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it('names a provider that is not signed in and how to fix it', async () => {
    setup({}, be => { be.state.ai.providers = [{...be.state.ai.providers[0], enabled: false, status: {state: 'needs_signin', version: '1', detail: '', hint: 'claude auth login'}}] })
    expect(await screen.findByTestId('ai-setup')).toHaveTextContent('Claude Code (run claude auth login)')
  })

  it('listens before it asks, then shows the streamed text and the final answer with its command', async () => {
    const {be} = setup()
    await ask('why is the disk full?')
    await waitFor(() => expect(asks(be)).toHaveLength(1))
    const [, sid, q, opts] = asks(be)[0] as [string, string, string, {request_id: string; provider: string; model: string; selection: string}]
    expect(sid).toBe('s1')
    expect(q).toBe('why is the disk full?')
    expect(opts.provider).toBe('claude')
    expect(opts.request_id).toMatch(/^req-[a-z0-9]+$/)
    expect(opts.selection).toBe('')
    expect(screen.getByRole('button', {name: 'Stop'})).toBeInTheDocument()
    act(() => be.emit(`assistant:chunk:${opts.request_id}`, {text: 'Looking at /var'}))
    expect(await screen.findByText('Looking at /var')).toBeInTheDocument()
    act(() => be.emit(`assistant:done:${opts.request_id}`, reply({commands: [{cmd: 'du -xh /var | sort -h', why: 'biggest folders', risk: 'low', reasons: [], warnings: [], blocked: false, block_reason: ''}], redacted: 2})))
    expect(await screen.findByText('The disk is full.')).toBeInTheDocument()
    expect(screen.getByText('du -xh /var | sort -h')).toBeInTheDocument()
    expect(screen.getByText(/Claude Code · 2 redacted/)).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Send'})).toBeInTheDocument()
  })

  it('does not show a half-written JSON answer', async () => {
    const {be} = setup()
    await ask('q')
    await waitFor(() => expect(asks(be)).toHaveLength(1))
    const rid = (asks(be)[0][3] as {request_id: string}).request_id
    act(() => be.emit(`assistant:chunk:${rid}`, {text: '{"explanation": "par'}))
    expect(screen.queryByText(/explanation/)).toBeNull()
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
  })

  it('shows an error with a way to Settings when the provider is not signed in', async () => {
    const {be, onOpenSettings} = setup()
    await ask('q')
    await waitFor(() => expect(asks(be)).toHaveLength(1))
    const rid = (asks(be)[0][3] as {request_id: string}).request_id
    act(() => be.emit(`assistant:error:${rid}`, {message: 'the provider is not signed in: run `claude auth login`', code: 'needs_signin'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('not signed in')
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', {name: 'Open Settings'}))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it('shows what the assistant did with tools and asks before a tool that changes something', async () => {
    const {be} = setup()
    await ask('q')
    await waitFor(() => expect(asks(be)).toHaveLength(1))
    const rid = (asks(be)[0][3] as {request_id: string}).request_id
    act(() => be.emit(`assistant:step:${rid}`, {server: 'docs', tool: 'Docs · search', state: 'done', note: ''}))
    act(() => be.emit(`assistant:confirm:${rid}`, {call: 'c1', server: 'Docs', tool: 'delete', args: '{"page":"a"}'}))
    expect(await screen.findByText('Docs · search: done')).toBeInTheDocument()
    const box = screen.getByRole('group', {name: 'Allow delete?'})
    expect(box).toHaveTextContent('{"page":"a"}')
    await userEvent.click(within(box).getByRole('button', {name: 'Allow'}))
    expect(be.state.calls).toContainEqual(['assistant.confirmTool', rid, 'c1', true])
    expect(within(box).getByText('Allowed')).toBeInTheDocument()
  })

  it('Stop cancels the running question', async () => {
    const {be} = setup()
    await ask('q')
    await userEvent.click(await screen.findByRole('button', {name: 'Stop'}))
    const rid = (asks(be)[0][3] as {request_id: string}).request_id
    expect(be.state.calls).toContainEqual(['assistant.cancel', rid])
  })

  it('a host that asks first shows the exact preview and only then shares', async () => {
    const {be} = setup({}, b => {
      b.state.ai.info = {...b.state.ai.info, policy: 'ask', confirmed: false}
      b.state.ai.preview = {...b.state.ai.preview, text: 'DB_PASSWORD=*******', findings: [{kind: 'secret value', count: 1}], redacted: 1}
    })
    await ask('help')
    const dlg = await screen.findByRole('dialog', {name: 'What will be sent'})
    expect(within(dlg).getByLabelText('Text that will be sent')).toHaveTextContent('DB_PASSWORD=*******')
    expect(within(dlg).getByText('1 item redacted')).toBeInTheDocument()
    expect(be.state.ai.asked).toHaveLength(0)
    await userEvent.click(within(dlg).getByRole('button', {name: 'Share and ask'}))
    await waitFor(() => expect(be.state.ai.asked).toHaveLength(1))
    expect(be.state.calls).toContainEqual(['assistant.confirmShare', 's1'])
    expect(screen.getByText('help')).toBeInTheDocument()
  })

  it('cancelling the preview shares nothing and keeps the question', async () => {
    const {be} = setup({}, b => { b.state.ai.info = {...b.state.ai.info, policy: 'ask', confirmed: false} })
    await ask('help me')
    await userEvent.click(within(await screen.findByRole('dialog', {name: 'What will be sent'})).getByRole('button', {name: 'Cancel'}))
    expect(be.state.ai.asked).toHaveLength(0)
    expect(screen.getByLabelText('Ask the assistant')).toHaveValue('help me')
  })

  it('is switched off for a host whose policy is off', async () => {
    setup({}, be => { be.state.ai.info = {...be.state.ai.info, host_id: 'h1', label: 'prod-web', policy: 'off', production: true} })
    expect(await screen.findByTestId('ai-off')).toHaveTextContent('turned off for prod-web')
    expect(screen.queryByLabelText('Ask the assistant')).toBeNull()
    expect(screen.getByTestId('ai-badge')).toHaveTextContent('Not sharing')
  })

  it('the badge says how many items were redacted from the screen', async () => {
    setup({}, be => { be.state.ai.preview = {...be.state.ai.preview, redacted: 3} })
    expect(await screen.findByText('Sharing screen · 3 redacted')).toBeInTheDocument()
  })

  it('"What will be sent" shows the redacted text and the vault warning', async () => {
    setup({}, be => { be.state.ai.preview = {...be.state.ai.preview, vault_locked: true, text: 'token=*******', redacted: 1, findings: [{kind: 'secret value', count: 1}]} })
    await userEvent.click(await screen.findByRole('button', {name: 'What will be sent'}))
    const dlg = screen.getByRole('dialog', {name: 'What will be sent'})
    expect(within(dlg).getByLabelText('Text that will be sent')).toHaveTextContent('token=*******')
    expect(within(dlg).getByText(/vault is locked/)).toBeInTheDocument()
  })

  it('the model list comes from the provider and the choice is sent with the question', async () => {
    const {be} = setup()
    await userEvent.click(await screen.findByRole('combobox', {name: /^Model,/}))
    await userEvent.click(screen.getByRole('option', {name: /Opus 5.5/}))
    await ask('q')
    await waitFor(() => expect(asks(be)).toHaveLength(1))
    expect((asks(be)[0][3] as {model: string}).model).toBe('opus')
    expect(localStorage.getItem('vvterm.ai.model.claude')).toBe('opus')
  })

  it('a custom model id is stored with the provider and then used', async () => {
    const {be} = setup()
    await userEvent.click(await screen.findByRole('combobox', {name: /^Model,/}))
    await userEvent.click(screen.getByRole('option', {name: 'Custom model id…'}))
    await userEvent.type(screen.getByLabelText('Custom model id'), 'my-model-9')
    await userEvent.click(screen.getByRole('button', {name: 'Use'}))
    await waitFor(() => expect(be.state.calls).toContainEqual(['assistant.setProviderModel', 'claude', 'my-model-9']))
  })

  it('a provider that cannot list models says so', async () => {
    setup({}, be => { be.state.ai.models.claude = {models: [{id: '', name: 'Default (CLI decides)'}], error: '', can_list: false} })
    expect(await screen.findByText(/cannot list its models/)).toBeInTheDocument()
  })

  it('a real host can switch the assistant on or off for itself', async () => {
    const {be} = setup({}, b => { b.state.ai.info = {...b.state.ai.info, host_id: 'h1', label: 'web-1'} })
    await userEvent.click(await screen.findByRole('combobox', {name: /^Assistant on this host,/}))
    await userEvent.click(screen.getByRole('option', {name: 'Off'}))
    await waitFor(() => expect(be.state.calls).toContainEqual(['assistant.setHostPolicy', 'h1', 'off']))
  })

  it('a local terminal has no host switch', async () => {
    setup()
    await screen.findByTestId('ai-panel')
    expect(screen.queryByRole('combobox', {name: /^Assistant on this host/})).toBeNull()
  })

  it('Enter sends and Shift+Enter makes a new line; an empty question is not sent', async () => {
    const {be} = setup()
    const box = await screen.findByLabelText('Ask the assistant')
    expect(screen.getByRole('button', {name: 'Send'})).toBeDisabled()
    await userEvent.type(box, 'one{Shift>}{Enter}{/Shift}two')
    expect(box).toHaveValue('one\ntwo')
    await userEvent.type(box, '{Enter}')
    await waitFor(() => expect(asks(be)).toHaveLength(1))
    expect(asks(be)[0][2]).toBe('one\ntwo')
  })

  it('New chat clears the conversation and tells the backend', async () => {
    const {be} = setup()
    await ask('hello there')
    await userEvent.click(await screen.findByRole('button', {name: 'New chat'}))
    expect(screen.queryByText('hello there')).toBeNull()
    expect(be.state.calls).toContainEqual(['assistant.resetConversation', 's1'])
  })

  it('waits for the terminal before it can be used', async () => {
    const be = makeFake()
    render(<Providers be={be}><AssistantTab paneId="nobody" onOpenSettings={vi.fn()} /></Providers>)
    expect(await screen.findByLabelText('Ask the assistant')).toBeDisabled()
  })

  it('reloads the providers when Settings changed them from its own window', async () => {
    const {be} = setup({}, b => { b.state.ai.providers = b.state.ai.providers.map(p => ({...p, enabled: false})) })
    expect(await screen.findByTestId('ai-setup')).toBeInTheDocument()
    be.state.ai.providers = be.state.ai.providers.map(p => ({...p, enabled: true}))
    act(() => be.emit('bridge:changed', 'AssistantService'))
    expect(await screen.findByTestId('ai-panel')).toBeInTheDocument()
  })
})
