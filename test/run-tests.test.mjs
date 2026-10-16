import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { checkEvidencia } from '../scripts/check-evidencia.mjs'
import { extractFailureBlocks } from '../scripts/run-tests.mjs'

const root = process.cwd()

const withTempDir = fn => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-stack-run-tests-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const cleanEnv = (overrides = {}) => {
  const env = { ...process.env, ...overrides }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  return env
}

const setupWorkspace = (dir, { pass = true, fail = false } = {}) => {
  mkdirSync(path.join(dir, 'scripts'))
  mkdirSync(path.join(dir, 'test'))
  mkdirSync(path.join(dir, 'mods', 'sample-mod', 'tests'), { recursive: true })

  copyFileSync(path.join(root, 'scripts', 'run-tests.mjs'), path.join(dir, 'scripts', 'run-tests.mjs'))

  if (pass) {
    writeFileSync(
      path.join(dir, 'test', 'alpha.test.mjs'),
      `import test from 'node:test'; test('alpha passing unit', () => {});`
    )
  }
  if (fail) {
    writeFileSync(
      path.join(dir, 'test', 'beta-failing.test.mjs'),
      `import test from 'node:test'; test('beta failing unit', () => { throw new Error('simulated error in beta'); });`
    )
  }
  writeFileSync(
    path.join(dir, 'mods', 'sample-mod', 'tests', 'mod.test.ts'),
    `export const ignored = true;`
  )
}

test('Rule 1: npm test runs with dot to stdout and spec to npm-test.log naming the log on the last line; README documents it and concurrent overwrite', () => {
  withTempDir(dir => {
    setupWorkspace(dir)
    const logPath = path.join(dir, 'npm-test.log')

    const first = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-tests.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: cleanEnv(),
    })
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /\./)
    const stdoutLines = first.stdout.trim().split(/\r?\n/)
    assert.equal(stdoutLines.at(-1), 'Detalle de cada test en npm-test.log')

    const firstLog = readFileSync(logPath, 'utf8')
    assert.match(firstLog, /✔\s+alpha passing unit/)

    // Overwrite check: previous content is replaced, not appended
    writeFileSync(logPath, 'STALE LOG CONTENT BEFORE RUN\n')
    const second = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-tests.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: cleanEnv(),
    })
    assert.equal(second.status, 0, second.stderr)
    const secondLog = readFileSync(logPath, 'utf8')
    assert.equal(secondLog.includes('STALE LOG CONTENT'), false)
    assert.match(secondLog, /✔\s+alpha passing unit/)
  })

  // Documentation checks in README.md Desarrollo
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
  assert.match(readme, /npm-test\.log/)
  assert.match(readme, /Detalle de cada test en npm-test\.log/)
  assert.match(readme, /sobreescriben el archivo mutuamente/)
})

test('Rule 2: npm-test.log lines pass check-evidencia using real runnerTitles from the run', () => {
  withTempDir(dir => {
    setupWorkspace(dir)
    const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-tests.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: cleanEnv(),
    })
    assert.equal(run.status, 0, run.stderr)

    const logPath = path.join(dir, 'npm-test.log')
    const logContent = readFileSync(logPath, 'utf8')
    const passLine = logContent
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.startsWith('✔') && line.includes('alpha passing unit'))
    assert.ok(passLine, `Expected pass line in log, got:\n${logContent}`)

    const body = [
      '## Summary',
      'Test summary',
      '',
      '## Evidencia',
      '| Rule | Test | Result |',
      '|---|---|---|',
      `| Rule 2 | \`alpha passing unit\` | \`${passLine}\` |`,
      '',
      'Implementador: agy',
      'Closes #227',
    ].join('\n')

    const result = checkEvidencia(body, dir)
    assert.equal(result.ok, true, result.stderr)
    assert.equal(result.count, 2)
  })
})

test('Rule 3: failing test output shows name and error on stdout, falling back to npm-test.log if dot reporter omits them', () => {
  withTempDir(dir => {
    setupWorkspace(dir, { pass: true, fail: true })
    const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-tests.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: cleanEnv(),
    })
    assert.equal(run.status, 1)
    assert.match(run.stdout, /beta failing unit/)
    assert.match(run.stdout, /simulated error in beta/)
    const lines = run.stdout.trim().split(/\r?\n/)
    assert.equal(lines.at(-1), 'Detalle de cada test en npm-test.log')
  })

  // Unit tests for extractFailureBlocks across Node 20 and 22/26 formats
  const node22Format = [
    '✔ alpha (1.0ms)',
    '✖ beta (2.0ms)',
    'ℹ tests 2',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at beta.test.mjs:1:1',
    '✖ beta (2.0ms)',
    '  Error: boom at line 1',
  ].join('\n')
  assert.equal(
    extractFailureBlocks(node22Format),
    ['✖ failing tests:', '', 'test at beta.test.mjs:1:1', '✖ beta (2.0ms)', '  Error: boom at line 1'].join('\n')
  )

  const node20Format = [
    '  ✔ alpha (1.0ms)',
    '  ✖ beta (2.0ms)',
    '  Error: boom inline',
    '      at stack trace',
    '  ℹ tests 2',
    '  ℹ fail 1',
  ].join('\n')
  assert.equal(
    extractFailureBlocks(node20Format),
    ['  ✖ beta (2.0ms)', '  Error: boom inline', '      at stack trace'].join('\n')
  )

  assert.equal(extractFailureBlocks(''), '')
  assert.equal(extractFailureBlocks('✔ alpha (1.0ms)\nℹ tests 1'), '')
})

test('Rule 4: unwritable npm-test.log fails with a message naming the file', () => {
  withTempDir(dir => {
    setupWorkspace(dir)
    const logPath = path.join(dir, 'npm-test.log')
    writeFileSync(logPath, 'read only')
    chmodSync(logPath, 0o444)
    try {
      const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-tests.mjs')], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv(),
      })
      assert.equal(run.status, 1)
      assert.match(run.stderr, /npm-test\.log/)
    } finally {
      chmodSync(logPath, 0o666)
    }
  })
})

test('Rule 5: keeps sorted test/*.test.mjs file list without mods tests and preserves verify command in package.json', () => {
  withTempDir(dir => {
    mkdirSync(path.join(dir, 'scripts'))
    mkdirSync(path.join(dir, 'test'))
    mkdirSync(path.join(dir, 'mods', 'sample', 'tests'), { recursive: true })

    copyFileSync(path.join(root, 'scripts', 'run-tests.mjs'), path.join(dir, 'scripts', 'run-tests.mjs'))

    writeFileSync(path.join(dir, 'test', 'z-second.test.mjs'), `import test from 'node:test'; test('second', () => {});`)
    writeFileSync(path.join(dir, 'test', 'a-first.test.mjs'), `import test from 'node:test'; test('first', () => {});`)
    writeFileSync(path.join(dir, 'test', 'notes.txt'), 'not a test')
    writeFileSync(path.join(dir, 'mods', 'sample', 'tests', 'sample.test.ts'), 'export default {}')

    const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'run-tests.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: cleanEnv(),
    })
    assert.equal(run.status, 0, run.stderr)

    const log = readFileSync(path.join(dir, 'npm-test.log'), 'utf8')
    assert.match(log, /first/)
    assert.match(log, /second/)
    assert.doesNotMatch(log, /notes/)
    assert.doesNotMatch(log, /sample\.test/)
    assert.ok(log.indexOf('first') < log.indexOf('second'), 'Files must run in sorted alphabetical order')
  })

  // Preserved public entry in package.json
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs')
  assert.equal(pkg.scripts.verify, 'npm test && npm run test:mods')
})
