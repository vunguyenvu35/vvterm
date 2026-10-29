import {useCallback, useEffect, useRef, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {Select} from '../ui/Select'
import {errMsg} from '../util'
import {selectionOfPane} from '../terminal/panes'
import {CommandCard} from './CommandCard'
import {PreviewDialog} from './PreviewDialog'
import {usePaneSession} from './useSession'
import type {AiCommand, AiModelList, AiPolicy, AiPreview, AiProvider, AiReply, AiSessionState, AiStep} from '../types'

interface ConfirmReq {call: string; server: string; tool: string; args: string; answer?: 'allowed' | 'declined'}

type Msg =
  | {kind: 'user'; text: string; selection?: boolean}
  | {kind: 'assistant'; rid: string; text: string; streaming: boolean; steps: AiStep[]; confirms: ConfirmReq[]; commands: AiCommand[]; meta?: string; error?: {message: string; code: string}}

const CUSTOM = '__custom__'
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) ?? '' } catch { return '' } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* not remembered */ } },
}
/** The agent answers in a JSON envelope; while it is still arriving it is not shown as text. */
const looksLikeJSON = (s: string) => /^[\s`]*(\{|json)/.test(s)
const requestId = () => 'req-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
const POLICY_LABEL: Record<string, string> = {off: 'Off', ask: 'Ask first', on: 'On'}

/**
 * The AI assistant of a terminal, in the sidebar. It asks a command-line AI the user is signed in to about
 * the text on the screen. VVTerm redacts secrets on the way out and in (shown as *******); the assistant
 * only proposes commands, and the user decides.
 */
export function AssistantTab({paneId, onOpenSettings}: {paneId: string; onOpenSettings(): void}) {
  const be = useBackend()
  const toast = useToast()
  const sid = usePaneSession(paneId)
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [provider, setProvider] = useState('')
  const [models, setModels] = useState<AiModelList | null>(null)
  const [model, setModel] = useState('')
  const [customModel, setCustomModel] = useState<string | null>(null)
  const [info, setInfo] = useState<AiSessionState | null>(null)
  const [preview, setPreview] = useState<AiPreview | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [pending, setPending] = useState<{question: string; selection: string} | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [runId, setRunId] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const listEnd = useRef<HTMLDivElement>(null)
  const offs = useRef<Array<() => void>>([])

  const enabled = providers.filter(p => p.enabled && p.status.state === 'ready')
  const current = providers.find(p => p.id === provider)

  const loadProviders = useCallback(async () => {
    try {
      const list = await be.assistant.providers()
      setProviders(list)
      setProvider(cur => {
        const ready = list.filter(p => p.enabled && p.status.state === 'ready')
        if (ready.some(p => p.id === cur)) return cur
        const remembered = store.get('vvterm.ai.provider')
        return (ready.find(p => p.id === remembered) ?? ready.find(p => p.default) ?? ready[0])?.id ?? ''
      })
      setLoadErr('')
    } catch (e) { setLoadErr(errMsg(e)) }
  }, [be])

  const loadInfo = useCallback(async () => {
    if (!sid) { setInfo(null); setPreview(null); return }
    try {
      setInfo(await be.assistant.sessionInfo(sid))
      setPreview(await be.assistant.preview(sid, 0, ''))
    } catch { /* the session is gone */ }
  }, [be, sid])

  useEffect(() => { void loadProviders() }, [loadProviders])
  useEffect(() => { void loadInfo() }, [loadInfo])
  // Settings may change providers from its own window
  useEffect(() => be.on('bridge:changed', (s: string) => { if (s === 'AssistantService') void loadProviders() }), [be, loadProviders])
  useEffect(() => { setMsgs([]) }, [sid])
  useEffect(() => () => { offs.current.forEach(o => o()) }, [])
  useEffect(() => { listEnd.current?.scrollIntoView?.({block: 'end'}) }, [msgs])

  // the models of the chosen provider come from the provider itself
  useEffect(() => {
    if (!provider) { setModels(null); return }
    let live = true
    void be.assistant.models(provider, false).then(l => {
      if (!live) return
      setModels(l)
      const want = store.get('vvterm.ai.model.' + provider) || providers.find(p => p.id === provider)?.model || ''
      setModel(l.models.some(m => m.id === want) ? want : '')
    }).catch(() => { if (live) setModels({models: [{id: '', name: 'Default (CLI decides)'}], error: '', can_list: false}) })
    return () => { live = false }
  }, [be, provider, providers])

  const policy = info?.policy ?? 'ask'
  const sharing = policy === 'on' || (policy === 'ask' && !!info?.confirmed)
  const realHost = !!info && info.host_id !== 'local' && !info.host_id.startsWith('serial:')
  const hostId = info?.host_id.replace(/^telnet:/, '') ?? ''
  const busy = !!runId

  const patchMsg = (rid: string, fn: (m: Extract<Msg, {kind: 'assistant'}>) => Partial<Extract<Msg, {kind: 'assistant'}>>) =>
    setMsgs(ms => ms.map(m => (m.kind === 'assistant' && m.rid === rid ? {...m, ...fn(m)} : m)))

  const finish = () => { offs.current.forEach(o => o()); offs.current = []; setRunId('') }

  const send = async (question: string, selection: string) => {
    if (!sid || !question.trim() || busy) return
    const rid = requestId()
    setMsgs(ms => [...ms, {kind: 'user', text: question, selection: !!selection}, {kind: 'assistant', rid, text: '', streaming: true, steps: [], confirms: [], commands: []}])
    setInput('')
    setRunId(rid)
    // listen first: the answer can start before ask() returns
    offs.current = [
      be.on(`assistant:chunk:${rid}`, (d: {text: string}) => { if (!looksLikeJSON(d.text)) patchMsg(rid, () => ({text: d.text})) }),
      be.on(`assistant:step:${rid}`, (d: AiStep) => patchMsg(rid, m => ({steps: [...m.steps, d]}))),
      be.on(`assistant:confirm:${rid}`, (d: ConfirmReq) => patchMsg(rid, m => ({confirms: [...m.confirms, d]}))),
      be.on(`assistant:done:${rid}`, (d: AiReply) => {
        patchMsg(rid, () => ({text: d.text, commands: d.commands ?? [], streaming: false,
          meta: [providers.find(p => p.id === d.provider)?.name ?? d.provider, d.model, d.redacted ? `${d.redacted} redacted` : ''].filter(Boolean).join(' · ')}))
        finish()
        void loadInfo()
      }),
      be.on(`assistant:error:${rid}`, (d: {message: string; code: string}) => {
        patchMsg(rid, () => ({streaming: false, error: d}))
        finish()
      }),
    ]
    try {
      await be.assistant.ask(sid, question, {provider, model, lines: 0, selection, request_id: rid})
    } catch (e) {
      finish()
      setMsgs(ms => ms.filter(m => !(m.kind === 'assistant' && m.rid === rid)).slice(0, -1)) // take the question back
      if (errMsg(e) === 'confirm_share') {
        setInput(question)
        try { setPreview(await be.assistant.preview(sid, 0, selection)) } catch { /* shown without */ }
        setPending({question, selection})
      } else toast.error(errMsg(e))
    }
  }

  const confirmShare = async () => {
    if (!pending || !sid) return
    const p = pending
    setPending(null)
    try { await be.assistant.confirmShare(sid); await loadInfo(); await send(p.question, p.selection) } catch (e) { toast.error(errMsg(e)) }
  }

  const cancel = () => { if (runId) void be.assistant.cancel(runId).catch(() => {}) }

  const answerTool = (rid: string, call: string, allow: boolean) => {
    void be.assistant.confirmTool(rid, call, allow).catch(() => {})
    patchMsg(rid, m => ({confirms: m.confirms.map(c => (c.call === call ? {...c, answer: allow ? 'allowed' : 'declined'} : c))}))
  }

  const askSelection = () => {
    const sel = selectionOfPane(paneId)
    if (!sel.trim()) { toast.error('Select some text in the terminal first'); return }
    void send(input.trim() || 'Explain this', sel)
  }

  const pickModel = async (v: string) => {
    if (v === CUSTOM) { setCustomModel(''); return }
    setModel(v)
    store.set('vvterm.ai.model.' + provider, v)
  }
  const saveCustomModel = async () => {
    const v = (customModel ?? '').trim()
    if (!v) { setCustomModel(null); return }
    try {
      await be.assistant.setProviderModel(provider, v)
      const l = await be.assistant.models(provider, false)
      setModels(l); setModel(v); store.set('vvterm.ai.model.' + provider, v); setCustomModel(null)
    } catch (e) { toast.error(errMsg(e)) }
  }
  const setPolicy = async (v: string) => {
    try { await be.assistant.setHostPolicy(hostId, v as AiPolicy); await loadInfo() } catch (e) { toast.error(errMsg(e)) }
  }
  const newChat = () => { if (sid) void be.assistant.resetConversation(sid).catch(() => {}); setMsgs([]) }
  const openPreview = async () => {
    if (!sid) return
    try { setPreview(await be.assistant.preview(sid, 0, '')); setShowPreview(true) } catch (e) { toast.error(errMsg(e)) }
  }

  if (loadErr) return <div className="ai-empty"><div className="error" role="alert">{loadErr}</div><button onClick={() => void loadProviders()}>Retry</button></div>
  if (providers.length > 0 && enabled.length === 0) {
    const waiting = providers.filter(p => p.status.state === 'needs_signin')
    return (
      <div className="ai-empty" data-testid="ai-setup">
        <b>AI assistant</b>
        <p className="muted">Ask an AI about what is on this terminal. VVTerm uses the AI command-line tool you already have, so no key is needed.</p>
        {waiting.length > 0 && <p className="muted">Not signed in: {waiting.map(p => `${p.name}${p.status.hint ? ' (run ' + p.status.hint + ')' : ''}`).join(', ')}.</p>}
        <button className="primary" onClick={onOpenSettings}>Enable a provider in Settings</button>
      </div>
    )
  }
  if (providers.length === 0) return <div className="ai-empty muted" data-testid="ai-setup">No AI tools were found on this computer. Install Claude Code, Codex CLI or Gemini CLI, or add your own command in Settings.<button onClick={onOpenSettings}>Open Settings</button></div>

  const modelOptions = [...(models?.models ?? []).map(m => ({value: m.id, label: m.name || m.id, hint: m.description})), {value: CUSTOM, label: 'Custom model id…'}]
  const policyOptions = [{value: '', label: `Default (${info?.production ? 'off' : 'ask first'})`}, {value: 'off', label: 'Off'}, {value: 'ask', label: 'Ask first'}, {value: 'on', label: 'On'}]

  return (
    <div className="ai-panel" data-testid="ai-panel">
      <div className="ai-head">
        <div className="ai-pickers">
          <Select className="inline" label="AI provider" value={provider} onChange={v => { setProvider(v); store.set('vvterm.ai.provider', v); setMsgs([]) }}
            options={enabled.map(p => ({value: p.id, label: p.name}))} />
          <Select className="inline" label="Model" value={model} onChange={v => void pickModel(v)} options={modelOptions} />
        </div>
        {customModel !== null && (
          <div className="ai-custom-model">
            <input aria-label="Custom model id" placeholder="model id" value={customModel} autoFocus onChange={e => setCustomModel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void saveCustomModel(); if (e.key === 'Escape') setCustomModel(null) }} />
            <button className="primary" onClick={() => void saveCustomModel()}>Use</button>
          </div>
        )}
        {models?.error && <div className="muted ai-note" role="status">{models.error}</div>}
        {models && !models.can_list && <div className="muted ai-note">{current?.name} cannot list its models: use Default or type a model id.</div>}
        <div className="ai-share">
          <span className={'ai-badge' + (sharing ? ' on' : '')} data-testid="ai-badge" title="The terminal text that goes to the AI is redacted first">
            {policy === 'off' ? 'Not sharing' : sharing ? `Sharing screen · ${preview?.redacted ?? 0} redacted` : 'Asks before sharing'}
          </span>
          <button className="link" onClick={() => void openPreview()} disabled={!sid}>What will be sent</button>
          <span className="spacer" />
          <button className="link" onClick={newChat} disabled={msgs.length === 0}>New chat</button>
        </div>
        {realHost && (
          <div className="ai-policy">
            <span className="muted">This host</span>
            <Select className="inline" label="Assistant on this host" value={info?.stored ?? ''} onChange={v => void setPolicy(v)} options={policyOptions} />
          </div>
        )}
      </div>

      {policy === 'off' ? (
        <div className="ai-empty" data-testid="ai-off">The assistant is turned off for {info?.label || 'this host'}.{realHost && <button onClick={() => void setPolicy('ask')}>Turn on (ask first)</button>}</div>
      ) : (
        <>
          <div className="ai-msgs" aria-live="polite">
            {msgs.length === 0 && <div className="muted ai-hint">Ask about the screen: “why did this fail?”, “what does this error mean?”. Commands are only suggested; you decide what runs.</div>}
            {msgs.map((m, i) => m.kind === 'user' ? (
              <div key={i} className="ai-msg user">{m.text}{m.selection && <span className="badge">selection</span>}</div>
            ) : (
              <div key={m.rid} className="ai-msg assistant" data-testid="ai-answer">
                {m.steps.length > 0 && <ul className="ai-steps">{m.steps.map((s, k) => <li key={k} className={s.state}>{s.tool}: {s.state}{s.note ? ` (${s.note})` : ''}</li>)}</ul>}
                {m.text && <div className="ai-text">{m.text}</div>}
                {m.streaming && !m.text && <div className="muted">Thinking…</div>}
                {m.confirms.map(c => (
                  <div key={c.call} className="ai-confirm" role="group" aria-label={`Allow ${c.tool}?`}>
                    <div><b>{c.server}</b> wants to run <code>{c.tool}</code></div>
                    <code className="ai-args">{c.args}</code>
                    {c.answer ? <div className="muted">{c.answer === 'allowed' ? 'Allowed' : 'Declined'}</div> : (
                      <div className="ai-cmd-actions"><button className="primary" onClick={() => answerTool(m.rid, c.call, true)}>Allow</button><button onClick={() => answerTool(m.rid, c.call, false)}>Decline</button></div>
                    )}
                  </div>
                ))}
                {m.commands.map((c, k) => <CommandCard key={k} sid={sid} cmd={c} />)}
                {m.error && (
                  <div className="ai-error" role="alert">
                    {m.error.message}
                    {m.error.code === 'needs_signin' && <button onClick={onOpenSettings}>Open Settings</button>}
                  </div>
                )}
                {m.meta && <div className="ai-meta muted">{m.meta}</div>}
              </div>
            ))}
            <div ref={listEnd} />
          </div>
          <div className="ai-composer">
            <textarea aria-label="Ask the assistant" rows={2} placeholder={sid ? 'Ask about this terminal…' : 'Waiting for the terminal…'} value={input} disabled={!sid}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input, '') } }} />
            <div className="ai-composer-actions">
              <button onClick={askSelection} disabled={!sid || busy} title="Send only the text selected in the terminal">Ask about selection</button>
              <span className="spacer" />
              {busy ? <button onClick={cancel}>Stop</button> : <button className="primary" onClick={() => void send(input, '')} disabled={!sid || !input.trim()}>Send</button>}
            </div>
          </div>
        </>
      )}

      {showPreview && preview && <PreviewDialog preview={preview} provider={current?.name ?? ''} onClose={() => setShowPreview(false)} />}
      {pending && preview && <PreviewDialog preview={preview} provider={current?.name ?? ''} onClose={() => setPending(null)} onConfirm={() => void confirmShare()} />}
    </div>
  )
}
