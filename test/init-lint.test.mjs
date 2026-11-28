import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { initCommand } from '../src/init.mjs'
import { languageOf } from '../src/lint-graph.mjs'
import { ROOT, backups, cleanup, cli, git, read, snapshot, tempDir, write } from './helpers.mjs'

const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const LINT_DEFAULTS = { enabled: true, comentarios: { alcance: 'repo' } }
const WORKFLOW = '.github/workflows/orca-stack-lint.yml'
const HOOK = '.githooks/pre-push'
const BASELINE = '.orca-stack-baseline.json'
const HOW_TO_ENABLE = 'git config core.hooksPath .githooks'

let home
let repo
beforeEach(() => {
  home = tempDir('home')
  repo = path.join(tempDir('repo'), 'proyecto')
  write(path.join(repo, 'README.md'), '# proyecto\n')
  git(repo, 'init', '-q', '-b', 'main')
})
afterEach(() => {
  cleanup(home)
  cleanup(path.dirname(repo))
})

const run = (...args) => cli(home, ['init', ...args], { cwd: repo })
const file = rel => path.join(repo, rel)
const commitAll = (target = repo) => {
  assert.equal(git(target, 'add', '-A').status, 0)
  const result = git(target, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init')
  assert.equal(result.status, 0, result.stderr)
}
const hooksPath = () => git(repo, 'config', '--get', 'core.hooksPath')
const tableOf = text => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.indexOf('| Type | Action |')
  assert.notEqual(start, -1, 'no comment rule table')
  let end = start
  while (lines[end + 1]?.startsWith('|')) end += 1
  return lines.slice(start, end + 1).join('\n')
}

// #424: in-process, so a test can answer the core.hooksPath question.
const initWith = async (t, answer) => {
  const out = []
  const asked = []
  t.mock.method(console, 'log', (...args) => out.push(args.join(' ')))
  t.mock.method(console, 'error', (...args) => out.push(args.join(' ')))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-none'), GIT_CONFIG_NOSYSTEM: '1' }
  const status = await initCommand({ dryRun: false }, repo, {
    home,
    env,
    ask: async question => {
      asked.push(question)
      return answer
    },
  })
  t.mock.restoreAll()
  return { status, out: out.join('\n'), asked }
}

describe('init installs the lint (#424)', () => {
  test('R1: the lint key init writes turns the lint on with the comment rule over the whole repo, also in an existing .orca-stack.json', () => {
    const fresh = run()
    assert.equal(fresh.status, 0, fresh.out)
    assert.deepEqual(JSON.parse(read(file('.orca-stack.json'))), { version: 1, lint: LINT_DEFAULTS })
    assert.match(fresh.out, /^agrego la clave lint a \.orca-stack\.json$/m)

    cleanup(path.dirname(repo))
    write(path.join(repo, 'README.md'), '# proyecto\n')
    git(repo, 'init', '-q', '-b', 'main')
    write(file('.orca-stack.json'), '{\r\n    "version": 1,\r\n    "ramaBase": "dev"\r\n}\r\n')
    const existing = run()
    assert.equal(existing.status, 0, existing.out)
    assert.equal(
      read(file('.orca-stack.json')),
      '{\r\n    "version": 1,\r\n    "ramaBase": "dev",\r\n    "lint": {\r\n        "enabled": true,\r\n        "comentarios": {\r\n            "alcance": "repo"\r\n        }\r\n    }\r\n}\r\n',
    )
    assert.equal(backups(home).filter(name => name.endsWith('.orca-stack.json')).length, 1)
  })

  test('R2: a repo with its own lint key ({"enabled": false}) keeps .orca-stack.json byte for byte and init says it skipped it', () => {
    const own = '{\n  "version": 1,\n  "lint": { "enabled": false }\n}\n'
    write(file('.orca-stack.json'), own)
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.equal(read(file('.orca-stack.json')), own)
    assert.match(result.out, /^\.orca-stack\.json: ya tiene una clave lint propia, no se toca$/m)
    assert.match(result.out, /^\.orca-stack-baseline\.json: no se crea, el lint está apagado \(lint\.enabled es false\)$/m)
    assert.equal(existsSync(file(BASELINE)), false)
    assert.deepEqual(backups(home), [])
  })

  test('R2: a repo whose own workflow has a job orca-stack-lint keeps it byte for byte and gets no second workflow', () => {
    const own = 'name: CI\non: [push]\njobs:\n  orca-stack-lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo propio\n'
    write(file('.github/workflows/ci.yml'), own)
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.equal(read(file('.github/workflows/ci.yml')), own)
    assert.equal(existsSync(file(WORKFLOW)), false)
    assert.match(result.out, /^\.github\/workflows\/orca-stack-lint\.yml: no se crea, \.github\/workflows\/ci\.yml ya tiene un job orca-stack-lint$/m)
  })

  test('R2: a repo whose own workflow already runs the lint in a job of another name keeps it byte for byte and gets no second workflow', () => {
    for (const command of ['node bin/orca-stack.mjs lint', 'npx orca-stack lint', 'npx -y orca-stack@0.21.0 lint']) {
      const own = `name: CI\r\non: [push]\r\njobs:\r\n  lint:\r\n    name: orca-stack lint\r\n    runs-on: ubuntu-latest\r\n    steps:\r\n      - uses: actions/checkout@v4\r\n      - name: Lint against the Baseline\r\n        run: ${command}\r\n`
      write(file('.github/workflows/ci.yml'), own)
      const result = run()
      assert.equal(result.status, 0, result.out)
      assert.equal(read(file('.github/workflows/ci.yml')), own)
      assert.equal(existsSync(file(WORKFLOW)), false)
      assert.match(result.out, /^\.github\/workflows\/orca-stack-lint\.yml: no se crea, \.github\/workflows\/ci\.yml ya corre orca-stack lint$/m)
    }
  })

  test('R2: an existing workflow file of the same name and an existing hook file are left byte for byte', () => {
    write(file(WORKFLOW), 'name: mío\r\n')
    write(file(HOOK), '#!/bin/sh\necho mi hook\n')
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.equal(read(file(WORKFLOW)), 'name: mío\r\n')
    assert.equal(read(file(HOOK)), '#!/bin/sh\necho mi hook\n')
    assert.match(result.out, /^\.github\/workflows\/orca-stack-lint\.yml: ya existe, no se toca$/m)
    assert.match(result.out, /^\.githooks\/pre-push: ya existe, no se toca$/m)
    assert.deepEqual(backups(home), [])
  })

  test('R2: an existing CODING_STANDARDS.md and an existing Baseline are left byte for byte and reported as skipped', () => {
    const standards = `# Mis reglas\n\n${tableOf(read(path.join(ROOT, 'CODING_STANDARDS.md')))}\n\nMás reglas propias.\n`
    const baseline = '{"version":1,"entries":[]}\n'
    write(file('CODING_STANDARDS.md'), standards)
    write(file(BASELINE), baseline)
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.equal(read(file('CODING_STANDARDS.md')), standards)
    assert.equal(read(file(BASELINE)), baseline)
    assert.match(result.out, /^CODING_STANDARDS\.md: ya existe, no se toca$/m)
    assert.match(result.out, /^\.orca-stack-baseline\.json: ya existe, no se toca$/m)
    assert.doesNotMatch(result.out, /regla de los comentarios/)
    assert.deepEqual(backups(home), [])
  })

  test('R2: init writes the five pieces in a fresh repo and reports each one as written', () => {
    const result = run()
    assert.equal(result.status, 0, result.out)
    for (const line of ['agrego la clave lint a .orca-stack.json', `creo ${WORKFLOW}`, `creo ${HOOK}`, 'creo CODING_STANDARDS.md', `creo ${BASELINE} (0 entradas)`]) {
      assert.ok(result.out.split(/\r?\n/).includes(line), `missing "${line}" in:\n${result.out}`)
    }
    const workflow = read(file(WORKFLOW))
    assert.match(workflow, /^jobs:\n {2}orca-stack-lint:\n/m)
    assert.match(workflow, /^ {8}run: npx --yes github:Gagaismo\/orca-stack#v\d+\.\d+\.\d+ lint$/m)
    assert.ok(workflow.includes(`github:Gagaismo/orca-stack#v${VERSION} lint`))
    const hook = read(file(HOOK))
    assert.match(hook, /^#!\/bin\/sh\n/)
    assert.match(hook, /#424/)
    assert.match(hook, /orca-stack lint/)
    if (process.platform !== 'win32') assert.ok(statSync(file(HOOK)).mode & 0o100, 'the hook is executable')
    assert.deepEqual(JSON.parse(read(file(BASELINE))), { version: 1, entries: [] })
  })

  test('R3: the seeded CODING_STANDARDS.md carries the comment rule table verbatim; an existing file without it is not edited and init reports the missing rule', () => {
    const ownTable = tableOf(read(path.join(ROOT, 'CODING_STANDARDS.md')))
    assert.equal(tableOf(read(path.join(ROOT, 'assets', 'lint', 'CODING_STANDARDS.md'))), ownTable)
    assert.equal(run().status, 0)
    assert.equal(read(file('CODING_STANDARDS.md')), read(path.join(ROOT, 'assets', 'lint', 'CODING_STANDARDS.md')))
    assert.ok(read(file('CODING_STANDARDS.md')).includes(`${ownTable}\n`))

    cleanup(path.dirname(repo))
    write(path.join(repo, 'README.md'), '# proyecto\n')
    git(repo, 'init', '-q', '-b', 'main')
    write(file('CODING_STANDARDS.md'), '# Reglas\r\n\r\nSin tabla.\r\n')
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.equal(read(file('CODING_STANDARDS.md')), '# Reglas\r\n\r\nSin tabla.\r\n')
    assert.match(result.out, /^⚠ CODING_STANDARDS\.md: ya existe, no se toca, y le falta la regla de los comentarios \(la tabla \| Type \| Action \|\): agregala a mano$/m)
  })

  test('R4: non-interactive without the flag, init changes no core.hooksPath and prints how to enable the hook', () => {
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.equal(hooksPath().status, 1, 'core.hooksPath stays unset')
    assert.match(result.out, new RegExp(`^core\\.hooksPath: no lo cambié; para activar el hook corré \`${HOW_TO_ENABLE}\`$`, 'm'))
  })

  test('R4: --activar-hook sets core.hooksPath to .githooks, and a second run finds it already set', () => {
    const result = run('--activar-hook')
    assert.equal(result.status, 0, result.out)
    assert.equal(hooksPath().stdout.trim(), '.githooks')
    assert.match(result.out, /^core\.hooksPath: lo apunté a \.githooks$/m)
    const again = run()
    assert.equal(again.status, 0, again.out)
    assert.match(again.out, /^core\.hooksPath: ya apunta a \.githooks$/m)
  })

  test('R4: a core.hooksPath already pointing elsewhere is never overwritten, even with --activar-hook', () => {
    git(repo, 'config', 'core.hooksPath', '.husky')
    const result = run('--activar-hook')
    assert.equal(result.status, 0, result.out)
    assert.equal(hooksPath().stdout.trim(), '.husky')
    assert.match(result.out, /^core\.hooksPath: ya apunta a \.husky, no lo cambio; para usar el hook, llamá a \.githooks\/pre-push desde tus hooks$/m)
  })

  test('R4: active hooks in .git/hooks keep core.hooksPath unset, even with --activar-hook or interactive, and init says how to call the hook', async t => {
    const hooksDir = path.join(repo, '.git', 'hooks')
    write(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho propio\n')
    const before = snapshot(hooksDir)
    const expected = /^core\.hooksPath: no lo cambio, el repo ya tiene hooks propios en \.git\/hooks \(pre-commit\); para usar el hook, llamá a \.githooks\/pre-push desde tu \.git\/hooks\/pre-push$/m
    const flagged = run('--activar-hook')
    assert.equal(flagged.status, 0, flagged.out)
    assert.match(flagged.out, expected)
    assert.equal(hooksPath().status, 1, 'core.hooksPath stays unset')
    assert.deepEqual(snapshot(hooksDir), before)

    const asked = await initWith(t, 's')
    assert.equal(asked.status, 0, asked.out)
    assert.deepEqual(asked.asked, [])
    assert.match(asked.out, expected)
    assert.equal(hooksPath().status, 1)
    assert.deepEqual(snapshot(hooksDir), before)
  })

  test('R4: interactive, init asks before setting core.hooksPath; yes sets it', async t => {
    const result = await initWith(t, 's')
    assert.equal(result.status, 0, result.out)
    assert.equal(result.asked.length, 1)
    assert.match(result.asked[0], /core\.hooksPath \.githooks/)
    assert.equal(hooksPath().stdout.trim(), '.githooks')
  })

  test('R4: interactive, a declined question changes nothing and prints how to enable the hook', async t => {
    const result = await initWith(t, 'n')
    assert.equal(result.status, 0, result.out)
    assert.equal(result.asked.length, 1)
    assert.equal(hooksPath().status, 1)
    assert.ok(result.out.includes(HOW_TO_ENABLE), result.out)
  })

  test('R5: the seeded Baseline makes orca-stack lint exit 0 after committing init output, counting the files init added', () => {
    for (let i = 1; i <= 9; i += 1) write(file(`f${i}.txt`), `${i}\n`)
    write(file('big.txt'), 'x\n'.repeat(2001))
    write(file('src/a.mjs'), '// TODO fix this later\nexport const a = 1\n')
    git(repo, 'add', '-A')
    const result = run()
    assert.equal(result.status, 0, result.out)
    const rules = JSON.parse(read(file(BASELINE))).entries.map(entry => `${entry.rule} ${entry.file}`)
    assert.deepEqual(rules.sort(), ['comment-excuse src/a.mjs', 'long-file big.txt', 'wide-directory ./'])
    commitAll()
    // #424: the workflow runs the lint through npx from GitHub; this runs the same lint from this checkout.
    const lint = cli(home, ['lint'], { cwd: repo })
    assert.equal(lint.status, 0, lint.out)
    assert.match(lint.stdout, /^lint OK: ninguna violación nueva ni entrada vencida \(3 en la Baseline\)$/m)
  })

  test('R6: running init twice changes nothing the second time and reports every piece as skipped', () => {
    assert.equal(run('--activar-hook').status, 0)
    const before = snapshot(repo)
    const second = run('--activar-hook')
    assert.equal(second.status, 0, second.out)
    assert.deepEqual(snapshot(repo), before)
    assert.deepEqual(backups(home), [])
    for (const line of ['.orca-stack.json: ya tiene una clave lint propia, no se toca', `${WORKFLOW}: ya existe, no se toca`, `${HOOK}: ya existe, no se toca`, 'CODING_STANDARDS.md: ya existe, no se toca', `${BASELINE}: ya existe, no se toca`, 'core.hooksPath: ya apunta a .githooks']) {
      assert.ok(second.out.split(/\r?\n/).includes(line), `missing "${line}" in:\n${second.out}`)
    }
    assert.doesNotMatch(second.out, /^(creo|agrego) /m)
  })

  test('R7: a write that fails between pieces is reported, the others are written, init exits non-zero, and a re-run completes the rest without duplicating', () => {
    write(file('.github'), 'a file in the way\n')
    const first = run()
    assert.equal(first.status, 1, first.out)
    assert.match(first.out, /^✖ \.github\/workflows\/orca-stack-lint\.yml: no se pudo escribir \(.+\)$/m)
    assert.match(first.out, /^✖ lint: no se escribió \.github\/workflows\/orca-stack-lint\.yml; arreglá el problema y volvé a correr orca-stack init, que completa lo que falta sin duplicar nada$/m)
    for (const rel of [HOOK, 'CODING_STANDARDS.md', BASELINE]) assert.ok(existsSync(file(rel)), rel)
    const written = Object.fromEntries([HOOK, 'CODING_STANDARDS.md', BASELINE, '.orca-stack.json'].map(rel => [rel, read(file(rel))]))

    cleanup(file('.github'))
    const second = run()
    assert.equal(second.status, 0, second.out)
    assert.match(second.out, /^creo \.github\/workflows\/orca-stack-lint\.yml$/m)
    for (const [rel, text] of Object.entries(written)) assert.equal(read(file(rel)), text, rel)
    assert.equal((read(file('.orca-stack.json')).match(/"lint"/g) ?? []).length, 1)
  })

  describe('S24: ast-grep unavailable skips the Baseline and the workflow that needs it', () => {
    const missingDir = () => path.join(home, 'no-ast-grep')
    const missingBinary = () => path.join(missingDir(), 'ast-grep')
    const withoutAstGrep = (...args) => cli(home, ['init', ...args], { cwd: repo, env: { ORCA_STACK_AST_GREP: missingBinary() } })
    const skipBaseline = reason => `⚠ ${BASELINE}: no se crea, ast-grep no está disponible (${reason}); sembrala con \`orca-stack lint --sembrar\` donde haya ast-grep y volvé a correr orca-stack init, o apagá el lint con "lint": {"enabled": false} en .orca-stack.json`
    const skipWorkflow = `${WORKFLOW}: no se crea, falta ${BASELINE} y sin ella el job fallaría con las violaciones que ya hay; otra corrida de orca-stack init lo crea cuando esté la Baseline`
    const lines = out => out.split(/\r?\n/)
    const withTodo = () => {
      write(file('a.js'), '// TODO fix later\nexport const a = 1\n')
      commitAll()
    }

    test('missing ast-grep: run 1 exits 0, skips the Baseline and the workflow with the reason and the manual fix, and writes the other pieces', () => {
      withTodo()
      const result = withoutAstGrep()
      assert.equal(result.status, 0, result.out)
      const reason = `ast-grep 0.51.3 no está instalado: no existe ${path.resolve(missingBinary())}. Instalalo con npm ci en la instalación de orca-stack (sin --omit=optional).`
      for (const line of [skipBaseline(reason), skipWorkflow, 'agrego la clave lint a .orca-stack.json', `creo ${HOOK}`, 'creo CODING_STANDARDS.md']) {
        assert.ok(lines(result.out).includes(line), `missing "${line}" in:\n${result.out}`)
      }
      assert.doesNotMatch(result.out, /✖/)
      assert.equal(existsSync(file(BASELINE)), false)
      assert.equal(existsSync(file(WORKFLOW)), false)
      for (const rel of [HOOK, 'CODING_STANDARDS.md']) assert.ok(existsSync(file(rel)), rel)
      assert.deepEqual(JSON.parse(read(file('.orca-stack.json'))).lint, LINT_DEFAULTS)
    })

    test('missing ast-grep: run 2 exits 0 and changes nothing byte for byte', () => {
      withTodo()
      assert.equal(withoutAstGrep().status, 0)
      const before = snapshot(repo)
      const backupsBefore = backups(home)
      const second = withoutAstGrep()
      assert.equal(second.status, 0, second.out)
      assert.deepEqual(snapshot(repo), before)
      assert.deepEqual(backups(home), backupsBefore)
      assert.ok(lines(second.out).includes(skipWorkflow), second.out)
      assert.match(second.out, /^⚠ \.orca-stack-baseline\.json: no se crea, ast-grep no está disponible \(/m)
      assert.doesNotMatch(second.out, /✖/)
    })

    test('once ast-grep is available, a re-run seeds the Baseline with the existing TODO and writes the workflow', () => {
      withTodo()
      assert.equal(withoutAstGrep().status, 0)
      const third = cli(home, ['init'], { cwd: repo, env: { ORCA_STACK_AST_GREP: '' } })
      assert.equal(third.status, 0, third.out)
      assert.ok(lines(third.out).includes(`creo ${BASELINE} (1 entrada)`), third.out)
      assert.ok(lines(third.out).includes(`creo ${WORKFLOW}`), third.out)
      assert.deepEqual(JSON.parse(read(file(BASELINE))).entries.map(entry => entry.file), ['a.js'])
      assert.ok(existsSync(file(WORKFLOW)))
    })

    test('unsupported platform (AST_GREP_UNSUPPORTED): init exits 0 and skips the Baseline and the workflow', async t => {
      withTodo()
      const arch = Object.getOwnPropertyDescriptor(process, 'arch')
      const astGrep = process.env.ORCA_STACK_AST_GREP
      delete process.env.ORCA_STACK_AST_GREP
      Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' })
      let result
      try {
        result = await initWith(t, 'n')
      } finally {
        Object.defineProperty(process, 'arch', arch)
        if (astGrep !== undefined) process.env.ORCA_STACK_AST_GREP = astGrep
      }
      assert.equal(result.status, 0, result.out)
      const reason = `ast-grep 0.51.3 no tiene un binario fijado para la plataforma ${process.platform}-arm64 (fijadas: win32-x64, linux-x64); no se ejecutó ningún binario.`
      for (const line of [skipBaseline(reason), skipWorkflow]) assert.ok(lines(result.out).includes(line), `missing "${line}" in:\n${result.out}`)
      assert.doesNotMatch(result.out, /✖/)
      assert.equal(existsSync(file(BASELINE)), false)
      assert.equal(existsSync(file(WORKFLOW)), false)
    })

    test('init --help and the manual say what happens when ast-grep is unavailable', () => {
      const help = cli(home, ['init', '--help']).stdout
      const manual = read(path.join(ROOT, 'docs', 'manual.md')).split('#### `init`')[1].split('\n#### ')[0]
      for (const text of [help, manual]) {
        assert.match(text, /ast-grep/)
        assert.match(text, /lint --sembrar/)
        assert.match(text, /lint\.enabled/)
      }
      assert.match(help, /sin Baseline no crea el workflow/)
      assert.match(manual, /sin Baseline no crea el workflow/)
    })
  })

  test('R9: init --help and the manual describe the five pieces, the skip rules, --activar-hook and the core.hooksPath question', () => {
    const help = cli(home, ['init', '--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /^orca-stack init \[--dry-run\] \[--activar-hook\]/)
    for (const piece of ['lint', WORKFLOW, HOOK, 'CODING_STANDARDS.md', BASELINE, 'core.hooksPath', 'orca-stack-lint', '.git/hooks']) assert.ok(help.stdout.includes(piece), piece)
    assert.match(help.stdout, /solo si falta/)
    assert.match(cli(home, ['--help']).stdout, /--activar-hook +\(init\)/)
    const manual = read(path.join(ROOT, 'docs', 'manual.md'))
    const initSection = manual.split('#### `init`')[1].split('\n#### ')[0]
    for (const piece of ['`lint`', `\`${WORKFLOW}\``, `\`${HOOK}\``, '`CODING_STANDARDS.md`', `\`${BASELINE}\``, '`--activar-hook`', '`core.hooksPath`', HOW_TO_ENABLE, '`.git/hooks`']) assert.ok(initSection.includes(piece), piece)
    assert.match(initSection, /con cinco piezas\. Escribe cada una solo si falta, nunca pisa lo que el repo ya tiene/)
  })

  test('PRESERVE: init --dry-run writes nothing, not even with --activar-hook, and lists the lint pieces it would write', () => {
    const before = snapshot(repo)
    const result = run('--dry-run', '--activar-hook')
    assert.equal(result.status, 0, result.out)
    assert.deepEqual(snapshot(repo), before)
    for (const line of ['agrego la clave lint a .orca-stack.json', `creo ${WORKFLOW}`, `creo ${HOOK}`, 'creo CODING_STANDARDS.md', `creo ${BASELINE}`, 'core.hooksPath: lo apuntaría a .githooks']) {
      assert.ok(result.out.split(/\r?\n/).includes(`[simulación] ${line}`), `missing "${line}" in:\n${result.out}`)
    }
  })

  test('PRESERVE: parseArgs takes --activar-hook only for init', async () => {
    const { parseArgs } = await import('../src/cli.mjs')
    assert.equal(parseArgs(['init', '--activar-hook']).flags.activarHook, true)
    assert.equal(parseArgs(['init']).flags.activarHook, undefined)
    assert.throws(() => parseArgs(['lint', '--activar-hook']), /^Error: Opción desconocida: --activar-hook$/)
  })
})

describe('init: hook scan, invalid config and the committed lint key (#451)', () => {
  const sha1 = rel => createHash('sha1').update(readFileSync(file(rel))).digest('hex')
  const lines = out => out.split(/\r?\n/)
  const PIECES = ['agrego la clave lint a .orca-stack.json', `creo ${WORKFLOW}`, `creo ${HOOK}`, 'creo CODING_STANDARDS.md', `creo ${BASELINE} (0 entradas)`]

  test('S16: a broken symlink in .git/hooks never makes init throw: init writes every piece, exits 0 and does not count it as an active hook', t => {
    try {
      symlinkSync('nope', file('.git/hooks/pre-commit'))
    } catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
      try {
        symlinkSync(file('.git/hooks/nope'), file('.git/hooks/pre-commit'), 'junction')
      } catch {
        return t.skip('creating a symlink needs privileges on this Windows machine')
      }
    }
    const result = run()
    assert.equal(result.status, 0, result.out)
    for (const line of PIECES) assert.ok(lines(result.out).includes(line), `missing "${line}" in:\n${result.out}`)
    assert.ok(lines(result.out).includes(`core.hooksPath: no lo cambié; para activar el hook corré \`${HOW_TO_ENABLE}\``), result.out)
    assert.doesNotMatch(result.out, /hooks propios/)
    assert.doesNotMatch(result.out, /✖/)
  })

  test('S17: negative: a real, non-sample hook file in .git/hooks keeps core.hooksPath unset, even with --activar-hook', () => {
    write(file('.git/hooks/pre-push'), '#!/bin/sh\necho propio\n')
    const result = run('--activar-hook')
    assert.equal(result.status, 0, result.out)
    assert.equal(hooksPath().status, 1, 'core.hooksPath stays unset')
    assert.ok(lines(result.out).includes('core.hooksPath: no lo cambio, el repo ya tiene hooks propios en .git/hooks (pre-push); para usar el hook, llamá a .githooks/pre-push desde tu .git/hooks/pre-push'), result.out)
  })

  test('S18: an existing .orca-stack.json that is not valid JSON makes init exit 1, name the file and the parse error, and stay byte for byte; a valid one without lint gets the key', () => {
    const broken = '{ // comment\n "version": 1 }'
    write(file('.orca-stack.json'), broken)
    const before = sha1('.orca-stack.json')
    let parseError
    try {
      JSON.parse(broken)
    } catch (error) {
      parseError = error.message
    }
    const result = run()
    assert.equal(result.status, 1, result.out)
    assert.ok(lines(result.out).includes(`✖ .orca-stack.json: no se pudo escribir (.orca-stack.json no es JSON válido (${parseError}); no lo toco)`), result.out)
    assert.ok(lines(result.out).includes('✖ lint: no se escribió .orca-stack.json; arreglá el problema y volvé a correr orca-stack init, que completa lo que falta sin duplicar nada'), result.out)
    assert.equal(sha1('.orca-stack.json'), before)
    assert.equal(read(file('.orca-stack.json')), broken)

    write(file('.orca-stack.json'), '{\n  "version": 1\n}\n')
    const valid = run()
    assert.equal(valid.status, 0, valid.out)
    assert.deepEqual(JSON.parse(read(file('.orca-stack.json'))), { version: 1, lint: LINT_DEFAULTS })
  })

  test('S19: a lint key only in .orca-stack.local.json does not count: init adds it to .orca-stack.json, lint still honors the local false, and a committed key stays byte for byte', () => {
    write(file('.orca-stack.json'), '{\n  "version": 1\n}\n')
    write(file('.orca-stack.local.json'), '{"lint":{"enabled":false}}\n')
    const result = run()
    assert.equal(result.status, 0, result.out)
    assert.ok(lines(result.out).includes('agrego la clave lint a .orca-stack.json'), result.out)
    assert.deepEqual(JSON.parse(read(file('.orca-stack.json'))), { version: 1, lint: LINT_DEFAULTS })
    assert.equal(read(file('.orca-stack.local.json')), '{"lint":{"enabled":false}}\n')
    const lint = cli(home, ['lint'], { cwd: repo })
    assert.equal(lint.status, 0, lint.out)
    assert.equal(lint.out, 'lint apagado: lint.enabled es false en .orca-stack.local.json; no se revisó nada.\n')

    const committed = read(file('.orca-stack.json'))
    const again = run()
    assert.equal(again.status, 0, again.out)
    assert.equal(read(file('.orca-stack.json')), committed)
    assert.ok(lines(again.out).includes('.orca-stack.json: ya tiene una clave lint propia, no se toca'), again.out)

    const help = cli(home, ['init', '--help']).stdout
    const manual = read(path.join(ROOT, 'docs', 'manual.md')).split('#### `init`')[1].split('\n#### ')[0]
    for (const text of [help, manual]) assert.match(text, /solo cuenta la de `?\.orca-stack\.json`?, no la de `?\.orca-stack\.local\.json`?/)
  })
})

describe('lint.enabled (#424)', () => {
  const lint = (...args) => cli(home, ['lint', ...args], { cwd: repo })
  const longRepo = config => {
    write(file('big.txt'), 'x\n'.repeat(2001))
    if (config) write(file(config.name), JSON.stringify(config.body))
    git(repo, 'add', 'big.txt')
  }

  test('lint.enabled false: lint prints one line saying it is off and where, exits 0 and writes nothing, also with --sembrar', () => {
    longRepo({ name: '.orca-stack.json', body: { version: 1, lint: { enabled: false } } })
    const before = snapshot(repo)
    const off = lint()
    assert.equal(off.status, 0, off.out)
    assert.equal(off.out, 'lint apagado: lint.enabled es false en .orca-stack.json; no se revisó nada.\n')
    const seeded = lint('--sembrar')
    assert.equal(seeded.status, 0, seeded.out)
    assert.equal(seeded.out, off.out)
    assert.deepEqual(snapshot(repo), before)

    write(file('.orca-stack.local.json'), '{"lint":{"enabled":false}}')
    write(file('.orca-stack.json'), '{"lint":{"enabled":true}}')
    assert.equal(lint().out, 'lint apagado: lint.enabled es false en .orca-stack.local.json; no se revisó nada.\n')
  })

  test('lint.enabled with a value that is not a boolean fails as a config error', () => {
    longRepo({ name: '.orca-stack.json', body: { lint: { enabled: 'no' } } })
    const result = lint()
    assert.equal(result.status, 1, result.out)
    assert.equal(result.out, '✖ lint.enabled tiene que ser true o false, no "no" (en .orca-stack.json, .orca-stack.local.json o ~/.orca-stack/config.json).\n')
  })

  test('PRESERVE: without lint.enabled, or with true, the lint runs as before', () => {
    longRepo()
    const absent = lint()
    assert.equal(absent.status, 1, absent.out)
    assert.match(absent.out, /^long-file big\.txt: 2001 líneas \(máximo 2000\) — dividí el archivo$/m)
    write(file('.orca-stack.json'), '{"lint":{"enabled":true}}')
    assert.equal(lint().out, absent.out)
  })
})

describe('init comments pass lint (#517)', () => {
  const LINT_OK_ZERO = 'lint OK: ninguna violación nueva ni entrada vencida (0 en la Baseline)\n'

  test('R5: init on an empty repo followed by lint reports no comments from init files, makes skipped files explicit, and all generated comments pass when scanned as shell', () => {
    const emptyRoot = tempDir('empty-init-lint')
    const emptyHome = tempDir('empty-init-home')
    try {
      const emptyRepo = path.join(emptyRoot, 'empty')
      git(emptyRoot, 'init', '-q', '-b', 'main', emptyRepo)

      const initResult = cli(emptyHome, ['init'], { cwd: emptyRepo })
      assert.equal(initResult.status, 0, initResult.out)
      assert.deepEqual(JSON.parse(read(path.join(emptyRepo, BASELINE))), { version: 1, entries: [] })

      commitAll(emptyRepo)

      const lintResult = cli(emptyHome, ['lint'], { cwd: emptyRepo })
      assert.equal(lintResult.status, 0, lintResult.out)
      assert.equal(lintResult.stdout, LINT_OK_ZERO)

      const commentedFiles = ['orca.yaml', '.worktreeinclude', HOOK, WORKFLOW]
      for (const rel of commentedFiles) {
        assert.equal(languageOf(rel), undefined, `expected ${rel} not to map to a linted comment language`)
      }

      const generatedComments = commentedFiles.flatMap(rel =>
        read(path.join(emptyRepo, rel))
          .split(/\r?\n/)
          .filter(line => line.startsWith('#') && !line.startsWith('#!')),
      )
      assert.equal(generatedComments.length, 5, `expected 5 generated comments, got ${generatedComments.length}`)

      write(
        path.join(emptyRepo, 'scripts', 'init-comments.sh'),
        `#!/usr/bin/env bash\nrun_init_comments() {\n${generatedComments.map(line => `  ${line} — temporary workaround`).join('\n')}\n  echo ok\n}\n`,
      )
      assert.equal(git(emptyRepo, 'add', 'scripts/init-comments.sh').status, 0)
      const shellLint = cli(emptyHome, ['lint'], { cwd: emptyRepo })
      assert.equal(shellLint.status, 0, shellLint.out)
      assert.equal(shellLint.stdout, LINT_OK_ZERO)
    } finally {
      cleanup(emptyHome)
      cleanup(emptyRoot)
    }
  })
})
