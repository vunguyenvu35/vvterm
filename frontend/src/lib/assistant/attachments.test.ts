import {formatSize, imageMime, readAttachment, toAttachment, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, MAX_TEXT_FILES, MAX_IMAGES, type Attach} from './attachments'

const file = (content: BlobPart, name: string, type = '') => new File([content], name, {type})
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('readAttachment', () => {
  it('reads a text file as text', async () => {
    const r = await readAttachment(file('line 1\nline 2', 'deploy.log', 'text/plain'), [], true)
    expect(r.ok && r.attach).toMatchObject({kind: 'text', name: 'deploy.log', text: 'line 1\nline 2'})
    expect(toAttachment((r as {attach: Attach}).attach)).toEqual({name: 'deploy.log', mime: 'text/plain', text: 'line 1\nline 2'})
  })

  it('reads a file with an unknown extension as text when it is text', async () => {
    const r = await readAttachment(file('[Unit]\nDescription=x', 'my.service'), [], true)
    expect(r.ok).toBe(true)
  })

  it('reads a picture as base64 and keeps a preview', async () => {
    const r = await readAttachment(file(png(), 'shot.png', 'image/png'), [], true)
    expect(r.ok && r.attach).toMatchObject({kind: 'image', mime: 'image/png', name: 'shot.png'})
    const a = (r as {attach: Attach}).attach
    expect(a.data).toBe(btoa(String.fromCharCode(...png())))
    expect(a.url).toMatch(/^data:image\/png;base64,/)
    expect(toAttachment(a)).toEqual({name: 'shot.png', mime: 'image/png', data: a.data})
  })

  it('takes the type of a picture from its name when the browser does not say', () => {
    expect(imageMime({name: 'a.JPG', type: ''})).toBe('image/jpeg')
    expect(imageMime({name: 'a.svg', type: 'image/svg+xml'})).toBe('') // a picture that can carry scripts is not sent
    expect(imageMime({name: 'a.txt', type: 'text/plain'})).toBe('')
  })

  it('refuses a picture when the provider cannot take pictures, and says what to do', async () => {
    const r = await readAttachment(file(png(), 'shot.png', 'image/png'), [], false)
    expect(r).toMatchObject({ok: false, error: expect.stringContaining('cannot take pictures')})
  })

  it('refuses what is neither text nor a picture, with the reason', async () => {
    for (const [name, type] of [['report.pdf', 'application/pdf'], ['a.zip', ''], ['clip.mp4', 'video/mp4'], ['id.p12', '']] as const) {
      const r = await readAttachment(file('x', name, type), [], true)
      expect(r, name).toMatchObject({ok: false, error: expect.stringContaining('not a text file or a picture')})
    }
    const bin = await readAttachment(file(new Uint8Array([0, 1, 2, 0, 255]), 'data.dat'), [], true)
    expect(bin.ok).toBe(false)
  })

  it('refuses empty and oversized files and too many of them', async () => {
    expect(await readAttachment(file('  \n', 'e.txt'), [], true)).toMatchObject({ok: false})
    expect(await readAttachment(file('a'.repeat(MAX_TEXT_BYTES + 1), 'big.log'), [], true)).toMatchObject({ok: false, error: expect.stringContaining('larger than 100 KB')})
    expect(await readAttachment(file(new Uint8Array(MAX_IMAGE_BYTES + 1), 'big.png', 'image/png'), [], true)).toMatchObject({ok: false, error: expect.stringContaining('larger than 5 MB')})
    const texts = Array.from({length: MAX_TEXT_FILES}, (_, i) => ({id: 't' + i, name: 'f', kind: 'text', mime: '', size: 1} as Attach))
    expect(await readAttachment(file('x', 'more.txt'), texts, true)).toMatchObject({ok: false, error: expect.stringContaining(`At most ${MAX_TEXT_FILES}`)})
    const imgs = Array.from({length: MAX_IMAGES}, (_, i) => ({id: 'i' + i, name: 'f', kind: 'image', mime: 'image/png', size: 1} as Attach))
    expect(await readAttachment(file(png(), 'more.png', 'image/png'), imgs, true)).toMatchObject({ok: false, error: expect.stringContaining(`At most ${MAX_IMAGES}`)})
  })

  it('formats sizes', () => {
    expect([formatSize(12), formatSize(2048), formatSize(3 * 1024 * 1024)]).toEqual(['12 B', '2 KB', '3.0 MB'])
  })
})
