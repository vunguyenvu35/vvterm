import {useCallback, useEffect, useRef, useState} from 'react'
import {useBackend} from '../backend'
import {useToast} from '../ui/Toast'
import {Select} from '../ui/Select'
import {errMsg} from '../util'
import {selectionOfPane} from '../terminal/panes'
import {Modal} from '../ui/Modal'
import {CommandCard} from './CommandCard'
import {Composer, FileChip} from './Composer'
import {MessageText} from './MessageText'
import {readAttachment, toAttachment, type Attach} from './attachments'
import {PreviewDialog} from './PreviewDialog'
import {usePaneSession} from './useSession'
import type {AiCommand, AiModelList, AiPolicy, AiPreview, AiProvider, AiReply, AiSessionState, AiStep} from '../types'

interface ConfirmReq {call: string; server: string; tool: string; args: string; answer?: 'allowed' | 'declined'}

type Msg =
  | {kind: 'user'; text: string; selection?: boolean; files?: Attach[]}
  | {kind: 'assistant'; rid: string; text: string; streaming: boolean; steps: AiStep[]; confirms: ConfirmReq[]; commands: AiCommand[]; meta?: string; error?: {message: string; code: string}}

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
  const [info, setInfo] = useState<AiSessionState | null>(null)
  const [preview, setPreview] = useState<AiPreview | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [pending, setPending] = useState<{question: string; selection: string; files: Attach[]} | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<Attach[]>([])
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [pictures, setPictures] = useState<{question: string; selection: string; files: Attach[]} | null>(null)
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

  // The models of the chosen provider come from the provider itself. They load in the background (starting the CLI can
  // take a moment), once per provider, and a failure can be retried: the list is for choosing, not for typing.
  const providersRef = useRef(providers)
  providersRef.current = providers
  const [modelsBusy, setModelsBusy] = useState(false)
  const loadModels = useCallback(async (refresh: boolean) => {
    if (!provider) { setModels(null); return }
    setModelsBusy(true)
    try {
      const l = await be.assistant.models(provider, refresh)
      setModels(l)
      const want = store.get('vvterm.ai.model.' + provider) || providersRef.current.find(p => p.id === provider)?.model || ''
      setModel(l.models.some(m => m.id === want) ? want : '')
    } catch (e) {
      setModels({models: [{id: '', name: 'Default (CLI decides)'}], error: errMsg(e), can_list: true})
    } finally { setModelsBusy(false) }
  }, [be, provider])
  useEffect(() => { void loadModels(false) }, [loadModels])

  const policy = info?.policy ?? 'ask'
  const sharing = policy === 'on' || (policy === 'ask' && !!info?.confirmed)
  const realHost = !!info && info.host_id !== 'local' && !info.host_id.startsWith('serial:')
  const hostId = info?.host_id.replace(/^telnet:/, '') ?? ''
  const busy = !!runId

  const patchMsg = (rid: string, fn: (m: Extract<Msg, {kind: 'assistant'}>) => Partial<Extract<Msg, {kind: 'assistant'}>>) =>
    setMsgs(ms => ms.map(m => (m.kind === 'assistant' && m.rid === rid ? {...m, ...fn(m)} : m)))

  const finish = () => { offs.current.forEach(o => o()); offs.current = []; setRunId('') }

  const QUICK = ['Explain the last error', 'What should I check first?', 'Summarize this output', 'Is anything wrong here?']

  const send = async (question: string, selection: string, attached: Attach[] = files, allowImages = false) => {
    if (!sid || (!question.trim() && attached.length === 0) || busy) return
    question = question.trim() || (attached.some(a => a.kind === 'image') ? 'What is in this?' : 'Look at the attached file.')
    const rid = requestId()
    setMsgs(ms => [...ms, {kind: 'user', text: question, selection: !!selection, files: attached}, {kind: 'assistant', rid, text: '', streaming: true, steps: [], confirms: [], commands: []}])
    setInput('')
    setFiles([])
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
      await be.assistant.ask(sid, question, {provider, model, lines: 0, selection, request_id: rid, attachments: attached.map(toAttachment), allow_images: allowImages})
    } catch (e) {
      finish()
      setMsgs(ms => ms.filter(m => !(m.kind === 'assistant' && m.rid === rid)).slice(0, -1)) // take the question back
      if (errMsg(e) === 'confirm_share') {
        setInput(question); setFiles(attached)
        try { setPreview(await be.assistant.preview(sid, 0, selection, attached.map(toAttachment))) } catch { /* shown without */ }
        setPending({question, selection, files: attached})
      } else if (errMsg(e) === 'confirm_images') {
        setInput(question); setFiles(attached)
        setPictures({question, selection, files: attached})
      } else { setInput(question); setFiles(attached); toast.error(errMsg(e)) }
    }
  }

  const confirmShare = async () => {
    if (!pending || !sid) return
    const p = pending
    setPending(null)
    try { await be.assistant.confirmShare(sid); await loadInfo(); await send(p.question, p.selection, p.files) } catch (e) { toast.error(errMsg(e)) }
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
  const addFiles = async (list: File[]) => {
    let taken = files
    for (const f of list) {
      try {
        const r = await readAttachment(f, taken, !!current?.supports_images)
        if (r.ok) { taken = [...taken, r.attach]; setFiles(taken) } else toast.error(r.error)
      } catch (e) { toast.error(errMsg(e)) }
    }
  }
  // dragging a file over the panel shows where to drop it
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const dragProps = {
    onDragEnter: (e: React.DragEvent) => { if (isFileDrag(e)) { e.preventDefault(); dragDepth.current++; setDragging(true) } },
    onDragOver: (e: React.DragEvent) => { if (isFileDrag(e)) e.preventDefault() },
    onDragLeave: (e: React.DragEvent) => { if (isFileDrag(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault(); dragDepth.current = 0; setDragging(false)
      void addFiles(Array.from(e.dataTransfer.files))
    },
  }

  const pickModel = (v: string) => {
    setModel(v)
    store.set('vvterm.ai.model.' + provider, v)
  }
  const setPolicy = async (v: string) => {
    try { await be.assistant.setHostPolicy(hostId, v as AiPolicy); await loadInfo() } catch (e) { toast.error(errMsg(e)) }
  }
  const newChat = () => { if (sid) void be.assistant.resetConversation(sid).catch(() => {}); setMsgs([]) }
  const openPreview = async () => {
    if (!sid) return
    try { setPreview(await be.assistant.preview(sid, 0, '', files.map(toAttachment))); setShowPreview(true) } catch (e) { toast.error(errMsg(e)) }
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

  const modelOptions = (models?.models ?? []).map(m => ({value: m.id, label: m.name || m.id, hint: m.description}))
  const policyOptions = [{value: '', label: `Default (${info?.production ? 'off' : 'ask first'})`}, {value: 'off', label: 'Off'}, {value: 'ask', label: 'Ask first'}, {value: 'on', label: 'On'}]

  return (
    <div className={'ai-panel' + (dragging ? ' dropping' : '')} data-testid="ai-panel" {...dragProps}>
      {dragging && <div className="ai-drop" role="status">Drop files or screenshots to add them to your question</div>}
      <div className="ai-head">
        <div className="ai-pickers">
          <Select className="inline" label="AI provider" value={provider} onChange={v => { setProvider(v); store.set('vvterm.ai.provider', v); setMsgs([]) }}
            options={enabled.map(p => ({value: p.id, label: p.name}))} />
          <Select className="inline" label="Model" value={modelsBusy ? '' : model} onChange={pickModel} options={modelOptions} disabled={modelsBusy}
            placeholder={modelsBusy ? 'Loading models…' : undefined} />
        </div>
        {!modelsBusy && models?.error && (
          <div className="ai-note ai-models-error" role="status">
            <span>Models could not be loaded: {models.error}</span>
            <button onClick={() => void loadModels(true)}>Retry</button>
          </div>
        )}
        {!modelsBusy && models && !models.can_list && <div className="muted ai-note">{current?.name} cannot list its models, so it uses its default one.</div>}
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
            {msgs.length === 0 && (
              <div className="ai-intro">
                <b>Ask about this terminal</b>
                <div className="muted">I read the screen (secrets hidden), explain it and suggest commands. You decide what runs. You can also drop a log or a screenshot here.</div>
                <div className="ai-quick" role="group" aria-label="Suggestions">
                  {QUICK.map(q => <button key={q} onClick={() => void send(q, '')} disabled={!sid || busy}>{q}</button>)}
                </div>
              </div>
            )}
            {msgs.map((m, i) => m.kind === 'user' ? (
              <div key={i} className="ai-msg user">
                {m.files && m.files.length > 0 && <div className="ai-chips">{m.files.map(f => <FileChip key={f.id} file={f} />)}</div>}
                {m.text}{m.selection && <span className="badge">selection</span>}
              </div>
            ) : (
              <div key={m.rid} className="ai-msg assistant" data-testid="ai-answer">
                {m.steps.length > 0 && <ul className="ai-steps">{m.steps.map((s, k) => <li key={k} className={s.state}>{s.tool}: {s.state}{s.note ? ` (${s.note})` : ''}</li>)}</ul>}
                {m.text && <MessageText text={m.text} />}
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
          <Composer value={input} onChange={setInput} files={files} onRemoveFile={id => setFiles(fs => fs.filter(f => f.id !== id))} onAddFiles={list => void addFiles(list)}
            onSend={() => void send(input, '')} onUseSelection={askSelection} onStop={cancel} busy={busy} ready={!!sid} images={!!current?.supports_images} />
        </>
      )}

      {showPreview && preview && <PreviewDialog preview={preview} provider={current?.name ?? ''} onClose={() => setShowPreview(false)} />}
      {pictures && (
        <Modal title="Send pictures as they are?" onClose={() => setPictures(null)}
          footer={<><button onClick={() => setPictures(null)}>Cancel</button><button className="primary" onClick={() => { const p = pictures; setPictures(null); void send(p.question, p.selection, p.files, true) }}>Send pictures</button></>}>
          <div className="ai-chips">{pictures.files.filter(f => f.kind === 'image').map(f => <FileChip key={f.id} file={f} />)}</div>
          <p>VVTerm hides secrets in text, but it <b>cannot find a secret inside a picture</b>. Anything you can see in {pictures.files.length === 1 ? 'it' : 'them'} goes to <b>{current?.name}</b> as it is. The terminal text and text files are still redacted.</p>
          <p className="muted">Check that no password, token or key is visible before you send.</p>
        </Modal>
      )}
      {pending && preview && <PreviewDialog preview={preview} provider={current?.name ?? ''} onClose={() => setPending(null)} onConfirm={() => void confirmShare()} />}
    </div>
  )
}
