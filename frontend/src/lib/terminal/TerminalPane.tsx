import {createLineTracker, recordCommand} from './history'
import {ConnectScreen} from './ConnectScreen'
import {useEffect, useRef, useState} from 'react'
import {ITheme, Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import {SearchAddon} from '@xterm/addon-search'
import {WebLinksAddon} from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {useBackend} from '../backend'
import {b64ToBytes, errMsg} from '../util'
import {registerPane} from './panes'
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
  pasteCombo?: string
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
  pasteCombo.current = p.pasteCombo ?? 'Mod+Shift+V'
  copyOnSelect.current = p.copyOnSelect ?? true
  rightClick.current = p.rightClick ?? 'paste'
  const [menu, setMenu] = useState<{x: number; y: number} | null>(null)
  const onTyped = useRef(p.onTyped)
  onTyped.current = p.onTyped
  onExit.current = p.onExit

  const setSt = (s: State) => { stateRef.current = s; setState(s) }

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
    try { f.fit() } catch { /* hidden */ }

    // Termius-style colouring of finished lines, a moment after output stops arriving
    const hl = createHighlighter(t as unknown as HighlightTerm)
    highlighter.current = hl
    let hlTimer = 0
    const hlSub = (t as unknown as {onWriteParsed?(cb: () => void): {dispose(): void}}).onWriteParsed?.(() => {
      window.clearTimeout(hlTimer)
      hlTimer = window.setTimeout(() => hl.scan(), 60)
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

    const track = createLineTracker()
    t.onData(d => {
      if (stateRef.current === 'ready') {
        sendKeys(d)
        onTyped.current?.(d)
        for (const line of track(d)) {
          // only what the terminal echoed: a password prompt shows nothing, so nothing is remembered. The echo
          // comes back from the server a moment after the keys, so look a moment later, a few lines up.
          const tail = line.trim().slice(-20)
          window.setTimeout(() => {
            const buf = t.buffer?.active
            if (!buf || buf.type !== 'normal') return
            for (let y = buf.baseY + buf.cursorY, n = 0; y >= 0 && n < 8; y--, n++) {
              if (buf.getLine(y)?.translateToString(true).includes(tail)) { recordCommand(line); return }
            }
          }, 250)
        }
      } else if (stateRef.current === 'closed' && (d === '\r' || d === '\n')) {
        // Never reconnect automatically: replaying commands unexpectedly is dangerous.
        setClosed(null)
        setSt('connecting')
        void be.session.reconnect(sid.current, t.cols, t.rows).catch(e => {
          setClosed({reason: errMsg(e), clean: false})
          setSt('closed')
        })
      }
    })
    const unregister = p.paneId ? registerPane(p.paneId, text => {
      if (stateRef.current !== 'ready') return false
      sendKeys(text)
      return true
    }) : () => {}
    t.onResize(({cols, rows}) => {
      if (sid.current && cols > 0 && rows > 0) void be.session.resize(sid.current, cols, rows).catch(() => {})
    })
    t.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown') return true
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
      return true
    })

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
        offs.push(be.on(`term:data:${id}`, (b64: string) => {
          t.write(b64ToBytes(b64))
          // output can only come from a live shell: do not keep the connecting screen up until the ready event
          if (stateRef.current === 'connecting') setSt('ready')
        }))
        offs.push(be.on(`term:ready:${id}`, () => { setPrompt(null); setClosed(null); setSt('ready') }))
        offs.push(be.on(`term:hostkey:${id}`, (hk: HostKeyPrompt) => setPrompt(hk)))
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
      selSub?.dispose()
      hl.dispose()
      unregister()
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
    t.options.cursorStyle = p.cursorStyle
    t.options.cursorBlink = p.cursorBlink
    t.options.scrollback = p.scrollback
    try { fit.current?.fit() } catch { /* hidden */ }
  }, [p.fontSize, p.fontFamily, p.termTheme, p.cursorStyle, p.cursorBlink, p.scrollback])

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
      {state === 'connecting' && !prompt && (p.connect
        ? (
          <div className="connect-over" role="status" aria-label="Connecting" style={{background: p.termTheme.background}}>
            <ConnectScreen label={p.connect.label} os={p.connect.os} subtitle={p.connect.subtitle} step="connecting"
              headerAction={p.onShowLogs ? <button onClick={p.onShowLogs}>Show logs</button> : undefined}
              footer={p.onCloseTab ? <button onClick={p.onCloseTab}>Close</button> : undefined}>
              <div className="connect-msg">Connecting…</div>
            </ConnectScreen>
          </div>
        )
        : <div className="banner info">Connecting…</div>)}
      {state === 'closed' && closed && (
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
