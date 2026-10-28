/**
 * This is an app, not a web page: the browser's right-click menu (Look Up, Translate, Search with Google,
 * Inspect Element…) is turned off everywhere. Text fields keep it, because it holds Cut / Copy / Paste there.
 * The app's own menus (terminal, tabs, files) open as before: they handle the event themselves.
 */
export function installNoNativeMenu(target: Window = window): () => void {
  const onMenu = (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target : null
    if (el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return
    e.preventDefault()
  }
  target.addEventListener('contextmenu', onMenu)
  return () => target.removeEventListener('contextmenu', onMenu)
}
