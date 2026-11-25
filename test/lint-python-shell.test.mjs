import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { cleanup, cli, tempDir } from './helpers.mjs'

const BASELINE = '.orca-stack-baseline.json'
const OK = n => `lint OK: ninguna violación nueva ni entrada vencida (${n} en la Baseline)\n`
const SUMMARY = (found, stale) => `✖ lint: ${found} ${found === 1 ? 'violación nueva' : 'violaciones nuevas'}, ${stale} ${stale === 1 ? 'entrada vencida' : 'entradas vencidas'}\n`
const EXCUSE = '(Excuse) — borralo y abrí un issue para arreglar la implementación'
const TAUTOLOGY = '(Tautology) — borralo'
const STALE_COMMENT = '(Stale) — borralo'
const print = text => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
const CYCLE = (...files) => `module-cycle ${files.join(' → ')} — dale una dirección a los módulos`
const LAYER = '¿cuál es la capa de abstracción buscada? ¿Qué módulo va en qué capa?'
const TANGLE = (members, modules) => `tangle ${members.join(', ')}: ${members.length} cosas en ${modules} ${modules === 1 ? 'módulo' : 'módulos'} (máximo 7 cosas en un solo módulo) — ${LAYER}`
const SHALLOW = (mod, shown, total) => `shallow-module ${mod}: muestra ${shown.length} de ${total} funciones (${shown.join(', ')}) y esconde ${total - shown.length} (máximo 7 mostradas, o más escondidas que mostradas) — ¿por qué existen estas funciones? ¿Cuáles son sus patrones de uso? ¿Se pueden esconder detrás de una interfaz angosta?`
const STALE_ENTRY = (rule, file, location, fingerprint) => `entrada vencida en ${BASELINE}: ${rule} ${file} (${location}, ${fingerprint}) — la violación ya no está en el repo: sacá esta entrada`

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

const withRepo = run => {
  const dir = tempDir('lint-py-sh')
  const repo = path.join(dir, 'repo')
  const home = path.join(dir, 'home')
  mkdirSync(repo)
  mkdirSync(home)
  git(repo, 'init', '-q')
  const add = (rel, text) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    writeFileSync(path.join(repo, rel), text)
    git(repo, 'add', '--', rel)
  }
  const lint = (args = [], env = {}) => cli(home, ['lint', ...args], { cwd: repo, env: { ORCA_STACK_AST_GREP: '', ...env } })
  const baseline = () => JSON.parse(readFileSync(path.join(repo, BASELINE), 'utf8'))
  try {
    run({ dir, repo, add, lint, baseline })
  } finally {
    cleanup(dir)
  }
}

const BLOCK_PYTHON = JSON.stringify({ lint: { lenguajes: { python: 'blocking' } } }) + '\n'

const PY_QUEUE = [
  'class Queue:',
  '    items = []',
  '    def __init__(self):',
  '        self.head = 0',
  '        self._limit = 3',
  '    def push(self, x):',
  '        if len(self.items) < self._limit:',
  '            self.items.append(x)',
  '    def size(self):',
  '        return len(self.items)',
  '',
].join('\n')

const pyRing = count => Array.from({ length: count }, (_, i) => `def f${i + 1}():\n    return f${((i + 1) % count) + 1}()\n`).join('\n')
const pyNames = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`)
const pyStore = list => list.map(name => `def ${name}():\n    return "${name}"\n`).join('\n')
const pyCaller = (mod, list) => `from ${mod} import ${list.join(', ')}\n${list.map(name => `${name}()`).join('\n')}\n`

describe('orca-stack lint Python and Shell support (#423)', () => {
  test('R1/R6: Python and Shell comment rules flag Excuse, Tautology and Stale; shebangs, directives, coding cookies, docstrings and Decision Records pass', () => {
    withRepo(({ add, lint }) => {
      add('.orca-stack.json', BLOCK_PYTHON)
      add('app/good.py', [
        '#!/usr/bin/env python3',
        '# -*- coding: utf-8 -*-',
        '# Copyright 2026 Example. Licensed under MIT. TODO hack',
        '"""Module docstring with TODO hack for now and missing_fn()."""',
        '',
        'class Service:',
        '    """Class docstring with temporary workaround."""',
        '    def run(self):',
        '        """Function docstring with FIXME."""',
        '        # type: ignore[attr-defined]',
        '        # noqa: E501',
        '        # TODO(#123): remove after migration',
        '        # follows ADR 0002',
        '        # calls helper_fn() and ignores `removed_fn()`',
        '        return helper_fn()',
        '',
        'def helper_fn():',
        '    return 1',
        '',
      ].join('\n'))
      add('scripts/good.sh', [
        '#!/usr/bin/env bash',
        '# Copyright 2026 Example. Licensed under MIT. TODO hack',
        '# shellcheck disable=SC2086',
        '# TODO(#45): remove once upstream fixes the flag',
        'echo "$1"',
        '',
      ].join('\n'))
      const clean = lint()
      assert.equal(clean.status, 0, clean.out)
      assert.equal(clean.stdout, OK(0))

      add('app/bad.py', [
        'def compute(i):',
        '    # TODO: hack for now',
        '    x = i',
        '    # increment i',
        '    i += 1',
        '    # calls old_helper() before returning',
        '    result = i + x',
        '    # return the result',
        '    return result',
        '',
      ].join('\n'))
      add('scripts/bad.sh', [
        '#!/usr/bin/env bash',
        'run_task() {',
        '  # temporary workaround',
        '  local i=0',
        '  # increment i',
        '  ((i++))',
        '  # calls gone_helper() here',
        '  echo "$i"',
        '}',
        '',
      ].join('\n'))
      const bad = lint()
      assert.equal(bad.status, 1, bad.out)
      assert.equal(bad.stdout, [
        `comment-excuse app/bad.py:compute() ${EXCUSE}`,
        `comment-tautology app/bad.py:compute() ${TAUTOLOGY}`,
        `comment-stale app/bad.py:compute() ${STALE_COMMENT}`,
        `comment-tautology app/bad.py:compute() ${TAUTOLOGY}`,
        `comment-excuse scripts/bad.sh:run_task() ${EXCUSE}`,
        `comment-tautology scripts/bad.sh:run_task() ${TAUTOLOGY}`,
        `comment-stale scripts/bad.sh:run_task() ${STALE_COMMENT}`,
        '',
      ].join('\n') + SUMMARY(7, 0))
    })
  })

  test('R2/R6: Python structural checks catch module-cycle, tangle, field-leak and shallow-module', () => {
    withRepo(({ add, lint }) => {
      add('.orca-stack.json', BLOCK_PYTHON)
      add('app/kernel.py', 'from app.timers import (\n    # keep timer reference\n    Timers,\n)\n\nclass Tasks:\n    def run(self):\n        return Timers().tick()\n')
      add('app/timers.py', 'from app.kernel import Tasks\n\nclass Timers:\n    def tick(self):\n        return Tasks\n')
      const cycleAndTangle = lint()
      assert.equal(cycleAndTangle.status, 1, cycleAndTangle.out)
      assert.equal(cycleAndTangle.stdout, [
        CYCLE('app/kernel.py', 'app/timers.py', 'app/kernel.py'),
        TANGLE(['app/kernel.py:Tasks', 'app/timers.py:Timers'], 2),
        '',
      ].join('\n') + SUMMARY(2, 0))
    })

    withRepo(({ add, lint }) => {
      add('.orca-stack.json', BLOCK_PYTHON)
      add('src/ring.py', pyRing(7))
      assert.equal(lint().status, 0)
      add('src/ring.py', pyRing(8))
      const eight = lint()
      assert.equal(eight.status, 1, eight.out)
      const members = Array.from({ length: 8 }, (_, i) => `src/ring.py:f${i + 1}`)
      assert.equal(eight.stdout, `${TANGLE(members, 1)}\n${SUMMARY(1, 0)}`)
    })

    withRepo(({ add, lint }) => {
      add('.orca-stack.json', BLOCK_PYTHON)
      add('src/queue.py', PY_QUEUE)
      add('src/point.py', 'class Point:\n    def __init__(self):\n        self.x = 0\n')
      add('src/app.py', 'from src.queue import Queue\nfrom src.point import Point\nq = Queue()\nq.push(1)\nn = q.size()\nfirst = q.items[0]\np = Point()\np.x = 1\n')
      const tidy = lint()
      assert.equal(tidy.status, 0, tidy.out)

      add('src/app.py', 'from src.queue import Queue\nq = Queue()\nq.items.append(1)\nq.head = 2\nq.head += 1\n')
      const leaky = lint()
      assert.equal(leaky.status, 1, leaky.out)
      assert.match(leaky.stdout, /^field-leak src\/queue\.py:Queue\.head: se trabaja fuera de Queue en 2 lugares de 1 módulo \(src\/app\.py; máximo 0\), y Queue se guarda _limit/m)
      assert.match(leaky.stdout, /^field-leak src\/queue\.py:Queue\.items: se trabaja fuera de Queue en 1 lugar de 1 módulo \(src\/app\.py; máximo 0\), y Queue se guarda _limit/m)
      assert.ok(leaky.stdout.endsWith(SUMMARY(2, 0)), leaky.stdout)
    })

    withRepo(({ add, lint }) => {
      add('.orca-stack.json', BLOCK_PYTHON)
      const all = pyNames('s', 15)
      add('src/store.py', pyStore(all))
      add('src/app.py', pyCaller('src.store', all.slice(0, 3)))
      assert.equal(lint().status, 0)

      add('src/app.py', pyCaller('src.store', all.slice(0, 9)))
      const shallow = lint()
      assert.equal(shallow.status, 1, shallow.out)
      assert.equal(shallow.stdout, `${SHALLOW('src/store.py', all.slice(0, 9), 15)}\n${SUMMARY(1, 0)}`)
    })

    withRepo(({ add, lint }) => {
      add('.orca-stack.json', BLOCK_PYTHON)
      const all = pyNames('d', 8)
      add('lib/__init__.py', `from .fns import ${all.join(', ')}\n`)
      add('lib/fns.py', pyStore(all))
      add('app.py', pyCaller('lib', all))
      const pkg = lint()
      assert.equal(pkg.status, 1, pkg.out)
      assert.equal(pkg.stdout, `${SHALLOW('lib/', all, 8)}\n${SUMMARY(1, 0)}`)
    })
  })

  test('R2/R6: Shell gets module-cycle over relative source/. only and never runs checks without a Shell definition', () => {
    withRepo(({ add, lint }) => {
      add('sh/clean.sh', '#!/usr/bin/env bash\nsource /etc/profile\nsource "$DIR/other.sh"\nsource ./missing.sh\n. helper_on_path.sh\n')
      const fns = Array.from({ length: 10 }, (_, i) => `fn_${i}() { fn_${(i + 1) % 10}; }\n`).join('')
      add('sh/many.sh', `#!/usr/bin/env bash\n${fns}`)
      const clean = lint()
      assert.equal(clean.status, 0, clean.out)
      assert.equal(clean.stdout, OK(0))

      add('sh/a.sh', '#!/usr/bin/env bash\nsource ./b.sh\n')
      add('sh/b.sh', '#!/usr/bin/env bash\n. "./a.sh"\n')
      const cyclic = lint()
      assert.equal(cyclic.status, 1, cyclic.out)
      assert.equal(cyclic.stdout, `${CYCLE('sh/a.sh', 'sh/b.sh', 'sh/a.sh')}\n${SUMMARY(1, 0)}`)
    })
  })

  test('R3/R6: Python defaults to warning without Python CI (exits 0 with warning lines), blocks when CI runs Python suites, and honors lint.lenguajes overrides', () => {
    withRepo(({ add, lint }) => {
      add('app/bad.py', 'def f():\n    # TODO: fix later\n    return 1\n')
      const defaultWarn = lint()
      assert.equal(defaultWarn.status, 0, defaultWarn.out)
      assert.match(defaultWarn.stdout, /^warning: comment-excuse app\/bad\.py:f\(\) \(Excuse\)/m)
      assert.match(defaultWarn.stdout, /^lint OK:/m)

      add('.github/workflows/ci.yml', 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pytest\n')
      const ciBlocks = lint()
      assert.equal(ciBlocks.status, 1, ciBlocks.out)
      assert.equal(ciBlocks.stdout, `comment-excuse app/bad.py:f() ${EXCUSE}\n${SUMMARY(1, 0)}`)

      add('.orca-stack.json', JSON.stringify({ lint: { lenguajes: { python: 'warning' } } }) + '\n')
      const forcedWarn = lint()
      assert.equal(forcedWarn.status, 0, forcedWarn.out)
      assert.match(forcedWarn.stdout, /^warning: comment-excuse app\/bad\.py:f\(\) \(Excuse\)/m)

      add('.orca-stack.json', JSON.stringify({ lint: { lenguajes: { python: 'silent' } } }) + '\n')
      const invalid = lint()
      assert.equal(invalid.status, 1, invalid.out)
      assert.match(invalid.out, /✖ lint\.lenguajes/)
    })
  })

  test('R4: lint.excluir excludes matching paths from every rule and Baseline, never hides files outside its glob, and ignores globs matching nothing', () => {
    withRepo(({ add, lint, baseline }) => {
      const longBody = Array.from({ length: 2005 }, (_, i) => `const x${i} = ${i}`).join('\n') + '\n'
      add('.orca-stack.json', JSON.stringify({ lint: { excluir: ['vendor/**', 'third_party/', 'nonexistent/**'] } }) + '\n')
      add('vendor/big.mjs', longBody)
      add('vendor/a.mjs', "import './b.mjs'\n// TODO: vendor hack\nexport const a = 1\n")
      add('vendor/b.mjs', "import './a.mjs'\nexport const b = 1\n")
      for (let i = 1; i <= 18; i++) add(`third_party/f${i}.sh`, '#!/usr/bin/env bash\n# TODO: third party\necho 1\n')

      const clean = lint(['--sembrar'])
      assert.equal(clean.status, 0, clean.out)
      assert.equal(baseline().entries.length, 0)

      add('vendor-own/real.mjs', 'export function real() {\n  // TODO: real debt\n  return 1\n}\n')
      const outside = lint()
      assert.equal(outside.status, 1, outside.out)
      assert.equal(outside.stdout, `comment-excuse vendor-own/real.mjs:real() ${EXCUSE}\n${SUMMARY(1, 0)}`)

      add('.orca-stack.json', JSON.stringify({ lint: { excluir: 'vendor/**' } }) + '\n')
      const invalid = lint()
      assert.equal(invalid.status, 1, invalid.out)
      assert.match(invalid.out, /✖ lint\.excluir/)
    })
  })

  test('R5: Python and Shell Baseline entries use the shared format without line numbers and fail when stale', () => {
    withRepo(({ add, lint, baseline }) => {
      add('.orca-stack.json', BLOCK_PYTHON)
      add('app/a.py', 'from . import b\ndef run():\n    # TODO: clean\n    return 1\n')
      add('app/b.py', 'from . import a\n')
      add('sh/a.sh', '#!/usr/bin/env bash\nsource ./b.sh\n# FIXME\n')
      add('sh/b.sh', '#!/usr/bin/env bash\n. ./a.sh\n')

      const seed = lint(['--sembrar'])
      assert.equal(seed.status, 0, seed.out)
      assert.equal(seed.stdout, `Baseline: 4 entradas nuevas en ${BASELINE}\n${OK(4)}`)
      const entries = baseline().entries
      assert.deepEqual(entries, [
        { rule: 'comment-excuse', file: 'app/a.py', location: 'run()', fingerprint: print('TODO: clean') },
        { rule: 'comment-excuse', file: 'sh/a.sh', location: '<módulo>', fingerprint: print('FIXME') },
        { rule: 'module-cycle', file: 'app/a.py', location: 'cycle', fingerprint: print('app/a.py\napp/b.py'), members: ['app/a.py', 'app/b.py'] },
        { rule: 'module-cycle', file: 'sh/a.sh', location: 'cycle', fingerprint: print('sh/a.sh\nsh/b.sh'), members: ['sh/a.sh', 'sh/b.sh'] },
      ])
      assert.equal(lint(['--sembrar']).stdout, `Baseline: sin cambios (${BASELINE})\n${OK(4)}`)

      add('sh/a.sh', '#!/usr/bin/env bash\necho ok\n')
      const stale = lint()
      assert.equal(stale.status, 1, stale.out)
      assert.equal(stale.stdout, [
        STALE_ENTRY('comment-excuse', 'sh/a.sh', '<módulo>', print('FIXME')),
        STALE_ENTRY('module-cycle', 'sh/a.sh', 'cycle', print('sh/a.sh\nsh/b.sh')),
        '',
      ].join('\n') + SUMMARY(0, 2))
    })
  })

  test('R7: Python and Shell rules gate on files of each language', () => {
    withRepo(({ dir, add, lint }) => {
      add('README.md', '# plain\n')
      const missing = { ORCA_STACK_AST_GREP: path.join(dir, 'missing', 'ast-grep') }
      assert.equal(lint([], missing).status, 0)

      add('script.sh', '#!/usr/bin/env bash\necho 1\n')
      const withSh = lint([], missing)
      assert.equal(withSh.status, 1, withSh.out)
      assert.match(withSh.out, /✖ ast-grep 0\.51\.3 no está instalado/)
    })
    withRepo(({ dir, add, lint }) => {
      const missing = { ORCA_STACK_AST_GREP: path.join(dir, 'missing', 'ast-grep') }
      add('app.py', 'print(1)\n')
      const withPy = lint([], missing)
      assert.equal(withPy.status, 1, withPy.out)
      assert.match(withPy.out, /✖ ast-grep 0\.51\.3 no está instalado/)
    })
  })

  test('PRESERVE: orca-stack init seeds Baseline respecting lint.excluir and keeps existing JS/TS lint intact', () => {
    withRepo(({ repo, add, lint, baseline }) => {
      add('.orca-stack.json', JSON.stringify({ lint: { enabled: true, comentarios: { alcance: 'repo' }, excluir: ['vendor/**'] } }) + '\n')
      add('vendor/ignored.mjs', '// TODO: vendor debt\nexport const x = 1\n')
      add('src/app.mjs', 'export function run() {\n  // TODO: real debt\n  return 1\n}\n')
      const init = cli(path.join(path.dirname(repo), 'home'), ['init'], { cwd: repo, env: { ORCA_STACK_AST_GREP: '' } })
      assert.equal(init.status, 0, init.out)
      const entries = baseline().entries
      assert.ok(entries.some(e => e.file === 'src/app.mjs' && e.rule === 'comment-excuse'), JSON.stringify(entries))
      assert.ok(!entries.some(e => e.file.startsWith('vendor/')), JSON.stringify(entries))
      assert.equal(lint().status, 0)
    })
  })
})
