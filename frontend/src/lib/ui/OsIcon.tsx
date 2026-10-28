import type {ReactNode} from 'react'
import {IconServer} from './Icons'

/** What VVTerm can tell a server apart by (see domain.ParseOS): its name and the colour of its tile. */
export const OS_INFO: Record<string, {name: string; color: string}> = {
  ubuntu: {name: 'Ubuntu', color: '#e95420'},
  debian: {name: 'Debian', color: '#a80030'},
  raspbian: {name: 'Raspberry Pi OS', color: '#c51a4a'},
  kali: {name: 'Kali Linux', color: '#2f6fdd'},
  centos: {name: 'CentOS', color: '#932279'},
  rhel: {name: 'Red Hat Enterprise Linux', color: '#cc0000'},
  fedora: {name: 'Fedora', color: '#3c6eb4'},
  rocky: {name: 'Rocky Linux', color: '#10a37f'},
  almalinux: {name: 'AlmaLinux', color: '#0f6cbd'},
  amazon: {name: 'Amazon Linux', color: '#e08a00'},
  suse: {name: 'SUSE / openSUSE', color: '#4f9d1f'},
  alpine: {name: 'Alpine Linux', color: '#0d597f'},
  arch: {name: 'Arch Linux', color: '#1793d1'},
  freebsd: {name: 'FreeBSD', color: '#ab2b28'},
  openbsd: {name: 'OpenBSD', color: '#b8a000'},
  netbsd: {name: 'NetBSD', color: '#e8590c'},
  macos: {name: 'macOS', color: '#6b7280'},
  windows: {name: 'Windows', color: '#0078d4'},
  linux: {name: 'Linux', color: '#4b5563'},
}

/** "Ubuntu", or '' when the server type is not known (yet). */
export const osName = (os?: string) => (os && OS_INFO[os]?.name) || ''

const pt = (r: number, deg: number) => `${(12 + r * Math.cos((deg * Math.PI) / 180)).toFixed(2)} ${(12 + r * Math.sin((deg * Math.PI) / 180)).toFixed(2)}`
/** a clockwise arc of the circle of radius r between two angles (degrees, 0 = right, y down) */
const arc = (r: number, a: number, b: number) => `M${pt(r, a)} A${r} ${r} 0 0 1 ${pt(r, b)}`

/** Simple white glyphs, one per server type, drawn on a 24×24 grid. `bg` is the tile colour, for cut-outs. */
const GLYPHS: Record<string, (bg: string) => ReactNode> = {
  // the circle of friends: a ring with three people on it, 120° apart
  ubuntu: () => (
    <g fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
      <path d={arc(6.8, 204, 276)} /><path d={arc(6.8, 324, 36)} /><path d={arc(6.8, 84, 156)} />
      <g fill="#fff" stroke="none">
        <circle cx="5.2" cy="12" r="2.5" /><circle cx="15.4" cy="6.1" r="2.5" /><circle cx="15.4" cy="17.9" r="2.5" />
      </g>
    </g>
  ),
  // an open swirl
  debian: () => <path d="M14.5 5.5C10 4 5.5 7.2 6.4 12c.8 4.2 5.8 6.2 9 3.6 2.6-2.2 1.7-6.2-1.2-6.8-2.4-.5-4.4 1.5-3.4 3.4.7 1.3 2.5 1.4 3.2.3" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />,
  raspbian: () => (
    <g fill="#fff">
      <circle cx="9.3" cy="13" r="2.7" /><circle cx="14.7" cy="13" r="2.7" /><circle cx="12" cy="17.3" r="2.7" /><circle cx="12" cy="9.6" r="2.4" />
      <path d="M8 6.2c1.6.2 2.8 1 4 2.4 1.2-1.4 2.4-2.2 4-2.4-.6 1.8-2 2.7-4 3-2-.3-3.4-1.2-4-3z" />
    </g>
  ),
  kali: () => <path d="M12 3.5 19.5 6v6c0 4.2-3.2 7.2-7.5 8.5C7.700 19.200 4.500 16.200 4.500 12V6zM9 8v8M9 12l5-4M10.500 12l4 4" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  // four squares around a diamond, like the pinwheel
  centos: () => (
    <g fill="#fff" transform="rotate(45 12 12)">
      <rect x="4.5" y="4.5" width="6" height="6" rx="1" /><rect x="13.5" y="4.5" width="6" height="6" rx="1" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1" /><rect x="13.5" y="13.5" width="6" height="6" rx="1" />
    </g>
  ),
  rhel: (bg) => (
    <g>
      <path d="M3 16.2c0-2.200 4.200-3.400 9-3.400s9 1.200 9 3.400-4.200 3.400-9 3.400-9-1.200-9-3.400z" fill="#fff" />
      <path d="M7.400 13.200 9.200 8.500c.9-2.300 5.700-2.300 6.600 0l1.800 4.700c-1.500-.9-3.100-1.300-5.600-1.300s-4.100.4-5.600 1.300z" fill="#fff" />
      <path d="M7.800 12.600c2.600-1 5.800-1 8.400 0" fill="none" stroke={bg} strokeWidth="1.500" />
    </g>
  ),
  fedora: () => (
    <g fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M13.800 7.800c-2-.4-3.200.6-3.200 2.400V17M8.300 11.200h5.500" />
    </g>
  ),
  rocky: () => <path d="M3.500 17.500 9.500 8.500l3 4 2-2.500 6 7.500z M9 18.500l7-8" fill="none" stroke="#fff" strokeWidth="1.900" strokeLinejoin="round" strokeLinecap="round" />,
  almalinux: () => (
    <g fill="#fff">
      <circle cx="12" cy="7" r="2.600" /><circle cx="7" cy="14.500" r="2.600" /><circle cx="17" cy="14.500" r="2.600" /><circle cx="12" cy="16.800" r="2" opacity=".6" />
    </g>
  ),
  amazon: () => (
    <g fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.500 14.500c4.500 3.500 10.500 3.500 15 0" /><path d="M16.800 12.800l2.700 1.700-1.200 3" />
      <path d="M9 11.500c0-2.400 1-3.600 3-3.600s3 1.200 3 3.200V13c-.2-.1-.6-.1-1.100-.1-1.800 0-4.900.1-4.900-1.400z" strokeWidth="1.600" />
    </g>
  ),
  suse: () => <text x="12" y="17.200" textAnchor="middle" fontSize="15" fontWeight="800" fill="#fff" fontFamily="system-ui, sans-serif">S</text>,
  alpine: () => <path d="M2.500 19 9 7l3.300 5.800L14.800 9 21.500 19z" fill="#fff" />,
  arch: () => <path fillRule="evenodd" fill="#fff" d="M12 3 21 21h-4.600L12 11.800 7.600 21H3zM12 15.300 14.600 21H9.400z" />,
  freebsd: () => (
    <g fill="#fff">
      <path d="M5 4.500c2.200.2 3.800 1.200 4.600 3.100M19 4.500c-2.200.2-3.800 1.200-4.600 3.100" stroke="#fff" strokeWidth="1.800" strokeLinecap="round" fill="none" />
      <circle cx="12" cy="13.500" r="6.300" />
    </g>
  ),
  openbsd: () => <path d="M3.500 12c3-4.500 8-6 12.500-3.200 1.700 1.100 3 2.200 4.500 3.200-1.500 1-2.800 2.100-4.500 3.200-4.500 2.800-9.500 1.300-12.500-3.200zM17 11.500h.01" fill="none" stroke="#fff" strokeWidth="1.900" strokeLinecap="round" strokeLinejoin="round" />,
  netbsd: () => <path d="M4 20V4l8 12V4M16 20V4l4 6" fill="none" stroke="#fff" strokeWidth="2.200" strokeLinecap="round" strokeLinejoin="round" />,
  // four panes
  windows: () => (
    <g fill="#fff">
      <path d="M3 5.600 10.500 4.500v6.800H3zM11.600 4.400 21 3v8.300h-9.400zM3 12.400h7.500v6.800L3 18.100zM11.600 12.400H21V21l-9.400-1.400z" />
    </g>
  ),
  macos: () => (
    <g fill="none" stroke="#fff" strokeWidth="1.900" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.500" y="4.500" width="17" height="11.500" rx="1.800" /><path d="M8 20h8M12 16v4" />
    </g>
  ),
  linux: (bg) => (
    <g>
      <ellipse cx="12" cy="14" rx="5.600" ry="7" fill="#fff" />
      <ellipse cx="12" cy="15.500" rx="3.200" ry="4.800" fill={bg} opacity=".9" />
      <circle cx="10.200" cy="9.500" r="1" fill={bg} /><circle cx="13.800" cy="9.500" r="1" fill={bg} />
      <path d="M10.400 11.300 12 12.500l1.600-1.200z" fill="#f5a623" />
    </g>
  ),
}

/** The icon of a server: its distribution's logo (white on its colour tile), or the generic server icon until it is known. */
export function OsIcon({os, size = 20}: {os?: string; size?: number}) {
  const info = os ? OS_INFO[os] : undefined
  const glyph = os ? GLYPHS[os] : undefined
  if (!info || !glyph) return <IconServer size={size} />
  return (
    <span className="os-mark" data-os={os} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" data-glyph={os}>
        <g transform="translate(12 12) scale(1.16) translate(-12 -12)">{glyph(info.color)}</g>
      </svg>
    </span>
  )
}
