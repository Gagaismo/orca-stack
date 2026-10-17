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
const expectedFormLine = '  Un span entre backticks en la columna Test debe ser un título de test tal como fue declarado en test()/it(), sin abreviar; una verificación sin test va en texto plano.'
const missingError = (rowNum, name) => `Evidencia fila ${rowNum}: no encuentro el test \`${name}\` en test/ ni mods/*/tests/\n${expectedFormLine}\n`

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

describe('closing PR evidence requirements', () => {
  test('Rule 1: rejects the one-line PR #207 body through the checker CLI', () => {
    const pr207Body = '## Summary Add CI enforcement to validate test names in PR evidence Closes #193'
    withCheckout({}, checkout => {
      const bodyFile = path.join(checkout, 'body.md')
      writeFileSync(bodyFile, pr207Body)
      const result = spawnSync(process.execPath, [checker, bodyFile], { cwd: checkout, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.equal(result.stderr, 'Evidencia: el PR cierra #193 pero no encuentro en ## Evidencia una tabla con columna Test\n')
    })
  })

  test('Rule 2: keeps no-closing-reference bodies as successful no-ops', () => {
    withCheckout({}, checkout => {
      const bodyFile = path.join(checkout, 'body.md')
      writeFileSync(bodyFile, '## Summary A report with no issue-closing reference')
      const result = spawnSync(process.execPath, [checker, bodyFile], { cwd: checkout, encoding: 'utf8' })
      assert.equal(result.status, 0)
      assert.equal(result.stdout, 'Sin ## Evidencia: nada que comprobar\n')
    })
  })

  test('Rule 3: accepts a closing PR with a valid Test table', () => {
    withCheckout({ 'test/a.test.mjs': testFile(['Rule 1: real']) }, checkout => {
      const result = checkEvidencia(`${bodyFor(row('Rule 1: real'))}Closes #193\n`, checkout)
      assert.deepEqual(result, { ok: true, count: 1, stdout: 'Evidencia OK: 1 nombres de test verificados\n', stderr: '' })
    })
  })

  test('Rule 4: detects each GitHub closing keyword case-insensitively in one-line bodies', () => {
    for (const keyword of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']) {
      const result = checkEvidencia(`Summary without an evidence section ${keyword.toUpperCase()} #193`, '')
      assert.equal(result.ok, false, keyword)
      assert.equal(result.stderr, 'Evidencia: el PR cierra #193 pero no encuentro en ## Evidencia una tabla con columna Test\n', keyword)
    }
  })

  test('Rule 5: rejects a closing PR whose Test table has a header but no rows', () => {
    const body = `Closes #193\n\n## Evidencia\n${header}\n`
    assert.equal(checkEvidencia(body, '').stderr, 'Evidencia: el PR cierra #193 pero no encuentro en ## Evidencia una tabla con columna Test\n')
  })
})

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
      assert.equal(result.stderr, missingError(4, 'Rule 9: nope'))
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
    assert.equal(checkEvidencia(headingInsideFence, '').stderr, missingError(1, 'Missing title'))
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
    const expectedMisses = oldNames.map(name => `Evidencia fila ${oldNames.indexOf(name) + 1}: no encuentro el test \`${name}\` en test/ ni mods/*/tests/\n${expectedFormLine}`).join('\n') + '\n'
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

  test('Issue 205 Rule 1: accepts all five repository test titles in double-backtick spans', () => {
    const titles = [
      'ticket rule 4: ultracode exempts only main own arena and still announces it',
      'rule 4: ponytail-debt finds `shortcut:` and older `ponytail:` markers, not prose',
      'rule 4 negative: no text in assets/ asks for new `ponytail:` comments',
      'an indented fence (inside a list item) hides its `# comment` lines too',
      'a balanced fence inside the removed text may hold `# comment` lines',
    ]
    const body = `## Evidencia\n${header}\n${titles.map(title => `| Rule | \`\`${title}\`\` | pass |`).join('\n')}\n`
    const result = checkEvidencia(body, root)
    assert.equal(result.ok, true, result.stderr)
    assert.equal(result.count, 5)
  })

  test('Issue 210 regression: finds test titles after escaped backticks in a nested template', () => {
    const source = [
      'const a = `${[1].map(t => `x \\`${t}\\``).join("")}`',
      'test("zz plain after", () => {})',
      '',
    ].join('\n')
    withCheckout({ 'test/a.test.mjs': source }, checkout => {
      assert.equal(checkEvidencia(bodyFor(row('zz plain after')), checkout).ok, true)
    })
  })

  test('Issue 205 Rule 2: applies delimiter length and CommonMark space trimming', () => {
    withCheckout({ 'test/a.test.mjs': testFile(['a`b', 'trimmed', '  ']) }, checkout => {
      const body = `## Evidencia\n${header}\n| Rule | \`\`a\`b\`\` | pass |\n| Rule | \`\` trimmed \`\` | pass |\n| Rule | \`\`  \`\` | pass |\n| Rule | \`\`unclosed | pass |\n| Rule | \`\`no exact closer\`\`\` | pass |\n`
      const result = checkEvidencia(body, checkout)
      assert.equal(result.ok, true)
      assert.equal(result.count, 3)
    })
  })

  test('Issue 205 Rule 3: keeps existing single-backtick title matching', () => {
    withCheckout({ 'test/a.test.mjs': testFile(['Rule 1: x']) }, checkout => {
      assert.equal(checkEvidencia(bodyFor(row('Rule 1: x')), checkout).ok, true)
    })
  })

  test('Issue 205 Rule 4 and Rule 6: exempts space-free non-titles but reports non-title phrases', () => {
    const body = `## Evidencia\n${header}\n| Rule 5 | sin test: lo verifiqu\u00E9 con \`--dry-run\` sobre \`ci-ok\` | \u2714 |\n| Rule 6 | \`ci ok\` | \u2714 |\n`
    const result = checkEvidencia(body, '')
    assert.equal(result.ok, false)
    assert.equal(result.stderr, missingError(2, 'ci ok'))
  })

  test('Issue 205 Rule 5 and Rule 8: keeps the exact CLI error, message, and exit code', () => {
    withCheckout({ 'test/a.test.mjs': testFile([]) }, checkout => {
      const bodyFile = path.join(checkout, 'body.md')
      writeFileSync(bodyFile, bodyFor('|| `Rule 99: no existe` | pass |'))
      const result = spawnSync(process.execPath, [checker, bodyFile], { cwd: checkout, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.equal(result.stderr, missingError(1, 'Rule 99: no existe'))
    })
  })

  test('Issue 205 Rule 7: still rejects abbreviated runner test names', () => {
    withCheckout({ 'test/a.test.mjs': testFile(['Rule 1: real']) }, checkout => {
      const body = bodyFor(row('Rule 1: real', '`\u2714 \u2026 (0.4685ms)`'))
      assert.equal(checkEvidencia(body, checkout).ok, false)
    })
  })

  describe('issue #249: describe paths, clearer test-name errors, brief and docs', () => {
    test('Rule 3: describe path accepted by its last segment, exact match of whole span tried first', () => {
      withCheckout({
        'test/a.test.mjs': testFile([
          'Rule 1: fast-forwards a clean worktree',
          'suite > test title with > inside',
        ]),
      }, checkout => {
        // Describe path with decoration prefix passes when last segment is declared title
        const pathSpan = 'rebote > issue 241: a worktree behind the PR head > Rule 1: fast-forwards a clean worktree'
        const body = bodyFor(row(pathSpan))
        const res = checkEvidencia(body, checkout)
        assert.equal(res.ok, true, res.stderr)
        assert.equal(res.count, 1)

        // Exact match of whole span containing ' > ' passes
        const exactSpan = 'suite > test title with > inside'
        const bodyExact = bodyFor(row(exactSpan))
        const resExact = checkEvidencia(bodyExact, checkout)
        assert.equal(resExact.ok, true, resExact.stderr)
        assert.equal(resExact.count, 1)
      })
    })

    test('Rule 4: describe path with an unknown test fails and names the last segment, not the whole span', () => {
      withCheckout({ 'test/a.test.mjs': testFile([]) }, checkout => {
        const body = bodyFor(row('rebote > Rule 99: not a test'))
        const res = checkEvidencia(body, checkout)
        assert.equal(res.ok, false)
        assert.match(res.stderr, /Evidencia fila 1: no encuentro el test `Rule 99: not a test` en test\/ ni mods\/\*\/tests\//)
        assert.doesNotMatch(res.stderr, /rebote > Rule 99: not a test/)
      })
    })

    test('Rule 5: errors state the expected form and suggest uniquely matching title on ellipsis', () => {
      const titles = [
        'Rule 8: despachar renders a ticket brief for every agent; the rebote and revisar briefs change only in the fanoutInstructions sentence',
        'Rule 10: unique title',
        'Ambiguous: alpha',
        'Ambiguous: beta',
      ]
      withCheckout({ 'test/a.test.mjs': testFile(titles) }, checkout => {
        // Single candidate matching prefix of 'Rule 8: …' (unicode ellipsis) -> suggests title
        const bodyUnicode = bodyFor(row('Rule 8: …'))
        const resUnicode = checkEvidencia(bodyUnicode, checkout)
        assert.equal(resUnicode.ok, false)
        assert.match(resUnicode.stderr, /Un span entre backticks en la columna Test debe ser un título de test tal como fue declarado en test\(\)\/it\(\), sin abreviar; una verificación sin test va en texto plano\./)
        assert.match(resUnicode.stderr, /¿Quisiste decir `Rule 8: despachar renders a ticket brief for every agent; the rebote and revisar briefs change only in the fanoutInstructions sentence`\?/)

        // Three dots '...' also suggests unique title
        const bodyDots = bodyFor(row('Rule 10: ...'))
        const resDots = checkEvidencia(bodyDots, checkout)
        assert.equal(resDots.ok, false)
        assert.match(resDots.stderr, /¿Quisiste decir `Rule 10: unique title`\?/)

        // Multiple candidates starting with 'Ambiguous: ' -> no suggestion
        const bodyMulti = bodyFor(row('Ambiguous: …'))
        const resMulti = checkEvidencia(bodyMulti, checkout)
        assert.equal(resMulti.ok, false)
        assert.doesNotMatch(resMulti.stderr, /¿Quisiste decir/)

        // Zero candidates starting with 'Nonexistent: ' -> no suggestion
        const bodyZero = bodyFor(row('Nonexistent: …'))
        const resZero = checkEvidencia(bodyZero, checkout)
        assert.equal(resZero.ok, false)
        assert.doesNotMatch(resZero.stderr, /¿Quisiste decir/)

        // Non-ellipsis unknown name -> states expected form without suggestion
        const bodyNormal = bodyFor(row('Plain unknown'))
        const resNormal = checkEvidencia(bodyNormal, checkout)
        assert.equal(resNormal.ok, false)
        assert.match(resNormal.stderr, /Un span entre backticks en la columna Test debe ser un título de test tal como fue declarado en test\(\)\/it\(\), sin abreviar; una verificación sin test va en texto plano\./)
        assert.doesNotMatch(resNormal.stderr, /¿Quisiste decir/)
      })
    })

    test('Rule 6: brief-ticket.md replaces Test column guidance with exact required wording', () => {
      const brief = readFileSync(path.join(root, 'assets', 'stack', 'brief-ticket.md'), 'utf8')
      assert.ok(brief.includes('the test title exactly as declared in `test()`/`it()`, without the describe path or abbreviations; only test names go in backticks in the Test column; a verification without a test (a command, a manual check) is written as plain text, without backticks.'))
      assert.doesNotMatch(brief, /the exact test name and passing line, or how it was verified when there is no test/)
    })

    test('Rule 7: what passes today keeps passing', () => {
      withCheckout({
        'test/a.test.mjs': "test('bare declared title', () => {})\ntest(`${file} states: ${invariant.name}`, () => {})\n",
      }, checkout => {
        // 1. Bare declared title
        assert.equal(checkEvidencia(bodyFor(row('bare declared title')), checkout).ok, true)
        // 2. Template-literal pattern
        assert.equal(checkEvidencia(bodyFor(row('a.md states: foo')), checkout).ok, true)
        // 3. Backticked command in COMMANDS
        assert.equal(checkEvidencia(bodyFor('| Check | `npm test && npm run test:mods` | pass |'), checkout).ok, true)
        // 4. Single-word span
        assert.equal(checkEvidencia(bodyFor('| Check | `ci-ok` | pass |'), checkout).ok, true)
        // 5. Runner line in Result column
        assert.equal(checkEvidencia(bodyFor(row('bare declared title', '`✔ bare declared title (1.5ms)`')), checkout).ok, true)
      })
    })

    test('Rule 8: docs describe cuerpoPR and accepted forms in README, manual and guia-setup', () => {
      const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
      assert.match(readme, /cuerpoPR/)
      assert.match(readme, /describe paths/)

      const manual = readFileSync(path.join(root, 'docs', 'manual.md'), 'utf8')
      assert.match(manual, /cuerpoPR/)

      const guia = readFileSync(path.join(root, 'docs', 'guia-setup.md'), 'utf8')
      assert.match(guia, /cuerpoPR/)
    })

    test('PRESERVE touched public entries in check-evidencia: checkEvidencia and CLI interface', () => {
      withCheckout({ 'test/a.test.mjs': testFile(['Rule 1: real']) }, checkout => {
        // checkEvidencia return object shape
        const valid = checkEvidencia(`${bodyFor(row('Rule 1: real'))}Closes #193\n`, checkout)
        assert.equal(valid.ok, true)
        assert.equal(valid.count, 1)
        assert.equal(typeof valid.stdout, 'string')
        assert.equal(typeof valid.stderr, 'string')

        // CLI interface exit 0 on pass
        const bodyFile = path.join(checkout, 'body.md')
        writeFileSync(bodyFile, `${bodyFor(row('Rule 1: real'))}Closes #193\n`)
        const cliPass = spawnSync(process.execPath, [checker, bodyFile], { cwd: checkout, encoding: 'utf8' })
        assert.equal(cliPass.status, 0)

        // CLI interface exit 1 on fail
        const failBody = path.join(checkout, 'fail.md')
        writeFileSync(failBody, `${bodyFor(row('Unknown test'))}Closes #193\n`)
        const cliFail = spawnSync(process.execPath, [checker, failBody], { cwd: checkout, encoding: 'utf8' })
        assert.equal(cliFail.status, 1)
      })
    })
  })
})

function readFile(relative) {
  return readFileSync(path.join(root, relative), 'utf8')
}
