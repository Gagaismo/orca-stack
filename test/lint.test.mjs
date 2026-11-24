import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, test } from 'node:test'

import { parseArgs } from '../src/cli.mjs'
import { ROOT, cleanup, cli, tempDir } from './helpers.mjs'

const BASELINE = '.orca-stack-baseline.json'

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

// A file of exactly n lines whose first lines carry its id, so two ids give two different fingerprints.
const lines = (n, id) => Array.from({ length: n }, (_, i) => {
  if (i < 3) return `// file ${id} header ${i}`
  if (i % 10 === 0) return ''
  if (i % 7 === 0) return '// a comment line'
  return `const line${i} = ${i}`
}).join('\n') + '\n'

const withRepo = run => {
  const dir = tempDir('lint')
  const repo = path.join(dir, 'repo')
  const home = path.join(dir, 'home')
  mkdirSync(repo)
  mkdirSync(home)
  git(repo, 'init', '-q')
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    writeFileSync(path.join(repo, rel), text)
  }
  const add = (rel, text) => {
    put(rel, text)
    git(repo, 'add', '--', rel)
  }
  const lint = (...args) => cli(home, ['lint', ...args], { cwd: repo })
  const baseline = () => readFileSync(path.join(repo, BASELINE), 'utf8')
  try {
    run({ dir, repo, home, put, add, lint, baseline })
  } finally {
    cleanup(dir)
  }
}

const VIOLATION = 'long-file test/big.test.mjs: 2345 líneas (máximo 2000) — dividí el archivo'
const OK = n => `lint OK: ninguna violación nueva ni entrada vencida (${n} en la Baseline)\n`

describe('orca-stack lint (#417)', () => {
  test('R1: a tracked file over 2,000 lines is a long-file violation and exactly 2,000 lines passes', () => {
    withRepo(({ add, lint }) => {
      add('src/edge.mjs', lines(2000, 'edge'))
      add('test/edge.test.mjs', lines(2000, 'edge-test'))
      const edge = lint()
      assert.equal(edge.status, 0, edge.out)
      assert.equal(edge.stdout, OK(0))

      add('test/over.test.mjs', lines(2001, 'over'))
      const over = lint()
      assert.equal(over.status, 1, over.out)
      assert.match(over.stdout, /^long-file test\/over\.test\.mjs: 2001 líneas \(máximo 2000\) — dividí el archivo$/m)
      assert.doesNotMatch(over.stdout, /edge/)
    })
  })

  test('R2: each failing line names the rule, the file, the location and the action', () => {
    withRepo(({ add, lint }) => {
      add('test/big.test.mjs', lines(2345, 'big'))
      add('src/small.mjs', lines(10, 'small'))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `${VIOLATION}\n✖ lint: 1 violación nueva, 0 entradas vencidas\n`)
    })
  })

  test('R3: exit 0 with a one-line OK on a clean repo with no Baseline, non-zero with the report otherwise', () => {
    withRepo(({ add, lint }) => {
      add('README.md', 'hola\n')
      const clean = lint()
      assert.equal(clean.status, 0, clean.out)
      assert.equal(clean.stdout, OK(0))
      assert.equal(clean.stdout.trimEnd().split('\n').length, 1)

      add('test/big.test.mjs', lines(2345, 'big'))
      const dirty = lint()
      assert.notEqual(dirty.status, 0)
      assert.ok(dirty.stdout.split(/\r?\n/).includes(VIOLATION), dirty.stdout)

      assert.equal(lint('--sembrar').status, 0)
      const baselined = lint()
      assert.equal(baselined.status, 0, baselined.out)
      assert.equal(baselined.stdout, OK(1))
    })
  })

  test('R4: a Baseline entry holds rule, file, location and fingerprint, never a line number, and lines added elsewhere do not change it', () => {
    withRepo(({ add, lint, baseline }) => {
      add('test/big.test.mjs', lines(2345, 'big'))
      assert.equal(lint('--sembrar').status, 0)
      const seeded = baseline()
      const parsed = JSON.parse(seeded)
      assert.equal(parsed.version, 1)
      assert.equal(parsed.entries.length, 1)
      const [entry] = parsed.entries
      assert.deepEqual(Object.keys(entry).sort(), ['file', 'fingerprint', 'location', 'rule'])
      assert.equal(entry.rule, 'long-file')
      assert.equal(entry.file, 'test/big.test.mjs')
      assert.equal(entry.location, 'file')
      assert.match(entry.fingerprint, /^sha256:[0-9a-f]{16}$/)
      assert.doesNotMatch(seeded, /2345|"line"/)

      add('test/big.test.mjs', lines(2345, 'big') + lines(300, 'appended'))
      const grown = lint()
      assert.equal(grown.status, 0, grown.out)
      assert.equal(lint('--sembrar').status, 0)
      assert.equal(baseline(), seeded)
    })
  })

  test('R5: moved code keeps matching its entry, and a new violation is reported together with a stale entry', () => {
    withRepo(({ repo, add, lint, baseline }) => {
      add('test/big.test.mjs', lines(2345, 'big'))
      assert.equal(lint('--sembrar').status, 0)
      const seeded = baseline()

      git(repo, 'mv', 'test/big.test.mjs', 'test/moved.test.mjs')
      const moved = lint()
      assert.equal(moved.status, 0, moved.out)
      assert.equal(moved.stdout, OK(1))

      add('test/moved.test.mjs', lines(100, 'big'))
      add('test/other.test.mjs', lines(2345, 'big'))
      const elsewhere = lint()
      assert.equal(elsewhere.status, 0, `the same fingerprint still violates in another file: ${elsewhere.out}`)

      add('test/other.test.mjs', lines(2345, 'big').replace('const line51 = 51', 'const changed = 51'))
      const sameHeader = lint()
      assert.equal(sameHeader.status, 1, `a shared header with another body is a new violation: ${sameHeader.out}`)

      add('test/other.test.mjs', lines(2400, 'other'))
      const both = lint()
      assert.equal(both.status, 1, both.out)
      assert.match(both.stdout, /^long-file test\/other\.test\.mjs: 2400 líneas \(máximo 2000\) — dividí el archivo$/m)
      assert.match(both.stdout, /^entrada vencida en \.orca-stack-baseline\.json: long-file test\/big\.test\.mjs \(file, sha256:[0-9a-f]{16}\) — la violación ya no está en el repo: sacá esta entrada$/m)
      assert.match(both.stdout, /✖ lint: 1 violación nueva, 1 entrada vencida\n$/)
      assert.equal(baseline(), seeded)
    })
  })

  test('R5: a copy of a baselined violation in another file fails while the original still violates', () => {
    withRepo(({ add, lint }) => {
      add('test/big.test.mjs', lines(2345, 'big'))
      assert.equal(lint('--sembrar').status, 0)
      add('test/copy.test.mjs', lines(2345, 'big'))
      const copy = lint()
      assert.equal(copy.status, 1, copy.out)
      assert.equal(copy.stdout, 'long-file test/copy.test.mjs: 2345 líneas (máximo 2000) — dividí el archivo\n✖ lint: 1 violación nueva, 0 entradas vencidas\n')
    })
  })

  test('R6: a stale entry fails, names the entry and asks for its removal, and the check never rewrites the Baseline', () => {
    withRepo(({ add, lint, baseline }) => {
      add('test/big.test.mjs', lines(2345, 'big'))
      assert.equal(lint('--sembrar').status, 0)
      const seeded = baseline()
      const { fingerprint } = JSON.parse(seeded).entries[0]

      add('test/big.test.mjs', lines(1500, 'big'))
      const stale = lint()
      assert.equal(stale.status, 1, stale.out)
      assert.equal(stale.stdout, `entrada vencida en .orca-stack-baseline.json: long-file test/big.test.mjs (file, ${fingerprint}) — la violación ya no está en el repo: sacá esta entrada\n✖ lint: 0 violaciones nuevas, 1 entrada vencida\n`)
      assert.equal(baseline(), seeded)
      assert.equal(lint().status, 1)
      assert.equal(baseline(), seeded)
    })
  })

  test('R7: --sembrar records every current violation, a second run changes nothing and an entry whose violation exists is kept', () => {
    withRepo(({ repo, add, lint, baseline }) => {
      add('test/big.test.mjs', lines(2345, 'big'))
      add('src/huge.mjs', lines(3000, 'huge'))
      const first = lint('--sembrar')
      assert.equal(first.status, 0, first.out)
      assert.match(first.stdout, /^Baseline: 2 entradas nuevas en \.orca-stack-baseline\.json$/m)
      assert.deepEqual(JSON.parse(baseline()).entries.map(entry => entry.file), ['src/huge.mjs', 'test/big.test.mjs'])
      const seeded = baseline()

      const second = lint('--sembrar')
      assert.equal(second.status, 0, second.out)
      assert.match(second.stdout, /^Baseline: sin cambios \(\.orca-stack-baseline\.json\)$/m)
      assert.equal(baseline(), seeded)

      add('src/new.mjs', lines(2100, 'new'))
      const dryRun = lint('--sembrar', '--dry-run')
      assert.equal(dryRun.status, 1, dryRun.out)
      assert.match(dryRun.out, /✖ lint no acepta --dry-run/)
      assert.equal(baseline(), seeded)
      git(repo, 'rm', '-q', '--cached', 'src/new.mjs')

      git(repo, 'mv', 'src/huge.mjs', 'src/renamed.mjs')
      const afterMove = lint('--sembrar')
      assert.equal(afterMove.status, 0, afterMove.out)
      assert.equal(baseline(), seeded)
      assert.deepEqual(JSON.parse(baseline()).entries.map(entry => entry.file), ['src/huge.mjs', 'test/big.test.mjs'])
    })
  })

  test('R8: a missing Baseline counts as empty and a malformed one fails naming the file without being overwritten', () => {
    withRepo(({ put, add, lint, baseline }) => {
      add('test/big.test.mjs', lines(2345, 'big'))
      const missing = lint()
      assert.equal(missing.status, 1, missing.out)
      assert.ok(missing.stdout.split(/\r?\n/).includes(VIOLATION), missing.stdout)

      for (const bad of ['{ not json', '{"version":1,"entries":[{"rule":"long-file"}]}', '[]']) {
        put(BASELINE, bad)
        for (const args of [[], ['--sembrar']]) {
          const result = lint(...args)
          assert.equal(result.status, 1, result.out)
          assert.match(result.out, /✖ \.orca-stack-baseline\.json no es una Baseline válida: .+\. Arreglalo a mano: el lint no lo reescribe\./)
          assert.equal(baseline(), bad)
        }
      }
    })
  })

  test('R9: untracked and ignored files are never checked', () => {
    withRepo(({ put, add, lint }) => {
      add('.gitignore', 'node_modules/\n*.log\n')
      put('untracked.mjs', lines(2500, 'untracked'))
      put('node_modules/dep/index.js', lines(2500, 'dep'))
      put('build.log', lines(2500, 'log'))
      const result = lint()
      assert.equal(result.status, 0, result.out)
      assert.equal(result.stdout, OK(0))
    })
  })

  test('R10: CI runs orca-stack lint in a job that ci-ok requires', () => {
    const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    const job = workflow.match(/^ {2}lint:\r?\n(?: {4}.*\r?\n|\r?\n)+/m)?.[0] ?? ''
    assert.match(job, /^ {8}run: node bin\/orca-stack\.mjs lint\r?$/m)
    const ciOk = workflow.slice(workflow.indexOf('\n  ci-ok:'))
    assert.match(ciOk, /^ {6}- lint\r?$/m)
  })

  test('R10: the pre-push hook runs the lint as an early warning and --no-verify skips only the hook', () => {
    withRepo(({ dir, repo, add }) => {
      const remote = path.join(dir, 'remote.git')
      git(dir, 'init', '-q', '--bare', remote)
      git(repo, 'remote', 'add', 'origin', remote)
      add('test/big.test.mjs', lines(2345, 'big'))
      git(repo, 'commit', '-q', '-m', 'add a long file')
      const hooks = path.join(ROOT, '.githooks').replaceAll('\\', '/')
      const push = (...extra) => spawnSync('git', ['-c', `core.hooksPath=${hooks}`, 'push', ...extra, 'origin', 'HEAD:refs/heads/main'], { cwd: repo, encoding: 'utf8' })

      const blocked = push()
      assert.notEqual(blocked.status, 0, blocked.stderr)
      assert.match(blocked.stdout + blocked.stderr, /long-file test\/big\.test\.mjs: 2345 líneas \(máximo 2000\) — dividí el archivo/)
      assert.equal(spawnSync('git', ['ls-remote', remote], { encoding: 'utf8' }).stdout, '')

      const skipped = push('--no-verify')
      assert.equal(skipped.status, 0, skipped.stderr)
      assert.match(spawnSync('git', ['ls-remote', remote], { encoding: 'utf8' }).stdout, /refs\/heads\/main/)
    })
  })

  test('R12: lint --help and the manual describe the command, the Baseline and --sembrar', () => {
    const home = tempDir('lint-help')
    try {
      const help = cli(home, ['lint', '--help'])
      assert.equal(help.status, 0)
      assert.match(help.stdout, /^orca-stack lint \[--sembrar\]/)
      assert.match(help.stdout, /long-file/)
      assert.match(help.stdout, /\.orca-stack-baseline\.json/)
      assert.match(help.stdout, /--sembrar/)
      const usage = cli(home, ['--help'])
      assert.match(usage.stdout, /^ {2}lint {6}/m)
      assert.match(usage.stdout, /--sembrar +\(lint\)/)
    } finally {
      cleanup(home)
    }
    const manual = readFileSync(path.join(ROOT, 'docs', 'manual.md'), 'utf8')
    assert.match(manual, /^#### `lint`$/m)
    assert.match(manual, /\| `lint` \|/)
    assert.match(manual, /\.orca-stack-baseline\.json/)
    assert.match(manual, /--sembrar/)
    assert.match(manual, /core\.hooksPath \.githooks/)
  })

  test('PRESERVE: parseArgs takes --sembrar only for lint and keeps refusing it elsewhere', () => {
    assert.equal(parseArgs(['lint', '--sembrar']).flags.sembrar, true)
    assert.equal(parseArgs(['lint']).flags.sembrar, undefined)
    assert.throws(() => parseArgs(['estado', '--sembrar']), /^Error: Opción desconocida: --sembrar$/)
    assert.equal(parseArgs(['estado', '70', '--json']).flags.json, true)
  })

})

// n tracked files directly inside dir, named so they never collide with anything else a test adds there.
const fill = (add, dir, n, ext = 'txt') => {
  for (let i = 1; i <= n; i += 1) add(`${dir}/f${String(i).padStart(2, '0')}.${ext}`, `${dir} ${i}\n`)
}

const WIDE = (dir, n) => `wide-directory ${dir}: ${n} entradas (máximo 15) — agrupá los archivos relacionados en subdirectorios`

describe('orca-stack lint wide-directory (#418)', () => {
  test('R1: a directory with 16 entries is a wide-directory violation and exactly 15 passes', () => {
    withRepo(({ add, lint }) => {
      fill(add, 'edge', 15)
      const edge = lint()
      assert.equal(edge.status, 0, edge.out)
      assert.equal(edge.stdout, OK(0))

      fill(add, 'over', 16)
      const over = lint()
      assert.equal(over.status, 1, over.out)
      assert.equal(over.stdout, `${WIDE('over/', 16)}\n✖ lint: 1 violación nueva, 0 entradas vencidas\n`)
    })
  })

  test('R2: tracked files and subdirectories holding tracked files count; ignored, untracked, empty directories and node_modules do not', () => {
    withRepo(({ repo, put, add, lint }) => {
      add('.gitignore', '*.log\n')
      fill(add, 'pkg', 13)
      add('pkg/sub/deep/inner.txt', 'counts once as pkg/sub\n')
      add('pkg/other/a.txt', 'a\n')
      add('pkg/other/b.txt', 'b\n')
      put('pkg/ignored.log', 'ignored\n')
      put('pkg/untracked.txt', 'untracked\n')
      put('pkg/untracked-dir/x.txt', 'only untracked inside\n')
      mkdirSync(path.join(repo, 'pkg', 'empty'))
      add('pkg/node_modules/dep/index.js', 'tracked on purpose\n')
      fill(add, 'pkg/node_modules/dep/lib', 20, 'js')
      const fifteen = lint()
      assert.equal(fifteen.status, 0, fifteen.out)
      assert.equal(fifteen.stdout, OK(0))

      add('pkg/f14.txt', 'the sixteenth entry\n')
      const sixteen = lint()
      assert.equal(sixteen.status, 1, sixteen.out)
      assert.equal(sixteen.stdout, `${WIDE('pkg/', 16)}\n✖ lint: 1 violación nueva, 0 entradas vencidas\n`)
    })
  })

  test('R3: the check is language-agnostic, including the repository root', () => {
    withRepo(({ add, lint }) => {
      const names = ['main.go', 'app.py', 'lib.rs', 'run.sh', 'index.ts', 'Main.java', 'notes.md', 'Makefile', 'data.json', 'style.css', 'page.html', 'query.sql', 'conf.yaml', 'mod.rb', 'prog.c', 'head.h']
      for (const name of names) add(`mixed/${name}`, `${name}\n`)
      for (const name of names) add(name, `${name}\n`)
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `${WIDE('./', 17)}\n${WIDE('mixed/', 16)}\n✖ lint: 2 violaciones nuevas, 0 entradas vencidas\n`)
    })
  })

  test('R4: the Baseline entry is the rule and the directory path; it leaves only at 15 entries or fewer, and a rename is a new violation plus a stale entry', () => {
    withRepo(({ repo, add, lint, baseline }) => {
      fill(add, 'docs', 16)
      assert.equal(lint('--sembrar').status, 0)
      const seeded = baseline()
      const [entry] = JSON.parse(seeded).entries
      assert.deepEqual(Object.keys(entry).sort(), ['file', 'fingerprint', 'location', 'rule'])
      assert.equal(entry.rule, 'wide-directory')
      assert.equal(entry.file, 'docs/')
      assert.equal(entry.location, 'directory')
      assert.match(entry.fingerprint, /^sha256:[0-9a-f]{16}$/)
      assert.doesNotMatch(seeded, /"16"|: 16|"line"/)

      add('docs/f17.txt', 'grows\n')
      const grown = lint()
      assert.equal(grown.status, 0, grown.out)
      assert.equal(grown.stdout, OK(1))

      git(repo, 'mv', 'docs', 'guide')
      const renamed = lint()
      assert.equal(renamed.status, 1, renamed.out)
      assert.equal(renamed.stdout, `${WIDE('guide/', 17)}\nentrada vencida en .orca-stack-baseline.json: wide-directory docs/ (directory, ${entry.fingerprint}) — la violación ya no está en el repo: sacá esta entrada\n✖ lint: 1 violación nueva, 1 entrada vencida\n`)
      assert.equal(baseline(), seeded)
      const reseeded = lint('--sembrar')
      assert.equal(reseeded.status, 1, reseeded.out)
      assert.deepEqual(JSON.parse(baseline()).entries.map(one => one.file), ['docs/', 'guide/'])

      git(repo, 'mv', 'guide', 'docs')
      git(repo, 'rm', '-q', '--cached', 'docs/f16.txt', 'docs/f17.txt')
      const shrunk = lint()
      assert.equal(shrunk.status, 1, shrunk.out)
      assert.match(shrunk.stdout, /^entrada vencida en \.orca-stack-baseline\.json: wide-directory docs\/ \(directory, sha256:[0-9a-f]{16}\)/m)
      assert.match(shrunk.stdout, /^entrada vencida en \.orca-stack-baseline\.json: wide-directory guide\/ /m)
    })
  })

  test('R7: orca-stack itself passes the lint with its seeded Baseline', () => {
    const home = tempDir('lint-self')
    try {
      const result = cli(home, ['lint'], { cwd: ROOT })
      assert.equal(result.status, 0, result.out)
      const entries = JSON.parse(readFileSync(path.join(ROOT, BASELINE), 'utf8')).entries
      for (const dir of ['src/', 'test/']) {
        assert.ok(entries.some(one => one.rule === 'wide-directory' && one.file === dir), `${dir} is not in the Baseline`)
      }
    } finally {
      cleanup(home)
    }
  })

  test('R8: lint --help and the manual list wide-directory', () => {
    const home = tempDir('lint-help-wide')
    try {
      const help = cli(home, ['lint', '--help'])
      assert.equal(help.status, 0)
      assert.match(help.stdout, /wide-directory: un directorio con más de 15 entradas es una violación/)
      assert.match(help.stdout, /wide-directory src\/: 37 entradas \(máximo 15\) — agrupá los archivos relacionados en subdirectorios/)
      assert.match(cli(home, ['--help']).stdout, /^ {2}lint {6}.*wide-directory/m)
    } finally {
      cleanup(home)
    }
    const manual = readFileSync(path.join(ROOT, 'docs', 'manual.md'), 'utf8')
    assert.match(manual, /\| `lint` \| Revisa el repo contra su Baseline \(`long-file`, `wide-directory`\)/)
    assert.match(manual, /`wide-directory`: un directorio con más de 15 entradas es una violación/)
  })
})
