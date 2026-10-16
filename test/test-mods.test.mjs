import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = process.cwd()

const withTempDir = fn => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-stack-test-mods-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const makeClaudeStub = dir => {
  const log = path.join(dir, 'calls.txt')
  const name = process.platform === 'win32' ? 'claude.cmd' : 'claude'
  const file = path.join(dir, name)
  const script = process.platform === 'win32'
    ? '@echo off\r\nif "%1"=="--version" exit /b 0\r\necho %~nx3>>"%CLAUDE_LOG%"\r\nif /I "%~nx3"=="%FAIL_MOD%" exit /b 1\r\nexit /b 0\r\n'
    : '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nmod=${3##*/}\nprintf "%s\\n" "$mod" >> "$CLAUDE_LOG"\n[ "$mod" != "$FAIL_MOD" ]\n'
  writeFileSync(file, script)
  if (process.platform !== 'win32') chmodSync(file, 0o755)
  return { log, file }
}

const isolatedEnv = (dir, overrides = {}) => {
  const env = { ...process.env, PATH: dir, ...overrides }
  delete env.CI
  return env
}

test('CI without Claude fails with a clear stderr message and no stdout', () => {
  withTempDir(dir => {
    const result = spawnSync(process.execPath, ['scripts/test-mods.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...isolatedEnv(dir), CI: 'true' },
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'claude no est\u00e1 instalado: en CI los tests de los mods no pueden omitirse.\n')
  })
})

test('without CI, missing Claude keeps the exact skip message', () => {
  withTempDir(dir => {
    const result = spawnSync(process.execPath, ['scripts/test-mods.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: isolatedEnv(dir),
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'claude no est\u00e1 instalado: se omiten los tests de los mods.\n')
    assert.equal(result.stderr, '')
  })
})

test('CI is strict: only true and 1 fail when Claude is missing', () => {
  withTempDir(dir => {
    for (const ci of ['true', '1']) {
      const result = spawnSync(process.execPath, ['scripts/test-mods.mjs'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...isolatedEnv(dir), CI: ci },
      })
      assert.equal(result.status, 1, `CI=${ci}`)
    }
    for (const ci of ['false', '0', '']) {
      const result = spawnSync(process.execPath, ['scripts/test-mods.mjs'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...isolatedEnv(dir), CI: ci },
      })
      assert.equal(result.status, 0, `CI=${ci}`)
    }
  })
})

test('Claude stubs run every mod and propagate any mod failure', () => {
  withTempDir(dir => {
    const { log } = makeClaudeStub(dir)
    const mods = readdirSync(path.join(root, 'mods')).sort()
    const ok = spawnSync(process.execPath, ['scripts/test-mods.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: isolatedEnv(dir, { CLAUDE_LOG: log, FAIL_MOD: '' }),
    })
    assert.equal(ok.status, 0, ok.stderr)
    assert.deepEqual(readFileSync(log, 'utf8').trim().split(/\r?\n/).sort(), mods)

    writeFileSync(log, '')
    const failed = spawnSync(process.execPath, ['scripts/test-mods.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: isolatedEnv(dir, { CLAUDE_LOG: log, FAIL_MOD: mods[0] }),
    })
    assert.equal(failed.status, 1)
    assert.deepEqual(readFileSync(log, 'utf8').trim().split(/\r?\n/).sort(), mods)
  })
})

test('mod CI is either required with a bounded pinned runner or documented as a local merge check', () => {
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  const jobStart = workflow.indexOf('\n  mods:\n')
  const fallback = agents.includes('main runs `npm run test:mods` on the PR head commit before merging')

  if (jobStart === -1) {
    assert.equal(fallback, true)
    return
  }

  const jobsEnd = workflow.indexOf('\n  ci-ok:', jobStart)
  const job = workflow.slice(jobStart, jobsEnd)
  const ciOk = workflow.slice(workflow.indexOf('\n  ci-ok:'))
  assert.equal(fallback, false)
  assert.match(job, /runs-on: windows-latest/)
  assert.match(job, /timeout-minutes: 10/)
  assert.match(job, /@anthropic-ai\/claude-code@2\.1\.300/)
  assert.doesNotMatch(job, /^    if:/m)
  assert.doesNotMatch(job, /paths:/)
  assert.match(ciOk, /^      - mods$/m)
})
