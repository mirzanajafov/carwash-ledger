export function Mark({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="text-warn">?</span>
  return (
    <svg viewBox="0 0 16 16" className={`size-4 ${ok ? 'text-ok' : 'text-bad'}`} aria-label={ok ? 'holds' : 'fails'}>
      {ok ? (
        <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />
      ) : (
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  )
}
