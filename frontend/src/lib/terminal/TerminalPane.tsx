import {getHistory, recordCommand} from './history'
import {createSuggester, SUGGEST_POPUP, type Suggester, type SuggestTerm} from './suggester'
import type {Snippet} from '../types'
import {ConnectScreen} from './ConnectScreen'
import {useEffect, useRef, useState} from 'react'
import {ITheme, Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import {SearchAddon} from '@xterm/addon-search'
import {WebLinksAddon} from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {useBackend} from '../backend'
import {b64ToBytes, errMsg} from '../util'
import {registerPane, registerSelection, setPaneSession, setPaneStatus} from './panes'
import {createHighlighter, HighlightTerm} from './highlight'
import {matches} from '../shortcuts/shortcuts'
import {IconArrowDown, IconArrowUp} from '../ui/Icons'
import type {ClosedInfo, HostKeyPrompt} from '../types'

interface Props {
  hostId: string
  /** identifies the pane so other parts of the UI (snippets) can type into it */
  paneId?: string
  visible: boolean
  focused: boolean
  fontSize: number
  fontFamily: string
  termTheme: ITheme
  /** key combination that toggles the scrollback search (default Mod+F) */
  searchCombo?: string
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  scrollback: number
  /** colour URLs, IPs, paths and error / warning / success words (default on) */
  highlight?: boolean
  /** copy the selection to the clipboard as soon as it is made (default on) */
  copyOnSelect?: boolean
  /** what a right click does (default: paste) */
  rightClick?: 'paste' | 'menu' | 'none'
  /** key combinations for Copy and Paste (platform defaults when not given) */
  copyCombo?: string
  /** keys the app owns and the terminal must let through to it (Next / Previous tab): xterm would send them to the shell and swallow them */
  appCombos?: string[]
  pasteCombo?: string
  /** command suggestions while typing (the Suggest setting; default on) */
  suggest?: boolean
  /** also read the shell history of the server for them */
  suggestHost?: boolean
  /** key that opens the list of suggestions */
  suggestCombo?: string
  /** who this pane connects to: drawn on the connecting screen */
  connect?: {label: string; os?: string; subtitle: string}
  onShowLogs?(): void
  /** the Close button of the connecting screen */
  onCloseTab?(): void
  /** what the user typed in this pane (the Workspace sends it to the other panes while broadcasting) */
  onTyped?(data: string): void
  onFocus(): void
  /** The remote shell ended cleanly (user typed exit): the pane can go away. */
  onExit(): void
}

type State = 'connecting' | 'ready' | 'closed'

/**
 * What is typed or pasted goes to the shell composed (NFC). On macOS the input methods of a web view can give a letter in
 * pieces, such as the Vietnamese ệ as e + dot below + circumflex; zsh cannot edit a line with such pieces and shows them
 * as <0087>. Composed text is what every other terminal sends. Control sequences are plain ASCII and are not changed.
 */
export function composedInput(d: string): string {
  return /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff]/.test(d) ? d.normalize('NFC') : d
}

/** The part of a terminal that followReplacements uses (xterm's Terminal has all of it). */
interface ComposingTerm {
  textarea?: HTMLTextAreaElement
  onData(cb: (d: string) => void): {dispose(): void}
  input(data: string, wasUserInput?: boolean): void
}

/**
 * Some input methods (the Vietnamese ones of macOS in WKWebView, for one) do not compose in xterm's hidden text box:
 * every key replaces the whole word being typed there ("tieng" becomes "tiéng") with an `insertReplacementText` input
 * event. xterm.js ignores those events, so only the first letter of each word and the spaces reached the shell:
 * "gõ tiếng việt" arrived as "g t v". Here the word as the shell has it is tracked, and every replacement sends what
 * differs: backspaces for the letters that changed, then the new letters (what Unikey or OpenKey do too).
 * Returns what undoes it.
 */
export function followReplacements(t: ComposingTerm): () => void {
  const ta = t.textarea
  if (!ta) return () => {}
  let word = '' // the word typed so far, as the shell has it
  let ours = false // data that we send ourselves is not xterm's
  const sub = t.onData(d => {
    if (ours) return
    // letters extend the word; a space, Enter, Backspace, a control key or an escape sequence ends it
    word = /^[^\s\u0000-\u001f\u007f]+$/.test(d) ? word + d : ''
  })
  const onInput = (e: Event) => {
    const ev = e as InputEvent
    if (ev.inputType !== 'insertReplacementText' || !ev.data) return
    const want = Array.from(ev.data.normalize('NFC'))
    const have = Array.from(word)
    let same = 0
    while (same < want.length && same < have.length && want[same] === have[same]) same++
    const out = '\x7f'.repeat(have.length - same) + want.slice(same).join('')
    word = want.join('')
    if (!out) return
    ours = true
    try { t.input(out, true) } finally { ours = false }
  }
  ta.addEventListener('input', onInput)
  return () => { ta.removeEventListener('input', onInput); sub.dispose() }
}

/**
 * Text being composed with an input method (Vietnamese Telex, Chinese pinyin, Japanese…) is shown at the cursor, highlighted,
 * until it is committed, like in other terminals. xterm.js draws it in a small element; the colours (the theme's own, inverted)
 * are handed to the stylesheet through two custom properties.
 */
export function imeColours(el: HTMLElement | null, theme: {foreground?: string; background?: string}) {
  el?.style.setProperty('--ime-bg', theme.foreground || '#ffffff')
  el?.style.setProperty('--ime-fg', theme.background || '#000000')
}

/** One SSH session rendered with xterm.js. Keystrokes go to Go, output arrives as batched events. */
export function TerminalPane(p: Props) {
  const be = useBackend()
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal>()
  const fit = useRef<FitAddon>()
  const search = useRef<SearchAddon>()
  const highlighter = useRef<ReturnType<typeof createHighlighter>>()
  const sid = useRef('')
  const stateRef = useRef<State>('connecting')
  const [state, setState] = useState<State>('connecting')
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null)
  const [closed, setClosed] = useState<ClosedInfo | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [needle, setNeedle] = useState('')
  const onExit = useRef(p.onExit)
  const searchCombo = useRef(p.searchCombo ?? 'Mod+F')
  searchCombo.current = p.searchCombo ?? 'Mod+F'
  const copyCombo = useRef(p.copyCombo ?? 'Mod+Shift+C')
  const pasteCombo = useRef(p.pasteCombo ?? 'Mod+Shift+V')
  const copyOnSelect = useRef(p.copyOnSelect ?? true)
  const rightClick = useRef(p.rightClick ?? 'paste')
  copyCombo.current = p.copyCombo ?? 'Mod+Shift+C'
  const appCombos = useRef<string[]>([])
  appCombos.current = p.appCombos ?? []
  pasteCombo.current = p.pasteCombo ?? 'Mod+Shift+V'
  copyOnSelect.current = p.copyOnSelect ?? true
  rightClick.current = p.rightClick ?? 'paste'
  const [menu, setMenu] = useState<{x: number; y: number} | null>(null)
  const focusedRef = useRef(p.focused && p.visible)
  focusedRef.current = p.focused && p.visible
  const suggestOn = useRef(p.suggest ?? true)
  suggestOn.current = p.suggest ?? true
  const suggestCombo = useRef(p.suggestCombo ?? 'Mod+Shift+J')
  suggestCombo.current = p.suggestCombo ?? 'Mod+Shift+J'
  const suggestHost = useRef(p.suggestHost ?? false)
  suggestHost.current = p.suggestHost ?? false
  const hostCmds = useRef<string[]>([])
  const onTyped = useRef(p.onTyped)
  onTyped.current = p.onTyped
  onExit.current = p.onExit

  const setSt = (s: State) => { stateRef.current = s; setState(s) }
  // how far the connection got (events from the backend) and where the line stood when it failed
  const [stage, setStage] = useState<'connecting' | 'authenticated'>('connecting')
  const retry = useRef<() => void>(() => {})
  const everReady = useRef(false)
  useEffect(() => { if (state === 'ready') everReady.current = true }, [state])
  // Where the connecting line is heading: slowly while the backend works, further once the login is done, and
  // to the very end when the session is ready (still smoothly: the screen goes when the line has arrived).
  const lineTarget = state === 'ready' ? 1 : stage === 'authenticated' ? 0.92 : 0.55
  const lineRate = state === 'ready' ? 7 : stage === 'authenticated' ? 0.9 : 0.35
  const [lineDone, setLineDone] = useState(true)
  useEffect(() => { if (state === 'connecting') setLineDone(false); else if (state === 'closed') setLineDone(true) }, [state])
  // the tab that holds this pane shows whether it is connecting or closed
  useEffect(() => {
    if (!p.paneId) return
    setPaneStatus(p.paneId, state)
    return () => setPaneStatus(p.paneId!, null)
  }, [state, p.paneId])

  // The clipboard goes through the native runtime where there is one (a webview often refuses page scripts).
  const copyText = (text: string) => { if (text) void be.system.writeClipboard(text).catch(() => {}) }
  const pasteClipboard = async () => {
    try {
      const text = await be.system.readClipboard()
      // the terminal turns it into bracketed paste when the shell asks for that, and the keys go out in order
      if (text && stateRef.current === 'ready') term.current?.paste(text)
    } catch { /* clipboard not available */ }
  }

  useEffect(() => {
    const t = new Terminal({
      fontSize: p.fontSize, fontFamily: p.fontFamily, cursorBlink: p.cursorBlink, cursorStyle: p.cursorStyle, cursorInactiveStyle: 'bar', cursorWidth: 2,
      scrollback: p.scrollback, allowProposedApi: true, theme: p.termTheme,
    })
    const f = new FitAddon()
    const s = new SearchAddon()
    t.loadAddon(f)
    t.loadAddon(s)
    t.loadAddon(new WebLinksAddon())
    term.current = t
    fit.current = f
    search.current = s
    t.open(host.current!)
    imeColours(host.current, p.termTheme)
    const unfollowIme = followReplacements(t as unknown as ComposingTerm)
    try { f.fit() } catch { /* hidden */ }

    // Command suggestions: the sources are the commands typed here, the snippets and (when asked) the host's history
    let snippets: Snippet[] = []
    const loadSnippets = () => { void be.snippets.list().then(l => { snippets = l }).catch(() => {}) }
    loadSnippets()
    window.addEventListener('focus', loadSnippets)
    let suggester: Suggester | null = null
    const popupFromMenu = () => { if (focusedRef.current) suggester?.togglePopup() }
    window.addEventListener(SUGGEST_POPUP, popupFromMenu)
    if (host.current?.parentElement) {
      suggester = createSuggester({
        term: t as unknown as SuggestTerm, container: host.current.parentElement, send: d => sendKeys(d),
        sources: () => ({typed: getHistory(), snippets, host: hostCmds.current}),
        enabled: () => suggestOn.current, ready: () => stateRef.current === 'ready', popupCombo: () => suggestCombo.current, onCommand: recordCommand,
      })
    }

    // Termius-style colouring of finished lines, a moment after output stops arriving
    const hl = createHighlighter(t as unknown as HighlightTerm)
    highlighter.current = hl
    let hlTimer = 0
    const hlSub = (t as unknown as {onWriteParsed?(cb: () => void): {dispose(): void}}).onWriteParsed?.(() => {
      window.clearTimeout(hlTimer)
      hlTimer = window.setTimeout(() => hl.scan(), 60)
      suggester?.refresh()
    })
    if (p.highlight === false) hl.dispose()

    let disposed = false
    const offs: Array<() => void> = []

    // Keystrokes leave one call at a time and in order: separate calls that are in flight together may be
    // run in any order by the backend (typing "echo" arrived as "ceho"). What is typed while a call is
    // running goes out together in the next one.
    let pendingKeys = ''
    let sending = false
    const sendKeys = (d: string) => {
      pendingKeys += d
      if (sending) return
      const flush = () => {
        if (!pendingKeys) { sending = false; return }
        const chunk = pendingKeys
        pendingKeys = ''
        sending = true
        be.session.write(sid.current, chunk).catch(() => {}).finally(flush)
      }
      flush()
    }

    // Never reconnect automatically: replaying commands unexpectedly is dangerous. Enter or the Retry button asks for it.
    retry.current = () => {
      setClosed(null)
      setStage('connecting')
      setSt('connecting')
      void be.session.reconnect(sid.current, t.cols, t.rows).catch(e => {
        setClosed({reason: errMsg(e), clean: false})
        setSt('closed')
      })
    }
    t.onData(raw => {
      const d = composedInput(raw)
      if (stateRef.current === 'ready') {
        suggester?.feed(d)
        sendKeys(d)
        onTyped.current?.(d)
      } else if (stateRef.current === 'closed' && (d === '\r' || d === '\n')) {
        retry.current()
      }
    })
    const unregSelection = p.paneId ? registerSelection(p.paneId, () => t.getSelection()) : () => {}
    const unregister = p.paneId ? registerPane(p.paneId, text => {
      if (stateRef.current !== 'ready') return false
      sendKeys(text)
      suggester?.feed(text)
      return true
    }) : () => {}
    t.onResize(({cols, rows}) => {
      if (sid.current && cols > 0 && rows > 0) void be.session.resize(sid.current, cols, rows).catch(() => {})
    })
    t.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true
      if (suggester?.handleKey(e)) return false
      if (matches(e, searchCombo.current)) {
        setShowSearch(v => !v)
        return false
      }
      if (matches(e, copyCombo.current)) {
        const sel = t.getSelection()
        if (!sel) return true // nothing selected: the key goes to the shell (Ctrl+C is the interrupt)
        copyText(sel)
        e.preventDefault()
        return false
      }
      if (matches(e, pasteCombo.current)) {
        e.preventDefault()
        void pasteClipboard()
        return false
      }
      if (appCombos.current.some(c => matches(e, c))) return false // not for the shell: the app's own handler gets it
      return true
    })

    const cursorSub = (t as unknown as {onCursorMove?(cb: () => void): {dispose(): void}}).onCursorMove?.(() => suggester?.refresh())

    // copy on select: once the selection stops changing
    let selTimer = 0
    const selSub = (t as unknown as {onSelectionChange?(cb: () => void): {dispose(): void}}).onSelectionChange?.(() => {
      window.clearTimeout(selTimer)
      selTimer = window.setTimeout(() => { if (copyOnSelect.current) copyText(t.getSelection()) }, 150)
    })

    ;(async () => {
      try {
        const id = await be.session.open(p.hostId, t.cols || 80, t.rows || 24)
        if (disposed) { void be.session.close(id).catch(() => {}); return }
        sid.current = id
        if (p.paneId) setPaneSession(p.paneId, id)
        offs.push(be.on(`term:data:${id}`, (b64: string) => {
          t.write(b64ToBytes(b64))
          // output can only come from a live shell: do not keep the connecting screen up until the ready event
          if (stateRef.current === 'connecting') setSt('ready')
        }))
        offs.push(be.on(`term:ready:${id}`, () => { setPrompt(null); setClosed(null); setSt('ready') }))
        offs.push(be.on(`term:hostkey:${id}`, (hk: HostKeyPrompt) => setPrompt(hk)))
        offs.push(be.on(`term:progress:${id}`, (e: {stage?: string}) => { if (e?.stage === 'authenticated') setStage('authenticated') }))
        offs.push(be.on(`term:closed:${id}`, (c: ClosedInfo) => {
          setPrompt(null)
          setSt('closed')
          if (c.clean) onExit.current()
          else setClosed(c)
        }))
        await be.session.attach(id) // replays anything emitted before we subscribed
      } catch (e) {
        setClosed({reason: errMsg(e), clean: false})
        setSt('closed')
      }
    })()

    const ro = new ResizeObserver(() => { try { f.fit() } catch { /* hidden */ } })
    ro.observe(host.current!)

    return () => {
      disposed = true
      window.clearTimeout(hlTimer)
      window.clearTimeout(selTimer)
      hlSub?.dispose()
      cursorSub?.dispose()
      suggester?.dispose()
      window.removeEventListener('focus', loadSnippets)
      window.removeEventListener(SUGGEST_POPUP, popupFromMenu)
      selSub?.dispose()
      unfollowIme()
      hl.dispose()
      unregister()
      unregSelection()
      if (p.paneId) setPaneSession(p.paneId, null)
      ro.disconnect()
      offs.forEach(o => o())
      if (sid.current) void be.session.close(sid.current).catch(() => {})
      t.dispose()
    }
    // the session lives as long as the pane; appearance changes are applied below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [be, p.hostId])

  useEffect(() => {
    const t = term.current
    if (!t) return
    t.options.fontSize = p.fontSize
    t.options.fontFamily = p.fontFamily
    t.options.theme = p.termTheme
    imeColours(host.current, p.termTheme)
    t.options.cursorStyle = p.cursorStyle
    t.options.cursorBlink = p.cursorBlink
    t.options.scrollback = p.scrollback
    try { fit.current?.fit() } catch { /* hidden */ }
  }, [p.fontSize, p.fontFamily, p.termTheme, p.cursorStyle, p.cursorBlink, p.scrollback])

  // the shell history is read once the session is ready: this computer's for the local terminal, a server's when asked for
  useEffect(() => {
    if (state !== 'ready' || !sid.current || p.suggest === false) { hostCmds.current = []; return }
    let gone = false
    void be.session.hostHistory(sid.current).then(l => { if (!gone) hostCmds.current = l }).catch(() => { if (!gone) hostCmds.current = [] }) // refused: an SSH host while that setting is off
    return () => { gone = true }
  }, [be, state, p.suggest, p.suggestHost])

  // the Highlight output switch in Settings
  useEffect(() => {
    const hl = highlighter.current
    if (!hl) return
    if (p.highlight === false) hl.dispose()
    else { hl.reset(); hl.scan() }
  }, [p.highlight])

  useEffect(() => {
    if (p.visible) {
      try { fit.current?.fit() } catch { /* hidden */ }
      if (p.focused) term.current?.focus()
    }
  }, [p.visible, p.focused])

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault() // never the browser's own menu
    const mode = rightClick.current
    if (mode === 'paste') void pasteClipboard()
    else if (mode === 'menu') setMenu({x: e.clientX, y: e.clientY})
  }
  // the right-click menu goes away on any click, Esc, or when the pane loses its place
  useEffect(() => {
    if (!menu) return
    const off = () => setMenu(null)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); off() } }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc, true)
    window.addEventListener('blur', off)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc, true); window.removeEventListener('blur', off) }
  }, [menu])
  const hasSelection = !!menu && !!term.current?.hasSelection()

  const trust = (ok: boolean) => {
    if (!prompt) return
    void be.session.trustHostKey(sid.current, ok ? prompt.fingerprint : '').catch(e => setClosed({reason: errMsg(e), clean: false}))
    setPrompt(null)
  }

  return (
    <div className={'pane' + (p.focused ? ' focused' : '')} onMouseDown={p.onFocus} onContextMenu={onContextMenu} data-testid="pane" style={{background: p.termTheme.background}}>
      <div ref={host} style={{height: '100%', background: p.termTheme.background}} />
      {menu && (
        <div className="ctx-menu" role="menu" aria-label="Terminal" style={{left: menu.x, top: menu.y}} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
          <button role="menuitem" disabled={!hasSelection} onClick={() => { copyText(term.current?.getSelection() ?? ''); setMenu(null); term.current?.focus() }}>Copy</button>
          <button role="menuitem" onClick={() => { void pasteClipboard(); setMenu(null); term.current?.focus() }}>Paste</button>
          <button role="menuitem" onClick={() => { term.current?.selectAll(); setMenu(null) }}>Select all</button>
          <button role="menuitem" onClick={() => { term.current?.clear(); setMenu(null); term.current?.focus() }}>Clear</button>
        </div>
      )}
      {showSearch && (
        <div className="searchbar">
          <input autoFocus aria-label="Search terminal" value={needle} placeholder="Find…"
            onChange={e => { setNeedle(e.target.value); search.current?.findNext(e.target.value, {incremental: true}) }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.shiftKey ? search.current?.findPrevious(needle) : search.current?.findNext(needle)
              if (e.key === 'Escape') { setShowSearch(false); term.current?.focus() }
            }} />
          <button className="icon" aria-label="Previous match" onClick={() => search.current?.findPrevious(needle)}><IconArrowUp size={15} /></button>
          <button className="icon" aria-label="Next match" onClick={() => search.current?.findNext(needle)}><IconArrowDown size={15} /></button>
        </div>
      )}
      {p.connect && !prompt && (state === 'connecting' || (state === 'ready' && !lineDone) || (state === 'closed' && closed && !everReady.current)) ? (
        <div className="connect-over" role={state === 'closed' ? undefined : 'status'} aria-label={state === 'closed' ? 'Connection failed' : 'Connecting'} style={{background: p.termTheme.background}}
          // a click on the screen must not take the keyboard away from the terminal under it
          onMouseDown={e => { if (!(e.target as HTMLElement).closest('button')) e.preventDefault() }}>
          <ConnectScreen label={p.connect.label} os={p.connect.os} subtitle={p.connect.subtitle} step={state === 'closed' ? 'failed' : 'connecting'}
            target={lineTarget} rate={lineRate} onFull={() => setLineDone(true)}
            headerAction={p.onShowLogs ? <button onClick={p.onShowLogs}>Show logs</button> : undefined}
            footer={state === 'closed'
              ? <>{p.onCloseTab ? <button onClick={p.onCloseTab}>Close</button> : <span />}<button className="primary" onClick={() => retry.current()}>Retry</button></>
              : p.onCloseTab ? <button onClick={p.onCloseTab}>Close</button> : undefined}>
            {state === 'closed' && closed
              ? <div className="connect-error" role="alert">{closed.reason}<small>Press Enter to try again</small></div>
              : <div className="connect-msg">{stage === 'authenticated' ? 'Opening the shell…' : 'Connecting…'}</div>}
          </ConnectScreen>
        </div>
      ) : (!p.connect && state === 'connecting' && !prompt ? <div className="banner info">Connecting…</div> : null)}
      {state === 'closed' && closed && !(!everReady.current && p.connect) && (
        <div className="banner" role="alert">
          <span>{closed.reason}</span>
          <b>Press Enter to reconnect</b>
        </div>
      )}
      {prompt && (
        <div className="overlay" role="alertdialog" aria-label="Host key confirmation">
          <div className="card">
            <h3 style={{marginTop: 0}}>Unknown host key</h3>
            <div>The authenticity of <b>{prompt.host}</b> can't be established.</div>
            <div className="muted">{prompt.key_type} fingerprint</div>
            <div className="fp" data-testid="fingerprint">{prompt.fingerprint}</div>
            <div className="row">
              <button className="primary" onClick={() => trust(true)}>Trust and connect</button>
              <button onClick={() => trust(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
