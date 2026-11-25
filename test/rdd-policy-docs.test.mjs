import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { renderBrief } from '../src/despacho.mjs'
import { render } from '../src/templates.mjs'
import { read } from './helpers.mjs'

// main-autonomo S2, S3, S11, S12, S13, S14: the policy and the briefs describe what estado, limpiar, the RDD consent policy
// and partial reviews do.
const ROOT = process.cwd()
const asset = name => read(path.join(ROOT, 'assets', 'stack', name))
const flat = text => text.replace(/\s+/g, ' ')
const main = asset('MAIN.md')
const cycle = main.split('\n### Ciclo de `main`\n')[1].split('\n### ')[0]
const step = n => cycle.split(/\r?\n/).find(line => line.startsWith(`${n}. `)) ?? ''
const AGENTS = ['claude', 'codex', 'agy', 'pi']
const OWN = 'If RDD asks for consent on your own candidate ('
const DECLINED = 'the orca-stack policy answer is `declined`: pi\'s Gentle Shell answers it by itself (orca-stack launched it with `GENTLE_PI_ORCA_RDD_POLICY=1` and wrote the policy file in this worktree\'s git dir), and any other agent answers `declined` itself; never ask the human.'

describe('main-autonomo: policy and briefs', () => {
  test('S1/S9: step 5 runs estado on every monitor event and at the start of every turn; vigilar stays the event source', () => {
    const five = step(5)
    assert.ok(five.includes('`orca-stack estado`'), five)
    assert.ok(five.includes('En cada evento y al empezar cada turno, corré `orca-stack estado`'), five)
    assert.ok(five.includes('`vigilar` sigue siendo la fuente de eventos'), five)
  })

  test('S3: step 6 answers RDD consent from the policy, and keeps the human flow only with "humano"', () => {
    const six = step(6)
    assert.ok(six.includes('`agentes.<agente>.rddConsentimiento`'), six)
    assert.ok(six.includes('`declined` sobre el candidato propio del worker y `granted` sobre tu pedido `RDD:` para ese head'), six)
    assert.ok(six.includes('Con `"humano"`'), six)
  })

  test('S2: step 6 switches a PR whose requested RDD ran out of context budget to two reviews of two families', () => {
    const six = step(6)
    for (const reason of ['`lens_context_budget_exceeded`', '`correction_context_budget_exceeded`']) assert.ok(six.includes(reason), reason)
    assert.ok(six.includes('pasás ese PR a dos reviews limpios de dos familias de modelo distintas que no sean la de pi'), six)
    assert.ok(six.includes('sin preguntarle al humano'), six)
    assert.ok(six.includes('cuya primera línea es `RDD fuera de presupuesto: <sha> (<motivo>)`'), six)
    assert.ok(six.includes('Vale también en un PR que toca `riesgo`'), six)
    assert.ok(six.includes('el comentario se publicó después de tu pedido `RDD: <head> (<lentes>)`'), six)
    assert.ok(six.includes('ese marcador sobre otro head, anterior a tu pedido, sin pedido o dentro de un review no cuenta, y una sola familia tampoco'), six)
    assert.ok(!six.includes('ese merge se lo pasás al humano'), six)
  })

  test('S1/S11/S12: step 7 checks with estado, merges with one pinned command, and covers partial reviews and migrations', () => {
    const seven = step(7)
    assert.ok(seven.includes('`orca-stack estado <n>`'), seven)
    assert.ok(seven.includes('`gh pr merge <n> --merge --match-head-commit <head>`'), seven)
    assert.ok(seven.includes('`orca-stack estado <n> --json`'), seven)
    assert.ok(seven.includes('sin `cd` a otro worktree, sin `-R` y sin `--admin` ni `--auto`'), seven)
    assert.ok(seven.includes('`orca-stack vigilar --merge-de-main <n>`'), seven)
    assert.ok(seven.includes('`## Cobertura`'), seven)
    assert.ok(seven.includes('`orca-stack revisar <pr> <agente> --rutas <rutas>`'), seven)
    assert.ok(seven.includes('gh pr comment <n> --body-file <archivo>'), seven)
    assert.ok(seven.includes('`orca-stack rebote <pr>`'), seven)
  })

  test('S8/S5: step 8 says revisar and rebote close done terminals themselves and names reanudar --terminal', () => {
    const eight = step(8)
    assert.ok(eight.includes('cierran solos las terminales en `done` y las shells vacías'), eight)
    assert.ok(eight.includes('`orca-stack reanudar <issue> <url-del-comentario> --terminal <handle>`'), eight)
  })

  test('S13: step 9 runs limpiar after each merge', () => {
    const nine = step(9)
    assert.ok(nine.includes('`orca-stack limpiar`'), nine)
    assert.ok(nine.includes('es idempotente'), nine)
  })

  test('S3: every agent\'s ticket brief and the bounce brief answer consent on the own candidate with declined, never asking the human', () => {
    for (const agent of AGENTS) {
      const brief = flat(renderBrief('ticket', { AGENT: agent, ISSUE: '42', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' }))
      assert.ok(brief.includes(OWN) && brief.includes(DECLINED), agent)
      assert.ok(brief.includes(`\`agentes.${agent}.rddConsentimiento\``), agent)
    }
    const bounce = flat(asset('brief-rebote.md'))
    assert.ok(bounce.includes(OWN) && bounce.includes(DECLINED), bounce)
    assert.ok(bounce.includes('`agentes.{{AGENT}}.rddConsentimiento`'))
  })

  test('S2/S3: the RDD brief grants consent for main\'s request and ends a context budget stop with the RDD fuera de presupuesto: first line', () => {
    const rdd = flat(asset('brief-rdd.md'))
    assert.ok(rdd.includes('the orca-stack policy answer for main\'s `RDD: {{SHA}}` request is `granted`'), rdd)
    for (const reason of ['`lens_context_budget_exceeded`', '`correction_context_budget_exceeded`']) assert.ok(rdd.includes(reason), reason)
    assert.ok(rdd.includes('whose first line is exactly `RDD fuera de presupuesto: {{SHA}} (<stop reason>)`, with the stop reason RDD returned, and nothing before it.'), rdd)
    assert.ok(rdd.includes('also on a `riesgo` path'), rdd)
    const rendered = flat(render(asset('brief-rdd.md'), { AGENT: 'pi', PR: '7', ISSUE: '42', SHA: 'abc1234', LENSES: 'risk' }))
    assert.ok(rendered.includes('first line is exactly `RDD fuera de presupuesto: abc1234 (<stop reason>)`'), rendered)
    assert.ok(!rendered.includes('Consulta:'), rendered)
  })

  test('S12: the review brief requires ## Cobertura, partial reviews list unread riesgo paths, layers over 700 lines, UTF-8 without BOM', () => {
    const brief = flat(renderBrief('review', { AGENT: 'codex', PR: '7', REPO: 'orca-stack', BASE: 'main', SHA: 'abc123', IMPLEMENTER: 'pi' }))
    for (const text of ['## Cobertura', 'Leído:', 'Sin leer:', 'over 700 changed lines', 'UTF-8 without a BOM']) assert.ok(brief.includes(text), text)
    assert.ok(brief.includes('A review that leaves a path matching `riesgo` unread is partial'), brief)
  })

  test('S3/S11: ORCA-STACK.md documents rddConsentimiento and migraciones', () => {
    const policy = flat(asset('ORCA-STACK.md'))
    assert.ok(policy.includes('`agentes.<agent>.rddConsentimiento`'))
    assert.ok(policy.includes('`"humano"` makes the worker ask main with `orca orchestration ask`, with only the consent\'s choices as closed options.'))
    assert.ok(!policy.includes('Consulta:'))
    assert.ok(policy.includes('`migraciones` in `.orca-stack.json`'))
  })

  test('S14: revisar help no longer asks for no done terminals; reanudar help names --terminal', () => {
    const cli = read(path.join(ROOT, 'src', 'cli.mjs'))
    const help = name => cli.split(`\n  ${name}: \``)[1].split('\n`,')[0]
    assert.ok(!help('revisar').includes('sin agentes ni terminales en done'), help('revisar'))
    assert.ok(help('revisar').includes('cierra sola'), help('revisar'))
    assert.ok(help('reanudar').includes('--terminal <handle>'))
  })
})
