import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { read } from './helpers.mjs'

// Issue 398: main answers supervised workers' questions through Orca, not through avisar/reanudar.
const ROOT = process.cwd()
const main = read(path.join(ROOT, 'assets', 'stack', 'MAIN.md'))
const section = (text, heading) => (text.split(`\n${heading}\n`)[1]?.split('\n### ')[0] ?? '').trim()
// Clauses: split on sentence ends and semicolons, ignoring the dots inside inline code.
const clauses = text => text.replace(/`[^`]*`/g, code => code.replace(/[.;]/g, '·')).split(/(?<=[.;])\s+/)

describe('issue 398: MAIN.md answers worker questions through Orca', () => {
  test('S4: main answers execution questions with reply by id, gates product questions and publishes rule changes', () => {
    const despacho = section(main, '### Despacho')
    for (const kept of [
      'Reglas de colaboración: `main` responde preguntas de ejecución de un worker supervisado por el buzón del Run.',
      'El worker pregunta con `orca orchestration ask` y `vigilar` lo avisa con `consulta #<n> <agente> <message_id>`; `main` le responde por id con `orca orchestration reply --id <message_id> --body <respuesta>`, y Orca despierta al worker con la respuesta.',
      'Las de producto e interpretación van al humano como un gate de Orca: `orca orchestration gate-create --task <task_id> --question <pregunta> --options <json_array>` sobre la tarea `#<n> <agente>` del worker (su id sale de `orca orchestration task-list --run <run_id> --json`), con las opciones para que el humano elija.',
      'Cuando el humano decide, `main` cierra el gate con `orca orchestration gate-resolve --id <gate_id> --resolution <respuesta>` y le contesta al worker con `orca orchestration reply` por el mismo id.',
      'Una pregunta de ejecución cuya respuesta cambiaría una regla del ticket cuenta como de interpretación.',
      'Si la respuesta del humano cambia una regla del ticket, `main` además la publica en GitHub como comentario `Respuesta del humano:` con el texto del humano literal o un enlace a él, nunca una paráfrasis; un cambio de reglas propio de `main` se publica como `Respuesta de main:`; ninguno de los dos es una edición silenciosa del cuerpo del ticket.',
      'Un worker que necesita un archivo fuera de lo que cubre el ticket lo propone con `ask`: `main` lo aprueba con `reply` solo dentro del objetivo del ticket; si sirve a otro objetivo, toca una ruta de `riesgo` o es una puerta de una vía, va al humano como gate.'
    ]) assert.ok(despacho.includes(kept), kept)
    const cycle = section(main, '### Ciclo de `main`')
    assert.ok(cycle.includes('Ante `consulta #<n> <agente> <message_id>`, seguí el Despacho; ante `worker-detenido #<n> <agente>: terminó sin abrir un PR`, actuá como con `diagnostico`.'))
    // A supervised worker that ended its turn waiting for an answer is answered and left for Orca to wake, never diagnosed.
    assert.ok(cycle.includes('Un `worker-detenido` de un worker supervisado sin diagnóstico cuya última `consulta` no tiene `reply`, o tiene un `reply` en el buzón del Run posterior a ella, no sigue esta regla: si falta el `reply`, respondela por id (si fue a un gate, esperá a que el humano lo resuelva y respondé con su resolución), y dejá que Orca lo despierte con la respuesta, sin `reanudar`, `rebote`, despacho nuevo ni `needs-info`.'))
    assert.ok(cycle.includes('Si llega `worker-detenido #<n> <agente>: terminó sin abrir un PR` con diagnóstico, o sin una `consulta` de Orca en el caso anterior, seguí esta regla.'))
    assert.ok(!cycle.includes('con diagnóstico o sin `Consulta:` pendiente, seguí esta regla'))
    assert.ok(!cycle.includes('o resolvé su gate pendiente'))
    // Negative: questions are no longer answered where they were asked, and product answers are no longer just relayed.
    assert.ok(!despacho.includes('`main` responde preguntas de ejecución donde se hicieron'))
    assert.ok(!despacho.includes('las de producto e interpretación van al humano y `main` transmite la respuesta'))
  })

  test('S6: MAIN.md never answers a worker with avisar or reanudar, and Consulta: is gone (#466)', () => {
    for (const gone of [
      'le toca el timbre con `orca-stack avisar <issue|pr> <url-del-comentario>`: una sola línea que apunta a la respuesta',
      'si hay `Consulta:` sin responder, respondela y corré `orca-stack reanudar <issue> <url-del-comentario>`',
      'La `Consulta:` en GitHub queda solo para las sesiones no supervisadas',
      'Consulta:'
    ]) assert.ok(!main.includes(gone), gone)
    const step5 = main.split(/\r?\n/).find(line => line.startsWith('5. '))
    const paired = clauses(`${step5}\n${section(main, '### Despacho')}`).filter(clause => /avisar|reanudar/.test(clause) && /respond|Consulta|\bpreguntas?\b/.test(clause))
    assert.equal(paired.length, 0)
    const despacho = section(main, '### Despacho')
    assert.ok(despacho.includes('orca orchestration send --to dispatch:<id> --subject "<issue>: reglas cambiadas" --body "<url-del-comentario>"'))
    assert.ok(!despacho.includes('avisar'))
  })
})
