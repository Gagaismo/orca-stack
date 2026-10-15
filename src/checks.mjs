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

// One entry per check: its latest row, and `runs`, how many rows the check has on this head commit.
export const latestChecks = rollup => {
  const latest = new Map()
  for (const check of rollup ?? []) {
    const key = isStatus(check) ? `status:${check.context}` : `check:${check.workflowName ?? ''}/${check.name}`
    const seen = latest.get(key)
    latest.set(key, { check: !seen || newer(check, seen.check) ? check : seen.check, runs: (seen?.runs ?? 0) + 1 })
  }

  return [...latest.values()]
}
