export function Mark({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-label={label} aria-hidden={label === undefined}>
      {ok ? (
        <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />
      ) : (
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  )
}
