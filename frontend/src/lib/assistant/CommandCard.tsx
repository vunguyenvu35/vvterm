import {useEffect, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {errMsg} from '../util'
import type {AiCommand, AiCommandCheck} from '../types'

/** what happened to the commands that ran by themselves, so a card that is drawn again does not run its command again */
const autoResults = new Map<string, 'done' | string>()

const RISK: Record<string, string> = {low: 'Low risk', medium: 'Changes things', high: 'High risk'}

/**
 * A command the assistant suggests. Insert puts it on the prompt without pressing Enter, so the user reads it in
 * place. Run presses Enter too: at once for a command that only reads, after a confirmation in the card for one that can
 * change something (and the typed word "run" for a risky one). The risk is
 * judged by VVTerm, never by the assistant, and a command with a hidden value cannot be run from here.
 */
export function CommandCard({sid, cmd, autoKey}: {sid: string; cmd: AiCommand; /** identifies this card, for the command that runs by itself */ autoKey?: string}) {
  const be = useBackend()
  const toast = useToast()
  const [check, setCheck] = useState<AiCommandCheck | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [done, setDone] = useState('')
  const key = autoKey ? `${sid}|${autoKey}|${cmd.cmd}` : ''
  const [auto, setAuto] = useState<'' | 'running' | 'done' | 'failed'>(() => (key && autoResults.get(key) === 'done' ? 'done' : ''))
  const [autoError, setAutoError] = useState('')

  useEffect(() => {
    let live = true
    if (!cmd.blocked) void be.assistant.checkCommand(sid, cmd.cmd).then(c => { if (live) setCheck(c) }).catch(() => {})
    return () => { live = false }
  }, [be, sid, cmd.cmd, cmd.blocked])

  // A command that only reads is run as soon as it is shown: nothing is asked, because nothing can change.
  useEffect(() => {
    if (!cmd.auto || !key || cmd.blocked || autoResults.has(key)) return
    autoResults.set(key, 'running')
    setAuto('running')
    be.assistant.runReadOnly(sid, cmd.cmd)
      .then(() => { autoResults.set(key, 'done'); setAuto('done') })
      .catch(e => { autoResults.set(key, 'failed'); setAuto('failed'); setAutoError(errMsg(e)) })
  }, [be, sid, key, cmd.auto, cmd.cmd, cmd.blocked])

  const insert = async () => {
    try { await be.assistant.insert(sid, cmd.cmd); setDone('Inserted: press Enter in the terminal to run it'); setConfirming(false) } catch (e) { toast.error(errMsg(e)) }
  }
  const run = async () => {
    try { await be.assistant.run(sid, cmd.cmd, typed); setDone('Sent to the terminal'); setConfirming(false); setTyped('') } catch (e) { toast.error(errMsg(e)) }
  }
  const needsWord = !!check?.typed_confirm
  const runDisabled = !check || !check.run_allowed
  // A command that only reads runs at once. One that can change something, or that may print secrets, asks first, here in the chat.
  const asks = cmd.risk !== 'low' || cmd.warnings.length > 0 || needsWord
  return (
    <div className={'ai-cmd risk-' + cmd.risk + (cmd.blocked ? ' blocked' : '')} data-testid="ai-command">
      <div className="ai-cmd-head">
        <span className={'ai-risk ' + cmd.risk}>{RISK[cmd.risk] ?? cmd.risk}</span>
        {cmd.why && <span className="ai-cmd-why">{cmd.why}</span>}
      </div>
      <code className="ai-cmd-text">{cmd.cmd}</code>
      {cmd.reasons.length > 0 && <ul className="ai-cmd-notes">{cmd.reasons.map(r => <li key={r}>{r}</li>)}</ul>}
      {cmd.warnings.length > 0 && <ul className="ai-cmd-notes warn">{cmd.warnings.map(r => <li key={r}>{r}</li>)}</ul>}
      {cmd.blocked ? <div className="ai-cmd-block" role="note">{cmd.block_reason || 'This command cannot be run from here.'}</div> : auto === 'running' || auto === 'done' ? (
        <div className="ai-cmd-done" role="status">{auto === 'running' ? 'Running in the terminal…' : 'Ran in the terminal (it only reads)'}</div>
      ) : (
        <>
          {!confirming && !done && (
            <div className="ai-cmd-actions">
              <button className="primary" onClick={insert} title="Put it on the prompt; you press Enter">Insert</button>
              <button onClick={() => (asks ? setConfirming(true) : void run())} disabled={runDisabled} title={check && !check.run_allowed ? check.run_reason : 'Insert and press Enter'}>{asks ? 'Run…' : 'Run'}</button>
              {check && !check.run_allowed && <span className="muted ai-cmd-why">{check.run_reason}</span>}
            </div>
          )}
          {confirming && (
            <div className="ai-cmd-actions" role="group" aria-label="Confirm run">
              {needsWord && <input aria-label="Type run to confirm" placeholder="type run" value={typed} onChange={e => setTyped(e.target.value)} className="ai-typed" />}
              <button className="primary" onClick={run} disabled={needsWord && typed.trim() !== 'run'}>Run now</button>
              <button onClick={() => { setConfirming(false); setTyped('') }}>Cancel</button>
            </div>
          )}
          {done && <div className="ai-cmd-done" role="status">{done}</div>}
          {autoError && <div className="ai-cmd-block" role="alert">Could not run it by itself: {autoError}</div>}
        </>
      )}
    </div>
  )
}
