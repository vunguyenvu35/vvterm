/**
 * Registry of live terminal panes. Anything that needs to type into a terminal (snippets)
 * asks the registry instead of reaching into the pane component. A writer returns false when
 * the pane cannot take input yet (still connecting, or disconnected).
 */
type Writer = (text: string) => boolean

const panes = new Map<string, Writer>()

export function registerPane(id: string, w: Writer): () => void {
  panes.set(id, w)
  return () => { if (panes.get(id) === w) panes.delete(id) }
}

export function writeToPane(id: string, text: string): boolean {
  return panes.get(id)?.(text) ?? false
}

/**
 * Terminals expect carriage returns. Multi-line scripts are typed line by line; with `run` the
 * last line is executed too, otherwise it is left on the prompt for review.
 */
export function toTerminalInput(script: string, run: boolean): string {
  const body = script.replace(/\r\n|\n/g, '\r').replace(/\r+$/, '')
  return run ? body + '\r' : body
}
