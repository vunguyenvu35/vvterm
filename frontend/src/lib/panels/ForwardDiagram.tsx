import type {ForwardType} from '../types'

interface Layout {
  nodes: [string, string, string]
  /** which hop goes through the SSH tunnel: first→second, or second→third */
  tunnel: 'ab' | 'bc'
  note: string
}

const LAYOUTS: Record<ForwardType, Layout> = {
  local: {nodes: ['This computer', 'SSH host', 'Destination'], tunnel: 'ab', note: 'a local port reaches the destination through the host'},
  remote: {nodes: ['Remote clients', 'SSH host', 'Your side'], tunnel: 'bc', note: 'a port on the host comes back to a service on your side'},
  dynamic: {nodes: ['Your app', 'SSH host', 'Any site'], tunnel: 'ab', note: 'a local SOCKS5 proxy sends traffic out through the host'},
}

const NODE_X = [44, 125, 206]

/** The three machines of a forwarding type and the encrypted hop between them. Decorative: the text says the same. */
export function ForwardDiagram({type, highlight}: {type: ForwardType; /** the machine the current step is about: 0 first, 1 SSH host, 2 last */ highlight?: 0 | 1 | 2}) {
  const l = LAYOUTS[type]
  const hop = (from: number, to: number, tunnel: boolean) => (
    <g key={from}>
      {tunnel
        ? <rect x={NODE_X[from] + 26} y={36} width={NODE_X[to] - NODE_X[from] - 52} height={8} rx={4} fill="var(--accent)" opacity=".85" />
        : <line x1={NODE_X[from] + 26} y1={40} x2={NODE_X[to] - 30} y2={40} stroke="var(--muted)" strokeWidth="2" strokeDasharray="4 4" />}
      <path d={`M${NODE_X[to] - 30} 34 l8 6 l-8 6`} fill="none" stroke={tunnel ? 'var(--accent)' : 'var(--muted)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
  return (
    <svg className="fw-diagram" viewBox="0 0 250 104" role="img" aria-label={`${type} forwarding: ${l.note}`} data-type={type}>
      {hop(0, 1, l.tunnel === 'ab')}
      {hop(1, 2, l.tunnel === 'bc')}
      {l.nodes.map((n, i) => (
        <g key={n} transform={`translate(${NODE_X[i] - 22} 14)`} opacity={highlight === undefined || highlight === i ? 1 : 0.45} data-active={highlight === i ? 'true' : undefined}>
          <rect width="44" height="52" rx="9" fill={i === 1 ? '#d9304f' : 'var(--bg-3)'} stroke={highlight === i ? 'var(--accent)' : 'var(--line)'} strokeWidth={highlight === i ? 2.5 : 1} />
          {i === 1
            ? <path d="M6 14h32M6 26h32M6 38h32M16 14v12M30 26v12" stroke="#fff" strokeOpacity=".75" strokeWidth="2" />
            : <><rect x="9" y="12" width="26" height="9" rx="2" fill="var(--muted)" opacity=".55" /><rect x="9" y="26" width="26" height="9" rx="2" fill="var(--muted)" opacity=".55" /><circle cx="14" cy="16.5" r="1.6" fill="var(--accent)" /></>}
        </g>
      ))}
      {l.nodes.map((n, i) => <text key={n} x={NODE_X[i]} y="86" textAnchor="middle" fontSize="9" fill="var(--muted)">{n}</text>)}
    </svg>
  )
}
