export interface VerificationFinding {
  kind: string
  seq?: number
  size?: number
  after?: number
  journalId?: string
}

export interface VerificationReport {
  size: number
  journals: number
  witnessed: number
  findings: number
  firstSeq: number | null
  examples: VerificationFinding[]
  ms: { read: number; compute: number; total: number }
}

export interface VerificationRun {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed'
  requested_at: string
  started_at: string | null
  finished_at: string | null
  attempts: number
  progress: { checked: number; size: number } | null
  report: VerificationReport | null
  error: string | null
}

export function isOpen(run: VerificationRun | null): boolean {
  return run?.status === 'queued' || run?.status === 'running'
}

export function percentDone(run: VerificationRun): number {
  const progress = run.progress
  if (!progress || progress.size === 0) return 0
  return Math.min(100, Math.floor((progress.checked / progress.size) * 100))
}

export function startedBeforeTamper(run: VerificationRun, tamperAt: string | null): boolean {
  return (
    run.status === 'done' && run.report?.findings === 0 && tamperAt !== null && run.started_at !== null && Date.parse(tamperAt) > Date.parse(run.started_at)
  )
}

export function describeFinding(f: VerificationFinding): string {
  if (f.kind === 'root') return `the root at size ${f.size} is not the one the witness signed (the change is in seq ${f.after} to ${(f.size ?? 0) - 1})`
  if (f.kind === 'leaf') return `seq ${f.seq}: journal ${f.journalId} no longer matches its leaf`
  if (f.kind === 'missing_journal') return `seq ${f.seq}: journal ${f.journalId} is gone`
  if (f.kind === 'chain') return `seq ${f.seq}: the chain breaks`
  return `${f.kind}${f.seq !== undefined ? ` at seq ${f.seq}` : ''}`
}
