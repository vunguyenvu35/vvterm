import type {Env} from './types'

/** Decode a base64 payload (term:data events) into raw bytes for xterm. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Wails rejects with a string or an Error; normalise to a message. */
export function errMsg(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

export function parseTags(s: string): string[] {
  return Array.from(new Set(s.split(',').map(t => t.trim()).filter(Boolean)))
}

export const ENV_COLORS: Record<string, string> = {
  prod: 'var(--env-prod)',
  staging: 'var(--env-staging)',
  dev: 'var(--env-dev)',
  '': 'var(--env-none)',
}

export function envColor(env?: Env): string {
  return ENV_COLORS[env ?? ''] ?? ENV_COLORS['']
}

export function formatAddr(h: {hostname: string; port: number; username?: string}): string {
  const base = h.port === 22 ? h.hostname : `${h.hostname}:${h.port}`
  return h.username ? `${h.username}@${base}` : base
}
