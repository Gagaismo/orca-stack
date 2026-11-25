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
const CYCLE = (...pkgs) => `module-cycle ${pkgs.join(' → ')} — dale una dirección a los módulos`
const LAYER = '¿cuál es la capa de abstracción buscada? ¿Qué módulo va en qué capa?'
const TANGLE = (members, modules) => `tangle ${members.join(', ')}: ${members.length} cosas en ${modules} ${modules === 1 ? 'módulo' : 'módulos'} (máximo 7 cosas en un solo módulo) — ${LAYER}`
const SHALLOW = (pkg, shown, total) => `shallow-module ${pkg}: muestra ${shown.length} de ${total} funciones (${shown.join(', ')}) y esconde ${total - shown.length} (máximo 7 mostradas, o más escondidas que mostradas) — ¿por qué existen estas funciones? ¿Cuáles son sus patrones de uso? ¿Se pueden esconder detrás de una interfaz angosta?`
const STALE_ENTRY = (rule, file, location, fingerprint) => `entrada vencida en ${BASELINE}: ${rule} ${file} (${location}, ${fingerprint}) — la violación ya no está en el repo: sacá esta entrada`

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

const withRepo = run => {
  const dir = tempDir('lint-go')
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

const GO_MOD = 'module example.com/app\n\ngo 1.22\n'

const QUEUE_GO = [
  'package queue',
  '',
  'type Queue struct {',
  '\tItems []int',
  '\tlimit int',
  '}',
  '',
  'func (q *Queue) Push(x int) {',
  '\tif len(q.Items) < q.limit {',
  '\t\tq.Items = append(q.Items, x)',
  '\t}',
  '}',
  '',
  'func (q *Queue) Size() int {',
  '\treturn len(q.Items)',
  '}',
  '',
].join('\n')

const COUNTER_GO = [
  'package counter',
  '',
  'type Counter struct {',
  '\tCount int',
  '}',
  '',
  'func (c *Counter) Inc() {',
  '\tc.Count++',
  '}',
  '',
].join('\n')

const goRing = count => [
  'package ring',
  '',
  ...Array.from({ length: count }, (_, i) => `func F${i + 1}() int { return F${((i + 1) % count) + 1}() }`),
  '',
].join('\n')

const goStore = names => [
  'package store',
  '',
  ...names.map(name => `func ${name}() int { return 1 }`),
  '',
].join('\n')

const goCaller = names => [
  'package app',
  '',
  'import "example.com/app/pkg/store"',
  '',
  'func Run() int {',
  '\tsum := 0',
  ...names.map(name => `\tsum += store.${name}()`),
  '\treturn sum',
  '}',
  '',
].join('\n')

describe('orca-stack lint Go support (#422)', () => {
  test('R1/R7: Go comments classify Excuse, Tautology and Stale; directives, package doc comment and Decision Records pass', () => {
    withRepo(({ add, lint }) => {
      add('pkg/good/good.go', [
        '//go:build linux',
        '//go:generate echo TODO hack',
        '',
        '// Copyright 2026 Example. Licensed under MIT. TODO hack',
        '',
        '// Package good provides helpers for testing package doc comments.',
        'package good',
        '',
        '// Parse validates the payload and returns the decoded fields.',
        'func Parse(x int) int {',
        '\t// TODO(#123): remove after migration',
        '\t// follows ADR 0002',
        '\t//nolint:errcheck // temporary workaround',
        '\t// calls helperFn() and ignores `removedFn()`',
        '\treturn helperFn(x)',
        '}',
        '',
        'func helperFn(x int) int { return x }',
        '',
      ].join('\n'))
      const clean = lint()
      assert.equal(clean.status, 0, clean.out)
      assert.equal(clean.stdout, OK(0))

      add('pkg/bad/bad.go', [
        'package bad',
        '',
        '// Foo does foo.',
        'func Foo(i int) int {',
        '\t// TODO: hack for now',
        '\t/* temporary workaround */',
        '\t_ = i',
        '\t// increment i',
        '\ti++',
        '\t// calls oldHelper() before returning',
        '\treturn i',
        '}',
        '',
      ].join('\n'))
      const bad = lint()
      assert.equal(bad.status, 1, bad.out)
      assert.equal(bad.stdout, [
        `comment-tautology pkg/bad/bad.go:Foo() ${TAUTOLOGY}`,
        `comment-excuse pkg/bad/bad.go:Foo() ${EXCUSE}`,
        `comment-excuse pkg/bad/bad.go:Foo() ${EXCUSE}`,
        `comment-tautology pkg/bad/bad.go:Foo() ${TAUTOLOGY}`,
        `comment-stale pkg/bad/bad.go:Foo() ${STALE_COMMENT}`,
        '',
      ].join('\n') + SUMMARY(5, 0))
    })
  })

  test('R2/R7: module-cycle in Go checks packages inside a module, reports none on acyclic code or without go.mod, and catches a cycle fixture', () => {
    withRepo(({ add, lint }) => {
      add('go.mod', GO_MOD)
      add('pkg/store/store.go', 'package store\n\nfunc Value() int { return 1 }\n')
      add('pkg/store/store_test.go', 'package store_test\n\nimport "example.com/app/pkg/store"\n\nfunc TestValue() int { return store.Value() }\n')
      add('pkg/app/app.go', 'package app\n\nimport "example.com/app/pkg/store"\n\nfunc Run() int { return store.Value() }\n')
      const acyclic = lint()
      assert.equal(acyclic.status, 0, acyclic.out)
      assert.equal(acyclic.stdout, OK(0))

      add('pkg/a/a.go', 'package a\n\nimport "example.com/app/pkg/b"\n\nfunc A() int { return b.B() }\n')
      add('pkg/b/b.go', 'package b\n\nimport "example.com/app/pkg/a"\n\nfunc B() int { return a.A() }\n')
      const cyclic = lint()
      assert.equal(cyclic.status, 1, cyclic.out)
      assert.match(cyclic.stdout, new RegExp(`^${CYCLE('pkg/a', 'pkg/b', 'pkg/a').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    })

    withRepo(({ add, lint }) => {
      add('pkg/a/a.go', 'package a\n\nimport "example.com/app/pkg/b"\n\nfunc A() int { return b.B() }\n')
      add('pkg/b/b.go', 'package b\n\nimport "example.com/app/pkg/a"\n\nfunc B() int { return a.A() }\n')
      const noGoMod = lint()
      assert.equal(noGoMod.status, 0, noGoMod.out)
      assert.equal(noGoMod.stdout, OK(0))
    })
  })

  test('R3/R7: field-leak in Go flags another package writing an exported field of a struct with methods using it; reading, same-package writes and plain structs pass', () => {
    withRepo(({ add, lint }) => {
      add('go.mod', GO_MOD)
      add('pkg/queue/queue.go', QUEUE_GO)
      add('pkg/queue/same.go', 'package queue\n\nfunc Reset(q *Queue) { q.Items = nil }\n')
      add('pkg/counter/counter.go', COUNTER_GO)
      add('pkg/point/point.go', 'package point\n\ntype Point struct { X int }\n')
      add('pkg/app/app.go', [
        'package app',
        '',
        'import (',
        '\t"example.com/app/pkg/counter"',
        '\t"example.com/app/pkg/point"',
        '\t"example.com/app/pkg/queue"',
        ')',
        '',
        'func Read(q *queue.Queue, c *counter.Counter) int {',
        '\tp := &point.Point{}',
        '\tp.X = 5',
        '\tq.Push(1)',
        '\tc.Inc()',
        '\treturn len(q.Items) + c.Count + p.X',
        '}',
        '',
      ].join('\n'))
      const tidy = lint()
      assert.equal(tidy.status, 0, tidy.out)
      assert.equal(tidy.stdout, OK(0))

      add('pkg/app/app.go', [
        'package app',
        '',
        'import (',
        '\t"example.com/app/pkg/counter"',
        '\t"example.com/app/pkg/queue"',
        ')',
        '',
        'func Mutate(q *queue.Queue) {',
        '\tq.Items = append(q.Items, 1)',
        '\tc := &counter.Counter{}',
        '\tc.Count = 0',
        '}',
        '',
      ].join('\n'))
      const leaky = lint()
      assert.equal(leaky.status, 1, leaky.out)
      assert.match(leaky.stdout, /^field-leak pkg\/counter:Counter\.Count: se trabaja fuera de Counter en 1 lugar de 1 módulo \(pkg\/app; máximo 0\)/m)
      assert.match(leaky.stdout, /^field-leak pkg\/queue:Queue\.Items: se trabaja fuera de Queue en 1 lugar de 1 módulo \(pkg\/app; máximo 0\), y Queue se guarda limit/m)
      assert.ok(leaky.stdout.endsWith(SUMMARY(2, 0)), leaky.stdout)
    })
  })

  test('R4/R7: tangle and shallow-module in Go apply the #421 thresholds to packages and types', () => {
    withRepo(({ add, lint }) => {
      add('go.mod', GO_MOD)
      add('pkg/ring/ring.go', goRing(7))
      const seven = lint()
      assert.equal(seven.status, 0, seven.out)
      assert.equal(seven.stdout, OK(0))

      add('pkg/ring/ring.go', goRing(8))
      const eight = lint()
      assert.equal(eight.status, 1, eight.out)
      const members = Array.from({ length: 8 }, (_, i) => `pkg/ring:F${i + 1}`)
      assert.equal(eight.stdout, `${TANGLE(members, 1)}\n${SUMMARY(1, 0)}`)
    })

    withRepo(({ add, lint }) => {
      add('go.mod', GO_MOD)
      add('pkg/kernel/kernel.go', 'package kernel\n\nimport "example.com/app/pkg/timers"\n\ntype Tasks struct{}\n\nfunc (t *Tasks) Run() *timers.Timers { return &timers.Timers{} }\n')
      add('pkg/timers/timers.go', 'package timers\n\nimport "example.com/app/pkg/kernel"\n\ntype Timers struct{}\n\nfunc (t *Timers) Tick() *kernel.Tasks { return &kernel.Tasks{} }\n')
      const across = lint()
      assert.equal(across.status, 1, across.out)
      assert.equal(across.stdout, [
        CYCLE('pkg/kernel', 'pkg/timers', 'pkg/kernel'),
        TANGLE(['pkg/kernel:Tasks', 'pkg/timers:Timers'], 2),
        '',
      ].join('\n') + SUMMARY(2, 0))
    })

    withRepo(({ add, lint }) => {
      add('go.mod', GO_MOD)
      const all = Array.from({ length: 15 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`)
      add('pkg/store/store.go', goStore(all))
      add('pkg/app/app.go', goCaller(all.slice(0, 3)))
      const three = lint()
      assert.equal(three.status, 0, three.out)
      assert.equal(three.stdout, OK(0))

      add('pkg/app/app.go', goCaller(all.slice(0, 9)))
      const nine = lint()
      assert.equal(nine.status, 1, nine.out)
      assert.equal(nine.stdout, `${SHALLOW('pkg/store', all.slice(0, 9), 15)}\n${SUMMARY(1, 0)}`)
    })
  })

  test('R5: Go rules gate on .go files so repos without them never invoke ast-grep, while Go repos fail clearly when ast-grep is missing', () => {
    withRepo(({ dir, add, lint }) => {
      add('README.md', '# no go here\n')
      const missing = { ORCA_STACK_AST_GREP: path.join(dir, 'missing', 'ast-grep') }
      const noGo = lint([], missing)
      assert.equal(noGo.status, 0, noGo.out)
      assert.equal(noGo.stdout, OK(0))

      add('main.go', 'package main\n\nfunc main() {}\n')
      const withGo = lint([], missing)
      assert.equal(withGo.status, 1, withGo.out)
      assert.match(withGo.out, /✖ ast-grep 0\.51\.3 no está instalado/)
    })
  })

  test('R6: Go Baseline entries use the shared format with package path and symbol, without line numbers, and fail when stale', () => {
    withRepo(({ add, lint, baseline }) => {
      add('go.mod', GO_MOD)
      add('pkg/queue/queue.go', QUEUE_GO)
      add('pkg/app/app.go', 'package app\n\nimport "example.com/app/pkg/queue"\n\nfunc Touch(q *queue.Queue) {\n\t// TODO: remove\n\tq.Items = nil\n}\n')
      add('pkg/ring/ring.go', goRing(8))
      const all = Array.from({ length: 15 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`)
      add('pkg/store/store.go', goStore(all))
      add('pkg/client/client.go', goCaller(all.slice(0, 9)))

      const seed = lint(['--sembrar'])
      assert.equal(seed.status, 0, seed.out)
      assert.equal(seed.stdout, `Baseline: 4 entradas nuevas en ${BASELINE}\n${OK(4)}`)
      const entries = baseline().entries
      const ringMembers = Array.from({ length: 8 }, (_, i) => `pkg/ring:F${i + 1}`)
      assert.deepEqual(entries, [
        { rule: 'comment-excuse', file: 'pkg/app/app.go', location: 'Touch()', fingerprint: print('TODO: remove') },
        { rule: 'field-leak', file: 'pkg/queue', location: 'Queue.Items', fingerprint: print('Queue.Items') },
        { rule: 'shallow-module', file: 'pkg/store', location: 'module', fingerprint: print('pkg/store') },
        { rule: 'tangle', file: 'pkg/ring', location: 'tangle', fingerprint: print(ringMembers.join('\n')), members: ringMembers },
      ])
      assert.equal(lint(['--sembrar']).stdout, `Baseline: sin cambios (${BASELINE})\n${OK(4)}`)

      add('pkg/app/app.go', 'package app\n\nimport "example.com/app/pkg/queue"\n\nfunc Touch(q *queue.Queue) {\n\t_ = q.Size()\n}\n')
      const stale = lint()
      assert.equal(stale.status, 1, stale.out)
      assert.equal(stale.stdout, [
        STALE_ENTRY('comment-excuse', 'pkg/app/app.go', 'Touch()', print('TODO: remove')),
        STALE_ENTRY('field-leak', 'pkg/queue', 'Queue.Items', print('Queue.Items')),
        '',
      ].join('\n') + SUMMARY(0, 2))
    })
  })
})
