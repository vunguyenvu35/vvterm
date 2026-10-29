import {Modal} from '../ui/Modal'
import type {AiPreview} from '../types'

interface Props {
  preview: AiPreview
  provider: string
  onClose(): void
  /** when set, the dialog asks the user to agree before the first question of this terminal */
  onConfirm?(): void
}

/** Exactly what the assistant would receive, after redaction. Secrets show as *******. */
export function PreviewDialog({preview: p, provider, onClose, onConfirm}: Props) {
  return (
    <Modal title="What will be sent" onClose={onClose} wide
      footer={onConfirm ? (
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={onConfirm}>Share and ask</button>
        </>
      ) : <button onClick={onClose}>Close</button>}>
      <p className="muted ai-preview-note">
        This text is sent to <b>{provider || 'the AI provider'}</b> with your question. Secrets are replaced by <code>*******</code> before it leaves VVTerm.
        Redaction is best-effort: read it before you share.
      </p>
      <div className="ai-findings" aria-label="Redaction summary">
        {p.redacted === 0 ? <span className="badge">Nothing redacted</span> : (
          <>
            <span className="badge ai-badge-warn">{p.redacted} {p.redacted === 1 ? 'item' : 'items'} redacted</span>
            {p.findings.map(f => <span key={f.kind} className="badge">{f.kind} × {f.count}</span>)}
          </>
        )}
      </div>
      {p.vault_locked && <div className="ai-warn" role="status">The vault is locked, so your saved passwords cannot be matched exactly. Only patterns are used.</div>}
      {p.alt_screen && <div className="ai-warn" role="status">A full-screen program (vim, htop…) is open: its screen is not a readable log.</div>}
      {p.empty ? <div className="muted">The terminal has no output yet.</div>
        : <pre className="ai-preview" aria-label="Text that will be sent" tabIndex={0}>{p.text}</pre>}
    </Modal>
  )
}
