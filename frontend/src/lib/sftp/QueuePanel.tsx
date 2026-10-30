import {IconChevron, IconChevronDown} from '../ui/Icons'
import {formatBytes} from './format'
import {isActive, isFinished, percent} from './transfer'
import type {QueueJob, QueueState} from '../types'

export interface QueueActions {
  pause(id: string): void
  resume(id: string): void
  cancel(id: string): void
  retry(id: string): void
  clearFinished(): void
}

const WORD: Record<QueueState, string> = {queued: 'Waiting', preparing: 'Preparing…', running: '', paused: 'Paused', done: 'Done', failed: 'Failed', canceled: 'Canceled'}
const ING = {upload: 'Uploading', download: 'Downloading', 'sync-up': 'Syncing', 'sync-down': 'Syncing'}

function stateText(j: QueueJob): string {
  if (j.state !== 'running') return WORD[j.state]
  return `${percent(j) >= 100 ? 'Finishing' : ING[j.direction]} · ${percent(j)}%`
}

/**
 * The transfer queue: one row per transfer with its progress, and what can be done with it in its state
 * (pause, resume, cancel, retry). Collapsed it shows a count and one bar for everything still running.
 */
export function QueuePanel({jobs, actions, open, onToggle, compact}: {jobs: QueueJob[]; actions: QueueActions; open: boolean; onToggle?(): void; compact?: boolean}) {
  if (jobs.length === 0) return null
  const live = jobs.filter(isActive)
  const total = live.reduce((n, j) => n + j.total, 0)
  const done = live.reduce((n, j) => n + Math.min(j.done, j.total), 0)
  const overall = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const failed = jobs.filter(j => j.state === 'failed').length
  return (
    <section className={'queue' + (compact ? ' compact' : '')} aria-label="Transfers">
      <div className="queue-head">
        {onToggle
          ? <button className="queue-toggle" aria-expanded={open} onClick={onToggle}>{open ? <IconChevronDown size={14} /> : <IconChevron size={14} />} Transfers</button>
          : <b>Transfers</b>}
        <span className={'queue-badge' + (failed ? ' bad' : '')} aria-label={`${live.length} active of ${jobs.length}`}>{live.length}/{jobs.length}</span>
        {!open && live.length > 0 && <div className="bar queue-overall" role="progressbar" aria-label="Overall progress" aria-valuenow={overall} aria-valuemin={0} aria-valuemax={100}><i style={{width: overall + '%'}} /></div>}
        <span className="spacer" />
        {open && <button className="link" disabled={!jobs.some(isFinished)} onClick={actions.clearFinished}>Clear finished</button>}
      </div>
      {open && (
        <ul className="queue-list">
          {jobs.map(j => (
            <li key={j.id} className={'queue-row ' + j.state} aria-label={j.name}>
              <div className="queue-main">
                <b className="queue-name" title={j.name}>{j.name}</b>
                <span className="muted queue-state">{stateText(j)}</span>
              </div>
              {j.state !== 'done' && j.state !== 'canceled' && (
                <div className="queue-sub muted">
                  {j.error ? <span className="error" role="alert">{j.error}</span> : <span title={j.current}>{j.current || (j.state === 'queued' ? 'Waiting for its turn' : '')}</span>}
                </div>
              )}
              {(j.state === 'running' || j.state === 'paused' || j.state === 'queued') && (
                <div className="queue-prog">
                  <div className="bar" role="progressbar" aria-label={`${j.name} progress`} aria-valuenow={percent(j)} aria-valuemin={0} aria-valuemax={100}><i style={{width: percent(j) + '%'}} /></div>
                  <span className="muted">{j.total > 0 ? `${formatBytes(j.done)} of ${formatBytes(j.total)}` : ''}</span>
                </div>
              )}
              <div className="queue-btns">
                {j.state === 'running' && <button aria-label={`Pause ${j.name}`} onClick={() => actions.pause(j.id)}>Pause</button>}
                {j.state === 'paused' && <button aria-label={`Resume ${j.name}`} onClick={() => actions.resume(j.id)}>Resume</button>}
                {(j.state === 'failed' || j.state === 'canceled') && <button aria-label={`Retry ${j.name}`} onClick={() => actions.retry(j.id)}>Retry</button>}
                {isActive(j) && <button aria-label={`Cancel ${j.name}`} onClick={() => actions.cancel(j.id)}>Cancel</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
