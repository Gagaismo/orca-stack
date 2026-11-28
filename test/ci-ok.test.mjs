import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
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

const cleanEnv = (needs, extraEnv = {}) => {
  const env = { ...process.env }
  for (const key of ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_API_URL', 'ORCA_CI_CANCEL_WAIT_MS']) {
    delete env[key]
  }
  return { ...env, ...extraEnv, ORCA_CI_NEEDS: JSON.stringify(needs) }
}

const runChecker = (needs, extraEnv = {}) => spawnSync(process.execPath, [checker], {
  cwd: root,
  encoding: 'utf8',
  env: cleanEnv(needs, extraEnv),
})

const spawnChecker = (needs, extraEnv = {}) => {
  const child = spawn(process.execPath, [checker], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv(needs, extraEnv),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { child, done }
}

const waitForRequestOrExit = async (signalPromise, donePromise, label) => {
  const outcome = await Promise.race([
    signalPromise.then(() => ({ kind: 'seen' })),
    donePromise.then(res => ({ kind: 'exited', res })),
  ])
  if (outcome.kind === 'exited') {
    assert.fail(`${label}: checker exited early with code ${outcome.res.code}: ${outcome.res.stderr}`)
  }
}

const startMockApi = handler => new Promise((resolve, reject) => {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
    handler(req, res, requests)
  })
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    resolve({
      url: `http://127.0.0.1:${port}`,
      requests,
      close: () => new Promise(res => {
        server.closeAllConnections?.()
        server.close(res)
      }),
    })
  })
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

  test('ci-ok checks out the checker script before running it', () => {
    const block = ciOk().get('ci-ok').join('\n')
    assert.match(block, /uses: actions\/checkout@v4/)
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

  test('Rule 11 (#206): a per-PR concurrency group cancels the run in progress, the triggers stay and no job skips on a title-only edit', () => {
    assert.match(workflow, /^concurrency:\r?\n  group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}\r?\n  cancel-in-progress: true\r?$/m)
    assert.match(workflow, /^  pull_request:\r?\n    types: \[opened, synchronize, reopened, edited\]\r?$/m)
    assert.doesNotMatch(workflow, /github\.event\.(action|changes)\b/)
  })

  test('Issue #507 Rule 1: cancelled-only needs calls force-cancel on the current run and waits, and ci-ok grants actions: write with GITHUB_TOKEN', async () => {
    const block = ciOk().get('ci-ok').join('\n')
    assert.match(block, /^    if: always\(\)$/m)
    assert.match(block, /^    permissions:\r?\n(?:      .+\r?\n)*      actions: write$/m)
    assert.match(block, /^      contents: read$/m)
    assert.match(block, /GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/)

    let notifyCancel
    const cancelSeen = new Promise(resolve => { notifyCancel = resolve })
    const api = await startMockApi((req, res) => {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end('{}')
      notifyCancel()
    })
    try {
      const { child, done } = spawnChecker(
        { test: { result: 'cancelled' }, hygiene: { result: 'success' } },
        {
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'Gagaismo/orca-stack',
          GITHUB_RUN_ID: '999',
          GITHUB_API_URL: api.url,
          ORCA_CI_CANCEL_WAIT_MS: '5000',
        },
      )
      await waitForRequestOrExit(cancelSeen, done, 'force-cancel')
      assert.equal(api.requests.length, 1)
      assert.equal(api.requests[0].method, 'POST')
      assert.equal(api.requests[0].url, '/repos/Gagaismo/orca-stack/actions/runs/999/force-cancel')
      assert.equal(api.requests[0].authorization, 'Bearer test-token')
      assert.equal(child.exitCode, null, 'checker stays waiting for runner termination')
      child.kill('SIGTERM')
      const result = await done
      assert.equal(result.signal, 'SIGTERM')
      assert.notEqual(result.code, 0)
    } finally {
      await api.close()
    }

    let notifySecondForceCancel
    const secondForceCancelSeen = new Promise(resolve => { notifySecondForceCancel = resolve })
    const retryApi = await startMockApi((req, res, requests) => {
      if (requests.length === 1) {
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end('{"message":"Conflict"}')
        return
      }
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end('{}')
      if (requests.length === 3) notifySecondForceCancel()
    })
    try {
      const { child, done } = spawnChecker(
        { test: { result: 'cancelled' } },
        {
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'Gagaismo/orca-stack',
          GITHUB_RUN_ID: '1000',
          GITHUB_API_URL: retryApi.url,
          ORCA_CI_CANCEL_WAIT_MS: '5000',
        },
      )
      await waitForRequestOrExit(secondForceCancelSeen, done, '409 retry force-cancel')
      assert.deepEqual(
        retryApi.requests.map(r => `${r.method} ${r.url}`),
        [
          'POST /repos/Gagaismo/orca-stack/actions/runs/1000/force-cancel',
          'POST /repos/Gagaismo/orca-stack/actions/runs/1000/cancel',
          'POST /repos/Gagaismo/orca-stack/actions/runs/1000/force-cancel',
        ],
      )
      child.kill('SIGTERM')
      const result = await done
      assert.equal(result.signal, 'SIGTERM')
      assert.notEqual(result.code, 0)
    } finally {
      await retryApi.close()
    }
  })

  test('Issue #507 Rule 2: cancelled needs never approves (fails closed without env, on API error, on invalid repo/runId, and on cancel wait timeout)', async () => {
    const block = ciOk().get('ci-ok').join('\n')
    assert.match(block, /^    if: always\(\)$/m)
    assert.doesNotMatch(block, /!cancelled\(\)/)

    const missingEnv = runChecker({ test: { result: 'cancelled' } })
    assert.equal(missingEnv.status, 1)

    const badRepo = runChecker({ test: { result: 'cancelled' } }, {
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: '../bad',
      GITHUB_RUN_ID: '999',
    })
    assert.equal(badRepo.status, 1)

    const badRunId = runChecker({ test: { result: 'cancelled' } }, {
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'Gagaismo/orca-stack',
      GITHUB_RUN_ID: 'abc',
    })
    assert.equal(badRunId.status, 1)

    for (const status of [403, 500]) {
      const api = await startMockApi((req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end('{"message":"error"}')
      })
      try {
        const result = await spawnChecker({ test: { result: 'cancelled' } }, {
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'Gagaismo/orca-stack',
          GITHUB_RUN_ID: '999',
          GITHUB_API_URL: api.url,
          ORCA_CI_CANCEL_WAIT_MS: '50',
        }).done
        assert.equal(result.code, 1, `HTTP ${status} must fail closed`)
      } finally {
        await api.close()
      }
    }

    const timeoutApi = await startMockApi((req, res) => {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end('{}')
    })
    try {
      const result = await spawnChecker({ test: { result: 'cancelled' } }, {
        GITHUB_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'Gagaismo/orca-stack',
        GITHUB_RUN_ID: '999',
        GITHUB_API_URL: timeoutApi.url,
        ORCA_CI_CANCEL_WAIT_MS: '30',
      }).done
      assert.equal(result.code, 1, 'wait timeout must fail closed')
      assert.match(result.stderr, /timed out|timeout/i)
    } finally {
      await timeoutApi.close()
    }
  })

  test('Issue #507 Rule 3: a real failure or skipped job fails ci-ok immediately without calling force-cancel, even alongside cancelled jobs', async () => {
    const api = await startMockApi((req, res) => {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end('{}')
    })
    try {
      for (const badStatus of ['failure', 'skipped']) {
        const result = await spawnChecker(
          { test: { result: badStatus }, lint: { result: 'cancelled' }, hygiene: { result: 'success' } },
          {
            GITHUB_TOKEN: 'test-token',
            GITHUB_REPOSITORY: 'Gagaismo/orca-stack',
            GITHUB_RUN_ID: '999',
            GITHUB_API_URL: api.url,
            ORCA_CI_CANCEL_WAIT_MS: '50',
          },
        ).done
        assert.equal(result.code, 1)
        assert.match(result.stderr, new RegExp(`test=${badStatus}`, 'i'))
      }
      assert.equal(api.requests.length, 0, 'must not call force-cancel when a real failure or skipped job exists')
    } finally {
      await api.close()
    }
  })
})
