import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { renderBrief } from '../src/despacho.mjs'
import { policyBlock } from '../src/templates.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(path.join(ROOT, rel), 'utf8')
const flat = text => text.replace(/\s+/g, ' ')
const between = (text, start, end) => text.split(start)[1].split(end)[0]

const contract = read('assets/stack/CONTRATO.md')
const reviewSection = between(contract, '### Review', '### Skills de Matt')
const step8 = contract.split('\n').find(line => line.startsWith('8. '))
const brief = read('assets/stack/brief-revision.md')
const manual = between(read('docs/manual.md'), '### 4.8 Review, rebote y merge', '\n### ')
const correctnessReviewer = flat(between(read('assets/stack/ROLE-BRIEFS.md'), '## Correctness/spec reviewer', '## Ponytail reviewer'))

// The size of assets/stack/CONTRATO.md on main when #302 started (7769fd3).
const CONTRACT_BYTES_ON_MAIN = 38488
const FORMAT = '(introducido|empeorado, test|comando|regla escrita|regla sin test, implementación|interpretación)'
const STEP_8_SENTENCE = 'Un bloqueo sin evidencia concreta (ver Review) es una sugerencia: no rebota el PR ni frena el merge.'

describe('issue 302: only concrete evidence blocks a review', () => {
  test('Rule 1: the contract, the review briefs and the manual name the four kinds of concrete evidence', () => {
    assert.ok(reviewSection.includes('Bloquean solo cuatro tipos de evidencia concreta: `test` (un test del reviewer que falla), `comando` (un comando y su salida), `regla escrita` (un `archivo:línea` que rompe una regla citada de `CODING_STANDARDS.md` o `AGENTS.md`) y `regla sin test` (una regla o criterio del ticket que el diff no cumple o no prueba).'))
    for (const part of [
      'What blocks: only a finding with one of four kinds of concrete evidence.',
      '`test`: a verifier test that fails, with its code.',
      '`comando`: a command and its output.',
      '`regla escrita` (Standards): a `file:line` as in the reviewed commit that breaks a rule written in {{REVIEW_STANDARDS}}, quoting the rule.',
      '`regla sin test` (Spec and Failure modes): a numbered rule, acceptance criterion or failure mode of the issue that the diff does not meet or does not test, naming it.',
    ]) assert.ok(brief.includes(part), part)
    assert.ok(correctnessReviewer.includes('Only concrete evidence blocks: a failing verifier test, a command and its output, a `file:line` breaking a quoted written rule, or a ticket rule the diff does not meet or test.'))
    assert.ok(manual.includes('Solo bloquea la evidencia concreta: `test` (un test del revisor que falla, con su código), `comando` (un comando y su salida), `regla escrita` (un `archivo:línea` que rompe una regla citada de `CODING_STANDARDS.md` o `AGENTS.md`) o `regla sin test` (una regla o criterio del ticket que el diff no cumple o no prueba).'))
  })

  test('Rule 2: an inferred finding, such as a race with no reproduction, goes to SUGERENCIAS with what to run', () => {
    assert.ok(reviewSection.includes('No bloquean lo inferido, que va a `## SUGERENCIAS` con qué correr para confirmarlo ("puede haber una race si corren dos `despachar`", sin reproducción)'))
    assert.ok(brief.includes('A finding without one of them is inferred and goes to SUGERENCIAS with the test or command that would confirm it'))
    assert.ok(brief.includes('"this may race when two dispatches run at once", with no reproduction, is a suggestion: `possible race in despachar when two run in parallel; confirm by running two despachar 301 claude at once`'))
    assert.ok(correctnessReviewer.includes('An inferred finding goes first among the suggestions, with the test or command that would confirm it.'))
    assert.ok(manual.includes('Lo inferido va a `## SUGERENCIAS` con qué correr para confirmarlo: "puede haber una race si corren dos `despachar`", sin reproducción, no bloquea.'))
  })

  test('Rule 3: the blocker line names its evidence kind instead of concreta or inferida', () => {
    assert.ok(reviewSection.includes(`1. \`archivo:línea\` ${FORMAT}:`))
    assert.ok(reviewSection.includes('Cada bloqueo dice si lo introduce o lo empeora y su tipo de evidencia.'))
    assert.ok(brief.includes(`1. \`file:line\` ${FORMAT}:`))
    assert.ok(brief.includes('Each blocker says whether the diff introduces or worsens it, and its evidence kind.'))
    assert.ok(manual.includes(`1. \`archivo:línea\` ${FORMAT}:`))
    for (const [name, text] of [['CONTRATO.md', contract], ['AGENTS.md', read('AGENTS.md')], ['brief-revision.md', brief], ['manual.md', manual]]) {
      assert.doesNotMatch(text, /concreta\|inferida|\*\*concreta\*\* o \*\*inferida\*\*|concrete \(a line, a failing test\) or inferred/, name)
    }
  })

  test('Rule 4: step 8 says a blocker without concrete evidence neither bounces the PR nor stops the merge', () => {
    assert.ok(!step8.includes('Un bloqueo `inferido` podés mandarlo a refutar antes de rebotar.'))
    assert.ok(step8.includes(STEP_8_SENTENCE))
    assert.ok(manual.includes('Un bloqueo sin evidencia concreta cuenta como sugerencia: no rebota el PR ni frena el merge.'))
  })

  test('Rule 5: SUGERENCIAS keeps its cap of three and lists inferred findings first', () => {
    assert.ok(reviewSection.includes('## SUGERENCIAS\n(como mucho tres, una línea cada una; lo inferido primero)\n```'))
    assert.ok(brief.includes('## SUGERENCIAS\n(at most three, one line each; inferred findings first)\n```'))
    assert.ok(manual.includes('## SUGERENCIAS\n(como mucho tres, una línea cada una; lo inferido primero)\n```'))
  })

  test('Rule 6: the AGENTS.md copy of the contract block matches assets/stack/CONTRATO.md', () => {
    assert.ok(read('AGENTS.md').includes(contract.replace(/\s+$/, '')))
  })

  test('Rule 7: CONTRATO.md is not larger than on main when the ticket started', () => {
    assert.ok(Buffer.byteLength(contract) <= CONTRACT_BYTES_ON_MAIN, `${Buffer.byteLength(contract)} > ${CONTRACT_BYTES_ON_MAIN}`)
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
    assert.ok(block.includes(STEP_8_SENTENCE))
    assert.ok(block.includes('### Política del stack'))
  })
})
