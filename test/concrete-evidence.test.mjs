import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { renderBrief } from '../src/despacho.mjs'
import { policyBlock } from '../src/templates.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8')
const between = (text, start, end) => text.split(start)[1].split(end)[0]

const contract = read('assets/stack/CONTRATO.md')
const reviewSection = between(contract, '### Review', '### Skills de Matt')
// Issue 325: main's cycle moved to MAIN.md.
const main = read('assets/stack/MAIN.md')
const step8 = main.split('\n').find(line => line.startsWith('8. '))
const brief = read('assets/stack/brief-revision.md')
const manual = between(read('docs/manual.md'), '### 4.8 Review, rebote y merge', '\n### ')

const FORMAT = '(introducido|empeorado, test|comando|regla escrita|regla sin test, implementación|interpretación)'
const STEP_8_SENTENCE = 'Un bloqueo sin evidencia concreta (ver Review) es una sugerencia: no rebota el PR ni frena el merge.'

describe('issue 302: only concrete evidence blocks a review', () => {
  test('Rule 1: the contract, the review brief and the manual name the four kinds of concrete evidence', () => {
    assert.ok(reviewSection.includes('Bloquean solo cuatro tipos de evidencia concreta: `test` (un test del reviewer que falla), `comando` (un comando y su salida), `regla escrita` (un `archivo:línea` que rompe una regla citada de `CODING_STANDARDS.md` o `AGENTS.md`) y `regla sin test` (la regla o criterio del ticket, nombrado, que el diff no cumple o no prueba).'))
    for (const part of [
      'What blocks: only a finding with one of four kinds of concrete evidence.',
      '`test`: a verifier test that fails, with its code.',
      '`comando`: a command and its output.',
      '`regla escrita` (Standards): a `file:line` as in the reviewed commit that breaks a rule written in {{REVIEW_STANDARDS}}, quoting the rule.',
      '`regla sin test` (Spec and Failure modes): a numbered rule, acceptance criterion or failure mode of the issue that the diff does not meet or does not test, naming it.',
    ]) assert.ok(brief.includes(part), part)
    assert.ok(manual.includes('Solo bloquea la evidencia concreta: `test` (un test del revisor que falla, con su código), `comando` (un comando y su salida), `regla escrita` (un `archivo:línea` que rompe una regla citada de `CODING_STANDARDS.md` o `AGENTS.md`) o `regla sin test` (la regla o criterio del ticket, nombrado, que el diff no cumple o no prueba).'))
  })

  test('Rule 2: an inferred finding, such as a race with no reproduction, goes to SUGERENCIAS with what to run', () => {
    assert.ok(reviewSection.includes('No bloquean lo inferido, que va a `## SUGERENCIAS` con qué correr para confirmarlo ("puede haber una race si corren dos `despachar`", sin reproducción)'))
    assert.ok(brief.includes('A finding without one of them is inferred and goes to SUGERENCIAS with the test or command that would confirm it'))
    assert.ok(brief.includes('"this may race when two dispatches run at once", with no reproduction, is a suggestion: `possible race in despachar when two run in parallel; confirm by running two despachar 301 claude at once`'))
    assert.ok(manual.includes('Lo inferido va a `## SUGERENCIAS` con qué correr para confirmarlo: "puede haber una race si corren dos `despachar`", sin reproducción, no bloquea.'))
  })

  test('Rule 3: the blocker line names its evidence kind instead of concreta or inferida', () => {
    assert.ok(reviewSection.includes(`1. \`archivo:línea\` ${FORMAT}:`))
    assert.ok(reviewSection.includes('Cada bloqueo dice si lo introduce o lo empeora y su tipo de evidencia.'))
    assert.ok(brief.includes(`1. \`file:line\` ${FORMAT}:`))
    assert.ok(brief.includes('Each blocker says whether the diff introduces or worsens it, and its evidence kind.'))
    assert.ok(manual.includes(`1. \`archivo:línea\` ${FORMAT}:`))
    for (const [name, text] of [['CONTRATO.md', contract], ['MAIN.md', main], ['AGENTS.md', read('AGENTS.md')], ['brief-revision.md', brief], ['manual.md', manual]]) {
      assert.doesNotMatch(text, /concreta\|inferida|\*\*concreta\*\* o \*\*inferida\*\*|concrete \(a line, a failing test\) or inferred/, name)
    }
  })

  test('Rule 4: step 8 says a blocker without concrete evidence neither bounces the PR nor stops the merge', () => {
    assert.ok(!step8.includes('Un bloqueo `inferido` podés mandarlo a refutar antes de rebotar.'))
    assert.ok(step8.includes(STEP_8_SENTENCE))
    assert.ok(manual.includes('Un bloqueo sin evidencia concreta cuenta como sugerencia: no rebota el PR ni frena el merge.'))
  })

  test('Rule 4 negative: the merge gate accepts a review whose only blocker is inferred', () => {
    const step7 = main.split(/\r?\n/).find(line => line.startsWith('7. '))
    assert.doesNotMatch(step7, /un review con `## BLOQUEA` en `nada`/, 'step 7 still demands BLOQUEA=nada even for an unsupported finding')
    assert.ok(step7.includes('(a) un review sin bloqueos con evidencia concreta en `## BLOQUEA` (paso 8)'))
    assert.doesNotMatch(manual, /Hay un review con `## BLOQUEA` en `nada`/, 'the manual merge condition still demands BLOQUEA=nada')
    assert.ok(manual.includes('1. Hay un review sin bloqueos con evidencia concreta (un bloqueo inferido cuenta como sugerencia)'))
  })

  test('Rule 5: SUGERENCIAS keeps its cap of three and lists inferred findings first', () => {
    assert.ok(reviewSection.includes('## SUGERENCIAS\n(como mucho tres, una línea cada una; lo inferido primero)\n```'))
    assert.ok(brief.includes('## SUGERENCIAS\n(at most three, one line each; inferred findings first)\n```'))
    assert.ok(manual.includes('## SUGERENCIAS\n(como mucho tres, una línea cada una; lo inferido primero)\n```'))
  })

  test('Rule 6: the AGENTS.md copy of the contract block matches assets/stack/CONTRATO.md', () => {
    assert.ok(read('AGENTS.md').includes(contract.replace(/\s+$/, '')))
  })

  test('Preserve: revisar renders the new blocker format and keeps its markers', () => {
    const rendered = renderBrief('review', {
      PR: '9', REPO: 'repo', AGENT: 'agy', IMPLEMENTER: 'codex', SHA: 'abc123', BASE: 'main', VERIFICATION: 'npm test',
    })
    for (const part of ['Revisor: agy', 'Commit: abc123', '## BLOQUEA', '## SUGERENCIAS', `1. \`file:line\` ${FORMAT}:`, '(at most three, one line each; inferred findings first)', 'rule written in AGENTS.md, quoting the rule']) {
      assert.ok(rendered.includes(part), part)
    }
  })

  test('Preserve: global and init install the contract block with the new rules and the policy section', () => {
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    assert.ok(block.startsWith('## Orca stack: contrato de trabajo'))
    assert.ok(block.includes(`1. \`archivo:línea\` ${FORMAT}:`))
    assert.ok(block.includes('leé `~/orca/stack/MAIN.md` entero antes de actuar'))
    assert.ok(main.includes(STEP_8_SENTENCE))
    assert.ok(block.includes('### Política del stack'))
  })
})
