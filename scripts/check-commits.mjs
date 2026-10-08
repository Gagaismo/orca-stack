#!/usr/bin/env node
// Fails when a commit subject in <base>..<head> does not follow Conventional Commits (`type(scope)!: subject`).
// Merge commits pass. Usage: node scripts/check-commits.mjs <base> [head]
import { execFileSync } from 'node:child_process'

const TYPES = 'feat|fix|docs|chore|refactor|test|ci|perf|build|style|revert'
const SUBJECT = new RegExp(`^(${TYPES})(\\([A-Za-z0-9._/-]+\\))?!?: \\S.*`)

const [base, head = 'HEAD'] = process.argv.slice(2)
if (!base) {
  console.error('Usage: node scripts/check-commits.mjs <base> [head]')
  process.exit(2)
}

const log = execFileSync('git', ['log', '--format=%h %s', `${base}..${head}`], { encoding: 'utf8' })
const bad = log
  .split('\n')
  .filter(Boolean)
  .filter(line => {
    const subject = line.slice(line.indexOf(' ') + 1)

    return !subject.startsWith('Merge ') && !SUBJECT.test(subject)
  })

if (bad.length > 0) {
  console.error(`Commits that do not follow Conventional Commits (${TYPES}):`)
  for (const line of bad) console.error(`  ${line}`)
  process.exit(1)
}
console.log('Commit subjects OK')
