import {useEffect, useState} from 'react'
import {IconCapsLock} from './Icons'

interface Spot {top: number; right: number; height: number}

/**
 * "Caps Lock is on" for every password field of the app, drawn by us instead of the webview's own
 * indicator (hidden in styles.css), which sits half outside the field and clashes with the design. One
 * instance at the root is enough: it follows whichever password field has the focus.
 */
export function CapsLockWarning() {
  const [spot, setSpot] = useState<Spot | null>(null)

  useEffect(() => {
    let caps = false
    const place = () => {
      const el = document.activeElement
      if (caps && el instanceof HTMLInputElement && el.type === 'password') {
        const r = el.getBoundingClientRect()
        setSpot({top: r.top, right: window.innerWidth - r.right, height: r.height})
      } else {
        setSpot(null)
      }
    }
    const keys = (e: KeyboardEvent) => { caps = e.getModifierState?.('CapsLock') ?? false; place() }
    const leave = () => { setSpot(null) }
    window.addEventListener('keydown', keys, true)
    window.addEventListener('keyup', keys, true)
    window.addEventListener('focusin', place, true)
    window.addEventListener('focusout', leave, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('keydown', keys, true)
      window.removeEventListener('keyup', keys, true)
      window.removeEventListener('focusin', place, true)
      window.removeEventListener('focusout', leave, true)
      window.removeEventListener('resize', place)
    }
  }, [])

  if (!spot) return null
  return (
    <span className="caps-warning" role="status" style={{top: spot.top + (spot.height - 24) / 2, right: spot.right + 10}}>
      <IconCapsLock size={13} /> Caps Lock is on
    </span>
  )
}
