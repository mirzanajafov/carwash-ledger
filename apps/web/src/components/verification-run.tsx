import { describeFinding, percentDone, type VerificationRun } from '@/lib/verification'

function time(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString() : ''
}

export function VerificationRunView({ run }: { run: VerificationRun }) {
  if (run.status === 'queued') {
    return <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">Queued at {time(run.requested_at)}, waiting for the worker.</p>
  }
  if (run.status === 'running') {
    const percent = percentDone(run)
    return (
      <div className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
        <p>
          {run.progress
            ? `Checked ${run.progress.done.toLocaleString('en')} of ${run.progress.size.toLocaleString('en')} journals.`
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
        The run that started at {time(run.started_at)} stopped: {run.error}.
      </p>
    )
  }
  const { report } = run
  return (
    <div className="rounded-xl border border-line bg-surface p-4 text-sm">
      <p className={report.findings === 0 ? 'font-medium text-ok' : 'font-medium text-bad'}>
        {report.findings === 0
          ? `${report.journals.toLocaleString('en')} journals, ${report.witnessed.toLocaleString('en')} signed roots: nothing wrong.`
          : `${report.findings} finding${report.findings === 1 ? '' : 's'} in ${report.journals.toLocaleString('en')} journals${report.firstSeq !== null ? `, first at seq ${report.firstSeq}` : ''}.`}
        <span className="ml-2 font-normal text-muted">
          Finished at {time(run.finished_at)}, in {(report.ms.total / 1000).toFixed(1)} s
        </span>
      </p>
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
