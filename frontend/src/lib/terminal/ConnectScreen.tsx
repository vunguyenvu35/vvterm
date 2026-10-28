import {ReactNode, useEffect, useRef, useState} from 'react'
import {OsIcon} from '../ui/OsIcon'
import {IconPlug, IconServer, IconTerminal} from '../ui/Icons'

export type ConnectStep = 'choose' | 'connecting' | 'failed'

interface Props {
  label: string
  os?: string
  /** the small line under the name: "SSH 10.0.0.1:22" */
  subtitle: string
  step: ConnectStep
  /** the line moves smoothly toward this point (0..1) at `rate` (about 1 / seconds it takes to cover most of the way); it never jumps */
  target?: number
  rate?: number
  /** the line reached its end */
  onFull?(): void
  /** a button at the right of the header, e.g. Show logs */
  headerAction?: ReactNode
  children?: ReactNode
  footer?: ReactNode
}

/**
 * The screen of a tab that is not connected yet, like Termius: who we are connecting to, a line from "plug"
 * to "terminal" that shows how far it got, and room below for the protocol choice, the message or the buttons.
 */
export function ConnectScreen({label, os, subtitle, step, target, rate = 0.5, onFull, headerAction, children, footer}: Props) {
  // The line is drawn by us, frame by frame: it eases toward its target, so a new target changes its speed and
  // never makes it jump. When the connection fails it stays where it was.
  const [value, setValue] = useState(0)
  const at = useRef(0)
  const full = useRef(onFull)
  full.current = onFull
  const prev = useRef(step)
  useEffect(() => {
    if (prev.current === 'failed' && step === 'connecting') { at.current = 0; setValue(0) } // a new try starts from the plug again
    prev.current = step
  }, [step])
  useEffect(() => {
    if (step !== 'connecting' || target === undefined) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const next = at.current + (target - at.current) * (1 - Math.exp(-rate * dt))
      at.current = target - next < 0.002 ? target : next
      setValue(at.current)
      if (at.current >= 1) { full.current?.(); return }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [step, target, rate])
  return (
    <div className="connect-screen" data-step={step}>
      <div className="connect-card">
        <div className="connect-head">
          {os ? <OsIcon os={os} size={26} /> : <span className="connect-os"><IconServer size={22} /></span>}
          <div className="connect-name"><b>{label}</b><small>{subtitle}</small></div>
          {headerAction}
        </div>
        <div className={'connect-track ' + step} aria-hidden="true">
          <span className="node start">{step === 'connecting' && <i className="ring" />}<IconPlug size={14} /></span>
          <span className="line">{target !== undefined && <i style={{width: (value * 100).toFixed(2) + '%'}} data-progress={value.toFixed(3)} data-target={target} />}</span>
          <span className="node end"><IconTerminal size={13} /></span>
        </div>
        {children}
        {footer && <div className="connect-foot">{footer}</div>}
      </div>
    </div>
  )
}
