import {installNoNativeMenu} from './noNativeMenu'

describe('installNoNativeMenu', () => {
  let off: () => void
  beforeEach(() => { document.body.innerHTML = '<p id="text">Docker</p><input id="field" /><textarea id="area"></textarea><div id="edit" contenteditable="true"><b id="inner">x</b></div>'; off = installNoNativeMenu() })
  afterEach(() => off())
  const menu = (id: string) => {
    const e = new MouseEvent('contextmenu', {bubbles: true, cancelable: true})
    document.getElementById(id)!.dispatchEvent(e)
    return e.defaultPrevented
  }

  it('blocks the browser menu on text and anywhere else in the page', () => {
    expect(menu('text')).toBe(true)
    expect(menu('text')).toBe(true) // also the second time
  })
  it('leaves it to text fields, where it holds Cut, Copy and Paste', () => {
    expect(menu('field')).toBe(false)
    expect(menu('area')).toBe(false)
    expect(menu('edit')).toBe(false)
    expect(menu('inner')).toBe(false)
  })
  it('stops when removed', () => {
    off()
    expect(menu('text')).toBe(false)
    off = installNoNativeMenu()
  })
})
