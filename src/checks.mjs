// statusCheckRollup keeps the rows of every run on one head commit (a re-run, a body edit that re-runs CI, a run that
// concurrency cancelled): `vigilar` and `rebote` both read a check by its latest row, through latestChecks.
const PENDING_RUN = ['QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING']
const PENDING_STATUS = ['EXPECTED', 'PENDING']

export const isStatus = check => check.__typename === 'StatusContext'
export const isPending = check => (isStatus(check) ? PENDING_STATUS.includes(check.state) : PENDING_RUN.includes(check.status))

// A row that has not finished beats a finished one, since a queued row has no startedAt yet; between rows alike, the
// latest startedAt wins.
const newer = (row, seen) =>
  isPending(row) !== isPending(seen) ? isPending(row) : String(row.startedAt ?? '') > String(seen.startedAt ?? '')

export const checkRunId = check => /\/actions\/runs\/(\d+)(?:\/|[?#]|$)/i.exec(check.detailsUrl ?? '')?.[1]
export const isHigherRunId = (candidate, seen) => /^\d+$/.test(String(candidate ?? '')) && /^\d+$/.test(String(seen ?? '')) && BigInt(candidate) > BigInt(seen)

// One entry per check: its latest row, `runs` for failed re-run counting, and the workflow run when available.
export const latestChecks = rollup => {
  const rows = rollup ?? []
  const latestRunByWorkflow = new Map()
  const olderChecks = new Map()
  for (const check of rows) {
    if (isStatus(check)) continue
    const runId = checkRunId(check)
    if (!runId) continue
    const workflow = check.workflowName ?? ''
    const seen = latestRunByWorkflow.get(workflow)
    if (!seen || isHigherRunId(runId, seen)) latestRunByWorkflow.set(workflow, runId)
    const key = `check:${workflow}/${check.name}`
    if (!olderChecks.has(key)) olderChecks.set(key, check)
  }

  const latest = new Map()
  for (const check of rows) {
    const runId = isStatus(check) ? undefined : checkRunId(check)
    const workflow = check.workflowName ?? ''
    if (runId && runId !== latestRunByWorkflow.get(workflow)) continue
    const key = isStatus(check) ? `status:${check.context}` : `check:${workflow}/${check.name}`
    const seen = latest.get(key)
    const sameRun = !runId || !seen?.runId || runId === seen.runId
    latest.set(key, {
      check: !seen || newer(check, seen.check) ? check : seen.check,
      runs: (sameRun ? seen?.runs ?? 0 : 0) + 1,
      ...(runId ? { runId } : seen?.runId ? { runId: seen.runId } : {}),
    })
  }

  for (const [key, check] of olderChecks) {
    if (latest.has(key)) continue
    const workflow = check.workflowName ?? ''
    const runId = latestRunByWorkflow.get(workflow)
    if (runId && checkRunId(check) !== runId) {
      latest.set(key, { check: { ...check, status: 'IN_PROGRESS', conclusion: '' }, runs: 0, runId })
    }
  }

  return [...latest.values()]
}
