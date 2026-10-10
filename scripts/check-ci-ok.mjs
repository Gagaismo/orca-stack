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

const failed = Object.entries(needs)
  .filter(([, job]) => !job || job.result !== 'success')
  .map(([name, job]) => `${name}=${job?.result ?? 'missing'}`)

if (failed.length > 0) {
  console.error(`CI jobs did not succeed: ${failed.join(', ')}`)
  process.exit(1)
}
