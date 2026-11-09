// Issue #346: both CI sites fetch tla2tools.jar through scripts/fetch-tla2tools.sh, which retries transient failures
// and always checks the pinned checksum.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { describe, test } from 'node:test'

import { cleanup, tempDir } from './helpers.mjs'

const root = process.cwd()
const script = path.join('scripts', 'fetch-tla2tools.sh')
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const JAR_URL = 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar'
const JAR_SHA = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
const skip = process.platform === 'win32' && 'bash on Windows may resolve to WSL; the ubuntu CI legs run it'

// Serves one scripted answer per request: 'reset' drops the connection, a number is an empty answer with that status,
// a string is a 200 with that body. The last answer repeats.
const serve = async answers => {
  let requests = 0
  const server = createServer((req, res) => {
    const answer = answers[Math.min(requests, answers.length - 1)]
    requests += 1
    if (answer === 'reset') req.socket.destroy()
    else if (typeof answer === 'number') res.writeHead(answer).end()
    else res.writeHead(200).end(answer)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/tla2tools.jar`, requests: () => requests, close: () => new Promise(resolve => server.close(resolve)) }
}

// Runs the script asynchronously so the in-process server can answer.
const fetchJar = (url, dest) => new Promise(resolve => {
  const child = spawn('bash', [script, dest], { cwd: root, env: { ...process.env, TLA2TOOLS_URL: url, TLA2TOOLS_RETRY_DELAY: '1' } })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.on('close', status => resolve({ status, output }))
})

const withServer = async (answers, check) => {
  const server = await serve(answers)
  const dir = tempDir('tla2tools')
  try {
    await check(await fetchJar(server.url, path.join(dir, 'tla2tools.jar')), server, dir)
  } finally {
    await server.close()
    cleanup(dir)
  }
}

// The lines of one job of ci.yml, from its `  <id>:` line to the next job.
const job = id => {
  const lines = workflow.split(/\r?\n/)
  const start = lines.indexOf(`  ${id}:`)
  assert.notEqual(start, -1, `ci.yml has no job ${id}`)
  const end = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

describe('tla2tools.jar download (issue #346)', () => {
  test('Rule 1: a 504 or a connection reset is retried and the download goes on to the checksum', { skip }, async () => {
    await withServer([504, 'reset', 'not the release jar'], async (run, server) => {
      assert.equal(server.requests(), 3, run.output)
      assert.match(run.output, /curl: \(22\).*504/)
      // curl recovered on the third try: the job now fails on the checksum of the served bytes (exit 1), not in curl.
      assert.equal(run.status, 1, run.output)
      assert.match(run.output, /tla2tools\.jar: FAILED/)
    })
  })

  test('Rule 1: a 404 still fails the download, after a bounded number of retries', { skip }, async () => {
    await withServer([404], async (run, server, dir) => {
      assert.equal(run.status, 22, run.output)
      assert.match(run.output, /curl: \(22\).*404/)
      assert.equal(server.requests(), 6, 'one try and 5 retries')
      assert.doesNotMatch(run.output, /FAILED|: OK/, 'no checksum after a failed download')
      assert.equal(existsSync(path.join(dir, 'tla2tools.jar')), false)
    })
  })

  test('Rule 2: a downloaded jar with a different checksum fails', { skip }, async () => {
    await withServer(['not the release jar'], async run => {
      assert.equal(run.status, 1, run.output)
      assert.match(run.output, /tla2tools\.jar: FAILED/)
    })
  })

  test('Rule 2: the script checks the pinned checksum strictly after every download', () => {
    const lines = readFileSync(path.join(root, script), 'utf8').split(/\r?\n/)
    assert.ok(lines.includes('set -euo pipefail'))
    const curl = lines.findIndex(line => line.startsWith('curl '))
    const check = lines.findIndex(line => line === `echo "${JAR_SHA}  $jar" | sha256sum --check --strict -`)
    assert.ok(curl !== -1 && check === curl + 1, 'the checksum line follows the download')
    assert.match(lines[curl], /^curl -fsSL --retry 5 --retry-all-errors --retry-delay "\$\{TLA2TOOLS_RETRY_DELAY:-5\}" -o "\$jar" "\$url"$/)
    assert.ok(lines.includes(`url="\${TLA2TOOLS_URL:-${JAR_URL}}"`))
  })

  test('Rule 4: both CI sites fetch the jar through the script and no old curl is left', () => {
    assert.doesNotMatch(workflow, /curl|sha256sum|tlaplus\/releases/)
    const statechart = job('test')
    assert.match(statechart, /- name: TLC para el test de corpus de statechart\n\s+if: runner\.os == 'Linux'\n\s+run: \|\n\s+jar="\$RUNNER_TEMP\/tla2tools\.jar"\n\s+bash scripts\/fetch-tla2tools\.sh "\$jar"\n\s+echo "TLA2TOOLS=\$jar" >> "\$GITHUB_ENV"\n/)
    assert.match(job('formal'), /- name: Download and verify tla2tools\.jar 1\.7\.4\n\s+run: bash scripts\/fetch-tla2tools\.sh "\$RUNNER_TEMP\/tla2tools\.jar"\n/)
  })
})
