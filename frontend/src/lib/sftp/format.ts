export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'}) + ' ' + d.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})
}

/** "/a/b/c" -> [{name:'/', path:'/'}, {name:'a', path:'/a'}, ...] */
export function breadcrumbs(path: string): {name: string; path: string}[] {
  const out = [{name: '/', path: '/'}]
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) {
    acc += '/' + part
    out.push({name: part, path: acc})
  }
  return out
}

export function parentOf(path: string): string {
  const i = path.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function joinPath(dir: string, name: string): string {
  return (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + name
}

/** A file or folder name must be one path segment. */
export function validName(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Enter a name'
  if (n === '.' || n === '..') return 'Choose a different name'
  if (/[/\0]/.test(n)) return 'A name cannot contain "/"'
  return null
}

/** The "Kind" column: folder, or the upper-cased extension, or plain "file". */
export function kindOf(e: {name: string; is_dir: boolean}): string {
  if (e.is_dir) return 'folder'
  const i = e.name.lastIndexOf('.')
  return i > 0 && i < e.name.length - 1 ? e.name.slice(i + 1).toUpperCase() : 'file'
}
