// Issue #311: the TLA+ model of rebote (formal/rebote), its CI job and the verify-rebote skill.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'

import { cleanup, tempDir } from './helpers.mjs'

const root = process.cwd()
const read = file => readFileSync(path.join(root, file), 'utf8')
const formal = path.join('formal', 'rebote')
const model = read(path.join(formal, 'Rebote.tla'))
const checkSh = read(path.join(formal, 'check.sh'))
const skill = read(path.join('.claude', 'skills', 'verify-rebote', 'SKILL.md'))
const workflow = read(path.join('.github', 'workflows', 'ci.yml'))
const JAR_URL = 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar'
const JAR_SHA = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'

const constants = cfg => Object.fromEntries([...cfg.matchAll(/^\s+(\w+) = (\w+)$/gm)].map(([, key, value]) => [key, value]))
const invariants = cfg => cfg.split(/^INVARIANTS$/m)[1].trim().split(/\s+/)
// The default <cfg> <expected> pairs of check.sh.
const expected = () => {
  const block = /set -- \\\n([\s\S]*?)\nfi/.exec(checkSh)?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/(\S+\.cfg) (\w+)/g)].map(([, cfg, result]) => [cfg, result]))
}
// The lines of one job of ci.yml, from its `  <id>:` line to the next job.
const job = id => {
  const lines = workflow.split(/\r?\n/)
  const start = lines.indexOf(`  ${id}:`)
  assert.notEqual(start, -1, `ci.yml has no job ${id}`)
  const end = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}
const stepRun = (block, name) => new RegExp(`- name: ${name}\\n\\s+run: (.+)`).exec(block)?.[1]

describe('formal/rebote (issue #311)', () => {
  test('Rule 1: the model describes the fixed rebote, with its comment retry and fail-loud exit', () => {
    assert.match(model, /synced at commit f85aa43/)
    // The fix of #310: 3 comment attempts after the launch, then a non-zero exit that main answers by posting the marker.
    assert.match(read(path.join('src', 'despacho.mjs')), /const MARKER_ATTEMPTS = 3\n/)
    assert.match(model, /CommentFail\s+\\\* TRUE: all 3 attempts of `gh pr comment`/)
    assert.match(model, /^ReboteCommentFails ==\n\s+\/\\ CommentFail\n\s+\/\\ Launch\n\s+\/\\ owed' = WithMarkers\(owed\)\n\s+\/\\ UNCHANGED mk$/m)
    assert.match(model, /^MainPostsOwed ==$/m)
    assert.match(model, /\\\/ \(OwedGuard \/\\ owed \/= NoMarkers\)/)
    // Every refusal carries the src/despacho.mjs line it models.
    const refused = /^Refused ==\n([\s\S]*?)\n\n/m.exec(model)[1].split(/\n(?=\s+\\\/ )/)
    // #296 removed the moved-head refusal: the review bounce is counted by the review's Commit: sha.
    assert.equal(refused.length, 7)
    for (const disjunct of refused) assert.match(disjunct, /\\\* L\d+/, disjunct)
  })

  test('Rule 2: check.sh expects rebote and commentfail to pass and each broken config to fail on its own invariant', () => {
    const cfgs = readdirSync(path.join(root, formal)).filter(name => name.endsWith('.cfg')).sort()
    const results = expected()
    assert.deepEqual(Object.keys(results).sort(), cfgs, 'every config has an expected result in check.sh')
    assert.equal(results['rebote.cfg'], 'pass')
    assert.equal(results['rebote-commentfail.cfg'], 'pass')
    const fixed = constants(read(path.join(formal, 'rebote.cfg')))
    assert.ok(Object.entries(fixed).every(([key, value]) => key === 'MaxHead' || key === 'CommentFail' || value === 'TRUE'), 'the real code has every guard on')
    assert.equal(fixed.MaxHead, '3')
    for (const cfg of cfgs.filter(name => name.startsWith('broken-'))) {
      const text = read(path.join(formal, cfg))
      const off = Object.entries(constants(text)).filter(([key, value]) => key.endsWith('Guard') && value === 'FALSE')
      assert.equal(off.length, 1, `${cfg} switches off exactly one guard`)
      assert.ok(invariants(text).includes(results[cfg]), `${cfg} expects ${results[cfg]}, one of its invariants`)
    }
    // A result that differs from the expected one makes the script exit non-zero.
    assert.match(checkSh, /if \[ "\$got" != "\$expected" \]; then\n\s+status=1/)
    assert.match(checkSh, /exit \$status\n$/)
  })

  test('Rule 2: check.sh exits 1 when a config result differs from its expected one', { skip: process.platform === 'win32' && 'bash on Windows may resolve to WSL; the ubuntu CI legs run it' }, () => {
    const dir = tempDir('formal-check')
    try {
      // A stand-in for java that reports every config as passing, so only check.sh's comparison is under test.
      const java = path.join(dir, 'java')
      writeFileSync(java, '#!/usr/bin/env bash\necho "Model checking completed. No error has been found."\n', { mode: 0o755 })
      writeFileSync(path.join(dir, 'tla2tools.jar'), '')
      const run = (...args) => spawnSync('bash', [path.join(root, formal, 'check.sh'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, TLA2TOOLS: 'tla2tools.jar', JAVA: './java' } })
      const same = run('rebote.cfg', 'pass')
      assert.equal(same.status, 0, same.stdout + same.stderr)
      assert.match(same.stdout, /^rebote\.cfg: pass \[expected pass\]$/m)
      const differs = run('rebote.cfg', 'pass', 'broken-owed.cfg', 'ConflictBounceOncePerHead')
      assert.equal(differs.status, 1, differs.stdout + differs.stderr)
      assert.match(differs.stdout, /^broken-owed\.cfg: pass \[expected ConflictBounceOncePerHead\]$/m)
    } finally {
      cleanup(dir)
    }
  })

  test('Rule 3: the replay tests pass under the node test runner with no Java on PATH', () => {
    const env = { ...process.env, PATH: path.dirname(process.execPath) }
    for (const key of Object.keys(env)) if (/^(java_home|java|tla2tools|path)$/i.test(key) && key !== 'PATH') delete env[key]
    delete env.NODE_TEST_CONTEXT
    delete env.NODE_TEST_WORKER_ID
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path.join('test', 'formal-rebote-replay.test.mjs')], { cwd: root, encoding: 'utf8', env })
    assert.equal(spawnSync('java', ['-version'], { env }).error?.code, 'ENOENT', 'java is reachable')
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /✔ replay: a conflict bounce whose marker comment failed is refused on the same head once main posts the printed marker/)
    assert.match(run.stdout, /✔ replay: a blocking review of an older head does not bounce the head that moved/)
    // npm test runs every test/*.test.mjs, so the replay is part of npm run verify.
    assert.ok(readdirSync(path.join(root, 'test')).includes('formal-rebote-replay.test.mjs'))
  })

  test('Rule 4: the formal CI job checks the pinned jar before TLC on ubuntu with Java 11 or later, and ci-ok requires it', () => {
    const block = job('formal')
    assert.match(block, /^    runs-on: ubuntu-latest$/m)
    assert.match(block, /uses: actions\/setup-java@v4/)
    assert.ok(Number(/java-version: '(\d+)'/.exec(block)?.[1]) >= 11, 'Java 11 or later')
    // scripts/fetch-tla2tools.sh downloads the jar and checks its pinned checksum (#346).
    assert.equal(stepRun(block, 'Download and verify tla2tools.jar 1.7.4'), 'bash scripts/fetch-tla2tools.sh "$RUNNER_TEMP/tla2tools.jar"')
    assert.match(read(path.join('scripts', 'fetch-tla2tools.sh')), new RegExp(`${JAR_URL}[\\s\\S]*echo "${JAR_SHA}  \\$jar" \\| sha256sum --check --strict -`))
    assert.equal(stepRun(block, 'Run TLC on every config'), 'TLA2TOOLS="$RUNNER_TEMP/tla2tools.jar" bash formal/rebote/check.sh')
    const order = ['Download and verify tla2tools.jar 1.7.4', 'Run TLC on every config'].map(name => block.indexOf(`- name: ${name}`))
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'download and checksum, then TLC')
    assert.match(job('ci-ok'), /^      - formal$/m)
  })

  test('Rule 4: a jar with a different checksum fails the checksum step', { skip: process.platform === 'win32' && 'bash on Windows may resolve to WSL; the ubuntu CI legs run it' }, () => {
    const dir = tempDir('formal-jar')
    try {
      writeFileSync(path.join(dir, 'tla2tools.jar'), 'not the release jar')
      // The checksum line of scripts/fetch-tla2tools.sh, which the formal job runs (#346).
      const check = read(path.join('scripts', 'fetch-tla2tools.sh')).split(/\r?\n/).find(line => line.includes('sha256sum'))
      const run = spawnSync('bash', ['-e', '-c', `jar="$RUNNER_TEMP/tla2tools.jar"; ${check}`], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: dir } })
      assert.notEqual(run.status, 0, run.stdout + run.stderr)
      assert.match(run.stdout + run.stderr, /FAILED/)
    } finally {
      cleanup(dir)
    }
  })

  test('Rule 5: the verify-rebote skill keeps its coverage record with the sync commit of the model', () => {
    assert.match(skill, /^name: verify-rebote$/m)
    assert.match(skill, /^## Coverage record$/m)
    assert.match(skill, /^- Sync commit: `f85aa43`/m)
    assert.match(skill, /^- Code covered: `reboteCommand` in `src\/despacho\.mjs`/m)
    assert.match(skill, /`latestChecks`, `analyzeChecks`, `isPending`/)
    assert.match(skill, /`blockingBody`, `blockingSection`, `humanAnswers`/)
    assert.equal(/Sync commit: `(\w+)`/.exec(skill)[1], /synced at commit (\w+)/.exec(model)[1])
  })

  test('Rule 6: the manual says what formal/rebote checks, its bounds, how to run it and that /statechart needs a non-Windows shell', () => {
    const manual = read(path.join('docs', 'manual.md'))
    const section = /### 4\.11 La verificación formal de `rebote`\n([\s\S]*?)\n## 5\./.exec(manual)?.[1]
    assert.ok(section, 'docs/manual.md has section 4.11')
    for (const text of ['un PR, un autor y una sola sesión de `main`', '`MaxHead=3`', 'pendiente, verde o roja', 'TLA2TOOLS=', 'JAVA=', '`/statechart`', 'no corre en Windows nativo', 'test/formal-rebote-replay.test.mjs']) {
      assert.ok(section.includes(text), `section 4.11 mentions ${text}`)
    }
  })
})
