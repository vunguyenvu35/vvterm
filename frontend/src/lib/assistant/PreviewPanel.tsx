import type {ReactNode} from 'react'
import type {AiPreview} from '../types'

interface Props {
  preview: AiPreview
  provider: string
  /** buttons under the text (the confirmation in the chat), or a way to close it (the plain preview) */
  actions?: ReactNode
  title?: string
}

/** Exactly what the assistant would receive, after redaction, shown in the chat. Secrets show as *******. */
export function PreviewPanel({preview: p, provider, actions, title = 'What will be sent'}: Props) {
  return (
    <section className="ai-preview-panel" aria-label={title}>
      <b>{title}</b>
      <p className="muted ai-preview-note">
        This text goes to <b>{provider || 'the AI provider'}</b> with your question. Secrets are replaced by <code>*******</code> before it leaves VVTerm. Redaction is best-effort: read it first.
      </p>
      <div className="ai-findings" aria-label="Redaction summary">
        {p.redacted === 0 ? <span className="badge">Nothing redacted</span> : (
          <>
            <span className="badge ai-badge-warn">{p.redacted} {p.redacted === 1 ? 'item' : 'items'} redacted</span>
            {p.findings.map(f => <span key={f.kind} className="badge">{f.kind} × {f.count}</span>)}
          </>
        )}
        {p.images > 0 && <span className="badge ai-badge-warn">{p.images} {p.images === 1 ? 'picture' : 'pictures'} sent as {p.images === 1 ? 'it is' : 'they are'}</span>}
      </div>
      {p.vault_locked && <div className="ai-warn" role="status">The vault is locked, so your saved passwords cannot be matched exactly. Only patterns are used.</div>}
      {p.alt_screen && <div className="ai-warn" role="status">A full-screen program (vim, htop…) is open: its screen is not a readable log.</div>}
      {p.empty ? <div className="muted">The terminal has no output yet.</div>
        : <pre className="ai-preview" aria-label="Text that will be sent" tabIndex={0}>{p.text}</pre>}
      {actions && <div className="ai-cmd-actions">{actions}</div>}
    </section>
  )
}
