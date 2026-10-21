import { describeFinding, percentDone, startedBeforeTamper, type VerificationRun } from '@/lib/verification'

function time(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
}

export function VerificationRunView({ run, tamperAt }: { run: VerificationRun; tamperAt: string | null }) {
  if (run.status === 'queued') {
    return <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">Queued at {time(run.requested_at)}, waiting for the worker.</p>
  }
  if (run.status === 'running') {
    const percent = percentDone(run)
    return (
      <div className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
        <p>
          {run.progress
            ? `Checked ${run.progress.checked.toLocaleString('en')} of ${run.progress.size.toLocaleString('en')} journals.`
            : 'Opening a snapshot of the log.'}
          <span className="ml-2 text-muted">Started at {time(run.started_at)}</span>
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      </div>
    )
  }
  if (run.status === 'failed' || !run.report) {
    return (
      <p className="rounded-xl border border-line bg-surface p-4 text-sm text-bad">
        The run that started at {time(run.started_at)} failed: {run.error}.
      </p>
    )
  }
  const { report } = run
  return (
    <div className="rounded-xl border border-line bg-surface p-4 text-sm">
      <p className="mb-1 text-xs text-muted">
        The last run, finished at {time(run.finished_at)} in {(report.ms.total / 1000).toFixed(1)} s
      </p>
      <p className={report.findings === 0 ? 'font-medium text-ok' : 'font-medium text-bad'}>
        {report.findings === 0
          ? `${report.journals.toLocaleString('en')} journals, ${report.witnessed.toLocaleString('en')} signed roots: nothing wrong.`
          : `${report.findings} finding${report.findings === 1 ? '' : 's'} in ${report.journals.toLocaleString('en')} journals${report.firstSeq !== null ? `, first at seq ${report.firstSeq}` : ''}.`}
      </p>
      {startedBeforeTamper(run, tamperAt) ? (
        <p className="mt-1 text-xs text-warn">This run started before the current tamper. Run it again to see it caught.</p>
      ) : null}
      {report.examples.length > 0 ? (
        <ul className="mt-2 space-y-0.5 font-mono text-xs text-bad">
          {report.examples.slice(0, 6).map((f, i) => (
            <li key={i}>{describeFinding(f)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
