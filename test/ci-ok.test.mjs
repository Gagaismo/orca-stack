import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, test } from 'node:test'

const root = process.cwd()
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const checker = path.join(root, 'scripts', 'check-ci-ok.mjs')

const jobBlocks = text => {
  const jobsStart = text.indexOf('\njobs:\n')
  assert.notEqual(jobsStart, -1, 'workflow has a top-level jobs section')
  const remainder = text.slice(jobsStart + '\njobs:\n'.length)
  const jobs = new Map()
  let current
  for (const line of remainder.split(/\r?\n/)) {
    if (/^[^ ]/.test(line)) break
    const match = line.match(/^  ([A-Za-z0-9_-]+):\s*$/)
    if (match) {
      current = match[1]
      jobs.set(current, [line])
    } else if (current) {
      jobs.get(current).push(line)
    }
  }
  return jobs
}

const ciOk = () => {
  const jobs = jobBlocks(workflow)
  assert.ok(jobs.has('ci-ok'), 'workflow defines ci-ok')
  return jobs
}

const coversEveryJob = text => {
  const jobs = jobBlocks(text)
  const block = jobs.get('ci-ok')?.join('\n') ?? ''
  const listed = [...block.matchAll(/^      - ([A-Za-z0-9_-]+)$/gm)].map(([, id]) => id)
  return jobs.has('ci-ok')
    && new Set(listed).size === listed.length
    && [...jobs.keys()].filter(id => id !== 'ci-ok').every(id => listed.includes(id))
    && listed.every(id => jobs.has(id) && id !== 'ci-ok')
}

const runChecker = needs => spawnSync(process.execPath, [checker], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, ORCA_CI_NEEDS: JSON.stringify(needs) },
})

describe('ci-ok aggregate check', () => {
  test('all other workflow jobs are listed in ci-ok.needs and it always runs', () => {
    const jobs = ciOk()
    const block = jobs.get('ci-ok').join('\n')
    const listed = [...block.matchAll(/^      - ([A-Za-z0-9_-]+)$/gm)].map(([, id]) => id)
    assert.deepEqual(new Set(listed), new Set([...jobs.keys()].filter(id => id !== 'ci-ok')))
    assert.match(block, /^    if: always\(\)$/m)

    const withNewJob = workflow.replace('\n  ci-ok:', '\n  added-job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  ci-ok:')
    assert.equal(coversEveryJob(withNewJob), false, 'an unlisted job must fail the coverage check')
  })

  test('all green jobs make ci-ok succeed', () => {
    const result = runChecker({ test: { result: 'success' }, hygiene: { result: 'success' } })
    assert.equal(result.status, 0, result.stderr)
  })

  test('a red matrix job fails ci-ok and names the failing job', () => {
    const result = runChecker({ test: { result: 'failure' }, hygiene: { result: 'success' } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /test.*failure/i)
  })

  test('skipped or cancelled jobs fail ci-ok', () => {
    for (const status of ['skipped', 'cancelled']) {
      const result = runChecker({ test: { result: status }, hygiene: { result: 'success' } })
      assert.equal(result.status, 1, `${status} must fail the aggregate`)
      assert.match(result.stderr, new RegExp(`test.*${status}`, 'i'))
    }
  })

  test('a skipped conventional-commit step on push does not exclude hygiene from the aggregate', () => {
    const jobs = ciOk()
    const block = jobs.get('ci-ok').join('\n')
    const hygiene = jobs.get('hygiene').join('\n')
    assert.match(block, /^      - hygiene$/m)
    assert.match(hygiene, /if: github\.event_name == 'pull_request'/)
  })
})
