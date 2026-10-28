import {ReactNode, useEffect, useState} from 'react'
import {OsIcon} from '../ui/OsIcon'
import {IconPlug, IconServer, IconTerminal} from '../ui/Icons'

export type ConnectStep = 'choose' | 'connecting' | 'failed'

interface Props {
  label: string
  os?: string
  /** the small line under the name: "SSH 10.0.0.1:22" */
  subtitle: string
  step: ConnectStep
  /** how far along the line the connection is (0..1); it fills the line from the plug to the terminal */
  progress?: number
  /** how long the line takes to get there (ms): slow while waiting, quick when something happened */
  duration?: number
  /** a button at the right of the header, e.g. Show logs */
  headerAction?: ReactNode
  children?: ReactNode
  footer?: ReactNode
}

/**
 * The screen of a tab that is not connected yet, like Termius: who we are connecting to, a line from "plug"
 * to "terminal" that shows how far it got, and room below for the protocol choice, the message or the buttons.
 */
export function ConnectScreen({label, os, subtitle, step, progress, duration, headerAction, children, footer}: Props) {
  // the line starts empty and then moves to where it should be, so that the move is seen
  const [shown, setShown] = useState(0)
  useEffect(() => {
    const t = window.setTimeout(() => setShown(progress ?? 0), 30)
    return () => window.clearTimeout(t)
  }, [progress])
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
          <span className={'line' + (progress !== undefined && progress >= 1 ? ' full' : '')}>{progress !== undefined && <i style={{width: (shown * 100).toFixed(1) + '%', transitionDuration: duration !== undefined ? duration + 'ms' : undefined}} data-progress={progress} />}</span>
          <span className="node end"><IconTerminal size={13} /></span>
        </div>
        {children}
        {footer && <div className="connect-foot">{footer}</div>}
      </div>
    </div>
  )
}
