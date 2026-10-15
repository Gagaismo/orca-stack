import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { checkEvidencia } from '../scripts/check-evidencia.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checker = path.join(root, 'scripts', 'check-evidencia.mjs')
const header = '| Rule | Test (exact name) | Result |\n|---|---|---|'
const row = (name, result = '') => `| Rule | \`${name}\` | ${result} |`

const withCheckout = (files, run) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-evidencia-'))
  try {
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(dir, file)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, contents)
    }
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const testFile = titles => `import { test } from 'node:test'\n${titles.map(title => `test(${JSON.stringify(title)}, () => {})`).join('\n')}\n`
const bodyFor = (...rows) => `## Evidencia\n\n${header}\n${rows.join('\n')}\n`

describe('PR evidence test-name checker', () => {
  test('Rule 1: counts each existing test-name span, including a duplicate result name', () => {
    withCheckout({ 'test/a.test.mjs': testFile(['Rule 1: x']) }, checkout => {
      const body = bodyFor(row('Rule 1: x', '`\u2714 Rule 1: x (1.2ms)`'))
      assert.deepEqual(checkEvidencia(body, checkout), { ok: true, count: 2, stdout: 'Evidencia OK: 2 nombres de test verificados\n', stderr: '' })
      const bodyFile = path.join(checkout, 'body.md')
      writeFileSync(bodyFile, body)
      const result = spawnSync(process.execPath, [checker, bodyFile], { cwd: checkout, encoding: 'utf8' })
      assert.equal(result.status, 0)
      assert.equal(result.stdout, 'Evidencia OK: 2 nombres de test verificados\n')
    })
  })

  test('Rule 2: reports a missing title and counts rows across checked tables', () => {
    const body = `## Evidencia\n${header}\n${row('Rule 1: x')}\n${row('Rule 2: x')}\n${row('Rule 3: x')}\n\n${header}\n${row('Rule 9: nope')}\n`
    withCheckout({ 'test/a.test.mjs': testFile(['Rule 1: x', 'Rule 2: x', 'Rule 3: x']) }, checkout => {
      const result = checkEvidencia(body, checkout)
      assert.equal(result.ok, false)
      assert.equal(result.stderr, 'Evidencia fila 4: no encuentro el test `Rule 9: nope` en test/ ni mods/*/tests/\n')
      const bodyFile = path.join(checkout, 'body.md')
      writeFileSync(bodyFile, body)
      const cli = spawnSync(process.execPath, [checker, bodyFile], { cwd: checkout, encoding: 'utf8' })
      assert.equal(cli.status, 1)
      assert.equal(cli.stderr, result.stderr)
    })
  })

  test('Rule 3: validates a runner line in column three independently of column two', () => {
    withCheckout({ 'test/a.test.mjs': testFile(['Rule 1: real']) }, checkout => {
      const result = checkEvidencia(bodyFor(row('Rule 1: real', '`(pass) Rule 2: missing [81.22ms]`')), checkout)
      assert.equal(result.ok, false)
      assert.match(result.stderr, /`Rule 2: missing`/)
    })
  })

  test('Rule 4: exempts command and path spans but ignores plain text', () => {
    const body = `## Evidencia\n${header}\n| Hand check | Checked by hand: \`orca-stack avisar 166 --dry-run\`; read \`src/avisar.mjs:45\`; \`npm test && npm run test:mods\`; made-up plain text | plain text |\n`
    assert.equal(checkEvidencia(body, '').ok, true)
    assert.match(checkEvidencia(body, '').stdout, /0 nombres/)
  })

  test('Rule 5: empty, absent, or none-touched evidence is a successful no-op', () => {
    for (const body of ['', null, '## Summary\nnone touched\n', '## Evidencia\n', `## Evidencia\n${header}\n`]) {
      assert.deepEqual(checkEvidencia(body, ''), { ok: true, count: 0, stdout: 'Sin ## Evidencia: nada que comprobar\n', stderr: '' })
    }
  })

  test('Rule 6: skips non-Test tables, fenced tables, and HTML-comment tables', () => {
    const body = `## Evidencia\n| Check | Result |\n|---|---|\n| CI | \`Not a test\` |\n\n\`\`\`md\n${header}\n${row('Fenced fake')}\n\`\`\`\n<!--\n${header}\n${row('Comment fake')}\n-->\n`
    assert.deepEqual(checkEvidencia(body, ''), { ok: true, count: 0, stdout: 'Sin ## Evidencia: nada que comprobar\n', stderr: '' })
    const headingInsideFence = `## Evidencia\n\`\`\`md\n## Example\n\`\`\`\n${header}\n${row('Missing title')}\n`
    assert.equal(checkEvidencia(headingInsideFence, '').stderr, 'Evidencia fila 1: no encuentro el test `Missing title` en test/ ni mods/*/tests/\n')
  })

  test('Rule 7: matches template titles and otherwise compares case exactly', () => {
    withCheckout({ 'test/a.test.mjs': "test(`${file} states: ${invariant.name}`, () => {})\ntest('Rule 1: x', () => {})\n" }, checkout => {
      assert.equal(checkEvidencia(bodyFor(row('a.md states: foo')), checkout).ok, true)
      const result = checkEvidencia(bodyFor(row('rule 1: x')), checkout)
      assert.equal(result.ok, false)
    })
  })

  test('Rule 8: a matching name outside test roots or in a non-test file does not count', () => {
    withCheckout({ 'src/only.mjs': "test('Rule 1: x', () => {})\n", 'README.md': 'Rule 1: x\n' }, checkout => {
      const result = checkEvidencia(bodyFor(row('Rule 1: x')), checkout)
      assert.equal(result.ok, false)
    })
  })

  test('Rule 9: trimmed recent PR tables pass with fixture checkouts and #187 historical names fail current source', () => {
    const fixtures = path.join(root, 'test', 'fixtures', 'evidencia-prs')
    for (const [pr, count] of [[186, 12], [189, 20], [190, 10], [191, 34]]) {
      const fixtureBody = readFileSync(path.join(fixtures, `pr-${pr}.md`), 'utf8')
      const fixtureSource = readFileSync(path.join(fixtures, `pr-${pr}.test.mjs.fixture`), 'utf8')
      withCheckout({ 'test/pr.test.mjs': fixtureSource }, checkout => {
        const result = checkEvidencia(fixtureBody, checkout)
        assert.equal(result.ok, true, `PR #${pr}`)
        assert.equal(result.count, count, `PR #${pr}`)
      })
    }
    const releaseBody = readFileSync(path.join(fixtures, 'pr-192.md'), 'utf8')
    assert.equal(checkEvidencia(releaseBody, '').ok, true)
    const oldBody = readFileSync(path.join(fixtures, 'pr-187.md'), 'utf8')
    const oldNames = [
      'Rule 1: a claude ticket brief without an authorization note forbids fan-out',
      'Rule 2: an approved claude note carries the exact one-round limit and effort',
      'Rule 3: non-claude ticket briefs reject arena and swarm even with a note',
    ]
    const existingOnly = readFileSync(path.join(fixtures, 'pr-187.test.mjs.fixture'), 'utf8')
      .split(/\r?\n/).filter(line => !oldNames.some(name => line.includes(name))).join('\n')
    const expectedMisses = oldNames.map(name => `Evidencia fila ${oldNames.indexOf(name) + 1}: no encuentro el test \`${name}\` en test/ ni mods/*/tests/`).join('\n') + '\n'
    withCheckout({ 'test/pr.test.mjs': existingOnly }, checkout => {
      const result = checkEvidencia(oldBody, checkout)
      assert.equal(result.stderr, expectedMisses)
    })
    assert.equal(checkEvidencia(oldBody, root).stderr, expectedMisses)
  })

  test('Rule 10: unescapes a literal pipe inside a table cell', () => {
    withCheckout({ 'test/a.test.mjs': testFile(['Rule | 1']) }, checkout => {
      const body = `## Evidencia\n${header}\n| Rule | \`Rule \\| 1\` | pass |\n`
      assert.equal(checkEvidencia(body, checkout).ok, true)
    })
  })

  test('Rule 11: workflow runs evidence on edited PRs and gates ci-ok fail-closed', () => {
    const workflow = readFile('.github/workflows/ci.yml')
    assert.match(workflow, /types: \[opened, synchronize, reopened, edited\]/)
    const job = workflow.split(/^  evidencia:\s*$/m)[1]?.split(/^  [\w-]+:/m)[0] ?? ''
    assert.match(job, /timeout-minutes: 5/)
    assert.match(job, /permissions:\n      contents: read\n      pull-requests: read/)
    assert.match(job, /uses: actions\/checkout@v4/)
    assert.match(workflow.match(/^  ci-ok:\n([\s\S]*)$/m)?.[1] ?? '', /^      - evidencia$/m)
    assert.equal([...job.matchAll(/if: github\.event_name == 'pull_request'/g)].length, 2)
    assert.doesNotMatch(job, /github\.event\.pull_request\.body/)
    assert.doesNotMatch(job, /continue-on-error:|\|\| true/)
  })

  test('Rule 12: edited is a body-update event that starts a fresh CI run', () => {
    assert.match(readFile('.github/workflows/ci.yml'), /pull_request:\n    types: \[opened, synchronize, reopened, edited\]/)
  })

  test('Rule 13: preserves ci-ok workflow public behavior and only adds edited trigger', () => {
    const existing = readFile('test/ci-ok.test.mjs')
    const workflow = readFile('.github/workflows/ci.yml')
    assert.match(existing, /all other workflow jobs are listed in ci-ok\.needs and it always runs/)
    assert.match(existing, /skipped or cancelled jobs fail ci-ok/)
    assert.match(workflow, /test:\n    name: \$\{\{ matrix\.os \}\} \/ Node \$\{\{ matrix\.node \}\}[\s\S]*node: \[20, 22\][\s\S]*run: npm test/)
    assert.match(workflow, /hygiene:[\s\S]*if: github\.event_name == 'pull_request'[\s\S]*uses: gitleaks\/gitleaks-action@v2/)
    assert.match(workflow, /name: CI[\s\S]*pull_request:\n    types: \[opened, synchronize, reopened, edited\]/)
  })

  test('Rule 14: body fetch cannot be ignored or allowed to pass unchecked', () => {
    const job = readFile('.github/workflows/ci.yml').split(/^  evidencia:\s*$/m)[1]?.split(/^  [\w-]+:/m)[0] ?? ''
    assert.match(job, /gh api repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR --jq \.body/)
    assert.match(job, /GH_TOKEN: \$\{\{ github\.token \}\}/)
    assert.match(job, /PR: \$\{\{ github\.event\.pull_request\.number \}\}/)
    assert.doesNotMatch(job, /continue-on-error:|\|\| true/)
  })

  test('Rule 15: declaration forms count but method calls and lookalikes do not', () => {
    withCheckout({ 'test/a.test.mjs': "/^[^ ]/.test(line)\nx.test('Rule 1: x')\ntest.skip('Rule 1: x', () => {})\n" }, checkout => {
      assert.equal(checkEvidencia(bodyFor(row('Rule 1: x')), checkout).ok, true)
      withCheckout({ 'test/a.test.mjs': "/^[^ ]/.test(line)\nx.test('Rule 1: x')\n" }, empty => {
        assert.equal(checkEvidencia(bodyFor(row('Rule 1: x')), empty).ok, false)
      })
      withCheckout({ 'test/a.test.mjs': 'const example = "test(\'Not an actual test\', () => {})"\n' }, sourceString => {
        assert.equal(checkEvidencia(bodyFor(row('Not an actual test')), sourceString).ok, false)
      })
      withCheckout({ 'test/a.test.mjs': '/no tiene la l\u00ednea "Implementador/\ntest(\'Rule 1: x\', () => {})\n' }, sourceRegex => {
        assert.equal(checkEvidencia(bodyFor(row('Rule 1: x')), sourceRegex).ok, true)
      })
    })
  })
})

function readFile(relative) {
  return readFileSync(path.join(root, relative), 'utf8')
}
