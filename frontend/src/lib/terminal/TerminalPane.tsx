import {useEffect, useRef, useState} from 'react'
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import {SearchAddon} from '@xterm/addon-search'
import {WebLinksAddon} from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {useBackend} from '../backend'
import {b64ToBytes, errMsg} from '../util'
import type {ClosedInfo, HostKeyPrompt} from '../types'

interface Props {
  hostId: string
  visible: boolean
  focused: boolean
  fontSize: number
  fontFamily: string
  theme: 'dark' | 'light'
  onFocus(): void
  /** The remote shell ended cleanly (user typed exit): the pane can go away. */
  onExit(): void
}

const THEMES = {
  dark: {background: '#0c0e12', foreground: '#e6e8ee', cursor: '#5b8cff', selectionBackground: '#33415c'},
  light: {background: '#ffffff', foreground: '#1b1f2a', cursor: '#2f62e0', selectionBackground: '#cfdcff'},
}

type State = 'connecting' | 'ready' | 'closed'

/** One SSH session rendered with xterm.js. Keystrokes go to Go, output arrives as batched events. */
export function TerminalPane(p: Props) {
  const be = useBackend()
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal>()
  const fit = useRef<FitAddon>()
  const search = useRef<SearchAddon>()
  const sid = useRef('')
  const stateRef = useRef<State>('connecting')
  const [state, setState] = useState<State>('connecting')
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null)
  const [closed, setClosed] = useState<ClosedInfo | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [needle, setNeedle] = useState('')
  const onExit = useRef(p.onExit)
  onExit.current = p.onExit

  const setSt = (s: State) => { stateRef.current = s; setState(s) }

  useEffect(() => {
    const t = new Terminal({
      fontSize: p.fontSize, fontFamily: p.fontFamily, cursorBlink: true, scrollback: 10000, allowProposedApi: true,
      theme: THEMES[p.theme],
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

    let disposed = false
    const offs: Array<() => void> = []

    t.onData(d => {
      if (stateRef.current === 'ready') {
        void be.session.write(sid.current, d).catch(() => {})
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
    t.onResize(({cols, rows}) => {
      if (sid.current && cols > 0 && rows > 0) void be.session.resize(sid.current, cols, rows).catch(() => {})
    })
    t.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        setShowSearch(v => !v)
        return false
      }
      return true
    })

    ;(async () => {
      try {
        const id = await be.session.open(p.hostId, t.cols || 80, t.rows || 24)
        if (disposed) { void be.session.close(id).catch(() => {}); return }
        sid.current = id
        offs.push(be.on(`term:data:${id}`, (b64: string) => t.write(b64ToBytes(b64))))
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
    t.options.theme = THEMES[p.theme]
    try { fit.current?.fit() } catch { /* hidden */ }
  }, [p.fontSize, p.fontFamily, p.theme])

  useEffect(() => {
    if (p.visible) {
      try { fit.current?.fit() } catch { /* hidden */ }
      if (p.focused) term.current?.focus()
    }
  }, [p.visible, p.focused])

  const trust = (ok: boolean) => {
    if (!prompt) return
    void be.session.trustHostKey(sid.current, ok ? prompt.fingerprint : '').catch(e => setClosed({reason: errMsg(e), clean: false}))
    setPrompt(null)
  }

  return (
    <div className={'pane' + (p.focused ? ' focused' : '')} onMouseDown={p.onFocus} data-testid="pane">
      <div ref={host} style={{height: '100%'}} />
      {showSearch && (
        <div className="searchbar">
          <input autoFocus aria-label="Search terminal" value={needle} placeholder="Find…"
            onChange={e => { setNeedle(e.target.value); search.current?.findNext(e.target.value, {incremental: true}) }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.shiftKey ? search.current?.findPrevious(needle) : search.current?.findNext(needle)
              if (e.key === 'Escape') { setShowSearch(false); term.current?.focus() }
            }} />
          <button className="icon" onClick={() => search.current?.findPrevious(needle)}>↑</button>
          <button className="icon" onClick={() => search.current?.findNext(needle)}>↓</button>
        </div>
      )}
      {state === 'connecting' && !prompt && <div className="banner info">Connecting…</div>}
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
