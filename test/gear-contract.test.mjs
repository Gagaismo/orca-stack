import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { cleanup, cli, git, read, tempDir, write } from './helpers.mjs'

const contract = read(path.join(process.cwd(), 'assets', 'stack', 'CONTRATO.md'))
const policy = read(path.join(process.cwd(), 'assets', 'stack', 'ORCA-STACK.md'))
const marchas = contract.split('### Marchas')[1]?.split('\n### ')[0] ?? ''
const gearList = policy.split('## Gear knobs')[1]?.split('\n## ')[0] ?? ''
const arena = contract.split('### Arena y swarm')[1]?.split('\n### ')[0] ?? ''
const permissions = contract.split('### Permisos')[1]?.split('\n### ')[0] ?? ''

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
  test('ticket rule 1: arena proposals require human approval and use the in-process route', () => {
    assert.match(arena, /"Propongo una arena de dise\u00F1o en #158: dos dise\u00F1os sin ganador; N=3 \(Haiku, Sonnet, Opus\); r\u00FAbrica: \u2026"/)
    assert.match(arena, /`main` no ejecuta nada hasta que el humano da el OK/)
    assert.match(arena, /corren en proceso, como subagentes de quien tiene la tarea \(Agent tool o Workflow\)/)
    assert.match(arena, /Cada writer de una arena trabaja en un worktree aislado/)
    assert.match(arena, /aplica tanto en `multiagente` como en `un-agente`/)
    assert.match(arena, /Quien tiene la tarea ejecuta la arena e injerta/)
    assert.match(arena, /El judge es de solo lectura, no es un review/)
    assert.match(arena, /elegir una candidatura nunca cuenta como el review de registro/)
    assert.match(arena, /suite configurada y los tests RED.*resultado injertado/)
    assert.match(arena, /`~\/.claude\/skills\/arena\/SKILL.md` o `~\/.agents\/skills\/arena\/SKILL.md`/)
  })

  test('ticket rule 2: only pure-read swarms avoid approval and Lazy runs none', () => {
    assert.match(arena, /Un swarm de solo lectura sobre c\u00F3digo, issues y PRs, con pocos subagentes y sin correr una suite, hacer llamadas remotas ni crear worktrees, no requiere OK, pero nunca se hace en Lazy/)
    assert.match(arena, /Cualquier otro swarm requiere OK como una arena/)
    assert.match(arena, /pero nunca se hace en Lazy/)
    assert.match(arena, /Una suite o build en paralelo requiere worktrees aislados/)
    assert.match(arena, /Las APIs externas son operaciones remotas y requieren su autorizaci\u00F3n/)
    assert.match(arena, /Es trabajo de lectura y no publica nada/)
    assert.match(arena, /El informe no reemplaza CI ni `Verificado por main`/)
    assert.match(arena, /Leer \u00E1reas distintas para darle contexto a `main` es delegaci\u00F3n, no un swarm, y no deja `## Swarm`/)
    assert.match(arena, /`~\/.claude\/skills\/swarm\/SKILL.md` o `~\/.agents\/skills\/swarm\/SKILL.md`/)
    assert.match(arena, /Los resultados se publican bajo `## Arena` o `## Swarm` en el artefacto correspondiente/)
    assert.match(arena, /Toda fan-out que pase por Workflow requiere el OK del humano/)
  })

  test('ticket rule 3: a second arena, changed rubric or exhausted retry requires new approval', () => {
    assert.match(arena, /Una segunda arena para el mismo ticket, un N o r\u00FAbrica nuevos, o un reintento despu\u00E9s de que todas las candidaturas hayan salido requieren un OK nuevo/)
    assert.match(arena, /Cada OK cubre una fan-out en un solo artefacto/)
  })

  test('ticket rule 4: ultracode exempts only main own arena and still announces it', () => {
    assert.match(arena, /Ultracode, que solo activa el humano, autoriza la fan-out propia de `main` durante esa sesi\u00F3n; cada arena se anuncia igual en una l\u00EDnea/)
    assert.match(arena, /Ultracode nunca autoriza la nota de un worker y no sobrevive al handoff/)
    assert.match(arena, /Con ultracode, la arena de `main` no espera OK, pero se anuncia en una l\u00EDnea/)
  })

  test('ticket rule 5: autonomous proposals go only on allowed artifacts and execution continues', () => {
    assert.match(arena, /Sin humano y sin ultracode, `main` registra la propuesta \(t\u00E9cnica, motivo y r\u00FAbrica\) en el PR, el informe o el issue del mapa/)
    assert.match(arena, /nunca en un issue que implementa un worker/)
    assert.match(arena, /y sigue con el camino normal/)
  })

  test('ticket rule 6: autonomous ultracode allows one arena per artifact', () => {
    assert.match(arena, /una sola arena por artefacto, la menor que responda la pregunta/)
    assert.match(arena, /N sale de una propuesta registrada que el humano haya visto, o es el menor n\u00FAmero de candidaturas que permita las diferencias necesarias/)
    assert.match(arena, /Un swarm que no sea de solo lectura cuenta como una arena/)
    assert.match(arena, /Proactive y los swarms de solo lectura no agregan otro l\u00EDmite/)
    assert.match(arena, /Una segunda arena queda registrada como propuesta y no se ejecuta/)
  })

  test('ticket rule 7: second CI bounce carries escalation and proposal together', () => {
    const step8 = contract.split('\n').find(line => line.startsWith('8. '))
    assert.match(step8, /Despu\u00E9s del segundo rebote de CI, si vuelve a fallar, se lo pas\u00E1s al humano/)
    assert.match(step8, /Si propon\u00E9s un swarm para diagnosticar, atac\u00E1 la premisa primero con la skill de #160/)
    assert.match(step8, /la propuesta viaja con la escalaci\u00F3n al humano, nunca en su lugar ni para demorarla/)
  })

  test('ticket rule 8: candidate cleanup is explicit, listed, one-at-a-time and non-forced', () => {
    assert.match(permissions, /el owner puede borrar, sin preguntar, las ramas y los worktrees candidatos que haya creado/)
    assert.match(permissions, /Cada candidato se llama `worktree-agent-<id>` y su id figura en su propio `## Arena`/)
    assert.match(permissions, /No tiene upstream y no aparece en `git ls-remote`/)
    assert.match(permissions, /La nota de s\u00EDntesis est\u00E1 publicada \(para un worker, el PR est\u00E1 abierto\)/)
    assert.match(permissions, /un id listado por vez, nunca por patr\u00F3n/)
    assert.match(permissions, /primero `git worktree remove` sin `--force` y despu\u00E9s `git branch -D`; nunca `orca worktree rm`/)
    assert.match(permissions, /Si `git worktree remove` se niega, el candidato queda y el owner lo informa/)
    assert.match(permissions, /Borrar es opcional/)
    assert.match(permissions, /`worktree-agent-a1b2` y `worktree-agent-c3d4`/)
    assert.match(permissions, /un `worktree-agent-e5f6` no listado nunca se toca/)
  })

  test('ticket rule 9: fan-out stops unless git ignores the Claude worktree directory', () => {
    assert.match(arena, /El owner comprueba que git ignore `.claude\/worktrees\/` con `git check-ignore`/)
    assert.match(arena, /Si no lo ignora, la fan-out no se ejecuta y el owner explica por qu\u00E9/)
  })

  test('ticket rule 10: verification runs on grafted result before publication', () => {
    assert.match(arena, /La suite configurada y los tests RED corren sobre el resultado injertado/)
    assert.match(arena, /La suite configurada y los tests RED corren sobre el resultado injertado, no sobre una candidatura aislada/)
  })

  test('ticket rule 11: design arena verdict remains a recommendation for the human', () => {
    assert.match(arena, /El veredicto de una arena de dise\u00F1o es una recomendaci\u00F3n y decide el humano/)
    assert.match(arena, /En una puerta de una v\u00EDa la arena nunca reemplaza el segundo review ni la consulta a Gentle Shell/)
    assert.match(arena, /El veredicto de una arena de dise\u00F1o es una recomendaci\u00F3n y decide el humano/)
  })

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
    // Issue 250 Rule 12: the rebote markers sit between the existing lines and the gear lines.
    const bounceLines = ['Rebote: <sha>', 'Rebote CI: <sha>', 'Rebote conflicto: <sha>']
    const addedLines = [
      'Marcha: <lazy|medium|proactive>', 'Esperando marcha: <items>', 'Consulta: <agente>',
      'Respuesta de main:', 'Respuesta del humano:',
    ]
    assert.ok(fixedLine)
    const markerList = fixedLine.split(', son marcas fijas')[0]
    const actual = [...markerList.matchAll(/`([^`]+)`/g)].map(([, marker]) => marker)
    assert.deepEqual(actual, [...existingHeadings, ...addedHeadings, ...existingLines, ...bounceLines, ...addedLines])
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

  test('ticket rule 12: K11 cites Arena y swarm and renaming that heading fails', () => {
    const k11 = gearList.split(/\r?\n/).find(line => line.startsWith('- **K11 '))
    assert.ok(k11)
    assert.match(k11, /Internal heading: CONTRATO\.md \u2014 Arena y swarm/)
    assert.doesNotThrow(() => checkCitedHeadings(contract, policy))
    const renamed = contract.replace('### Arena y swarm', '### Arena and swarm')
    assert.throws(() => checkCitedHeadings(renamed, policy), /K11 cites missing heading "Arena y swarm" in CONTRATO\.md/)
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
