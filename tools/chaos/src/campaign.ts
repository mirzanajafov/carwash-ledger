export function campaignFailed(summary: { runsWithViolations: number; harnessErrors: number }): boolean {
  return summary.runsWithViolations > 0 || summary.harnessErrors > 0
}
