import type { VerificationFinding, VerificationRunView } from '@carwash/contracts'

export function isOpen(run: VerificationRunView | null): boolean {
  return run?.status === 'queued' || run?.status === 'running'
}

export function percentDone(run: VerificationRunView): number {
  const progress = run.progress
  if (!progress || progress.size === 0) return 0
  return Math.min(100, Math.floor((progress.checked / progress.size) * 100))
}

export function startedBeforeTamper(run: VerificationRunView, tamperAt: string | null): boolean {
  return (
    run.status === 'done' && run.report?.findings === 0 && tamperAt !== null && run.started_at !== null && Date.parse(tamperAt) > Date.parse(run.started_at)
  )
}

export function describeFinding(f: VerificationFinding): string {
  switch (f.kind) {
    case 'root':
      return `the root at size ${f.size} is not the one the witness signed (the change is in seq ${f.after} to ${f.size - 1})`
    case 'leaf':
      return `seq ${f.seq}: journal ${f.journalId} no longer matches its leaf`
    case 'missing_journal':
      return `seq ${f.seq}: journal ${f.journalId} is gone`
    case 'chain':
      return `seq ${f.seq}: the chain breaks`
    case 'gap':
      return `${f.kind} at seq ${f.seq}`
    default:
      return f.kind
  }
}
