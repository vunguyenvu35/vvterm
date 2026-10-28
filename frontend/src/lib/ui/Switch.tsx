/** Accessible on/off switch (role="switch"). */
export function Switch({checked, onChange, label, disabled}: {checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={'switch' + (checked ? ' on' : '')} onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  )
}
