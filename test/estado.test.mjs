import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { main } from '../src/cli.mjs'
import { estadoCommand } from '../src/estado.mjs'
import { cleanup, tempDir, write } from './helpers.mjs'

const BOM = String.fromCharCode(0xfeff)
const HEAD = `abc1234${'a'.repeat(33)}`
const OLD = `def5678${'b'.repeat(33)}`
const MERGE = 'main mergea sola cuando la CI está verde'
const T = minute => `2026-11-15T10:${String(minute).padStart(2, '0')}:00Z`

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = stdout => ({ status: 0, stdout, stderr: '' })
const fail = stderr => ({ status: 1, stdout: '', stderr })

const run = (name, conclusion, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, workflowName: 'CI', status, conclusion: status === 'COMPLETED' ? conclusion : '', startedAt: T(0) })
const GREEN = [run('test', 'SUCCESS'), run('lint', 'SKIPPED'), run('ci-ok', 'SUCCESS')]

const prData = (number, { head = HEAD, body = 'Implementador: codex\n\nCloses #7', comments = [], reviews = [], files = ['src/a.mjs'], checks = GREEN, state = 'OPEN', mergeable = 'MERGEABLE' } = {}) =>
  ({ number, headRefOid: head, body, comments, reviews, files: files.map(file => ({ path: file, additions: 1, deletions: 0 })), statusCheckRollup: checks, baseRefName: 'main', mergeable, state })
const review = (who, sha, { verdict = 'nada', at = T(5), extra = '' } = {}) => ({ body: `Revisor: ${who}\nCommit: ${sha}\n\n## BLOQUEA\n${verdict}\n\n## SUGERENCIAS\nnada\n${extra}`, submittedAt: at, state: 'COMMENTED' })
const comment = (body, at = T(5)) => ({ body, createdAt: at, author: { login: 'stack-bot' } })

let root
let home
const harness = (world = {}, config = {}) => {
  write(path.join(root, '.orca-stack.json'), JSON.stringify({ ramaBase: 'main', merge: MERGE, ...config }))
  const out = []
  const err = []
  const calls = []
  const io = {
    cwd: root,
    home,
    now: () => Date.parse('2026-11-15T12:00:00Z'),
    out: line => out.push(line),
    err: line => err.push(line),
    sh: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'git' && args.includes('--git-common-dir')) return okRes(`${root}/.git\n${root}/.git\n${root}\n`)
      if (cmd === 'git' && args[0] === 'fetch') return world.fetchDown ? fail(world.fetchDown) : okRes('')
      if (cmd === 'git' && args[0] === 'ls-tree') return okRes((world.baseFiles ?? []).map(file => `${file}\n`).join(''))
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const found = (world.prs ?? []).find(one => String(one.number) === args[2])
        return found ? json(found) : fail(`no pull requests found for branch "${args[2]}"`)
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return json((world.prs ?? []).filter(one => one.state === 'OPEN').map(one => ({ number: one.number })))
      return fail(`unexpected call: ${cmd} ${args.join(' ')}`)
    },
  }

  return { io, out, err, calls }
}
const estado = (h, prs, flags = {}) => estadoCommand(flags, prs, h.io)
const one = h => {
  assert.equal(h.out.length, 1, h.out.join('\n'))
  return JSON.parse(h.out[0])
}

describe('orca-stack estado (S1, #366)', () => {
  before(() => {
    root = tempDir('estado-root')
    home = tempDir('estado-home')
  })
  after(() => {
    cleanup(root)
    cleanup(home)
  })

  test('S1 / #366 Rule 1: a clean review on the head, green CI and no riesgo path: ok, exit 0, exact JSON and human line', async () => {
    const world = { prs: [prData(70, { reviews: [review('agy', HEAD)] })] }
    const h = harness(world)
    assert.equal(await estado(h, ['70'], { json: true }), 0)
    assert.deepEqual(h.out, [JSON.stringify({ pr: 70, head: HEAD, ok: true, falta: [], merge: MERGE })])
    assert.deepEqual(h.err, [])
    assert.ok(h.calls.includes('gh pr view 70 --json number,headRefOid,body,comments,reviews,files,statusCheckRollup,baseRefName,mergeable,state'))

    const human = harness(world)
    assert.equal(await estado(human, ['70']), 0)
    assert.deepEqual(human.out, ['#70 #7 codex head=abc1234 ci=green review=agy@abc1234 riesgo=no falta='])
  })

  test('S1 negative / #366 Rule 2: a review that names an older commit gives ok:false naming it, review=stale, exit 1', async () => {
    const world = { prs: [prData(70, { reviews: [review('agy', OLD)] })] }
    const h = harness(world)
    assert.equal(await estado(h, ['70'], { json: true }), 1)
    assert.deepEqual(one(h), { pr: 70, head: HEAD, ok: false, falta: ['(b) el review de agy nombra el commit def5678, no el head abc1234'], merge: MERGE })

    const human = harness(world)
    assert.equal(await estado(human, ['70']), 1)
    assert.deepEqual(human.out, ['#70 #7 codex head=abc1234 ci=green review=stale riesgo=no falta=(b) el review de agy nombra el commit def5678, no el head abc1234'])
  })

  test('S9: a review led by a BOM with the sha in backticks counts; a quoted review and the implementer\'s own review do not', async () => {
    const bom = { body: `${BOM}Revisor: agy\nCommit: \`${HEAD}\`\n\n## BLOQUEA\nnada`, submittedAt: T(5) }
    const h = harness({ prs: [prData(70, { reviews: [bom] })] })
    assert.equal(await estado(h, ['70'], { json: true }), 0)
    assert.equal(one(h).ok, true)

    const quoted = { body: `> Revisor: agy\n> Commit: ${HEAD}\n>\n> ## BLOQUEA\n> nada`, submittedAt: T(5) }
    const missing = harness({ prs: [prData(70, { reviews: [quoted, review('codex', HEAD)] })] })
    assert.equal(await estado(missing, ['70'], { json: true }), 1)
    assert.deepEqual(one(missing).falta, ['(a) falta un review sin bloqueos sobre abc1234 de alguien que no sea codex'])
  })

  test('S1 (a): a review with blockers on the head is named; Verificado por main or Decidido por main on the head settles it', async () => {
    const blocked = harness({ prs: [prData(70, { reviews: [review('agy', HEAD, { verdict: '1. Falta el test del borde vacío' })] })] })
    assert.equal(await estado(blocked, ['70'], { json: true }), 1)
    assert.deepEqual(one(blocked).falta, ['(a) el review de agy sobre abc1234 tiene bloqueos'])

    for (const marker of [`Verificado por main: hallazgos 1 corregidos en ${HEAD}`, 'Decidido por main: hallazgo 1 — es un falso positivo']) {
      const settled = harness({ prs: [prData(70, {
        reviews: [review('agy', OLD, { verdict: '1. Falta el test del borde vacío', at: T(1) })],
        comments: [comment(`${BOM}${marker}\nCommit: ${HEAD}`, T(9))],
      })] })
      assert.equal(await estado(settled, ['70']), 0, marker)
      assert.deepEqual(settled.out, ['#70 #7 codex head=abc1234 ci=green review=main@abc1234 riesgo=no falta='])
    }

    const noImplementer = harness({ prs: [prData(70, { body: 'Closes #7', reviews: [review('agy', HEAD)] })] })
    assert.equal(await estado(noImplementer, ['70'], { json: true }), 1)
    assert.deepEqual(one(noImplementer).falta, ['(a) el body del PR no tiene una línea Implementador: <agente>'])
  })

  test('S1 (c): a red, a pending or a missing check gives ok:false with ci=red, pending and no checks', async () => {
    const cases = [
      [[run('test', 'FAILURE'), run('ci-ok', 'SUCCESS')], 'red', '(c) CI roja: test=FAILURE'],
      [[run('test', '', 'IN_PROGRESS'), run('ci-ok', 'SUCCESS')], 'pending', '(c) CI pendiente: test'],
      [[], 'pending', '(c) el head no tiene checks'],
    ]
    for (const [checks, ci, falta] of cases) {
      const h = harness({ prs: [prData(70, { checks, reviews: [review('agy', HEAD)] })] })
      assert.equal(await estado(h, ['70']), 1)
      assert.deepEqual(h.out, [`#70 #7 codex head=abc1234 ci=${ci} review=agy@abc1234 riesgo=no falta=${falta}`])
    }
  })

  test('S1 RDD mode: a pi review requested with RDD: on the head counts; an unrequested one does not; Sin review: needs the head and ## Evidencia', async () => {
    const config = { agentes: { usa: ['claude', 'codex', 'agy', 'pi'], pi: { review: 'rdd' } } }
    const body = 'Implementador: pi\n\nCloses #7\n\n## Evidencia\n| Regla | Test |'
    const rddReview = { body: `Revisor: pi (RDD: risk, resilience)\nCommit: ${HEAD}\n\n## BLOQUEA\nnada`, submittedAt: T(6) }
    const request = comment(`RDD: ${HEAD.slice(0, 7)} (resilience,risk)`, T(4))

    const requested = harness({ prs: [prData(70, { body, comments: [request], reviews: [rddReview] })] }, config)
    assert.equal(await estado(requested, ['70']), 0)
    assert.deepEqual(requested.out, ['#70 #7 pi head=abc1234 ci=green review=pi(RDD:resilience,risk)@abc1234 riesgo=no falta='])

    const unrequested = harness({ prs: [prData(70, { body, reviews: [rddReview] })] }, config)
    assert.equal(await estado(unrequested, ['70'], { json: true }), 1)
    assert.deepEqual(one(unrequested).falta, ['(a) falta un review sin bloqueos sobre abc1234 de alguien que no sea pi (o un review RDD pedido con RDD:, o un Sin review:)'])

    const pending = harness({ prs: [prData(70, { body, comments: [request] })] }, config)
    assert.equal(await estado(pending, ['70']), 1)
    assert.match(pending.out[0], / review=rdd-pedido\(resilience,risk\)@abc1234 /)

    const sinReview = harness({ prs: [prData(70, { body, comments: [comment(`Sin review: cambio de una línea en docs\nCommit: ${HEAD}`)] })] }, config)
    assert.equal(await estado(sinReview, ['70'], { json: true }), 0)
    const stale = harness({ prs: [prData(70, { body, comments: [comment(`Sin review: cambio de una línea en docs\nCommit: ${OLD}`)] })] }, config)
    assert.equal(await estado(stale, ['70'], { json: true }), 1)
    assert.deepEqual(one(stale).falta, ['(b) el Sin review: nombra el commit def5678, no el head abc1234'])
    const noEvidence = harness({ prs: [prData(70, { body: 'Implementador: pi', comments: [comment(`Sin review: trivial\nCommit: ${HEAD}`)] })] }, config)
    assert.equal(await estado(noEvidence, ['70'], { json: true }), 1)
    assert.deepEqual(one(noEvidence).falta, ['(a) el Sin review: necesita ## Evidencia en el body del PR'])
  })

  test('S1 (d): a riesgo path needs the second review riskDeny asks for; riesgo=yes', async () => {
    const config = { riesgo: ['src/auth/'] }
    const files = ['src/auth/login.mjs', 'README.md']
    const h = harness({ prs: [prData(70, { files, reviews: [review('agy', HEAD)] })] }, config)
    assert.equal(await estado(h, ['70']), 1)
    assert.deepEqual(h.out, ['#70 #7 codex head=abc1234 ci=green review=agy@abc1234 riesgo=yes falta=(d) PR #70 toca una ruta de riesgo (src/auth/login.mjs): falta un review de pi sobre el commit abc1234. Corré `orca-stack revisar 70 pi` y mergeá cuando el review esté limpio.'])

    const both = harness({ prs: [prData(70, { files, reviews: [review('agy', HEAD), review('pi', HEAD)] })] }, config)
    assert.equal(await estado(both, ['70'], { json: true }), 0)

    // Written by pi: two clean reviews of families other than pi's (claude).
    const piBody = 'Implementador: pi\n\nCloses #7'
    const piConfig = { ...config, agentes: { usa: ['claude', 'codex', 'agy', 'pi'] } }
    const oneFamily = harness({ prs: [prData(70, { body: piBody, files, reviews: [review('codex', HEAD)] })] }, piConfig)
    assert.equal(await estado(oneFamily, ['70'], { json: true }), 1)
    assert.deepEqual(one(oneFamily).falta, ['(d) PR #70 toca una ruta de riesgo (src/auth/login.mjs) y lo escribió pi: faltan reviews limpios sobre el commit abc1234 de dos familias de modelo distintas que no sean la de pi (claude). Hay 1 (gpt). Corré `orca-stack revisar 70 agy`.'])
    const twoFamilies = harness({ prs: [prData(70, { body: piBody, files, reviews: [review('codex', HEAD), review('agy', HEAD)] })] }, piConfig)
    assert.equal(await estado(twoFamilies, ['70'], { json: true }), 0)

    // On a riesgo path, Decidido por main does not settle a blocker of the head.
    const decided = harness({ prs: [prData(70, { files, reviews: [review('agy', HEAD), review('pi', HEAD, { verdict: '1. Token sin expirar' })], comments: [comment(`Decidido por main: 1 — aceptado\nCommit: ${HEAD}`, T(9))] })] }, config)
    assert.equal(await estado(decided, ['70'], { json: true }), 1)
    assert.match(one(decided).falta.join('\n'), /\(d\) PR #70 toca una ruta de riesgo \(src\/auth\/login\.mjs\) y el review de pi sobre el commit abc1234 tiene bloqueos/)
  })

  test('S2 on riesgo: after main\'s RDD: request, a Consulta: pi with RDD fuera de presupuesto: on the head lets two clean reviews of two other families clear (d)', async () => {
    const config = { riesgo: ['src/auth/'], agentes: { usa: ['claude', 'codex', 'agy', 'pi'], preguntarAntes: [], pi: { review: 'rdd' } } }
    const files = ['src/auth/login.mjs']
    const body = 'Implementador: pi\n\nCloses #7\n\n## Evidencia\n| Regla | Test |'
    const request = comment(`RDD: ${HEAD.slice(0, 7)} (risk)`, T(4))
    const stop = (sha = HEAD.slice(0, 7), at = T(6), extra = '') => comment(`${BOM}Consulta: pi\n\nEl RDD se detuvo.\nRDD fuera de presupuesto: ${sha} (lens_context_budget_exceeded)${extra}`, at)
    const crossed = [review('codex', HEAD, { at: T(8) }), review('agy', HEAD, { at: T(9) })]
    const rddDeny =
      '(d) PR #70 toca una ruta de riesgo (src/auth/login.mjs) y lo escribió pi en modo RDD: falta un review RDD limpio de pi con la lente risk sobre el commit abc1234 ' +
      'o, si el RDD no entró en el presupuesto, dos reviews limpios de dos familias distintas de la de pi; eso último cuenta solo con un comentario "Consulta: pi" ' +
      'con la línea "RDD fuera de presupuesto: abc1234 (<motivo>)" publicado después de tu pedido RDD: sobre ese commit, y sin él los reviews de otras familias no lo reemplazan. ' +
      'Corré `orca-stack rebote 70 --rdd risk` (podés sumar lentes).'

    const fallback = harness({ prs: [prData(70, { body, files, comments: [request, stop()], reviews: crossed })] }, config)
    assert.equal(await estado(fallback, ['70'], { json: true }), 0)
    assert.deepEqual(fallback.out, [JSON.stringify({ pr: 70, head: HEAD, ok: true, falta: [], merge: MERGE })])

    const oneFamily = harness({ prs: [prData(70, { body, files, comments: [request, stop()], reviews: [crossed[0]] })] }, config)
    assert.equal(await estado(oneFamily, ['70'], { json: true }), 1)
    assert.deepEqual(one(oneFamily).falta, ['(d) PR #70 toca una ruta de riesgo (src/auth/login.mjs) y lo escribió pi: faltan reviews limpios sobre el commit abc1234 de dos familias de modelo distintas que no sean la de pi (claude). Hay 1 (gpt). Corré `orca-stack revisar 70 agy`.'])

    const negatives = {
      'older head': [request, stop(OLD.slice(0, 7))],
      'before the request': [stop(HEAD.slice(0, 7), T(3)), request],
      'no request': [stop()],
      'inside a review': [request, stop(HEAD.slice(0, 7), T(6), '\n\n## BLOQUEA\nnada')],
    }
    for (const [name, comments] of Object.entries(negatives)) {
      const h = harness({ prs: [prData(70, { body, files, comments, reviews: crossed })] }, config)
      assert.equal(await estado(h, ['70'], { json: true }), 1, name)
      assert.deepEqual(one(h).falta, [rddDeny], name)
    }
    const reviewer = harness({ prs: [prData(70, { body, files, comments: [request, comment(`Consulta: pi\nRevisor: codex\nRDD fuera de presupuesto: ${HEAD} (lens_context_budget_exceeded)`, T(6))], reviews: crossed })] }, config)
    assert.equal(await estado(reviewer, ['70'], { json: true }), 1)
    assert.deepEqual(one(reviewer).falta, [rddDeny])
  })

  test('S12: a partial review counts only when no Sin leer: path is riesgo; a partial review without ## Cobertura does not count', async () => {
    const config = { riesgo: ['src/auth/'] }
    const files = ['src/auth/login.mjs', 'docs/x.md']
    const cobertura = sinLeer => `\n## Cobertura\nLeído: src/auth/login.mjs\nSin leer:\n- ${sinLeer}\n`
    const skippedRisk = harness({ prs: [prData(70, { files, reviews: [review('agy', HEAD), review('pi', HEAD, { extra: cobertura('`src/auth/login.mjs`') })] })] }, config)
    assert.equal(await estado(skippedRisk, ['70'], { json: true }), 1)
    assert.deepEqual(one(skippedRisk).falta, ['(d) PR #70 toca una ruta de riesgo (src/auth/login.mjs): falta un review de pi sobre el commit abc1234. Corré `orca-stack revisar 70 pi` y mergeá cuando el review esté limpio.'])

    const skippedDocs = harness({ prs: [prData(70, { files, reviews: [review('agy', HEAD), review('pi', HEAD, { extra: cobertura('docs/x.md') })] })] }, config)
    assert.equal(await estado(skippedDocs, ['70'], { json: true }), 0)

    const partial = harness({ prs: [prData(70, { reviews: [review('agy', HEAD, { extra: 'Review parcial: solo leí src/a.mjs.' })] })] })
    assert.equal(await estado(partial, ['70'], { json: true }), 1)
    assert.deepEqual(one(partial).falta, ['(a) falta un review sin bloqueos sobre abc1234 de alguien que no sea codex', '(a) el review de agy es parcial y no tiene ## Cobertura: no cuenta'])
  })

  test('S11: an added migration whose number is not above the highest on origin/<base> is named, with the review body main publishes', async () => {
    const config = { migraciones: { glob: 'db/migrations/*.sql', numero: '^(\\d+)_' } }
    const baseFiles = ['db/migrations/00011_users.sql', 'db/migrations/00012_roles.sql', 'db/migrations/README.md']
    const world = { baseFiles, prs: [prData(70, { files: ['db/migrations/00012_cuotas.sql', 'db/migrations/00011_users.sql', 'src/a.mjs'], reviews: [review('agy', HEAD)] })] }
    const h = harness(world, config)
    assert.equal(await estado(h, ['70']), 1)
    assert.ok(h.calls.includes('git fetch origin main'))
    assert.ok(h.calls.includes('git ls-tree -r --name-only origin/main -- db/migrations'))
    assert.deepEqual(h.out, [
      '#70 #7 codex head=abc1234 ci=green review=agy@abc1234 riesgo=no falta=migración db/migrations/00012_cuotas.sql (12) no es mayor que 12 en main',
      'Comentario para publicar en el PR #70 (gh pr comment 70 --body-file <archivo>), para rebotarlo con orca-stack rebote 70:',
      `Revisor: main (migraciones)\nCommit: ${HEAD}\n\n## BLOQUEA\n1. migración db/migrations/00012_cuotas.sql (12) no es mayor que 12 en main: renumerala a 00013 (renombrá el archivo y lo que lo nombre) para que corra después de las de main.\n\n## SUGERENCIAS\nnada`,
    ])

    const js = harness(world, config)
    assert.equal(await estado(js, ['70'], { json: true }), 1)
    assert.deepEqual(one(js).falta, ['migración db/migrations/00012_cuotas.sql (12) no es mayor que 12 en main'])
    assert.match(js.err.join('\n'), /Revisor: main \(migraciones\)/)

    const above = harness({ ...world, prs: [prData(70, { files: ['db/migrations/00013_cuotas.sql'], reviews: [review('agy', HEAD)] })] }, config)
    assert.equal(await estado(above, ['70'], { json: true }), 0)

    const blind = harness({ ...world, fetchDown: 'fatal: unable to access' }, config)
    assert.equal(await estado(blind, ['70'], { json: true }), 1)
    assert.deepEqual(one(blind).falta, ['no pude leer las migraciones de origin/main: fatal: unable to access'])
  })

  test('S1: several PRs print a JSON array; without arguments every open PR on ramaBase; a merged PR only when named', async () => {
    const world = { prs: [prData(70, { reviews: [review('agy', HEAD)] }), prData(71, { reviews: [review('agy', OLD)] }), prData(72, { state: 'MERGED', reviews: [review('agy', HEAD)] })] }
    const h = harness(world, { merge: undefined })
    assert.equal(await estado(h, ['70', '#72'], { json: true }), 1)
    assert.deepEqual(JSON.parse(h.out.join('\n')), [
      { pr: 70, head: HEAD, ok: true, falta: [], merge: null },
      { pr: 72, head: HEAD, ok: false, falta: ['el PR está mergeado'], merge: null },
    ])

    const all = harness(world)
    assert.equal(await estado(all, []), 1)
    assert.ok(all.calls.includes('gh pr list --state open --base main --json number --limit 100'))
    assert.deepEqual(all.out.map(line => line.split(' ')[0]), ['#70', '#71'])

    const allOk = harness({ prs: [world.prs[0]] })
    assert.equal(await estado(allOk, [], { json: true }), 0)
    assert.deepEqual(JSON.parse(allOk.out.join('\n')), [{ pr: 70, head: HEAD, ok: true, falta: [], merge: MERGE }])
  })

  test('S1 errors: an unreadable PR fails with the gh error; a non-number is refused before any call', async () => {
    const h = harness({ prs: [] })
    await assert.rejects(estado(h, ['99'], { json: true }), /No pude leer el PR #99 con gh pr view: no pull requests found/)
    assert.deepEqual(h.out, [])
    const typo = harness({ prs: [] })
    await assert.rejects(estado(typo, ['abc']), /Uso: orca-stack estado \[<pr>\.\.\.\] \[--json\]/)
    assert.deepEqual(typo.calls, [])
  })

  test('CLI: estado is wired with --json and the help names its contract', async () => {
    const h = harness({ prs: [prData(70, { reviews: [review('agy', HEAD)] })] })
    assert.equal(await main(['estado', '70', '--json'], h.io), 0)
    assert.deepEqual(h.out, [JSON.stringify({ pr: 70, head: HEAD, ok: true, falta: [], merge: MERGE })])
  })
})
