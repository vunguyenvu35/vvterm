/** Logo mark and wordmark on one row: gradient "VV", bold "Term" and a blinking terminal cursor. */
export function Brand({size = 'sm', heading = false}: {size?: 'sm' | 'lg'; heading?: boolean}) {
  const px = size === 'lg' ? 52 : 28
  const Tag = heading ? 'h1' : 'div'
  return (
    <Tag className={`brand-lockup ${size}`} aria-label="VVTerm">
      <img src="/logo-mark.svg" alt="" width={px} height={px} />
      <span className="wordmark" aria-hidden="true">
        <span className="vv">VV</span>Term<span className="cursor">_</span>
      </span>
    </Tag>
  )
}
