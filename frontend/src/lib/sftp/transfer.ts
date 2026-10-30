import {useEffect, useRef, useState} from 'react'
import type {Backend} from '../backend'
import {useBackend} from '../backend'
import {formatBytes} from './format'
import type {QueueDirection, QueueJob, TransferResult} from '../types'

/** "Uploaded 12 files and 3 folders (1.2 MB), 2 left as they were" */
export function summarize(verb: string, r: Pick<TransferResult, 'files' | 'dirs' | 'bytes' | 'skipped' | 'ignored'>): string {
  const parts = [
    r.files ? `${r.files} ${r.files === 1 ? 'file' : 'files'}` : '',
    r.dirs ? `${r.dirs} ${r.dirs === 1 ? 'folder' : 'folders'}` : '',
  ].filter(Boolean)
  let text = parts.length ? `${verb} ${parts.join(' and ')} (${formatBytes(r.bytes)})` : 'Nothing to transfer'
  if (r.skipped.length) text += `, ${r.skipped.length} left as they were`
  if (r.ignored.length) text += `, ${r.ignored.length} ${r.ignored.length === 1 ? 'link' : 'links'} ignored`
  return text
}

/** The one question asked when files already exist where they are going. */
export function replaceQuestion(r: {skipped: string[]}, where: string): string {
  if (r.skipped.length === 1) return `${r.skipped[0]} already exists in ${where}. Replace it?`
  const first = r.skipped.slice(0, 3).join(', ') + (r.skipped.length > 3 ? ', …' : '')
  return `${r.skipped.length} files already exist in ${where} (${first}). Replace them?`
}

/** The word a finished job's summary starts with. */
export const verbOf = (d: QueueDirection) => (d === 'upload' ? 'Uploaded' : d === 'download' ? 'Saved' : 'Synced')

type Ask = (message: string, options?: {confirmLabel?: string; danger?: boolean}) => Promise<boolean>

/**
 * Queues an upload or a download. Names that already exist at the destination are asked about once for the
 * whole batch: Replace sends everything over, anything else leaves those files as they are.
 */
export async function queueTransfer(be: Backend, ask: Ask, sid: string, direction: 'upload' | 'download', sources: string[], destDir: string): Promise<string> {
  const clash = await be.sftp.conflicts(sid, direction, sources, destDir)
  const overwrite = clash.length > 0 && (await ask(replaceQuestion({skipped: clash}, destDir), {confirmLabel: 'Replace', danger: true}))
  return be.sftp.enqueue(sid, {direction, sources, destDir, overwrite})
}

export const isFinished = (j: QueueJob) => j.state === 'done' || j.state === 'failed' || j.state === 'canceled'
export const isActive = (j: QueueJob) => !isFinished(j)

/** how many percent of a job is done */
export function percent(j: QueueJob): number {
  if (j.state === 'done') return 100
  return j.total > 0 ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0
}

/**
 * The transfer queues of some SFTP sessions: loaded once, then replaced by every `sftp:queue:<sid>` snapshot.
 * `onFinished` is called once per job that reaches done, failed or canceled while this is mounted.
 */
export function useQueues(sids: string[], onFinished?: (sid: string, job: QueueJob) => void): Record<string, QueueJob[]> {
  const be = useBackend()
  const [jobs, setJobs] = useState<Record<string, QueueJob[]>>({})
  const seen = useRef(new Set<string>())
  const finished = useRef(onFinished)
  finished.current = onFinished
  const key = sids.filter(Boolean).join('|')
  useEffect(() => {
    const list = key ? key.split('|') : []
    let alive = true
    const apply = (sid: string, next: QueueJob[], announce: boolean) => {
      if (!alive) return
      setJobs(m => ({...m, [sid]: next}))
      for (const j of next) {
        const k = sid + '/' + j.id
        if (!isFinished(j)) { seen.current.delete(k); continue } // retried: it will finish (and be announced) again
        if (seen.current.has(k)) continue
        seen.current.add(k)
        if (announce) finished.current?.(sid, j)
      }
    }
    const offs = list.map(sid => {
      void be.sftp.queue(sid).then(q => apply(sid, q ?? [], false)).catch(() => {})
      return be.on(`sftp:queue:${sid}`, (q: QueueJob[]) => apply(sid, q ?? [], true))
    })
    return () => { alive = false; offs.forEach(o => o()) }
  }, [be, key])
  return jobs
}
