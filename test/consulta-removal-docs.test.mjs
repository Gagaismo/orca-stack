import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { validateAnswerComment } from '../src/avisar.mjs'
import { renderBrief } from '../src/despacho.mjs'
import { MARKERS } from '../src/marcas.mjs'
import { upsertBlock } from '../src/marker.mjs'
import { policyBlock } from '../src/templates.mjs'
import { read } from './helpers.mjs'

const ROOT = process.cwd()
const asset = name => read(path.join(ROOT, 'assets', 'stack', name))
const section = (text, heading) => (text.split(`\n${heading}\n`)[1]?.split('\n### ')[0] ?? '').trim()
const stepOf = (main, n) => section(main, '### Ciclo de `main`').split(/\r?\n/).find(line => line.startsWith(`${n}. `)) ?? ''
const AGENTS = ['claude', 'codex', 'agy', 'pi']

describe('issue #466: contract, policy and briefs without Consulta: or the 700-line rule', () => {
  test('R1: Consulta: leaves the fixed protocol marks in CONTRATO.md, the AGENTS block written by init, and src/marcas.mjs, while avisar keeps accepting only Respuesta de main: and Respuesta del humano:', () => {
    const contract = asset('CONTRATO.md')
    const agents = read(path.join(ROOT, 'AGENTS.md'))
    const blockOff = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    const blockOn = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md', perks: { marchas: true } })

    assert.ok(!MARKERS.includes('Consulta'))
    assert.ok(!contract.includes('Consulta:'))
    assert.ok(!blockOff.includes('Consulta:'))
    assert.ok(!blockOn.includes('Consulta:'))
    assert.ok(!agents.includes('Consulta:'))
    assert.equal(upsertBlock(agents, blockOff), agents)

    const commentIo = body => ({
      sh: (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: JSON.stringify({ login: 'stack-bot' }), stderr: '' }
        if (cmd === 'gh' && args[0] === 'api') {
          return {
            status: 0,
            stdout: JSON.stringify({
              user: { login: 'stack-bot' },
              body,
              html_url: 'https://github.com/Gagaismo/orca-stack/issues/466#issuecomment-1',
            }),
            stderr: '',
          }
        }
        return { status: 1, stdout: '', stderr: 'unexpected' }
      },
    })
    const remote = { ownerRepo: 'Gagaismo/orca-stack' }
    const url = 'https://github.com/Gagaismo/orca-stack/issues/466#issuecomment-1'
    assert.ok(validateAnswerComment('466', url, ROOT, remote, commentIo('Respuesta de main: ok')))
    assert.ok(validateAnswerComment('466', url, ROOT, remote, commentIo('Respuesta del humano: ok')))
    assert.throws(() => validateAnswerComment('466', url, ROOT, remote, commentIo('Consulta: agy — pregunta')), /Respuesta de main:.*Respuesta del humano:/)
  })

  test('R2: CONTRATO.md and the AGENTS block no longer contain the 700-line rule', () => {
    const rule700 = 'Si el diff proyecta más de 700 líneas, pará y avisá en el issue antes de seguir.'
    const contract = asset('CONTRATO.md')
    const agents = read(path.join(ROOT, 'AGENTS.md'))
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })

    assert.ok(!contract.includes(rule700))
    assert.ok(!block.includes(rule700))
    assert.ok(!agents.includes(rule700))
    assert.ok(!contract.includes('700 líneas'))
    assert.ok(!agents.includes('700 líneas'))
  })

  test('R3: brief-ticket.md drops the Consulta: fallback, After posting a Consulta:, and 700-line warning, and keeps single-pr delivery', () => {
    const raw = asset('brief-ticket.md')
    assert.ok(!raw.includes('Consulta:'))
    assert.ok(!raw.includes('After posting a Consulta:'))
    assert.ok(!raw.includes('700 lines'))
    assert.ok(raw.includes('Delivery strategy is always a single PR (`single-pr`)'))

    for (const agent of AGENTS) {
      const brief = renderBrief('ticket', { AGENT: agent, ISSUE: '466', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
      assert.ok(!brief.includes('Consulta:'), agent)
      assert.ok(!brief.includes('After posting a Consulta:'), agent)
      assert.ok(!brief.includes('700 lines'), agent)
      assert.ok(brief.includes('Delivery strategy is always a single PR (`single-pr`)'), agent)
      assert.ok(brief.includes('orca orchestration ask'), agent)
    }
  })

  test('R4: MAIN.md steps 5, 8 and Despacho describe only mailbox questions, and step 1 or 2 splits large tickets before dispatch', () => {
    const main = asset('MAIN.md')
    const cycle = section(main, '### Ciclo de `main`')
    const step1And2 = `${stepOf(main, 1)}\n${stepOf(main, 2)}`
    const step5AndDiag = cycle.slice(cycle.indexOf('5. '), cycle.indexOf('\n6. '))
    const step8 = stepOf(main, 8)
    const despacho = section(main, '### Despacho')

    assert.ok(!main.includes('--consultas'))
    assert.ok(!step5AndDiag.includes('Consulta:'))
    assert.ok(!step8.includes('Consulta:'))
    assert.ok(!despacho.includes('Consulta:'))
    assert.ok(!main.includes('La `Consulta:` en GitHub queda solo para las sesiones no supervisadas'))
    assert.match(step5AndDiag, /Ante `consulta #<n> <agente> <message_id>`, seguí el Despacho/)
    assert.match(step1And2, /si un ticket parece grande, partilo en tickets más chicos antes de despacharlo/i)
  })

  test('R5: ORCA-STACK.md and ROLE-BRIEFS.md no longer mention Consulta:', () => {
    assert.ok(!asset('ORCA-STACK.md').includes('Consulta:'))
    assert.ok(!asset('ROLE-BRIEFS.md').includes('Consulta:'))
  })

  test('R6: Diagnóstico:, Respuesta de main: and Respuesta del humano: keep their rules unchanged', () => {
    const contract = asset('CONTRATO.md')
    const agents = read(path.join(ROOT, 'AGENTS.md'))
    const main = asset('MAIN.md')
    const brief = renderBrief('ticket', { AGENT: 'agy', ISSUE: '466', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })

    for (const marker of ['Respuesta de main', 'Respuesta del humano']) {
      assert.ok(MARKERS.includes(marker), marker)
    }
    for (const doc of [contract, agents]) {
      assert.ok(doc.includes('`Diagnóstico: <agente>`'))
      assert.ok(doc.includes('`Respuesta de main:`'))
      assert.ok(doc.includes('`Respuesta del humano:`'))
      assert.ok(doc.includes('Un comentario `Diagnóstico: <agente>` incluye las líneas `Causa:`, `Probado:` y `Siguiente hipótesis:` (puede ser `ninguna`).'))
    }
    assert.ok(brief.includes('publish `Diagnóstico: agy` with `Causa:`, `Probado:` and `Siguiente hipótesis:`'))
    assert.ok(brief.includes('handle any `Respuesta de main:` / `Respuesta del humano:`'))
    assert.ok(main.includes('Ante `diagnostico #<n> <agente>`'))
    assert.ok(main.includes('`Diagnóstico: main`'))
    assert.ok(main.includes('`Respuesta del humano:`'))
    assert.ok(main.includes('`Respuesta de main:`'))
  })
})
