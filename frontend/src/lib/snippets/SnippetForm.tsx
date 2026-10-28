import {useState} from 'react'
import {SidePanel, Section} from '../ui/Modal'
import {useBackend} from '../backend'
import {errMsg} from '../util'
import type {Snippet} from '../types'

export function SnippetForm({snippet, onClose, onSaved}: {snippet?: Snippet; onClose(): void; onSaved(s: Snippet): void}) {
  const be = useBackend()
  const [label, setLabel] = useState(snippet?.label ?? '')
  const [description, setDescription] = useState(snippet?.description ?? '')
  const [script, setScript] = useState(snippet?.script ?? '')
  const [err, setErr] = useState('')

  const save = async () => {
    setErr('')
    if (!label.trim()) return setErr('Label is required')
    if (!script.trim()) return setErr('Script is required')
    try {
      onSaved(await be.snippets.save({...(snippet ?? {}), label: label.trim(), description: description.trim(), script}))
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  return (
    <SidePanel title={snippet ? 'Edit snippet' : 'New snippet'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></>}>
      <Section title="General">
        <input aria-label="Snippet label" value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (for example: Docker full clean)" autoFocus />
        <input aria-label="Snippet description" value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)" />
      </Section>
      <Section title="Script">
        <textarea aria-label="Script" className="script-area" rows={10} spellCheck={false} value={script}
          onChange={e => setScript(e.target.value)} placeholder={'docker stop $(docker ps -aq) 2>/dev/null\ndocker system prune -af'} />
        <div className="muted">Each line is typed into the terminal. Run presses Enter after the last line; Paste leaves it on the prompt.</div>
      </Section>
      {err && <div className="error" role="alert">{err}</div>}
    </SidePanel>
  )
}
