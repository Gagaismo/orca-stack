import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, cleanup, cli, tempDir } from './helpers.mjs'

const BASELINE = '.orca-stack-baseline.json'
const OK = n => `lint OK: ninguna violación nueva ni entrada vencida (${n} en la Baseline)\n`
const SUMMARY = (found, stale) => `✖ lint: ${found} ${found === 1 ? 'violación nueva' : 'violaciones nuevas'}, ${stale} ${stale === 1 ? 'entrada vencida' : 'entradas vencidas'}\n`
const print = text => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
const LAYER = '¿cuál es la capa de abstracción buscada? ¿Qué módulo va en qué capa?'
const TANGLE = (members, modules) => `tangle ${members.join(', ')}: ${members.length} cosas en ${modules} ${modules === 1 ? 'módulo' : 'módulos'} (máximo 7 cosas en un solo módulo) — ${LAYER}`
const CYCLE = (...files) => `module-cycle ${files.join(' → ')} — dale una dirección a los módulos`
const LEAK = (field, places) => `field-leak src/queue.mjs:Queue.${field}: se trabaja fuera de Queue en ${places} de 1 módulo (src/app.mjs; máximo 0), y Queue se guarda #limit — ¿por qué existe este campo? ¿Cuáles son sus patrones de uso? ¿Se puede esconder detrás de una interfaz angosta?`
const SHALLOW = (module, shown, total) => `shallow-module ${module}: muestra ${shown.length} de ${total} funciones (${shown.join(', ')}) y esconde ${total - shown.length} (máximo 7 mostradas, o más escondidas que mostradas) — ¿por qué existen estas funciones? ¿Cuáles son sus patrones de uso? ¿Se pueden esconder detrás de una interfaz angosta?`
const STALE = (rule, file, location, fingerprint) => `entrada vencida en ${BASELINE}: ${rule} ${file} (${location}, ${fingerprint}) — la violación ya no está en el repo: sacá esta entrada`

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

const withRepo = run => {
  const dir = tempDir('lint-design')
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
  const lint = (...args) => cli(home, ['lint', ...args], { cwd: repo, env: { ORCA_STACK_AST_GREP: '' } })
  const baseline = () => JSON.parse(readFileSync(path.join(repo, BASELINE), 'utf8'))
  try {
    run({ repo, add, lint, baseline })
  } finally {
    cleanup(dir)
  }
}

const KERNEL = "import { Timers } from './timers.mjs'\nexport class Tasks {\n  run() {\n    return new Timers().tick()\n  }\n}\n"
const TIMERS = "import { Tasks } from './kernel.mjs'\nexport class Timers {\n  tick() {\n    return Tasks.name\n  }\n}\n"
const ring = count => Array.from({ length: count }, (_, i) => `export const f${i + 1} = () => f${((i + 1) % count) + 1}()\n`).join('')

const QUEUE = [
  'export class Queue {',
  '  items = []',
  '  #limit = 3',
  '  constructor() {',
  '    this.head = 0',
  '  }',
  '  push(x) {',
  '    if (this.items.length < this.#limit) this.items.push(x)',
  '  }',
  '  get size() {',
  '    return this.items.length',
  '  }',
  '}',
  '',
].join('\n')
const LEAKY_APP = "import { Queue } from './queue.mjs'\nconst queue = new Queue()\nqueue.items.push(1)\nqueue.head = 2\nqueue.head++\nexport const n = queue.size\n"
const TIDY_APP = "import { Queue } from './queue.mjs'\nconst queue = new Queue()\nqueue.push(1)\nexport const n = queue.size\nexport const first = queue.items[0]\n"

const names = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`)
const store = list => list.map(name => `export const ${name} = () => '${name}'\n`).join('')
const caller = (from, list) => `import { ${list.join(', ')} } from '${from}'\n${list.map(name => `${name}()`).join('\n')}\n`

describe('orca-stack lint tangle, field-leak and shallow-module (#421)', () => {
  test('R1: the manual and lint --help define the three checks for JS/TS, with deslop-please and its MIT license as source', () => {
    const manual = readFileSync(path.join(ROOT, 'docs', 'manual.md'), 'utf8')
    const lintSection = manual.split('#### `lint`')[1].split('\n#### ')[0]
    for (const rule of ['tangle', 'field-leak', 'shallow-module']) assert.match(lintSection, new RegExp(`\`${rule}\`: `))
    assert.match(lintSection, /https:\/\/github\.com\/deterministic-machines\/deslop-please/)
    assert.match(lintSection, /MIT/)
    assert.match(lintSection, /> `tangle`: things that know each other in a circle/)
    assert.match(lintSection, /> `field-leak`: code that works on a field of a type it is not part of/)
    assert.match(lintSection, /> `shallow-module`: a crate, or a module with child modules/)
    assert.match(lintSection, /Una \*\*cosa\*\* es una clase, una función exportada o un objeto de módulo/)
    assert.match(lintSection, /No son cosas/)
    const home = tempDir('lint-design-help')
    try {
      const help = cli(home, ['lint', '--help'])
      assert.equal(help.status, 0)
      for (const rule of ['tangle', 'field-leak', 'shallow-module']) assert.match(help.stdout, new RegExp(`^${rule}`, 'm'))
      assert.match(cli(home, ['--help']).stdout, /^ {2}lint {6}.*tangle.*field-leak.*shallow-module/m)
    } finally {
      cleanup(home)
    }
  })

  test('R2: Tasks and Timers that call each other across two modules are a tangle; a circle of seven things in one module passes and eight fail', () => {
    withRepo(({ add, lint }) => {
      add('src/kernel.mjs', KERNEL)
      add('src/timers.mjs', TIMERS)
      const across = lint()
      assert.equal(across.status, 1, across.out)
      assert.equal(across.stdout, [
        CYCLE('src/kernel.mjs', 'src/timers.mjs', 'src/kernel.mjs'),
        TANGLE(['src/kernel.mjs:Tasks', 'src/timers.mjs:Timers'], 2),
      ].join('\n') + `\n${SUMMARY(2, 0)}`)
    })
    withRepo(({ add, lint }) => {
      add('src/ring.mjs', ring(7))
      const seven = lint()
      assert.equal(seven.status, 0, seven.out)
      assert.equal(seven.stdout, OK(0))
      add('src/ring.mjs', ring(8))
      const eight = lint()
      assert.equal(eight.status, 1, eight.out)
      assert.equal(eight.stdout, `${TANGLE(names('src/ring.mjs:f', 8), 1)}\n${SUMMARY(1, 0)}`)
    })
  })

  test('R3: writing, bumping or calling a method on a field of Queue from another module leaks it; reading a value or calling a forwarding method does not', () => {
    withRepo(({ add, lint }) => {
      add('src/queue.mjs', QUEUE)
      add('src/app.mjs', TIDY_APP)
      add('src/point.mjs', 'export class Point {\n  constructor() {\n    this.x = 0\n  }\n}\n')
      add('src/use-point.mjs', "import { Point } from './point.mjs'\nconst p = new Point()\np.x = 1\n")
      const tidy = lint()
      assert.equal(tidy.status, 0, tidy.out)
      assert.equal(tidy.stdout, OK(0))
      add('src/app.mjs', LEAKY_APP)
      const leaky = lint()
      assert.equal(leaky.status, 1, leaky.out)
      assert.equal(leaky.stdout, `${LEAK('head', '2 lugares')}\n${LEAK('items', '1 lugar')}\n${SUMMARY(2, 0)}`)
    })
  })

  test('R4: app.mjs calling 9 of the 15 functions of store.mjs is a shallow module; showing 3 and hiding 12 passes, and a directory with an index is one module', () => {
    withRepo(({ add, lint }) => {
      const all = names('s', 15)
      add('src/store.mjs', store(all))
      add('src/app.mjs', caller('./store.mjs', all.slice(0, 3)))
      const three = lint()
      assert.equal(three.status, 0, three.out)
      assert.equal(three.stdout, OK(0))
      add('src/app.mjs', caller('./store.mjs', all.slice(0, 9)))
      const nine = lint()
      assert.equal(nine.status, 1, nine.out)
      assert.equal(nine.stdout, `${SHALLOW('src/store.mjs', all.slice(0, 9), 15)}\n${SUMMARY(1, 0)}`)
    })
    withRepo(({ add, lint }) => {
      const all = names('d', 8)
      add('lib/fns.mjs', store(all))
      add('lib/index.mjs', "export * from './fns.mjs'\n")
      add('lib/inner.mjs', caller('./fns.mjs', all))
      add('app.mjs', caller('./lib/index.mjs', all))
      const dir = lint()
      assert.equal(dir.status, 1, dir.out)
      assert.equal(dir.stdout, `${SHALLOW('lib/', all, 8)}\n${SUMMARY(1, 0)}`)
    })
  })

  test('R5: dynamic property access, computed imports, packages and missing modules are skipped and never fail the run', () => {
    withRepo(({ add, lint }) => {
      add('src/a.mjs', [
        "import pkg from 'lodash'",
        "import { gone } from './missing.mjs'",
        "import * as ns from './b.mjs'",
        "const key = 'x'",
        'export const run = () => {',
        '  ns[key]()',
        '  pkg.thing.push(1)',
        '  gone()',
        '  return import(key)',
        '}',
        '',
      ].join('\n'))
      add('src/b.mjs', 'export const x = () => 1\n')
      const result = lint()
      assert.equal(result.status, 0, result.out)
      assert.equal(result.out, OK(0))
    })
  })

  test('R5: hundreds of class instances never push the ast-grep command line past its limit', () => {
    withRepo(({ add, lint }) => {
      add('src/queue.mjs', QUEUE)
      const many = Array.from({ length: 300 }, (_, i) => `const instance_with_a_long_name_${i} = new Queue()\ninstance_with_a_long_name_${i}.push(${i})\n`).join('')
      add('src/app.mjs', `import { Queue } from './queue.mjs'\n${many}`)
      const result = lint()
      assert.equal(result.status, 0, result.out)
      assert.equal(result.out, OK(0))
    })
  })

  test('R6: the Baseline keeps tangle by member set, field-leak by class and field and shallow-module by module, without line numbers', () => {
    withRepo(({ add, lint, baseline }) => {
      add('src/kernel.mjs', KERNEL)
      add('src/timers.mjs', TIMERS)
      add('src/queue.mjs', QUEUE)
      add('src/app.mjs', LEAKY_APP)
      const all = names('s', 15)
      add('src/store.mjs', store(all))
      add('src/client.mjs', caller('./store.mjs', all.slice(0, 9)))
      const seeded = lint('--sembrar')
      assert.equal(seeded.status, 0, seeded.out)
      assert.equal(seeded.stdout, `Baseline: 5 entradas nuevas en ${BASELINE}\n${OK(5)}`)
      const members = ['src/kernel.mjs:Tasks', 'src/timers.mjs:Timers']
      const design = baseline().entries.filter(entry => entry.rule !== 'module-cycle')
      assert.deepEqual(design, [
        { rule: 'field-leak', file: 'src/queue.mjs', location: 'Queue.head', fingerprint: print('Queue.head') },
        { rule: 'field-leak', file: 'src/queue.mjs', location: 'Queue.items', fingerprint: print('Queue.items') },
        { rule: 'shallow-module', file: 'src/store.mjs', location: 'module', fingerprint: print('src/store.mjs') },
        { rule: 'tangle', file: 'src/kernel.mjs', location: 'tangle', fingerprint: print(members.join('\n')), members },
      ])
      const again = lint('--sembrar')
      assert.equal(again.stdout, `Baseline: sin cambios (${BASELINE})\n${OK(5)}`)

      add('src/app.mjs', "import { Queue } from './queue.mjs'\nconst queue = new Queue()\nqueue.items.push(1)\n")
      add('src/client.mjs', caller('./store.mjs', all.slice(0, 3)))
      add('src/timers.mjs', "import { Tasks } from './kernel.mjs'\nexport class Timers {\n  tick() {\n    return 1\n  }\n}\nexport const keep = Tasks\n")
      const fixed = lint()
      assert.equal(fixed.status, 1, fixed.out)
      assert.equal(fixed.stdout, [
        STALE('field-leak', 'src/queue.mjs', 'Queue.head', print('Queue.head')),
        STALE('shallow-module', 'src/store.mjs', 'module', print('src/store.mjs')),
        STALE('tangle', 'src/kernel.mjs', 'tangle', print(members.join('\n'))),
      ].join('\n') + `\n${SUMMARY(0, 3)}`)
    })
  })

  test('R6: a tangle that shrinks to members of its entry still passes, and a tangle entry without members is a malformed Baseline', () => {
    withRepo(({ add, lint, repo }) => {
      add('src/ring.mjs', ring(9))
      assert.equal(lint('--sembrar').status, 0)
      add('src/ring.mjs', ring(8))
      const shrunk = lint()
      assert.equal(shrunk.status, 0, shrunk.out)
      assert.equal(shrunk.stdout, OK(1))
      const broken = JSON.stringify({ version: 1, entries: [{ rule: 'tangle', file: 'src/ring.mjs', location: 'tangle', fingerprint: 'sha256:0' }] })
      writeFileSync(path.join(repo, BASELINE), broken)
      const malformed = lint()
      assert.equal(malformed.status, 1, malformed.out)
      assert.match(malformed.out, /\.orca-stack-baseline\.json no es una Baseline válida: la entrada 1 de tangle necesita members como una lista de cosas/)
      assert.equal(readFileSync(path.join(repo, BASELINE), 'utf8'), broken)
    })
  })

  test('R8: classes, fields and modules in other languages never give a design finding', () => {
    withRepo(({ add, lint }) => {
      add('app/kernel.py', 'from app.timers import Timers\n\nclass Tasks:\n    def run(self):\n        return Timers().tick()\n')
      add('app/timers.py', 'from app.kernel import Tasks\n\nclass Timers:\n    def tick(self):\n        return Tasks\n')
      add('app/queue.go', 'package app\n\ntype Queue struct{ items []int }\n\nfunc Use(q *Queue) { q.items = append(q.items, 1) }\n')
      const result = lint()
      assert.equal(result.status, 0, result.out)
      assert.equal(result.stdout, OK(0))
    })
  })
})
