import {stepKeys, stepsOf} from './shortcuts'

/** A shortcut drawn as key caps: ⇧ ⌘ T. A two-step shortcut shows its steps with "then" between them. */
export function KeyCombo({combo}: {combo: string}) {
  return (
    <span className="keycombo" aria-hidden="true">
      {stepsOf(combo).map((step, i) => (
        <span key={i} className="keystep">
          {i > 0 && <small className="keythen">then</small>}
          {stepKeys(step).map((k, j) => <kbd key={j} className="keycap">{k}</kbd>)}
        </span>
      ))}
    </span>
  )
}
