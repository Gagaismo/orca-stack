import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync } from 'node:fs'
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
    exists: existsSync,
    readFile: file => readFileSync(file, 'utf8'),
    writeFile: (file, text) => write(file, text),
    mkdirp: () => {},
    rename: renameSync,
    sh: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'git' && args.includes('--git-common-dir')) return okRes(`${root}/.git\n${root}/.git\n${root}\n`)
      if (cmd === 'git' && args[0] === 'fetch') return world.fetchDown ? fail(world.fetchDown) : okRes('')
      if (cmd === 'git' && args[0] === 'ls-tree') return okRes((world.baseFiles ?? []).map(file => `${file}\n`).join(''))
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const found = (world.prs ?? []).find(one => String(one.number) === args[2])
        return found ? json(found) : fail(`no pull requests found for branch "${args[2]}"`)
      }
      if (cmd === 'gh' && args[0] === 'api') {
        if (world.baseConfig === undefined) return fail('gh: Not Found (HTTP 404)')
        world.apiCalls = [...(world.apiCalls ?? []), args.join(' ')]
        return okRes(world.baseConfig)
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list' && args.includes('all')) return json(world.allPrs ?? [])
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list' && args.includes('number,headRefName,body,files')) return world.openDown ? fail(world.openDown) : json((world.prs ?? []).filter(one => one.state === 'OPEN'))
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return json((world.prs ?? []).filter(one => one.state === 'OPEN').map(one => ({ number: one.number })))
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') return json({ state: (world.issueStates ?? {})[args[2]] ?? 'OPEN' })
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
    assert.ok(h.calls.includes('gh pr view 70 --json number,headRefOid,body,comments,reviews,files,statusCheckRollup,baseRefName,mergeable,state,url'))

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

  test('issue 385 Rule 1: qualified nada is explained in both review paths', async () => {
    for (const waived of [false, true]) {
      const world = { prs: [prData(70, { body: 'Implementador: codex\n\n## Evidencia', reviews: [review('agy', HEAD, { verdict: 'Nada identificado en la cobertura parcial' })] })], ...(waived ? { baseConfig: JSON.stringify({ reviewParaMerge: false }) } : {}) }
      const h = harness(world)
      assert.equal(await estado(h, ['70'], { json: true }), 1)
      assert.deepEqual(one(h).falta, ['(a) el review de agy sobre abc1234 no dice "nada" solo en ## BLOQUEA: "Nada identificado en la cobertura parcial"'])
    }
  })
  test('issue 385 Rule 2: risk explains qualified nada and keeps the risk guidance', async () => {
    const h = harness({ prs: [prData(70, { files: ['src/auth/login.mjs'], reviews: [review('agy', HEAD, { verdict: 'nada identificado en la cobertura parcial' })] })] }, { riesgo: ['src/auth/**'] })
    assert.equal(await estado(h, ['70'], { json: true }), 1)
    assert.ok(one(h).falta.some(line => line.includes('sobre el commit abc1234 no dice "nada" solo en ## BLOQUEA: "nada identificado en la cobertura parcial". En una ruta de riesgo un bloqueo no se salda con "Decidido por main"')))
  })
  test('issue 385 Rule 3: verdicts over 80 characters are shortened', async () => {
    for (const verdict of ['nada (no blockers established within the partial coverage above)', `nada ${'x'.repeat(74)}\u{1f600}x`, `nada ${'\u{1f600}'.repeat(40)}`]) {
      const chars = Array.from(verdict)
      const quote = `"${chars.length > 80 ? chars.slice(0, 80).join('') + '\u2026' : verdict}"`
      const h = harness({ prs: [prData(70, { files: ['src/auth/login.mjs'], reviews: [review('agy', HEAD, { verdict })] })] }, { riesgo: ['src/auth/**'] })
      assert.equal(await estado(h, ['70'], { json: true }), 1)
      const falta = one(h).falta
      assert.ok(falta.some(line => line.startsWith('(a)') && line.endsWith(quote)))
      assert.ok(falta.some(line => line.startsWith('(d)') && line.includes(`${quote}. En una ruta de riesgo`)))
    }
  })
  test('issue 385 Rule 4: numbered findings still report blockers', async () => {
    const h = harness({ prs: [prData(70, { reviews: [review('agy', HEAD, { verdict: '1. api/x.go:10 (introducido, test, implementaci\u00f3n): ...' })] })] })
    assert.equal(await estado(h, ['70'], { json: true }), 1)
    assert.deepEqual(one(h).falta, ['(a) el review de agy sobre abc1234 tiene bloqueos'])
  })
  test('issue 385 Rule 5: exact nada is clean and other verdicts remain blockers', async () => {
    for (const verdict of ['nada', 'Nada', 'ninguno']) {
      const h = harness({ prs: [prData(70, { reviews: [review('agy', HEAD, { verdict })] })] })
      assert.equal(await estado(h, ['70'], { json: true }), verdict === 'ninguno' ? 1 : 0)
      assert.deepEqual(one(h).falta, verdict === 'ninguno' ? ['(a) el review de agy sobre abc1234 tiene bloqueos'] : [])
    }
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

describe('orca-stack estado: reviewParaMerge (#377)', () => {
  before(() => {
    root = tempDir('estado-377-root')
    home = tempDir('estado-377-home')
  })
  after(() => {
    cleanup(root)
    cleanup(home)
  })
  const EVIDENCIA = ['Implementador: claude', '', '## Evidencia', '', '| Rule | Test |', '| --- | --- |', '| R1 | `x` |', ''].join('\n')
  const WAIVED = JSON.stringify({ ramaBase: 'main', reviewParaMerge: false })

  test('#377 Rule 1/2: reviewParaMerge false on the base branch on GitHub, green CI and ## Evidencia: ok with no review, read with gh api on the PR base', async () => {
    const world = { prs: [prData(80, { body: EVIDENCIA })], baseConfig: WAIVED }
    const h = harness(world)
    assert.equal(await estado(h, ['80'], { json: true }), 0)
    assert.deepEqual(one(h), { pr: 80, head: HEAD, ok: true, falta: [], merge: MERGE })
    assert.deepEqual(world.apiCalls, ['api -H Accept: application/vnd.github.raw+json repos/{owner}/{repo}/contents/.orca-stack.json?ref=main'])
  })

  test('#377 Rule 2 negative: a local .orca-stack.json saying false does not waive the review when the base on GitHub does not', async () => {
    const world = { prs: [prData(81, { body: EVIDENCIA })], baseConfig: JSON.stringify({ ramaBase: 'main' }) }
    const h = harness(world, { reviewParaMerge: false })
    assert.equal(await estado(h, ['81'], { json: true }), 1)
    assert.deepEqual(one(h).falta, [`(a) falta un review sin bloqueos sobre ${HEAD.slice(0, 7)} de alguien que no sea claude`])
  })

  test('#377 Rule 3 negative: with the waiver, red CI, a body without ## Evidencia, a blocking review on the head and an uncovered riesgo path still give ok:false', async () => {
    const red = { prs: [prData(82, { body: EVIDENCIA, checks: [run('test', 'FAILURE')] })], baseConfig: WAIVED }
    const hRed = harness(red)
    assert.equal(await estado(hRed, ['82'], { json: true }), 1)
    assert.ok(one(hRed).falta.some(item => item.startsWith('(c) ')), hRed.out[0])

    const bare = { prs: [prData(83, { body: 'Implementador: claude' })], baseConfig: WAIVED }
    const hBare = harness(bare)
    assert.equal(await estado(hBare, ['83'], { json: true }), 1)
    assert.deepEqual(one(hBare).falta, ['(a) reviewParaMerge: false en la base necesita ## Evidencia en el body del PR'])

    const blocked = { prs: [prData(84, { body: EVIDENCIA, reviews: [review('codex', HEAD, { verdict: '- src/a.mjs:3 rompe X' })] })], baseConfig: WAIVED }
    const hBlocked = harness(blocked)
    assert.equal(await estado(hBlocked, ['84'], { json: true }), 1)
    assert.deepEqual(one(hBlocked).falta, [`(a) el review de codex sobre ${HEAD.slice(0, 7)} tiene bloqueos`])

    const risky = { prs: [prData(85, { body: EVIDENCIA.replace('claude', 'codex'), files: ['auth/store.go'] })], baseConfig: JSON.stringify({ ramaBase: 'main', reviewParaMerge: false, riesgo: ['auth/**'] }) }
    const hRisky = harness(risky, { riesgo: ['auth/**'] })
    assert.equal(await estado(hRisky, ['85'], { json: true }), 1)
    assert.ok(one(hRisky).falta.some(item => item.startsWith('(d) ')), hRisky.out[0])
  })

  test('#377 Rule 2 hardening: the config is read from the PR\'s own repository with the base escaped, and with the waiver the committed riesgo also counts', async () => {
    const pr = { ...prData(87, { body: EVIDENCIA, files: ['auth/store.go'] }), url: 'https://github.com/Owner/Repo/pull/87', baseRefName: 'a&ref=main' }
    const world = { prs: [pr], baseConfig: JSON.stringify({ reviewParaMerge: false, riesgo: ['auth/**'] }) }
    const h = harness(world, { riesgo: [] })
    assert.equal(await estado(h, ['87'], { json: true }), 1)
    assert.deepEqual(world.apiCalls, ['api -H Accept: application/vnd.github.raw+json repos/Owner/Repo/contents/.orca-stack.json?ref=a%26ref%3Dmain'])
    assert.ok(one(h).falta.some(item => item.startsWith('(d) ')), 'emptying riesgo in the local checkout does not drop the committed riesgo review')
  })

  test('#377 Rule 4: gh api failing or returning invalid JSON keeps the full step 7 and does not error', async () => {
    for (const baseConfig of [undefined, '{not json']) {
      const world = { prs: [prData(86, { body: EVIDENCIA })], baseConfig }
      const h = harness(world)
      assert.equal(await estado(h, ['86'], { json: true }), 1)
      assert.deepEqual(one(h).falta, [`(a) falta un review sin bloqueos sobre ${HEAD.slice(0, 7)} de alguien que no sea claude`])
    }
  })
})

describe('main-autonomo-2 S2: estado orders migrations by reservation', () => {
  const CONFIG = { migraciones: { glob: 'db/migrations/*.sql', numero: String.raw`^(\d+)_` } }
  const BASE = ['db/migrations/00011_users.sql', 'db/migrations/00012_roles.sql']
  const registry = () => path.join(root, '.git', 'orca-stack', 'migraciones.json')
  const reserved = reservas => write(registry(), JSON.stringify({ reservas }))
  const pr = (number, issue, files) => prData(number, { body: `Implementador: codex\n\nCloses #${issue}`, files, reviews: [review('agy', HEAD)] })
  before(() => {
    root = tempDir('estado-mig-root')
    home = tempDir('estado-mig-home')
  })
  after(() => {
    cleanup(root)
    cleanup(home)
  })

  test('S2: another open PR adding a lower migration makes this one wait for its merge; the lower one is ok; one gh pr list for both', async () => {
    reserved({ 7: { numero: 14, texto: '00014' }, 8: { numero: 13, texto: '00013' } })
    const world = { baseFiles: BASE, prs: [pr(70, 7, ['db/migrations/00014_cuotas.sql', 'src/a.mjs']), pr(71, 8, ['db/migrations/00013_pagos.sql'])] }
    const h = harness(world, CONFIG)
    assert.equal(await estado(h, ['70', '71'], { json: true }), 1)
    const [first, second] = JSON.parse(h.out[0])
    assert.deepEqual(first.falta, ['migración db/migrations/00014_cuotas.sql (14): esperá el merge de #71 (migración 13 reservada antes)'])
    assert.equal(first.ok, false)
    assert.deepEqual(second.falta, [])
    assert.equal(second.ok, true)
    assert.equal(h.calls.filter(call => call === 'gh pr list --state open --json number,headRefName,body,files --limit 100').length, 1)
    assert.deepEqual(h.err, [])

    const human = harness(world, CONFIG)
    assert.equal(await estado(human, ['70']), 1)
    assert.deepEqual(human.out, ['#70 #7 codex head=abc1234 ci=green review=agy@abc1234 riesgo=no falta=migración db/migrations/00014_cuotas.sql (14): esperá el merge de #71 (migración 13 reservada antes)'])
  })

  test('S2: an open reservation of another issue with a lower number blocks even before that issue has a PR', async () => {
    reserved({ 7: { numero: 14, texto: '00014' }, 9: { numero: 13, texto: '00013' } })
    const h = harness({ baseFiles: BASE, prs: [pr(70, 7, ['db/migrations/00014_cuotas.sql'])] }, CONFIG)
    assert.equal(await estado(h, ['70'], { json: true }), 1)
    assert.deepEqual(one(h).falta, ['migración db/migrations/00014_cuotas.sql (14): esperá el merge de #9 (migración 13 reservada antes)'])
  })

  test('S2 negative: a reservation of a closed issue is released from the registry and does not block', async () => {
    reserved({ 7: { numero: 14, texto: '00014' }, 9: { numero: 13, texto: '00013' } })
    const h = harness({ baseFiles: BASE, issueStates: { 9: 'CLOSED' }, prs: [pr(70, 7, ['db/migrations/00014_cuotas.sql'])] }, CONFIG)
    assert.equal(await estado(h, ['70'], { json: true }), 0)
    assert.deepEqual(one(h).falta, [])
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(registry(), 'utf8')).reservas), ['7'])
  })

  test('S2 negative: its own reservation, a higher one and a PR adding no migration never block; the out-of-order check stays', async () => {
    reserved({ 7: { numero: 2, texto: '00002' }, 8: { numero: 15, texto: '00015' } })
    const h = harness({ baseFiles: BASE, prs: [pr(70, 7, ['db/migrations/00014_cuotas.sql']), pr(71, 8, ['src/b.mjs'])] }, CONFIG)
    assert.equal(await estado(h, ['70'], { json: true }), 0)
    assert.deepEqual(one(h).falta, [])

    reserved({})
    const late = harness({ baseFiles: BASE, prs: [pr(70, 7, ['db/migrations/00012_cuotas.sql']), pr(71, 8, ['src/b.mjs'])] }, CONFIG)
    assert.equal(await estado(late, ['70']), 1)
    assert.deepEqual(late.out, [
      '#70 #7 codex head=abc1234 ci=green review=agy@abc1234 riesgo=no falta=migración db/migrations/00012_cuotas.sql (12) no es mayor que 12 en main',
      'Comentario para publicar en el PR #70 (gh pr comment 70 --body-file <archivo>), para rebotarlo con orca-stack rebote 70:',
      `Revisor: main (migraciones)\nCommit: ${HEAD}\n\n## BLOQUEA\n1. migración db/migrations/00012_cuotas.sql (12) no es mayor que 12 en main: renumerala a 00013 (renombrá el archivo y lo que lo nombre) para que corra después de las de main.\n\n## SUGERENCIAS\nnada`,
    ])
  })

  test('S2 negative: without migraciones there is no reservation lookup and no new falta', async () => {
    reserved({ 9: { numero: 1, texto: '00001' } })
    const h = harness({ baseFiles: BASE, prs: [pr(70, 7, ['db/migrations/00014_cuotas.sql']), pr(71, 8, ['db/migrations/00013_pagos.sql'])] })
    assert.equal(await estado(h, ['70'], { json: true }), 0)
    assert.deepEqual(one(h).falta, [])
    assert.ok(!h.calls.some(call => call.startsWith('gh pr list') || call.startsWith('gh issue') || call.startsWith('git ls-tree')), h.calls.join('\n'))
  })

  test('S2: open PRs that cannot be listed, or an unreadable registry, are named instead of passing', async () => {
    reserved({})
    const down = harness({ baseFiles: BASE, openDown: 'gh: HTTP 502', prs: [pr(70, 7, ['db/migrations/00014_cuotas.sql'])] }, CONFIG)
    assert.equal(await estado(down, ['70'], { json: true }), 1)
    assert.deepEqual(one(down).falta, ['no pude listar los PRs abiertos para ordenar las migraciones: gh: HTTP 502'])

    write(registry(), 'not json')
    const broken = harness({ baseFiles: BASE, prs: [pr(70, 7, ['db/migrations/00014_cuotas.sql'])] }, CONFIG)
    assert.equal(await estado(broken, ['70'], { json: true }), 1)
    assert.deepEqual(one(broken).falta, [`no pude leer el registro de migraciones ${registry()}`])
    assert.equal(readFileSync(registry(), 'utf8'), 'not json')
  })
})
