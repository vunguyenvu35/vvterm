import {useState} from 'react'
import {IconCopy} from '../ui/Icons'

/** Splits an answer into plain paragraphs and fenced code blocks, so a command or a log excerpt reads as code. */
export function splitBlocks(text: string): Array<{code: boolean; text: string; lang?: string}> {
  const out: Array<{code: boolean; text: string; lang?: string}> = []
  const re = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)(```|$)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({code: false, text: text.slice(last, m.index)})
    out.push({code: true, lang: m[1] || undefined, text: m[2].replace(/\n$/, '')})
    last = m.index + m[0].length
    if (m[3] === '') break
  }
  if (last < text.length) out.push({code: false, text: text.slice(last)})
  return out.filter(b => b.text.trim() !== '')
}

/** `inline code` inside a paragraph. Everything is rendered as text: an answer can never inject markup. */
function Inline({text}: {text: string}) {
  return <>{text.split(/(`[^`\n]+`)/g).map((p, i) => (p.length > 2 && p.startsWith('`') && p.endsWith('`') ? <code key={i} className="ai-inline">{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))}</>
}

export function CodeBlock({text, lang}: {text: string; lang?: string}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  return (
    <div className="ai-code">
      <div className="ai-code-head"><span>{lang || 'text'}</span><button className="link" onClick={copy} aria-label="Copy code"><IconCopy size={13} /> {copied ? 'Copied' : 'Copy'}</button></div>
      <pre><code>{text}</code></pre>
    </div>
  )
}

export function MessageText({text}: {text: string}) {
  return (
    <div className="ai-text">
      {splitBlocks(text).map((b, i) => (b.code ? <CodeBlock key={i} text={b.text} lang={b.lang} /> : <p key={i}><Inline text={b.text.trim()} /></p>))}
    </div>
  )
}
