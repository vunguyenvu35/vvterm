import {Snippet} from '../types'
import {IconBraces, IconCopy, IconEdit, IconPlay, IconPlus, IconTrash} from '../ui/Icons'

interface Props {
  snippets: Snippet[]
  /** a terminal tab is open, so Run/Paste have somewhere to go */
  canRun: boolean
  onNew(): void
  onRun(s: Snippet, execute: boolean): void
  onEdit(s: Snippet): void
  onDelete(s: Snippet): void
}

const firstLine = (s: string) => s.split(/\r?\n/).find(l => l.trim()) ?? ''

/** Reusable scripts. Run types the script into the focused terminal pane and presses Enter. */
export function SnippetsPage(p: Props) {
  return (
    <div className="hosts-page">
      <div className="page-head">
        <h2>Snippets</h2>
        <button className="split-btn" aria-label="New snippet" onClick={p.onNew}><IconPlus size={14} /> New snippet</button>
      </div>
      {!p.canRun && p.snippets.length > 0 && (
        <div className="notice">Open a terminal to run a snippet: it is typed into the focused pane.</div>
      )}
      <div className="cards" role="list" aria-label="Snippets">
        {p.snippets.map(s => (
          <div key={s.id} className="card snippet" role="listitem" onDoubleClick={() => p.onEdit(s)}>
            <span className="tile"><IconBraces size={20} /></span>
            <div className="meta">
              <div className="label">{s.label}</div>
              <div className="addr mono">{s.description || firstLine(s.script)}</div>
            </div>
            <div className="actions always">
              <button className="icon ghost" aria-label={`Run ${s.label}`} title="Run in the focused terminal" onClick={() => p.onRun(s, true)}><IconPlay size={14} /></button>
              <button className="icon ghost" aria-label={`Paste ${s.label}`} title="Type without pressing Enter" onClick={() => p.onRun(s, false)}><IconCopy size={14} /></button>
              <button className="icon ghost" aria-label={`Edit ${s.label}`} onClick={() => p.onEdit(s)}><IconEdit size={14} /></button>
              <button className="icon ghost danger" aria-label={`Delete ${s.label}`} onClick={() => p.onDelete(s)}><IconTrash size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {p.snippets.length === 0 && (
        <div className="empty-hint">No snippets yet. Save commands you run often, then run them in any terminal with one click.</div>
      )}
    </div>
  )
}
