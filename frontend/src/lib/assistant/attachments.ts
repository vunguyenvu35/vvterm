import type {AiAttachment} from '../types'

/** The limits of the Go side (internal/domain/assistant/attachment.go): a file over one is refused here, with a reason. */
export const MAX_TEXT_FILES = 5
export const MAX_TEXT_BYTES = 100 * 1024
export const MAX_IMAGES = 3
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES_TOTAL = 10 * 1024 * 1024

/** A file waiting to be sent with the next question. */
export interface Attach {
  id: string
  name: string
  kind: 'text' | 'image'
  mime: string
  size: number
  text?: string
  /** base64 */
  data?: string
  /** a data URL to show the picture */
  url?: string
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const IMAGE_EXT: Record<string, string> = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp'}
/** what is clearly not text and not a picture: said plainly instead of read as garbage */
const OTHER_BINARY = /\.(pdf|zip|gz|tgz|tar|7z|rar|dmg|exe|bin|so|dylib|o|class|jar|mp3|mp4|mov|avi|mkv|wav|doc|docx|xls|xlsx|ppt|pptx|sqlite|db|key|p12|pfx)$/i

const ext = (n: string) => (n.includes('.') ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : '')
export const imageMime = (f: {name: string; type: string}) => (IMAGE_TYPES.includes(f.type) ? f.type : IMAGE_EXT[ext(f.name)] ?? '')

export function formatSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function readAs<T extends string | ArrayBuffer>(f: Blob, how: 'text' | 'dataurl'): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as T)
    r.onerror = () => reject(r.error ?? new Error('could not read the file'))
    if (how === 'text') r.readAsText(f)
    else r.readAsDataURL(f)
  })
}

let n = 0

/**
 * Reads a dropped, pasted or chosen file. Pictures are kept as base64; anything else must be text (a log, a config, a
 * script…): a file that is not text is refused with the reason instead of being sent as noise.
 */
export async function readAttachment(file: File, taken: Attach[], supportsImages: boolean): Promise<{ok: true; attach: Attach} | {ok: false; error: string}> {
  const name = file.name || 'pasted file'
  const img = imageMime(file)
  if (img) {
    if (!supportsImages) return {ok: false, error: `${name}: this provider cannot take pictures. Select the text in the terminal instead.`}
    if (taken.filter(a => a.kind === 'image').length >= MAX_IMAGES) return {ok: false, error: `At most ${MAX_IMAGES} pictures can be added.`}
    if (file.size > MAX_IMAGE_BYTES) return {ok: false, error: `${name} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`}
    if (taken.filter(a => a.kind === 'image').reduce((s, a) => s + a.size, 0) + file.size > MAX_IMAGES_TOTAL) return {ok: false, error: 'The pictures are too large together.'}
    const url = await readAs<string>(file, 'dataurl')
    return {ok: true, attach: {id: 'a' + ++n, name, kind: 'image', mime: img, size: file.size, data: url.slice(url.indexOf(',') + 1), url}}
  }
  if (OTHER_BINARY.test(name) || file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type === 'application/pdf') {
    return {ok: false, error: `${name} is not a text file or a picture. Text files (logs, configs, scripts) and PNG, JPEG, GIF or WebP pictures can be added.`}
  }
  if (taken.filter(a => a.kind === 'text').length >= MAX_TEXT_FILES) return {ok: false, error: `At most ${MAX_TEXT_FILES} text files can be added.`}
  if (file.size > MAX_TEXT_BYTES) return {ok: false, error: `${name} is larger than ${MAX_TEXT_BYTES / 1024} KB: add the part you need.`}
  const text = await readAs<string>(file, 'text')
  if (!text.trim()) return {ok: false, error: `${name} is empty.`}
  if (text.includes('\u0000') || text.includes('�')) return {ok: false, error: `${name} is not a text file.`}
  return {ok: true, attach: {id: 'a' + ++n, name, kind: 'text', mime: file.type || 'text/plain', size: file.size, text}}
}

export const toAttachment = (a: Attach): AiAttachment => (a.kind === 'image' ? {name: a.name, mime: a.mime, data: a.data} : {name: a.name, mime: a.mime, text: a.text})
