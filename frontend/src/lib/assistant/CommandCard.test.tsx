import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {CommandCard} from './CommandCard'
import {makeFake, Providers} from '../../test/fakeBackend'
import type {AiCommand, AiCommandCheck} from '../types'

const cmd = (o: Partial<AiCommand> = {}): AiCommand => ({cmd: 'df -h', why: 'check usage', risk: 'low', reasons: [], warnings: [], blocked: false, block_reason: '', ...o})
const check = (o: Partial<AiCommandCheck> = {}): AiCommandCheck => ({blocked: false, block_reason: '', risk: 'low', reasons: [], warnings: [], run_allowed: true, run_reason: '', typed_confirm: false, ...o})

function setup(c: AiCommand, ck: Partial<AiCommandCheck> = {}) {
  const be = makeFake()
  be.state.ai.check = () => check(ck)
  render(<Providers be={be}><CommandCard sid="s1" cmd={c} /></Providers>)
  return be
}
const calls = (be: ReturnType<typeof makeFake>, name: string) => be.state.calls.filter(c => c[0] === name)

describe('CommandCard', () => {
  it('Insert puts the command on the prompt without Enter', async () => {
    const be = setup(cmd())
    await userEvent.click(screen.getByRole('button', {name: 'Insert'}))
    expect(calls(be, 'assistant.insert')).toEqual([['assistant.insert', 's1', 'df -h']])
    expect(calls(be, 'assistant.run')).toHaveLength(0)
    expect(await screen.findByRole('status')).toHaveTextContent('press Enter')
  })

  it('a command that only reads runs at once', async () => {
    const be = setup(cmd())
    const run = await screen.findByRole('button', {name: 'Run'})
    await waitFor(() => expect(run).toBeEnabled())
    await userEvent.click(run)
    expect(calls(be, 'assistant.run')).toEqual([['assistant.run', 's1', 'df -h', '']])
    expect(screen.queryByRole('button', {name: 'Run now'})).toBeNull() // no confirmation for a plain read
  })

  it('a command that can change something asks first, here in the card, then sends it', async () => {
    const be = setup(cmd({cmd: 'systemctl restart nginx', risk: 'medium', reasons: ['changes files, services or packages']}))
    const run = await screen.findByRole('button', {name: 'Run…'})
    await waitFor(() => expect(run).toBeEnabled())
    await userEvent.click(run)
    expect(calls(be, 'assistant.run')).toHaveLength(0)
    expect(screen.getByRole('group', {name: 'Confirm run'})).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {name: 'Run now'}))
    expect(calls(be, 'assistant.run')).toEqual([['assistant.run', 's1', 'systemctl restart nginx', '']])
  })

  it('a command that may print secrets asks first even if it only reads', async () => {
    const be = setup(cmd({cmd: 'cat .env', warnings: ['reads a file that usually holds secrets']}))
    const run = await screen.findByRole('button', {name: 'Run…'})
    await waitFor(() => expect(run).toBeEnabled())
    await userEvent.click(run)
    expect(calls(be, 'assistant.run')).toHaveLength(0)
  })

  it('a risky command needs the word run typed', async () => {
    const be = setup(cmd({cmd: 'sudo reboot', risk: 'high', reasons: ['stops or restarts the machine']}), {typed_confirm: true})
    expect(screen.getByText('High risk')).toBeInTheDocument()
    expect(screen.getByText('stops or restarts the machine')).toBeInTheDocument()
    const run = await screen.findByRole('button', {name: 'Run…'})
    await waitFor(() => expect(run).toBeEnabled())
    await userEvent.click(run)
    const go = screen.getByRole('button', {name: 'Run now'})
    expect(go).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Type run to confirm'), 'ru')
    expect(go).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Type run to confirm'), 'n')
    expect(go).toBeEnabled()
    await userEvent.click(go)
    expect(calls(be, 'assistant.run')[0]).toEqual(['assistant.run', 's1', 'sudo reboot', 'run'])
  })

  it('a command with a hidden value cannot be inserted or run', () => {
    const be = setup(cmd({cmd: 'mysql -p *******', blocked: true, block_reason: 'The command contains a secret or a hidden value. Type it yourself.'}))
    expect(screen.getByText(/Type it yourself/)).toBeInTheDocument()
    expect(screen.queryByRole('button', {name: 'Insert'})).toBeNull()
    expect(screen.queryByRole('button', {name: /Run/})).toBeNull()
    expect(be.state.calls.some(c => c[0] === 'assistant.checkCommand')).toBe(false)
  })

  it('Run is disabled with the reason on a production host, Insert still works', async () => {
    setup(cmd(), {run_allowed: false, run_reason: 'Run is disabled on production hosts: insert it and press Enter yourself.'})
    expect(await screen.findByText(/disabled on production/)).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Run'})).toBeDisabled()
    expect(screen.getByRole('button', {name: 'Insert'})).toBeEnabled()
  })

  it('shows what a command may print', () => {
    setup(cmd({cmd: 'cat .env', warnings: ['reads a file that usually holds secrets']}))
    expect(screen.getByText('reads a file that usually holds secrets')).toBeInTheDocument()
  })

  describe('a command that only reads', () => {
    it('runs as soon as it is shown, once, and says so', async () => {
      const be = makeFake()
      const c = cmd({cmd: 'which nginx; nginx -v 2>&1', auto: true})
      const {rerender} = render(<Providers be={be}><CommandCard sid="s1" cmd={c} autoKey="r1:0" /></Providers>)
      expect(await screen.findByText('Ran in the terminal (it only reads)')).toBeInTheDocument()
      expect(be.state.calls.filter(x => x[0] === 'assistant.runReadOnly')).toEqual([['assistant.runReadOnly', 's1', 'which nginx; nginx -v 2>&1']])
      expect(screen.queryByRole('button', {name: 'Insert'})).toBeNull() // nothing left to decide
      // drawn again (another sidebar tab and back): it must not run a second time
      rerender(<Providers be={be}><CommandCard sid="s1" cmd={{...c}} autoKey="r1:0" /></Providers>)
      expect(be.state.calls.filter(x => x[0] === 'assistant.runReadOnly')).toHaveLength(1)
    })

    it('does not run by itself when it is not marked, or has no key', async () => {
      const be = makeFake()
      render(<Providers be={be}><CommandCard sid="s1" cmd={cmd({auto: false})} autoKey="r2:0" /><CommandCard sid="s1" cmd={cmd({auto: true})} /></Providers>)
      await screen.findAllByRole('button', {name: 'Insert'})
      expect(be.state.calls.some(x => x[0] === 'assistant.runReadOnly')).toBe(false)
    })

    it('falls back to the buttons, with the reason, when it could not run by itself', async () => {
      const be = makeFake()
      be.assistant.runReadOnly = async () => { throw new Error('The terminal is not connected.') }
      render(<Providers be={be}><CommandCard sid="s1" cmd={cmd({auto: true})} autoKey="r3:0" /></Providers>)
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not run it by itself: The terminal is not connected.')
      expect(await screen.findByRole('button', {name: 'Insert'})).toBeInTheDocument()
    })
  })
})
