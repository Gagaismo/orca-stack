import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, test } from 'node:test'

import { cleanup, cli, tempDir } from './helpers.mjs'

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
  const lint = (args = [], env = {}) => cli(home, ['lint', ...args], { cwd: repo, env: { ORCA_STACK_AST_GREP: '', ...env } })
  const baseline = () => readFileSync(path.join(repo, BASELINE), 'utf8')
  try {
    run({ dir, repo, put, add, remove, lint, baseline })
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
  '',
].join('\n')

describe('orca-stack lint comment rules (#419)', () => {
  test('S3: each Excuse example is flagged with the open-an-issue action; TODO(#123) and a temporary file pass', () => {
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

  test('S10: Go, Python, Shell and Markdown give no comment findings and never need ast-grep', () => {
    withRepo(({ dir, put, add, lint }) => {
      add('main.go', 'package main\n// TODO hack for now\nfunc main() {}\n')
      add('tool.py', '# TODO hack for now\nprint(1)\n')
      add('run.sh', '#!/bin/sh\n# TODO hack for now\necho 1\n')
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
      for (let i = 0; i < 260; i++) add(`${deep}/${deep}/file-${String(i).padStart(3, '0')}.mjs`, 'export const v = 1\n')
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
})
