const raw = process.env.ORCA_CI_NEEDS

if (!raw) {
  console.error('ORCA_CI_NEEDS must contain the needs context JSON.')
  process.exit(2)
}

let needs
try {
  needs = JSON.parse(raw)
} catch {
  console.error('ORCA_CI_NEEDS must contain valid JSON.')
  process.exit(2)
}

if (!needs || typeof needs !== 'object' || Array.isArray(needs) || Object.keys(needs).length === 0) {
  console.error('ORCA_CI_NEEDS must contain at least one job result.')
  process.exit(2)
}

const formatJobs = entries => entries.map(([name, job]) => `${name}=${job?.result ?? 'missing'}`).join(', ')

const nonSuccess = Object.entries(needs).filter(([, job]) => !job || job.result !== 'success')
if (nonSuccess.length === 0) process.exit(0)

const nonCancelled = nonSuccess.filter(([, job]) => job?.result !== 'cancelled')
if (nonCancelled.length > 0) {
  console.error(`CI jobs did not succeed: ${formatJobs(nonSuccess)}`)
  process.exit(1)
}

console.error(`CI jobs were cancelled: ${formatJobs(nonSuccess)}`)

const token = process.env.GITHUB_TOKEN
const repository = process.env.GITHUB_REPOSITORY
const runId = process.env.GITHUB_RUN_ID

if (!token || !repository || !runId) {
  console.error('Cannot cancel run: GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_RUN_ID are required.')
  process.exit(1)
}

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^\d+$/.test(runId)) {
  console.error('Cannot cancel run: invalid GITHUB_REPOSITORY or GITHUB_RUN_ID.')
  process.exit(1)
}

const parsedWait = Number(process.env.ORCA_CI_CANCEL_WAIT_MS)
const waitMs = Number.isFinite(parsedWait) && parsedWait >= 0 ? parsedWait : 60_000
const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const postAction = async action => fetch(`${apiUrl}/repos/${repository}/actions/runs/${runId}/${action}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'orca-stack-ci-ok',
  },
})

try {
  let response = await postAction('force-cancel')
  if (response.status === 409) {
    await postAction('cancel')
    await sleep(Math.min(1000, waitMs))
    response = await postAction('force-cancel')
  }
  if (!response.ok) {
    console.error(`Failed to cancel workflow run ${runId}: HTTP ${response.status}`)
    process.exit(1)
  }
} catch (error) {
  console.error(`Failed to cancel workflow run ${runId}: ${error.message}`)
  process.exit(1)
}

await sleep(waitMs)
console.error(`Timed out waiting ${waitMs}ms for runner to cancel workflow run ${runId}.`)
process.exit(1)
