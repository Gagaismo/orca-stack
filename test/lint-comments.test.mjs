import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, test } from 'node:test'

import { BIN, ROOT, cleanup, cli, tempDir } from './helpers.mjs'
import { commentViolations } from '../src/lint-comments.mjs'
import { lintCommand, seedBaseline } from '../src/lint.mjs'

const BASELINE = '.orca-stack-baseline.json'
const EXCUSE = '(Excuse) — borralo y abrí un issue para arreglar la implementación'
const OK = n => `lint OK: ninguna violación nueva ni entrada vencida (${n} en la Baseline)\n`
const SUMMARY = (found, stale) => `✖ lint: ${found} ${found === 1 ? 'violación nueva' : 'violaciones nuevas'}, ${stale} ${stale === 1 ? 'entrada vencida' : 'entradas vencidas'}\n`

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

const withRepo = run => {
  const dir = tempDir('lint-comments')
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
  const remove = rel => {
    git(repo, 'rm', '-q', '--cached', '--', rel)
    rmSync(path.join(repo, rel))
  }
  const commit = message => git(repo, 'commit', '-q', '-m', message)
  const lint = (args = [], env = {}) => cli(home, ['lint', ...args], { cwd: repo, env: { ORCA_STACK_AST_GREP: '', ...env } })
  const baseline = () => readFileSync(path.join(repo, BASELINE), 'utf8')
  const lintWithin = timeout => spawnSync(process.execPath, [BIN, 'lint'], {
    cwd: repo,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, HOME: home, USERPROFILE: home, ORCA_STACK_HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-none'), ORCA_STACK_AST_GREP: '' },
  })
  try {
    run({ dir, repo, home, put, add, remove, commit, lint, lintWithin, baseline })
  } finally {
    cleanup(dir)
  }
}

const EXCUSES = [
  'export function shortcut() {',
  '  // shortcut: in-memory, upgrade when the store lands',
  '  return 1',
  '}',
  'export function hack() {',
  '  // TODO: hack for now',
  '  return 2',
  '}',
  'export const temp = () => {',
  '  // temporary workaround',
  '  return 3',
  '}',
  'export class Store {',
  '  load() {',
  '    // FIXME',
  '    return 4',
  '  }',
  '}',
  'export function cited() {',
  '  // TODO(#123): replace the in-memory store',
  '  return 5',
  '}',
  'export function save() {',
  '  // Written to a temporary file and renamed, so a reader never sees half a file.',
  '  return 6',
  '}',
  'export function walk() {',
  '  // recorre todo el árbol y anota cada hoja',
  '  return 7',
  '}',
  '',
].join('\n')

describe('orca-stack lint comment rules (#419)', () => {
  test('S3: each Excuse example is flagged with the open-an-issue action; TODO(#123), a temporary file and a lowercase Spanish todo pass', () => {
    withRepo(({ add, lint }) => {
      add('src/excuse.mjs', EXCUSES)
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, [
        `comment-excuse src/excuse.mjs:shortcut() ${EXCUSE}`,
        `comment-excuse src/excuse.mjs:hack() ${EXCUSE}`,
        `comment-excuse src/excuse.mjs:temp() ${EXCUSE}`,
        `comment-excuse src/excuse.mjs:Store.load() ${EXCUSE}`,
        '',
      ].join('\n') + SUMMARY(4, 0))
    })
  })

  test('S2: a comment citing #n, ADR 0002 or docs/adr/0002-… passes, and "see the ADR" without a number does not', () => {
    withRepo(({ add, lint }) => {
      add('src/records.ts', [
        'export function a(): number {',
        '  // temporary workaround until #12 lands',
        '  return 1',
        '}',
        'export function b(): number {',
        '  // for now this follows adr 0002',
        '  return 2',
        '}',
        'export function c(): number {',
        '  // hack kept on purpose, see docs/adr/0002-x.md',
        '  return 3',
        '}',
        'export function d(): number {',
        '  // temporary workaround, see the ADR',
        '  return 4',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `comment-excuse src/records.ts:d() ${EXCUSE}\n${SUMMARY(1, 0)}`)
    })
  })

  test('S4: a comment that restates the next statement is a Tautology; a less clear one, a label for strings or a longer statement, and a why citing #n are not flagged', () => {
    withRepo(({ add, lint }) => {
      add('src/count.js', [
        'export function count(items) {',
        '  let i = 0',
        '  for (const item of items) {',
        '    // increment i',
        '    i++',
        '  }',
        '  // make sure the counter only grows',
        '  i++',
        '  // i++ keeps the count monotonic for the retry budget, see #416',
        '  i++',
        '  const result = i * 2',
        '  // return the result',
        '  return result',
        '}',
        'export function sync(git) {',
        '  // Fetch origin',
        "  git(['fetch', 'origin'])",
        '  // pi uninstalled',
        '  const piUninstalled = status({ piBin: null, codexBin: null })',
        '  return piUninstalled',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, [
        'comment-tautology src/count.js:count() (Tautology) — borralo',
        'comment-tautology src/count.js:count() (Tautology) — borralo',
        '',
      ].join('\n') + SUMMARY(2, 0))
    })
  })

  test('S5: a comment naming an identifier the file no longer has is Stale; an existing one, a CLI command or a plain word is not', () => {
    withRepo(({ add, lint }) => {
      add('src/stale.mjs', [
        'const helperFn = () => 1',
        'export function run() {',
        '  // calls removedFn() before the helper',
        '  // keeps `helperFn` cached between runs',
        '  // run `npm ci` and `orca-stack lint` first, see the `parse` docs',
        '  return helperFn()',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `comment-stale src/stale.mjs:run() (Stale) — borralo\n${SUMMARY(1, 0)}`)
    })
  })

  test('S5: Stale flags only a name() call neither defined nor imported in the file, never a backticked identifier', () => {
    withRepo(({ add, lint }) => {
      add('src/calls.mjs', [
        "import { importedFn } from './other.mjs'",
        'const definedFn = () => importedFn()',
        'export function run() {',
        '  // The event name the router emits is `jobs_update`; see `PI_OFFLINE` too.',
        '  // wraps `removedFn()` and `goneValue` from the old router',
        '  // calls definedFn() and importedFn() once',
        '  // calls missingFn() before returning',
        '  return definedFn()',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `comment-stale src/calls.mjs:run() (Stale) — borralo\n${SUMMARY(1, 0)}`)
    })
  })

  test('S3: Excuse ignores «Método», «todo el listado» and «the todo list», and still flags an uppercase TODO', () => {
    withRepo(({ add, lint }) => {
      add('src/words.mjs', [
        'export function later() {',
        '  // TODO: drop the cache',
        '  return 2',
        '}',
        'export function register() {',
        '  // Método que registra el complemento en el Gateway.',
        '  // Recorre todo el listado una sola vez.',
        '  // Walks the todo list once.',
        '  return 1',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `comment-excuse src/words.mjs:later() ${EXCUSE}\n${SUMMARY(1, 0)}`)
    })
  })

  test('S8: two comment lines before a later declaration do not hang the lint (#419 review)', () => {
    withRepo(({ add, lintWithin }) => {
      add('src/slow.mjs', [
        'export function run() {',
        '  // TODO: handle the error when the API returns a 500',
        '  // the upstream service is flaky in the mornings, so we retry',
        '  return call()',
        '}',
        'export function next() {',
        '  return 1',
        '}',
        '',
      ].join('\n'))
      const result = lintWithin(15000)
      assert.equal(result.error, undefined, `lint did not finish in 15 s: ${result.error}`)
      assert.equal(result.status, 1, result.stdout + result.stderr)
      assert.equal(result.stdout, `comment-excuse src/slow.mjs:run() ${EXCUSE}\n${SUMMARY(1, 0)}`)
    })
  })

  test('S6: shebangs, license headers, directives, JSDoc type annotations and strings with // are never flagged', () => {
    withRepo(({ add, lint }) => {
      add('bin/tool.mjs', [
        '#!/usr/bin/env node',
        '// Copyright 2026 Example. Licensed under MIT. TODO hack',
        '/* eslint-disable no-console -- temporary workaround */',
        '// @ts-expect-error for now',
        "/** @type {import('x').Y} TODO */",
        'let y',
        '/**',
        ' * @param {string} name hack',
        ' * @returns {string}',
        ' */',
        'export function greet(name) {',
        '  // eslint-disable-next-line no-console',
        "  console.log('// TODO: hack for now', \"/* FIXME */\", `// XXX ${name}`)",
        '  // prettier-ignore',
        '  /* c8 ignore next */',
        '  return name',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 0, result.out)
      assert.equal(result.stdout, OK(0))
    })
  })

  test('S8: comment violations seed with their symbol and fingerprint, survive moving the function and go stale when deleted', () => {
    withRepo(({ add, remove, lint, baseline }) => {
      const first = ['export function first() {', '  // TODO: first excuse', '  // temporary workaround here', '  return 1', '}', ''].join('\n')
      add('src/a.mjs', first)
      const seed = lint(['--sembrar'])
      assert.equal(seed.status, 0, seed.out)
      assert.match(seed.stdout, /^Baseline: 2 entradas nuevas en \.orca-stack-baseline\.json$/m)
      const seeded = baseline()
      const { entries } = JSON.parse(seeded)
      assert.equal(entries.length, 2)
      for (const entry of entries) {
        assert.deepEqual(Object.keys(entry).sort(), ['file', 'fingerprint', 'location', 'rule'])
        assert.equal(entry.rule, 'comment-excuse')
        assert.equal(entry.file, 'src/a.mjs')
        assert.equal(entry.location, 'first()')
        assert.match(entry.fingerprint, /^sha256:[0-9a-f]{16}$/)
      }
      assert.notEqual(entries[0].fingerprint, entries[1].fingerprint)
      assert.doesNotMatch(seeded, /"line"/)

      const again = lint(['--sembrar'])
      assert.match(again.stdout, /^Baseline: sin cambios \(\.orca-stack-baseline\.json\)$/m)
      assert.equal(baseline(), seeded)

      add('src/a.mjs', `export const before = 1\n\nexport function other() {\n  return 2\n}\n\n${first}`)
      const within = lint()
      assert.equal(within.status, 0, within.out)
      assert.equal(within.stdout, OK(2))

      remove('src/a.mjs')
      add('src/b.mjs', first)
      const moved = lint()
      assert.equal(moved.status, 0, moved.out)
      assert.equal(moved.stdout, OK(2))

      add('src/b.mjs', ['export function first() {', '  // TODO: first excuse', '  return 1', '}', ''].join('\n'))
      const deleted = lint()
      assert.equal(deleted.status, 1, deleted.out)
      assert.match(deleted.stdout, /^entrada vencida en \.orca-stack-baseline\.json: comment-excuse src\/a\.mjs \(first\(\), sha256:[0-9a-f]{16}\) — la violación ya no está en el repo: sacá esta entrada$/m)
      assert.ok(deleted.stdout.endsWith(SUMMARY(0, 1)), deleted.stdout)
      assert.equal(deleted.stdout.trimEnd().split('\n').length, 2)
      assert.equal(baseline(), seeded)
    })
  })

  test('S8: a comment before a declaration belongs to it, a free one to the module, and a nested function wins', () => {
    withRepo(({ add, lint }) => {
      add('src/where.mjs', [
        'import fs from "node:fs"',
        '// TODO: module level',
        'fs.existsSync(".")',
        '// FIXME before the declaration',
        'export const arrow = () => 1',
        'export function outer() {',
        '  const inner = function () {',
        '    // HACK inside inner',
        '    return 1',
        '  }',
        '  return inner()',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, [
        `comment-excuse src/where.mjs:<módulo> ${EXCUSE}`,
        `comment-excuse src/where.mjs:arrow() ${EXCUSE}`,
        `comment-excuse src/where.mjs:inner() ${EXCUSE}`,
        '',
      ].join('\n') + SUMMARY(3, 0))
    })
  })

  test('S10: unsupported languages (Markdown, Rust, Ruby) give no comment findings and never need ast-grep', () => {
    withRepo(({ dir, put, add, lint }) => {
      add('lib.rs', '// TODO hack for now\nfn main() {}\n')
      add('tool.rb', '# TODO hack for now\nputs 1\n')
      add('README.md', '```js\n// TODO hack for now\n```\n')
      put('untracked.mjs', '// TODO hack for now\n')
      const missing = { ORCA_STACK_AST_GREP: path.join(dir, 'missing', 'ast-grep') }
      const result = lint([], missing)
      assert.equal(result.status, 0, result.out)
      assert.equal(result.stdout, OK(0))
    })
  })

  test('S9: with a JS/TS file and no ast-grep the lint fails naming the pinned 0.51.3 instead of passing', () => {
    withRepo(({ dir, add, lint }) => {
      add('src/a.mjs', 'export const a = 1\n')
      const result = lint([], { ORCA_STACK_AST_GREP: path.join(dir, 'missing', 'ast-grep') })
      assert.equal(result.status, 1, result.out)
      assert.match(result.out, /✖ ast-grep 0\.51\.3 no está instalado: no existe .+\. Instalalo con npm ci/)
      assert.doesNotMatch(result.out, /lint OK/)
    })
  })

  test('S11: the report names rule, file, symbol, comment type and action, after long-file lines', () => {
    withRepo(({ add, lint }) => {
      add('src/x.mjs', 'export function foo() {\n  // TODO: hack for now\n  return 1\n}\n')
      add('src/y.cts', 'export function bar(): number {\n  // FIXME\n  return 1\n}\n')
      add('src/z.tsx', 'export function Baz() {\n  // XXX\n  return <div />\n}\n')
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, [
        `comment-excuse src/x.mjs:foo() ${EXCUSE}`,
        `comment-excuse src/y.cts:bar() ${EXCUSE}`,
        `comment-excuse src/z.tsx:Baz() ${EXCUSE}`,
        '',
      ].join('\n') + SUMMARY(3, 0))
    })
  })

  test('S12: every checked extension is scanned and many long paths are batched under the command-line limit', () => {
    withRepo(({ add, lint }) => {
      const extensions = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts']
      for (const ext of extensions) add(`src/f.${ext}`, 'export function f() {\n  // FIXME\n  return 1\n}\n')
      const deep = `${'deep-directory-name-'.repeat(3)}x`
      // Two grouping levels keep every directory at 15 entries or fewer, so wide-directory never fires.
      for (let i = 0; i < 260; i++) add(`${deep}/${deep}/g${Math.floor(i / 225)}/h${Math.floor(i / 15) % 15}/file-${String(i).padStart(3, '0')}.mjs`, 'export const v = 1\n')
      add(`${deep}/${deep}/last.mjs`, '// TODO: hack for now\nexport const w = 1\n')
      const result = lint()
      assert.equal(result.status, 1, result.out)
      const lines = result.stdout.trimEnd().split('\n')
      assert.deepEqual(lines.slice(0, -1).sort(), [
        `comment-excuse ${deep}/${deep}/last.mjs:<módulo> ${EXCUSE}`,
        ...extensions.map(ext => `comment-excuse src/f.${ext}:f() ${EXCUSE}`),
      ].sort())
      assert.equal(lines.at(-1), SUMMARY(9, 0).trimEnd())
    })
  })

  test('S7: by default the lint checks the whole repo, so an existing Excuse on an unchanged line is reported', () => {
    withRepo(({ repo, add, commit, lint }) => {
      add('src/old.mjs', 'export function old() {\n  // FIXME\n  return 1\n}\n')
      commit('base')
      git(repo, 'branch', '-M', 'main')
      git(repo, 'checkout', '-q', '-b', 'feature')
      add('.orca-stack.json', JSON.stringify({ ramaBase: 'main', lint: { comentarios: { alcance: 'repo' } } }))
      add('src/new.mjs', 'export const n = 1\n')
      commit('feature')
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `comment-excuse src/old.mjs:old() ${EXCUSE}\n${SUMMARY(1, 0)}`)
    })
  })

  test('S7: with lint.comentarios.alcance "diff" only comments on lines added since ramaBase are reported, committed or not', () => {
    withRepo(({ repo, put, add, commit, lint }) => {
      const long = Array.from({ length: 2001 }, (_, i) => `const v${i} = ${i}`).join('\n') + '\n'
      add('src/old.mjs', ['export function old() {', '  // FIXME', '  /*', '   * keeps the cache warm', '   */', '  return 1', '}', ''].join('\n'))
      add('src/long.mjs', long)
      commit('base')
      git(repo, 'branch', '-M', 'main')
      git(repo, 'checkout', '-q', '-b', 'feature')
      add('.orca-stack.json', JSON.stringify({ ramaBase: 'main', lint: { comentarios: { alcance: 'diff' } } }))
      add(BASELINE, JSON.stringify({ version: 1, entries: [{ rule: 'comment-excuse', file: 'src/gone.mjs', location: 'gone()', fingerprint: 'sha256:0000000000000000' }] }))
      add('src/old.mjs', ['export function old() {', '  // FIXME', '  /*', '   * keeps the cache warm', '   * temporary workaround', '   */', '  return 1', '}', ''].join('\n'))
      add('src/added.mjs', 'export function added() {\n  // TODO: hack for now\n  return 1\n}\n')
      add('src/local.ts', 'export function local(): number {\n  return 1\n}\n')
      commit('feature')
      put('src/local.ts', 'export function local(): number {\n  // XXX\n  return 1\n}\n')
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, [
        'long-file src/long.mjs: 2001 líneas (máximo 2000) — dividí el archivo',
        `comment-excuse src/added.mjs:added() ${EXCUSE}`,
        `comment-excuse src/local.ts:local() ${EXCUSE}`,
        `comment-excuse src/old.mjs:old() ${EXCUSE}`,
        '',
      ].join('\n') + SUMMARY(4, 0))
    })
  })

  test('S7: in diff mode an old baselined comment keeps its entry, so a new comment with the same text on an added line is reported', () => {
    withRepo(({ repo, add, commit, lint }) => {
      add('old.mjs', 'export function old() {\n  // FIXME\n  return 1\n}\n')
      const seed = lint(['--sembrar'])
      assert.equal(seed.status, 0, seed.out)
      git(repo, 'add', '--', BASELINE)
      commit('base')
      git(repo, 'branch', '-M', 'main')
      git(repo, 'checkout', '-q', '-b', 'feature')
      add('.orca-stack.json', JSON.stringify({ ramaBase: 'main', lint: { comentarios: { alcance: 'diff' } } }))
      add('new.mjs', 'export function fresh() {\n  // FIXME\n  return 1\n}\n')
      commit('feature')
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `comment-excuse new.mjs:fresh() ${EXCUSE}\n${SUMMARY(1, 0)}`)
    })
  })

  test('S7: in diff mode an identical comment added above a baselined one in the same symbol is reported', () => {
    withRepo(({ repo, add, commit, lint }) => {
      add('old.mjs', 'export function old() {\n  // FIXME\n  return 1\n}\n')
      const seed = lint(['--sembrar'])
      assert.equal(seed.status, 0, seed.out)
      git(repo, 'add', '--', BASELINE)
      commit('base')
      git(repo, 'branch', '-M', 'main')
      git(repo, 'checkout', '-q', '-b', 'feature')
      add('.orca-stack.json', JSON.stringify({ ramaBase: 'main', lint: { comentarios: { alcance: 'diff' } } }))
      add('old.mjs', 'export function old() {\n  // FIXME\n  // FIXME\n  return 1\n}\n')
      commit('feature')
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `comment-excuse old.mjs:old() ${EXCUSE}\n${SUMMARY(1, 0)}`)
    })
  })

  test('S7: in diff mode added lines are found in files whose names have a space or non-ASCII characters', () => {
    withRepo(({ repo, add, commit, lint }) => {
      add('src/a.mjs', 'export const a = 1\n')
      commit('base')
      git(repo, 'branch', '-M', 'main')
      git(repo, 'checkout', '-q', '-b', 'feature')
      add('.orca-stack.json', JSON.stringify({ ramaBase: 'main', lint: { comentarios: { alcance: 'diff' } } }))
      add('with space.mjs', 'export function spaced() {\n  // TODO: hack for now\n  return 1\n}\n')
      add('dir ñ/año.mjs', 'export function year() {\n  // FIXME\n  return 1\n}\n')
      commit('feature')
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, [
        `comment-excuse dir ñ/año.mjs:year() ${EXCUSE}`,
        `comment-excuse with space.mjs:spaced() ${EXCUSE}`,
        '',
      ].join('\n') + SUMMARY(2, 0))
    })
  })

  test('S7: in diff mode added lines are found in a file whose name git C-quotes', { skip: process.platform === 'win32' && 'Windows forbids " and \\ in file names' }, () => {
    withRepo(({ repo, add, commit, lint }) => {
      add('src/a.mjs', 'export const a = 1\n')
      commit('base')
      git(repo, 'branch', '-M', 'main')
      git(repo, 'checkout', '-q', '-b', 'feature')
      add('.orca-stack.json', JSON.stringify({ ramaBase: 'main', lint: { comentarios: { alcance: 'diff' } } }))
      add('say "hi" \\ año.mjs', 'export function quoted() {\n  // FIXME\n  return 1\n}\n')
      commit('feature')
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, `comment-excuse say "hi" \\ año.mjs:quoted() ${EXCUSE}\n${SUMMARY(1, 0)}`)
    })
  })

  test('S7: an invalid lint.comentarios.alcance fails naming the key', () => {
    withRepo(({ put, add, lint }) => {
      add('src/a.mjs', 'export const a = 1\n')
      put('.orca-stack.local.json', JSON.stringify({ lint: { comentarios: { alcance: 'cambios' } } }))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.match(result.out, /✖ lint\.comentarios\.alcance tiene que ser "repo" o "diff", no "cambios"/)
      assert.doesNotMatch(result.out, /lint OK/)
    })
  })

  test('S7: in diff mode a ramaBase that does not resolve, or has no merge-base with HEAD, fails naming the ref', () => {
    withRepo(({ repo, put, add, commit, lint }) => {
      add('src/a.mjs', 'export const a = 1\n')
      commit('base')
      put('.orca-stack.json', JSON.stringify({ ramaBase: 'nope', lint: { comentarios: { alcance: 'diff' } } }))
      const missing = lint()
      assert.equal(missing.status, 1, missing.out)
      assert.match(missing.out, /✖ lint\.comentarios\.alcance "diff": no se encontró la rama base nope ni origin\/nope/)

      const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
      git(repo, 'checkout', '-q', '--orphan', 'other')
      commit('unrelated')
      git(repo, 'checkout', '-q', branch)
      put('.orca-stack.json', JSON.stringify({ ramaBase: 'other', lint: { comentarios: { alcance: 'diff' } } }))
      const unrelated = lint()
      assert.equal(unrelated.status, 1, unrelated.out)
      assert.match(unrelated.out, /✖ lint\.comentarios\.alcance "diff": HEAD no tiene merge-base con other/)

      put('.orca-stack.json', JSON.stringify({ lint: { comentarios: { alcance: 'diff' } } }))
      const noBase = lint()
      assert.equal(noBase.status, 1, noBase.out)
      assert.match(noBase.out, /✖ lint\.comentarios\.alcance "diff" necesita ramaBase/)
    })
  })

  test('S15: lint --help and the manual describe the comment rules, the Decision Record, ast-grep 0.51.3 and lint.comentarios.alcance', () => {
    const home = tempDir('lint-comments-help')
    let help
    try {
      help = cli(home, ['lint', '--help'])
    } finally {
      cleanup(home)
    }
    assert.equal(help.status, 0)
    const manual = readFileSync(path.join(ROOT, 'docs', 'manual.md'), 'utf8')
    for (const text of [help.stdout, manual]) {
      for (const rule of ['comment-excuse', 'comment-tautology', 'comment-stale']) assert.ok(text.includes(rule), rule)
      assert.match(text, /Decision Record/)
      assert.match(text, /ast-grep 0\.51\.3/)
      assert.match(text, /npm ci/)
      assert.match(text, /lint\.comentarios\.alcance/)
      assert.match(text, /"diff"/)
      assert.match(text, /Go, Python, Shell/)
      assert.match(text, /no está definida ni importada en el archivo/)
      assert.match(text, /entre backticks nunca se marca/)
      assert.match(text, /comment-excuse src\/x\.mjs:foo\(\) \(Excuse\) — borralo y abrí un issue para arreglar la implementación/)
    }
  })
})

describe('owner/repo#n Decision Record citations (#517)', () => {
  test('R1: owner/repo#n is recognized as a Decision Record citation in # and // comments', () => {
    withRepo(({ add, lint }) => {
      add('scripts/worktree.sh', [
        '#!/usr/bin/env bash',
        '# Gagaismo/orca-stack#432: literal paths only (Orca skips globs and negations); never list secrets such as .env files.',
        'run_check() {',
        '  # Gagaismo/orca-stack#432: temporary workaround — literal paths only (Orca skips globs and negations); never list secrets such as .env files.',
        '  echo "ok"',
        '}',
        '',
      ].join('\n'))
      add('src/records.ts', [
        'export function a(): number {',
        '  // temporary workaround, see Gagaismo/orca-stack#432',
        '  return 1',
        '}',
        'export function b(): number {',
        '  // TODO(Gagaismo/orca-stack#487): remove once lockfile setup lands',
        '  return 2',
        '}',
        'export function c(): number {',
        '  // hack kept per my-org/my.repo_1#9',
        '  return 3',
        '}',
        'export function d(): number {',
        '  // for now follows a/b#1',
        '  return 4',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 0, result.out)
      assert.equal(result.stdout, OK(0))
    })
  })

  test('R2: existing Decision Record forms (#n, ADR 0002, docs/adr/0002-…) still pass', () => {
    withRepo(({ add, lint }) => {
      add('src/existing.mjs', [
        'export function a() {',
        '  // ver #12',
        '  // temporary workaround, ver #12',
        '  return 1',
        '}',
        'export function b() {',
        '  // docs/adr/0002-deprecate-ponytail-adopt-comment-rule.md',
        '  // for now see docs/adr/0002-deprecate-ponytail-adopt-comment-rule.md',
        '  return 2',
        '}',
        '',
      ].join('\n'))
      add('scripts/existing.sh', [
        '#!/usr/bin/env bash',
        'run_task() {',
        '  # ADR 0002: comment rule applies here',
        '  # hack kept under ADR 0002: comment rule',
        '  echo "ok"',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 0, result.out)
      assert.equal(result.stdout, OK(0))
    })
  })

  test('R3: negative: incomplete citations without owner/repo#n are still reported', () => {
    withRepo(({ add, lint }) => {
      add('scripts/bad-citations.sh', [
        '#!/usr/bin/env bash',
        'f1() {',
        '  # literal paths only — temporary workaround',
        '  echo 1',
        '}',
        'f2() {',
        '  # orca-stack#432: temporary workaround',
        '  echo 2',
        '}',
        'f3() {',
        '  # foo#12 bar temporary workaround',
        '  echo 3',
        '}',
        'f4() {',
        '  # Gagaismo/#12 temporary workaround',
        '  echo 4',
        '}',
        '',
      ].join('\n'))
      const result = lint()
      assert.equal(result.status, 1, result.out)
      assert.equal(result.stdout, [
        `comment-excuse scripts/bad-citations.sh:f1() ${EXCUSE}`,
        `comment-excuse scripts/bad-citations.sh:f2() ${EXCUSE}`,
        `comment-excuse scripts/bad-citations.sh:f3() ${EXCUSE}`,
        `comment-excuse scripts/bad-citations.sh:f4() ${EXCUSE}`,
        '',
      ].join('\n') + SUMMARY(4, 0))
    })
  })

  test('R6: lint has no --fix flag and rejects --fix without modifying files with owner/repo#n comments', () => {
    withRepo(({ repo, add, lint }) => {
      const content = [
        '#!/usr/bin/env bash',
        '# Gagaismo/orca-stack#432: literal paths only',
        'echo "ok"',
        '',
      ].join('\n')
      add('scripts/keep.sh', content)
      const result = lint(['--fix'])
      assert.equal(result.status, 2, result.out)
      assert.match(result.out, /^Opción desconocida: --fix/m)
      assert.equal(readFileSync(path.join(repo, 'scripts/keep.sh'), 'utf8'), content)
    })
  })

  test('R7: lint --help and docs/manual.md mention owner/repo#n in the Decision Record comment rule', () => {
    const home = tempDir('lint-comments-help-517')
    let help
    try {
      help = cli(home, ['lint', '--help'])
    } finally {
      cleanup(home)
    }
    assert.equal(help.status, 0, help.out)
    const manual = readFileSync(path.join(ROOT, 'docs', 'manual.md'), 'utf8')
    assert.match(help.stdout, /Un comentario que cita un issue \(#123 o owner\/repo#123\), un ADR \(ADR 0002\) o docs\/adr\/0002-… es un Decision Record y pasa\./)
    assert.match(manual, /Un comentario que cita un issue \(`#123` o `owner\/repo#123`\), un ADR \(`ADR 0002`\) o un link a `docs\/adr\/0002-…` es un Decision Record y pasa/)
  })

  test('PRESERVE: commentViolations reports Excuse, Tautology and Stale while exempting owner/repo#n Decision Records', () => {
    withRepo(({ repo, add }) => {
      add('src/preserve.mjs', [
        'export function cited() {',
        '  // temporary workaround, see Gagaismo/orca-stack#432',
        '  return 1',
        '}',
        'export function excuse(i) {',
        '  // TODO: drop hack',
        '  let x = i',
        '  // increment i',
        '  i++',
        '  // calls goneFn() here',
        '  return i + x',
        '}',
        '',
      ].join('\n'))
      const violations = commentViolations(repo, ['src/preserve.mjs'])
      assert.deepEqual(
        violations.map(({ rule, location }) => ({ rule, location })),
        [
          { rule: 'comment-excuse', location: 'excuse()' },
          { rule: 'comment-tautology', location: 'excuse()' },
          { rule: 'comment-stale', location: 'excuse()' },
        ],
      )
    })
  })

  test('PRESERVE: seedBaseline and lintCommand seed uncited comment violations and skip owner/repo#n Decision Records', async t => {
    let result
    await new Promise(resolve => {
      withRepo(async ({ repo, home, add, baseline }) => {
        add('src/preserve.mjs', [
          'export function cited() {',
          '  // temporary workaround, see Gagaismo/orca-stack#432',
          '  return 1',
          '}',
          'export function uncited() {',
          '  // temporary workaround',
          '  return 2',
          '}',
          '',
        ].join('\n'))
        const seeded = seedBaseline(repo, { home })
        assert.equal(seeded.added, 1)
        const entries = JSON.parse(baseline()).entries
        assert.deepEqual(entries.map(({ rule, file, location }) => ({ rule, file, location })), [
          { rule: 'comment-excuse', file: 'src/preserve.mjs', location: 'uncited()' },
        ])
        const out = []
        t.mock.method(console, 'log', (...args) => out.push(args.join(' ')))
        const status = await lintCommand({}, { cwd: repo, home })
        t.mock.restoreAll()
        result = { status, out: out.join('\n') }
        resolve()
      })
    })
    assert.equal(result.status, 0, result.out)
    assert.equal(result.out, OK(1).trimEnd())
  })
})
