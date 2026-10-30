/**
 * macOS turns on "secure event input" for the whole session while a password field has the keyboard, so that no
 * other program can read the keys. Input tools such as OpenKey and GoTiengViet stop working in every app while it is
 * on. WebKit turns it off again when the field is removed or another text field is focused, but NOT when the field
 * only loses its focus to nothing: a click on an empty part of the page (the unlock card, a panel) leaves it on, and
 * it stays on after unlocking until some text field happens to be focused. This puts the focus on a hidden read-only
 * text field in that case, which makes WebKit release it. Measured with a WKWebView: blur() and a click on the
 * background keep it on; focusing a read-only text field turns it off, a focused <div tabindex=-1> does not.
 *
 * Nothing else changes: with the focus on nothing, a key does nothing; with it on the hidden field it does nothing
 * either (the field is read-only), and the app's shortcuts see the same events.
 */
export function installSecureInputGuard(doc: Document = document, hasFocus: () => boolean = () => doc.hasFocus()): () => void {
  const sink = doc.createElement('input')
  sink.type = 'text'
  sink.readOnly = true
  sink.tabIndex = -1
  sink.autocomplete = 'off'
  sink.setAttribute('aria-hidden', 'true')
  sink.setAttribute('data-secure-input-sink', '')
  sink.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  doc.body.appendChild(sink)

  let timer = 0
  const onFocusOut = (e: FocusEvent) => {
    const t = e.target
    if (!(t instanceof HTMLInputElement) || t.type !== 'password' || e.relatedTarget) return // the focus goes to another element: nothing to do
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      // only when the window is still the active one (switching to another app also blurs the field, and the field
      // gets its focus back with the window) and the focus really is on nothing
      const a = doc.activeElement
      if (hasFocus() && (!a || a === doc.body)) sink.focus({preventScroll: true})
    }, 0)
  }
  doc.addEventListener('focusout', onFocusOut, true)
  return () => {
    window.clearTimeout(timer)
    doc.removeEventListener('focusout', onFocusOut, true)
    sink.remove()
  }
}
