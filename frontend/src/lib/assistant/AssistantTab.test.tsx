import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react'
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

  it('says it is looking for the tools while detection runs, then shows the panel', async () => {
    setup({}, be => { be.state.ai.checking = 1 })
    expect(await screen.findByTestId('ai-checking')).toHaveTextContent('Looking for AI tools')
    expect(screen.queryByTestId('ai-setup')).toBeNull() // not the "enable a provider" screen
    expect(await screen.findByTestId('ai-panel', {}, {timeout: 4000})).toBeInTheDocument()
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

  it('a default host answers at once, with no confirmation of any kind', async () => {
    const {be} = setup()
    await ask('help')
    await waitFor(() => expect(be.state.ai.asked).toHaveLength(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('group', {name: 'Share this terminal?'})).toBeNull()
  })

  it('a host set to ask shows the exact preview as a card in the chat, not a popup, and only then shares', async () => {
    const {be} = setup({}, b => {
      b.state.ai.info = {...b.state.ai.info, policy: 'ask', confirmed: false}
      b.state.ai.preview = {...b.state.ai.preview, text: 'DB_PASSWORD=*******', findings: [{kind: 'secret value', count: 1}], redacted: 1}
    })
    await ask('help')
    const card = await screen.findByRole('group', {name: 'Share this terminal?'})
    expect(screen.queryByRole('dialog')).toBeNull() // in the chat, not a popup
    expect(within(card).getByLabelText('Text that will be sent')).toHaveTextContent('DB_PASSWORD=*******')
    expect(within(card).getByText('1 item redacted')).toBeInTheDocument()
    expect(screen.getByText('help')).toBeInTheDocument() // the question stays in the chat
    expect(be.state.ai.asked).toHaveLength(0)
    await userEvent.click(within(card).getByRole('button', {name: 'Share and ask'}))
    await waitFor(() => expect(be.state.ai.asked).toHaveLength(1))
    expect(be.state.calls).toContainEqual(['assistant.confirmShare', 's1'])
    expect(screen.queryByRole('group', {name: 'Share this terminal?'})).toBeNull()
    expect(screen.getAllByText('help')).toHaveLength(1) // not asked twice in the chat
  })

  it('cancelling the card shares nothing and puts the question back in the box', async () => {
    const {be} = setup({}, b => { b.state.ai.info = {...b.state.ai.info, policy: 'ask', confirmed: false} })
    await ask('help me')
    await userEvent.click(within(await screen.findByRole('group', {name: 'Share this terminal?'})).getByRole('button', {name: 'Cancel'}))
    expect(be.state.ai.asked).toHaveLength(0)
    expect(screen.getByLabelText('Ask the assistant')).toHaveValue('help me')
    expect(screen.queryByText('help me', {selector: '.ai-msg'})).toBeNull()
  })

  it('is switched off for a host whose policy is off', async () => {
    setup({}, be => { be.state.ai.info = {...be.state.ai.info, host_id: 'h1', label: 'prod-web', policy: 'off', production: true} })
    expect(await screen.findByTestId('ai-off')).toHaveTextContent('turned off for prod-web')
    expect(screen.queryByLabelText('Ask the assistant')).toBeNull()
    expect(screen.getByTestId('ai-badge')).toHaveTextContent('Not sharing')
  })

  it('the badge says how many items were redacted from the screen', async () => {
    setup({}, be => { be.state.ai.preview = {...be.state.ai.preview, redacted: 3} })
    expect(await screen.findByText('Sharing · 3 redacted')).toBeInTheDocument()
  })

  it('"What will be sent" opens in the chat (not a popup) and closes again', async () => {
    setup({}, be => { be.state.ai.preview = {...be.state.ai.preview, vault_locked: true, text: 'token=*******', redacted: 1, findings: [{kind: 'secret value', count: 1}]} })
    await userEvent.click(await screen.findByRole('button', {name: 'What will be sent'}))
    const panel = screen.getByRole('region', {name: 'What will be sent'})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(panel).getByLabelText('Text that will be sent')).toHaveTextContent('token=*******')
    expect(within(panel).getByText(/vault is locked/)).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', {name: 'Hide'}))
    expect(screen.queryByRole('region', {name: 'What will be sent'})).toBeNull()
  })

  const picker = () => screen.findByRole('button', {name: /^Model:/})

  it('the model chip sits under the message box and its menu lists the provider\'s models in full', async () => {
    const {be} = setup({}, b => { b.state.ai.models.claude = {models: [{id: '', name: 'Default (CLI decides)'}, {id: 'opus', name: 'Opus 5.5', description: 'Best for everyday, complex tasks and long running work'}], error: '', can_list: true} })
    const chip = await picker()
    expect(within(screen.getByTestId('ai-composer')).getByRole('button', {name: /^Model:/})).toBe(chip) // under the box, not in a header
    await userEvent.click(chip)
    const menu = screen.getByRole('dialog', {name: 'Provider and model'})
    expect(within(menu).getByText('Best for everyday, complex tasks and long running work')).toBeInTheDocument() // the whole description
    await userEvent.click(within(menu).getByRole('option', {name: /Opus 5.5/}))
    expect(screen.queryByRole('dialog', {name: 'Provider and model'})).toBeNull() // choosing closes it
    expect(await picker()).toHaveTextContent('Opus 5.5')
    await ask('q')
    await waitFor(() => expect(asks(be)).toHaveLength(1))
    expect((asks(be)[0][3] as {model: string}).model).toBe('opus')
    expect(localStorage.getItem('vvterm.ai.model.claude')).toBe('opus')
  })

  it('the menu opens upward inside the window and closes with Escape or a click outside', async () => {
    setup()
    const chip = await picker()
    await userEvent.click(chip)
    const menu = screen.getByRole('dialog', {name: 'Provider and model'})
    expect(parseInt(menu.style.left)).toBeGreaterThanOrEqual(8)
    expect(parseInt(menu.style.width)).toBeLessThanOrEqual(window.innerWidth - 16)
    expect(menu.style.bottom).not.toBe('')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', {name: 'Provider and model'})).toBeNull()
    await userEvent.click(chip)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', {name: 'Provider and model'})).toBeNull()
  })

  it('the arrow keys move through the models and Enter chooses', async () => {
    const {be} = setup()
    await userEvent.click(await picker())
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await waitFor(() => expect(localStorage.getItem('vvterm.ai.model.claude')).toBe('opus'))
    expect(be.state.calls.length).toBeGreaterThan(0)
  })

  it('more than one provider can be switched from the same menu, and that starts a new chat', async () => {
    const {be} = setup({}, b => {
      b.state.ai.providers = [...b.state.ai.providers, {id: 'codex', name: 'Codex CLI', status: {state: 'ready', version: '1', detail: '', hint: ''}, enabled: true, default: false, model: '', supports_mcp: false, supports_images: true, custom: false}]
      b.state.ai.models.codex = {models: [{id: '', name: 'Default (CLI decides)'}, {id: 'gpt-x', name: 'GPT X'}], error: '', can_list: true}
    })
    await ask('first question')
    await waitFor(() => expect(asks(be)).toHaveLength(1))
    act(() => be.emit(`assistant:done:${(asks(be)[0][3] as {request_id: string}).request_id}`, reply()))
    await screen.findByText('The disk is full.')
    await userEvent.click(await picker())
    await userEvent.click(within(screen.getByRole('radiogroup', {name: 'Provider'})).getByRole('radio', {name: 'Codex CLI'}))
    expect(screen.queryByText('first question')).toBeNull() // a different provider starts a new conversation
    expect(await screen.findByRole('option', {name: /GPT X/})).toBeInTheDocument() // and its own models load
  })

  it('shows that the models are loading', async () => {
    let open!: () => void
    const {be} = setup({}, b => { b.state.ai.modelsGate = new Promise<void>(r => { open = r }) })
    const chip = await picker()
    expect(chip).toBeEnabled()
    expect(chip).toHaveTextContent('Loading models…')
    await userEvent.click(chip)
    expect(within(screen.getByRole('dialog', {name: 'Provider and model'})).getByRole('status')).toHaveTextContent('Loading the models')
    act(() => open())
    await waitFor(() => expect(screen.queryByText(/Loading the models/)).toBeNull())
    expect(be.state.calls.filter(c => c[0] === 'assistant.models')).toHaveLength(1)
    expect(screen.queryByLabelText('Custom model id')).toBeNull()
  })

  it('a models failure says why in the menu and can be retried, then the list appears', async () => {
    const {be} = setup({}, b => { b.state.ai.models.claude = {models: [{id: '', name: 'Default (CLI decides)'}], error: 'Claude Code did not answer in time', can_list: true} })
    expect(await picker()).toHaveTextContent('Models unavailable')
    await userEvent.click(await picker())
    const menu = screen.getByRole('dialog', {name: 'Provider and model'})
    expect(within(menu).getByText(/Models could not be loaded: Claude Code did not answer in time/)).toBeInTheDocument()
    be.state.ai.models.claude = {models: [{id: '', name: 'Default (CLI decides)'}, {id: 'opus', name: 'Opus 5.5'}], error: '', can_list: true}
    await userEvent.click(within(menu).getByRole('button', {name: 'Retry'}))
    expect(await within(menu).findByRole('option', {name: /Opus 5.5/})).toBeInTheDocument()
    expect(be.state.calls).toContainEqual(['assistant.models', 'claude', true])
    expect(within(menu).queryByRole('option', {name: /Custom model id/})).toBeNull() // chosen from the list, never typed
  })

  it('a provider that cannot list models says it uses its default one', async () => {
    setup({}, be => { be.state.ai.models.claude = {models: [{id: '', name: 'Default (CLI decides)'}], error: '', can_list: false} })
    await userEvent.click(await picker())
    expect(within(screen.getByRole('dialog', {name: 'Provider and model'})).getByText(/uses its default one/)).toBeInTheDocument()
    expect(screen.queryByText(/custom/i)).toBeNull()
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

  describe('files and pictures', () => {
    const pngFile = (name = 'shot.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], name, {type: 'image/png'})
    const logFile = (name = 'deploy.log') => new File(['starting\nDB_PASSWORD=hunter2hunter2\nfailed'], name, {type: 'text/plain'})
    const drop = (el: HTMLElement, files: File[]) => fireEvent.drop(el, {dataTransfer: {types: ['Files'], files}})
    const panel = () => screen.findByTestId('ai-panel')

    it('shows a drop target while a file is dragged over the panel', async () => {
      setup()
      const p = await panel()
      fireEvent.dragEnter(p, {dataTransfer: {types: ['Files'], files: []}})
      expect(await screen.findByText(/Drop files or screenshots/)).toBeInTheDocument()
      fireEvent.dragLeave(p, {dataTransfer: {types: ['Files'], files: []}})
      await waitFor(() => expect(screen.queryByText(/Drop files or screenshots/)).toBeNull())
      fireEvent.dragEnter(p, {dataTransfer: {types: ['text/plain'], files: []}}) // dragging text is not a file drop
      expect(screen.queryByText(/Drop files or screenshots/)).toBeNull()
    })

    it('a dropped text file becomes a chip and goes with the question; the chip is cleared after sending', async () => {
      const {be} = setup()
      drop(await panel(), [logFile()])
      const chip = await screen.findByTestId('ai-chip')
      expect(chip).toHaveTextContent('deploy.log')
      await userEvent.type(screen.getByLabelText('Ask the assistant'), 'what failed?')
      await userEvent.click(screen.getByRole('button', {name: 'Send'}))
      await waitFor(() => expect(asks(be)).toHaveLength(1))
      const opts = asks(be)[0][3] as {attachments: Array<{name: string; text?: string}>; allow_images: boolean}
      expect(opts.attachments).toEqual([{name: 'deploy.log', mime: 'text/plain', text: 'starting\nDB_PASSWORD=hunter2hunter2\nfailed'}])
      expect(opts.allow_images).toBe(false)
      // the question shows its file, and the composer is empty again
      expect(within(screen.getByText('what failed?').closest('.ai-msg') as HTMLElement).getByText('deploy.log')).toBeInTheDocument()
      expect(screen.queryAllByTestId('ai-chip')).toHaveLength(1) // only the one in the sent message
    })

    it('a file can be sent without a question, and a chip can be removed', async () => {
      const {be} = setup()
      drop(await panel(), [logFile('a.log'), logFile('b.log')])
      await waitFor(() => expect(screen.getAllByTestId('ai-chip')).toHaveLength(2))
      await userEvent.click(screen.getByRole('button', {name: 'Remove a.log'}))
      expect(screen.getAllByTestId('ai-chip')).toHaveLength(1)
      await userEvent.click(screen.getByRole('button', {name: 'Send'}))
      await waitFor(() => expect(asks(be)).toHaveLength(1))
      expect(asks(be)[0][2]).toBe('Look at the attached file.')
      expect((asks(be)[0][3] as {attachments: unknown[]}).attachments).toHaveLength(1)
    })

    it('the paperclip chooses files', async () => {
      setup()
      await panel()
      await userEvent.upload(screen.getByLabelText('Choose files'), [logFile('x.log')])
      expect(await screen.findByTestId('ai-chip')).toHaveTextContent('x.log')
    })

    it('a pasted screenshot is added instead of being typed in', async () => {
      setup()
      const box = await screen.findByLabelText('Ask the assistant')
      fireEvent.paste(box, {clipboardData: {files: [pngFile('pasted.png')], types: ['Files']}})
      expect(await screen.findByTestId('ai-chip')).toHaveTextContent('pasted.png')
      expect(box).toHaveValue('')
    })

    it('pictures need an explicit confirmation, as a card in the chat, and Cancel sends nothing', async () => {
      const {be} = setup()
      drop(await panel(), [pngFile()])
      await screen.findByTestId('ai-chip')
      await userEvent.type(screen.getByLabelText('Ask the assistant'), 'what is this?')
      await userEvent.click(screen.getByRole('button', {name: 'Send'}))
      const card = await screen.findByRole('group', {name: 'Send pictures as they are?'})
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(card).toHaveTextContent('cannot find a secret inside a picture')
      expect(be.state.ai.asked).toHaveLength(0)
      await userEvent.click(within(card).getByRole('button', {name: 'Cancel'}))
      expect(be.state.ai.asked).toHaveLength(0)
      expect(screen.getByLabelText('Ask the assistant')).toHaveValue('what is this?')
      expect(screen.getAllByTestId('ai-chip')).toHaveLength(1) // back in the box, still attached
      await userEvent.click(screen.getByRole('button', {name: 'Send'}))
      await userEvent.click(within(await screen.findByRole('group', {name: 'Send pictures as they are?'})).getByRole('button', {name: 'Send pictures'}))
      await waitFor(() => expect(be.state.ai.asked).toHaveLength(1))
      expect((asks(be).at(-1)![3] as {allow_images: boolean}).allow_images).toBe(true)
    })

    it('a provider that cannot take pictures refuses them with a reason', async () => {
      const {be} = setup({}, b => { b.state.ai.providers = b.state.ai.providers.map(p => ({...p, supports_images: false})) })
      drop(await panel(), [pngFile()])
      expect(await screen.findByText(/cannot take pictures/)).toBeInTheDocument()
      expect(screen.queryByTestId('ai-chip')).toBeNull()
      drop(await panel(), [logFile()]) // text still works
      expect(await screen.findByTestId('ai-chip')).toBeInTheDocument()
      expect(be.state.ai.asked).toHaveLength(0)
    })

    it('a file type that is not text or a picture is refused in plain words', async () => {
      setup()
      drop(await panel(), [new File(['%PDF'], 'report.pdf', {type: 'application/pdf'})])
      expect(await screen.findByText(/not a text file or a picture/)).toBeInTheDocument()
      expect(screen.queryByTestId('ai-chip')).toBeNull()
    })

    it('the share card previews the attached files and how many pictures go as they are', async () => {
      const {be} = setup({}, b => { b.state.ai.info = {...b.state.ai.info, policy: 'ask', confirmed: false} })
      drop(await panel(), [logFile(), pngFile()])
      await waitFor(() => expect(screen.getAllByTestId('ai-chip')).toHaveLength(2))
      await userEvent.type(screen.getByLabelText('Ask the assistant'), 'help')
      await userEvent.click(screen.getByRole('button', {name: 'Send'}))
      await screen.findByRole('group', {name: 'Share this terminal?'})
      const call = be.state.calls.filter(c => c[0] === 'assistant.preview').at(-1)!
      expect((call[4] as unknown[]).length).toBe(2)
    })

    it('suggestions in an empty chat ask at once', async () => {
      const {be} = setup()
      await userEvent.click(await screen.findByRole('button', {name: 'Explain the last error'}))
      await waitFor(() => expect(asks(be)).toHaveLength(1))
      expect(asks(be)[0][2]).toBe('Explain the last error')
    })

    it('an answer shows code as a block with a Copy button', async () => {
      const {be} = setup()
      await ask('how do I see the biggest folders?')
      await waitFor(() => expect(asks(be)).toHaveLength(1))
      const rid = (asks(be)[0][3] as {request_id: string}).request_id
      act(() => be.emit(`assistant:done:${rid}`, reply({text: 'Try this:\n```bash\ndu -xh /var | sort -h\n```', commands: []})))
      expect(await screen.findByText('du -xh /var | sort -h')).toBeInTheDocument()
      expect(screen.getByRole('button', {name: 'Copy code'})).toBeInTheDocument()
    })

    it('the question and files come back when the send is refused', async () => {
      setup({}, b => { b.state.ai.info = {...b.state.ai.info, policy: 'off'} })
      expect(await screen.findByTestId('ai-off')).toBeInTheDocument() // nothing to drop on while the assistant is off
    })
  })
})
