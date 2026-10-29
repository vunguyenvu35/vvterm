import {ClipboardEvent, KeyboardEvent, ReactNode, useEffect, useRef} from 'react'
import {IconClose, IconFile, IconPaperclip, IconSend} from '../ui/Icons'
import {formatSize, type Attach} from './attachments'

interface Props {
  value: string
  onChange(v: string): void
  files: Attach[]
  onRemoveFile(id: string): void
  /** files chosen with the paperclip or pasted */
  onAddFiles(files: File[]): void
  onSend(): void
  onUseSelection(): void
  onStop(): void
  busy: boolean
  ready: boolean
  /** the provider can take pictures */
  images: boolean
  /** what goes in the bar under the box before the buttons (the provider and model chip) */
  leading?: ReactNode
}

/** What a file waiting to go with the question looks like: a thumbnail for a picture, an icon for a text file. */
export function FileChip({file, onRemove}: {file: Attach; onRemove?(): void}) {
  return (
    <span className="ai-chip" title={`${file.name} · ${formatSize(file.size)}`} data-testid="ai-chip">
      {file.kind === 'image' && file.url ? <img src={file.url} alt="" /> : <IconFile size={16} />}
      <span className="ai-chip-name">{file.name}</span>
      <span className="ai-chip-size">{formatSize(file.size)}</span>
      {onRemove && <button aria-label={'Remove ' + file.name} onClick={onRemove}><IconClose size={12} /></button>}
    </span>
  )
}

/**
 * The box a question is typed in. It grows with the text, takes files by drag and drop (handled by the panel), by the
 * paperclip and by paste, and sends with Enter (Shift+Enter makes a new line).
 */
export function Composer(p: Props) {
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  // grow with the text, up to about six lines
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 150) + 'px'
  }, [p.value])

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) p.onSend() }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length > 0) { e.preventDefault(); p.onAddFiles(files) }
  }
  const canSend = p.ready && !p.busy && (p.value.trim() !== '' || p.files.length > 0)

  return (
    <div className="ai-composer" data-testid="ai-composer">
      {p.files.length > 0 && <div className="ai-chips" aria-label="Attached files">{p.files.map(f => <FileChip key={f.id} file={f} onRemove={() => p.onRemoveFile(f.id)} />)}</div>}
      <textarea ref={area} aria-label="Ask the assistant" rows={1} value={p.value} disabled={!p.ready} onChange={e => p.onChange(e.target.value)} onKeyDown={onKey} onPaste={onPaste}
        placeholder={p.ready ? 'Ask about this terminal, or drop a file or screenshot here…' : 'Waiting for the terminal…'} />
      <div className="ai-composer-bar">
        <input ref={picker} type="file" multiple hidden aria-label="Choose files" accept={p.images ? undefined : 'text/*,.log,.conf,.cfg,.ini,.json,.yaml,.yml,.toml,.sh,.py,.js,.ts,.go,.md,.txt,.csv,.xml'}
          onChange={e => { p.onAddFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
        <button className="ai-tool" onClick={() => picker.current?.click()} disabled={!p.ready || p.busy} title={p.images ? 'Add a file or a screenshot' : 'Add a text file'} aria-label="Attach a file"><IconPaperclip size={17} /></button>
        {p.leading}
        <button className="ai-tool text" onClick={p.onUseSelection} disabled={!p.ready || p.busy} title="Send only the text selected in the terminal">Selection</button>
        <span className="spacer" />
        {p.busy ? <button onClick={p.onStop}>Stop</button>
          : <button className="primary ai-send" onClick={p.onSend} disabled={!canSend} aria-label="Send" title="Send (Enter)"><IconSend size={16} /> Send</button>}
      </div>
    </div>
  )
}
