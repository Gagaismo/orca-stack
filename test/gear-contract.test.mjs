import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { cleanup, cli, git, read, tempDir, write } from './helpers.mjs'

const contract = read(path.join(process.cwd(), 'assets', 'stack', 'CONTRATO.md'))
const policy = read(path.join(process.cwd(), 'assets', 'stack', 'ORCA-STACK.md'))
const marchas = contract.split('### Marchas')[1]?.split('\n### ')[0] ?? ''
const gearList = policy.split('## Gear knobs')[1]?.split('\n## ')[0] ?? ''

const checkCitedHeadings = (contractText, policyText) => {
  const sources = { 'CONTRATO.md': contractText, 'ORCA-STACK.md': policyText }
  for (const line of policyText.split(/\r?\n/)) {
    if (!line.startsWith('- **K')) continue
    const match = /^- \*\*(K\d+) \u2014 [^*]+\*\*.*?Internal heading: (CONTRATO\.md|ORCA-STACK\.md) \u2014 (.+?)(?:\.|;|$)/.exec(line)
    if (!match) throw new Error(`Malformed internal heading citation in knob: ${line}`)
    const [, knob, source, heading] = match
    const found = sources[source].split(/\r?\n/)
      .filter(row => /^#{1,6}\s/.test(row))
      .map(row => row.replace(/^#{1,6}\s+/, '').trim())
      .includes(heading)
    if (!found) throw new Error(`${knob} cites missing heading "${heading}" in ${source}`)
  }
}

describe('gear contract', () => {
  test('rule 1: renaming Ciclo de `main` fails the heading check and names the knob and missing heading', () => {
    const renamed = contract.replace('### Ciclo de `main`', '### Ciclo de main')
    assert.throws(() => checkCitedHeadings(renamed, policy), /K\d+ cites missing heading "Ciclo de `main`" in CONTRATO\.md/)
  })

  test('rule 2: internal heading citations pass when unchanged and external citations are marked unchecked', () => {
    assert.doesNotThrow(() => checkCitedHeadings(contract, policy))
    for (const number of [1, 2, 3, 5]) {
      const knob = gearList.split(/\r?\n/).find(line => line.startsWith(`- **K${number} `))
      assert.match(knob, /external gentle-ai ODD heading: .+ \(unchecked\)/)
    }
  })

  test('rule 3: fixed markers preserve existing markers and add exactly the seven new markers', () => {
    const fixedLine = contract.split(/\r?\n/).find(line => line.includes('son marcas fijas del protocolo'))
    const existingHeadings = ['## Evidencia', '## Desv\u00EDos del ticket', '## BLOQUEA', '## SUGERENCIAS']
    const addedHeadings = ['## Arena', '## Swarm']
    const existingLines = [
      'Implementador: <agente>', 'Revisor: <agente>', 'Commit: <sha>',
      'Verificado por main: hallazgos <n,\u2026> corregidos en <sha>', 'Decidido por main: <hallazgo> \u2014 <raz\u00F3n>',
    ]
    const addedLines = [
      'Marcha: <lazy|medium|proactive>', 'Esperando marcha: <items>', 'Consulta: <agente>',
      'Respuesta de main:', 'Respuesta del humano:',
    ]
    assert.ok(fixedLine)
    const markerList = fixedLine.split(', son marcas fijas')[0]
    const actual = [...markerList.matchAll(/`([^`]+)`/g)].map(([, marker]) => marker)
    assert.deepEqual(actual, [...existingHeadings, ...addedHeadings, ...existingLines, ...addedLines])
    assert.equal(addedHeadings.length + addedLines.length, 7)
  })

  test('rule 4: no Marcha message means Medium', () => {
    assert.match(marchas, /Sin mensaje `Marcha:`[\s\S]*?Medium/)
  })

  test('rule 5: suggestions are one line ending in the exact command and main never shifts itself', () => {
    assert.match(marchas, /`Sugiero subir a Proactive para #42 \(toca riesgo\): \/marcha proactive`/)
    assert.match(marchas, /main nunca ejecuta `\/marcha` ni informa un cambio que no vio hacer al humano/i)
    assert.match(marchas, /pr\u00F3ximo mensaje de main abre con una l\u00EDnea que nombra la marcha y qu\u00E9 cambia ahora/i)
  })

  test('rule 6: do not suggest Lazy while a Proactive tanda is in flight', () => {
    assert.match(marchas, /nunca mientras haya una tanda despachada en Proactive en curso/i)
  })

  test('rule 7: autonomous Lazy close lists shift-waiting items and omits AUTONOMO-LISTO', () => {
    assert.match(marchas, /El resumen de cierre lista los items en espera/)
    assert.match(marchas, /`Esperando marcha: #41, #43`/)
    assert.match(marchas, /sin escribir `\[AUTONOMO-LISTO\]`/)
  })

  test('rule 8: step 10 records the gear and the next session suggests it without applying it', () => {
    const step10 = contract.split('\n').find(line => line.startsWith('10. '))
    assert.match(step10, /marcha que deja/)
    assert.match(step10, /sugiere en una l\u00EDnea esa marcha/)
    assert.match(step10, /sin aplicarla/)
  })

  test('rule 9: K11 does not cite the not-yet-existing Arena y swarm section', () => {
    const k11 = gearList.split(/\r?\n/).find(line => line.startsWith('- **K11 '))
    assert.ok(k11)
    assert.doesNotMatch(k11, /Arena y swarm/)
  })

  test('rule 10: Marchas points to the policy list instead of copying knobs', () => {
    assert.match(marchas, /perillas de marcha.*ORCA-STACK\.md/i)
    assert.doesNotMatch(marchas, /\bK(?:[1-9]|10|11)\b/)
    assert.deepEqual(
      [...gearList.matchAll(/^- \*\*(K\d+) /gm)].map(([, knob]) => knob),
      Array.from({ length: 11 }, (_, index) => `K${index + 1}`),
    )
  })

  test('rule 11: init writes the gear contract and fixed markers into AGENTS.md', () => {
    const home = tempDir('gear-home')
    const repo = path.join(tempDir('gear-repo'), 'project')
    try {
      write(path.join(repo, 'README.md'), '# project\n')
      git(repo, 'init', '-q', '-b', 'main')
      const result = cli(home, ['init'], { cwd: repo })
      assert.equal(result.status, 0, result.out)
      const agents = read(path.join(repo, 'AGENTS.md'))
      assert.match(agents, /### Marchas/)
      assert.match(agents, /`Marcha: <lazy\|medium\|proactive>`/)
    } finally {
      cleanup(home)
      cleanup(path.dirname(repo))
    }
  })
})
