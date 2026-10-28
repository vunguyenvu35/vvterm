import {useBackend} from '../backend'

/**
 * A strip along the top of a screen that has no title bar of its own (unlocking, creating the vault): the
 * window can be dragged by it, and a double click zooms the window like on any Mac app. It sits clear of
 * the macOS window buttons because those are drawn by the system on top of it.
 */
export function DragBar() {
  const be = useBackend()
  return <div className="drag-bar" data-testid="drag-bar" onDoubleClick={() => void be.system.toggleMaximise()} />
}
