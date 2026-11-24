import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, cleanup, cli, tempDir } from './helpers.mjs'

const BASELINE = '.orca-stack-baseline.json'
const OK = n => `lint OK: ninguna violación nueva ni entrada vencida (${n} en la Baseline)\n`
const SUMMARY = (found, stale) => `✖ lint: ${found} ${found === 1 ? 'violación nueva' : 'violaciones nuevas'}, ${stale} ${stale === 1 ? 'entrada vencida' : 'entradas vencidas'}\n`
const CYCLE = (...files) => `module-cycle ${files.join(' → ')} — dale una dirección a los módulos`
const print = members => `sha256:${createHash('sha256').update([...members].sort().join('\n')).digest('hex').slice(0, 16)}`
const STALE = members => `entrada vencida en ${BASELINE}: module-cycle ${[...members].sort()[0]} (cycle, ${print(members)}) — la violación ya no está en el repo: sacá esta entrada`

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

const withRepo = run => {
  const dir = tempDir('lint-cycles')
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
  const baseline = () => readFileSync(path.join(repo, BASELINE), 'utf8')
  try {
    run({ repo, home, add, lint, baseline })
  } finally {
    cleanup(dir)
  }
}

const imports = (...specs) => `${specs.map(spec => `import '${spec}'`).join('\n')}\nexport const x = 1\n`

describe('orca-stack lint module-cycle (#420)', () => {
  test('R1: a two-file cycle and a three-file cycle fail, a chain passes', () => {
    withRepo(({ add, lint }) => {
      add('src/a.mjs', imports('./b.mjs'))
      add('src/b.mjs', imports('./c.mjs'))
      add('src/c.mjs', 'export const c = 1\n')
      const chain = lint()
      assert.equal(chain.status, 0, chain.out)
      assert.equal(chain.stdout, OK(0))

      add('lib/x.mjs', imports('./y.mjs'))
      add('lib/y.mjs', imports('./x.mjs'))
      const two = lint()
      assert.equal(two.status, 1, two.out)
      assert.equal(two.stdout, `${CYCLE('lib/x.mjs', 'lib/y.mjs', 'lib/x.mjs')}\n${SUMMARY(1, 0)}`)

      add('lib/y.mjs', 'export const y = 1\n')
      add('src/c.mjs', imports('./a.mjs'))
      const three = lint()
      assert.equal(three.status, 1, three.out)
      assert.equal(three.stdout, `${CYCLE('src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/a.mjs')}\n${SUMMARY(1, 0)}`)
    })
  })

  test('R2: import from, export from and require close a cycle; packages, dynamic import() and import type do not', () => {
    withRepo(({ add, lint }) => {
      add('from/a.mjs', "import { b } from './b.mjs'\nexport const a = b\n")
      add('from/b.mjs', "import a from './a.mjs'\nexport const b = a\n")
      add('reexport/a.mjs', "export { b } from './b.mjs'\n")
      add('reexport/b.mjs', "export * from './a.mjs'\n")
      add('req/a.cjs', "const b = require('./b.cjs')\nmodule.exports = b\n")
      add('req/b.cjs', "const a = require('./a.cjs')\nmodule.exports = a\n")
      const forms = lint()
      assert.equal(forms.status, 1, forms.out)
      assert.equal(forms.stdout, [
        CYCLE('from/a.mjs', 'from/b.mjs', 'from/a.mjs'),
        CYCLE('reexport/a.mjs', 'reexport/b.mjs', 'reexport/a.mjs'),
        CYCLE('req/a.cjs', 'req/b.cjs', 'req/a.cjs'),
      ].join('\n') + `\n${SUMMARY(3, 0)}`)
    })
    withRepo(({ add, lint }) => {
      add('node_modules/fs/index.js', "import '../../pkg/a.mjs'\n")
      add('pkg/a.mjs', "import fs from 'node:fs'\nimport b from 'lodash'\nimport c from 'fs'\nexport { fs, b, c }\n")
      add('dyn/a.mjs', "const name = './b.mjs'\nexport const load = () => import(name)\nexport const lit = () => import('./b.mjs')\n")
      add('dyn/b.mjs', "export const load = () => import('./a.mjs')\n")
      add('types/a.ts', "import type { B } from './b'\nexport type A = { b: B }\n")
      add('types/b.ts', "import type { A } from './a'\nexport type { A } from './a'\nexport type B = { a: A }\n")
      const negatives = lint()
      assert.equal(negatives.status, 0, negatives.out)
      assert.equal(negatives.stdout, OK(0))
    })
  })

  test('R3: relative specifiers resolve without extension, to .ts and to /index.*; an unresolvable one is ignored', () => {
    withRepo(({ add, lint }) => {
      add('bare/a.mjs', imports('./b'))
      add('bare/b.mjs', imports('./a'))
      add('ts/a.ts', "import { b } from './b'\nexport const a = b\n")
      add('ts/b.ts', "import { a } from './a.ts'\nexport const b = a\n")
      add('idx/main.js', imports('./lib'))
      add('idx/lib/index.js', imports('../main'))
      const resolved = lint()
      assert.equal(resolved.status, 1, resolved.out)
      assert.equal(resolved.stdout, [
        CYCLE('bare/a.mjs', 'bare/b.mjs', 'bare/a.mjs'),
        CYCLE('idx/lib/index.js', 'idx/main.js', 'idx/lib/index.js'),
        CYCLE('ts/a.ts', 'ts/b.ts', 'ts/a.ts'),
      ].join('\n') + `\n${SUMMARY(3, 0)}`)
    })
    withRepo(({ add, lint }) => {
      add('src/a.mjs', imports('./missing', './missing.mjs', '../../outside.mjs', './data.json', './'))
      add('src/data.json', '{}\n')
      const missing = lint()
      assert.equal(missing.status, 0, missing.out)
      assert.equal(missing.stdout, OK(0))
    })
  })

  test('R4: the Baseline entry is the sorted member set; a shrunken cycle still passes and a new member fails', () => {
    withRepo(({ add, lint, baseline }) => {
      add('src/c.mjs', imports('./a.mjs'))
      add('src/a.mjs', imports('./b.mjs'))
      add('src/b.mjs', imports('./c.mjs'))
      const seed = lint('--sembrar')
      assert.equal(seed.status, 0, seed.out)
      assert.equal(seed.stdout, `Baseline: 1 entrada nueva en ${BASELINE}\n${OK(1)}`)
      const seeded = baseline()
      const members = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']
      assert.deepEqual(JSON.parse(seeded), {
        version: 1,
        entries: [{ rule: 'module-cycle', file: 'src/a.mjs', location: 'cycle', fingerprint: print(members), members }],
      })
      assert.equal(lint('--sembrar').stdout, `Baseline: sin cambios (${BASELINE})\n${OK(1)}`)
      assert.equal(baseline(), seeded)

      add('src/b.mjs', imports('./a.mjs'))
      const shrunk = lint()
      assert.equal(shrunk.status, 0, shrunk.out)
      assert.equal(shrunk.stdout, OK(1))

      add('src/b.mjs', imports('./c.mjs', './d.mjs'))
      add('src/d.mjs', imports('./a.mjs'))
      const grown = lint()
      assert.equal(grown.status, 1, grown.out)
      assert.equal(grown.stdout, `${CYCLE('src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/a.mjs', 'src/b.mjs', 'src/d.mjs', 'src/a.mjs')}\n${SUMMARY(1, 0)}`)
      assert.equal(baseline(), seeded)
    })
  })

  test('R4: a module-cycle entry without a members list is a malformed Baseline and is not rewritten', () => {
    withRepo(({ repo, add, lint, baseline }) => {
      add('src/a.mjs', imports('./b.mjs'))
      add('src/b.mjs', imports('./a.mjs'))
      const entry = { rule: 'module-cycle', file: 'src/a.mjs', location: 'cycle', fingerprint: print(['src/a.mjs', 'src/b.mjs']) }
      for (const members of [undefined, [], [''], 'src/a.mjs']) {
        const bad = `${JSON.stringify({ version: 1, entries: [{ ...entry, members }] })}\n`
        writeFileSync(path.join(repo, BASELINE), bad)
        for (const args of [[], ['--sembrar']]) {
          const result = lint(...args)
          assert.equal(result.status, 1, result.out)
          assert.match(result.out, /✖ \.orca-stack-baseline\.json no es una Baseline válida: la entrada 1 de module-cycle necesita members como una lista de rutas\. Arreglalo a mano: el lint no lo reescribe\./)
          assert.equal(baseline(), bad)
        }
      }
    })
  })

  test('R5: breaking one edge keeps the entry while another edge closes a cycle among its members; it is stale only when none remains', () => {
    withRepo(({ add, lint, baseline }) => {
      add('src/a.mjs', imports('./b.mjs', './c.mjs'))
      add('src/b.mjs', imports('./a.mjs'))
      add('src/c.mjs', imports('./a.mjs'))
      assert.equal(lint('--sembrar').status, 0)
      const seeded = baseline()

      add('src/a.mjs', imports('./c.mjs'))
      const oneEdge = lint()
      assert.equal(oneEdge.status, 0, oneEdge.out)
      assert.equal(oneEdge.stdout, OK(1))

      add('src/c.mjs', 'export const c = 1\n')
      const none = lint()
      assert.equal(none.status, 1, none.out)
      assert.equal(none.stdout, `${STALE(['src/a.mjs', 'src/b.mjs', 'src/c.mjs'])}\n${SUMMARY(0, 1)}`)
      assert.equal(baseline(), seeded)
    })
  })

  test('R5: in diff scope a module-cycle is always checked and its stale entries are reported', () => {
    withRepo(({ repo, add, lint, baseline }) => {
      add('.orca-stack.json', '{"ramaBase":"main","lint":{"comentarios":{"alcance":"diff"}}}\n')
      add('src/a.mjs', imports('./b.mjs'))
      add('src/b.mjs', imports('./a.mjs'))
      git(repo, 'commit', '-q', '-m', 'base')
      git(repo, 'branch', '-M', 'main')
      const fresh = lint()
      assert.equal(fresh.status, 1, fresh.out)
      assert.equal(fresh.stdout, `${CYCLE('src/a.mjs', 'src/b.mjs', 'src/a.mjs')}\n${SUMMARY(1, 0)}`)
      assert.equal(lint('--sembrar').status, 0)
      const seeded = baseline()
      add('src/b.mjs', 'export const b = 1\n')
      const stale = lint()
      assert.equal(stale.status, 1, stale.out)
      assert.equal(stale.stdout, `${STALE(['src/a.mjs', 'src/b.mjs'])}\n${SUMMARY(0, 1)}`)
      assert.equal(baseline(), seeded)
    })
  })

  test('R6: the report lists the cycle in order, closed at its smallest member, with every member of the tangle', () => {
    withRepo(({ add, lint, baseline }) => {
      add('src/z.mjs', imports('./m.mjs'))
      add('src/m.mjs', imports('./b.mjs'))
      add('src/b.mjs', imports('./z.mjs', './k.mjs'))
      add('src/k.mjs', imports('./b.mjs'))
      add('src/self.mjs', imports('./self.mjs'))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, [
        CYCLE('src/b.mjs', 'src/k.mjs', 'src/b.mjs', 'src/z.mjs', 'src/m.mjs', 'src/b.mjs'),
        CYCLE('src/self.mjs', 'src/self.mjs'),
      ].join('\n') + `\n${SUMMARY(2, 0)}`)
      assert.throws(baseline, /ENOENT/)
    })
  })

  test('R7: files of other languages never give a module-cycle finding', () => {
    withRepo(({ add, lint }) => {
      add('py/a.py', 'from . import b\nimport b\n')
      add('py/b.py', 'from . import a\nimport a\n')
      add('go/a.go', 'package a\nimport "./b"\n')
      add('go/b.go', 'package b\nimport "./a"\n')
      add('sh/a.sh', '. ./b.sh\n')
      add('sh/b.sh', '. ./a.sh\n')
      add('md/a.md', "import './b.md'\n")
      add('md/b.md', "import './a.md'\n")
      const result = lint()
      assert.equal(result.status, 0, result.out)
      assert.equal(result.stdout, OK(0))
    })
  })

  test('R9: orca-stack itself passes the lint with its seeded Baseline', () => {
    const home = tempDir('lint-cycles-self')
    try {
      const result = cli(home, ['lint'], { cwd: ROOT })
      assert.equal(result.status, 0, result.out)
    } finally {
      cleanup(home)
    }
  })

  test('S10: lint --help and the manual describe module-cycle', () => {
    const home = tempDir('lint-cycles-help')
    try {
      const help = cli(home, ['lint', '--help'])
      assert.equal(help.status, 0)
      assert.match(help.stdout, /module-cycle src\/a\.mjs → src\/b\.mjs → src\/a\.mjs — dale una dirección a los módulos/)
      assert.match(help.stdout, /"members"/)
      assert.match(cli(home, ['--help']).stdout, /^ {2}lint {6}.*module-cycle/m)
    } finally {
      cleanup(home)
    }
    const manual = readFileSync(path.join(ROOT, 'docs', 'manual.md'), 'utf8')
    assert.match(manual, /`module-cycle`/)
    assert.match(manual, /"members"/)
    assert.match(manual, /\(#420\)/)
  })
})
