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
    assert.ok(cycle.includes('Ante `consulta #<n> <agente> <message_id>`, o `worker-detenido #<n> <agente>: terminó sin abrir un PR` con `Consulta:` pendiente (sesión no supervisada), seguí el Despacho;'))
    // A supervised worker that ended its turn waiting for an answer is answered and left for Orca to wake, never diagnosed.
    assert.ok(cycle.includes('Un `worker-detenido` de un worker supervisado sin diagnóstico y con una `consulta` sin `reply` o recién respondida no sigue esta regla: respondela por id (o resolvé su gate pendiente) y dejá que Orca lo despierte con la respuesta, sin `reanudar`, `rebote`, despacho nuevo ni `needs-info`.'))
    // Negative: questions are no longer answered where they were asked, and product answers are no longer just relayed.
    assert.ok(!despacho.includes('`main` responde preguntas de ejecución donde se hicieron'))
    assert.ok(!despacho.includes('las de producto e interpretación van al humano y `main` transmite la respuesta'))
  })

  test('S6: MAIN.md never answers a supervised worker with avisar or reanudar, and Consulta: stays for non-supervised sessions', () => {
    for (const gone of [
      'le toca el timbre con `orca-stack avisar <issue|pr> <url-del-comentario>`: una sola línea que apunta a la respuesta',
      'si hay `Consulta:` sin responder, respondela y corré `orca-stack reanudar <issue> <url-del-comentario>`'
    ]) assert.ok(!main.includes(gone), gone)
    // Every clause of the worker-question rules (step 5 and Despacho) that pairs avisar/reanudar with answering a question
    // names a non-supervised session. Step 6 is the PR path (rebote, reviews), which is never supervised.
    const step5 = main.split(/\r?\n/).find(line => line.startsWith('5. '))
    const paired = clauses(`${step5}\n${section(main, '### Despacho')}`).filter(clause => /avisar|reanudar/.test(clause) && /respond|Consulta|\bpreguntas?\b/.test(clause))
    assert.ok(paired.length > 0)
    for (const clause of paired) assert.match(clause, /no supervisad/, clause)
    const despacho = section(main, '### Despacho')
    assert.ok(despacho.includes('La `Consulta:` en GitHub queda solo para las sesiones no supervisadas (reviews y rebotes): `main` la responde con un comentario `Respuesta de main:` y, si la sesión se detuvo, la retoma con `orca-stack reanudar <issue> <url-del-comentario>`.'))
    assert.ok(despacho.includes('le toca el timbre con `orca-stack avisar <issue|pr> <url-del-comentario>`, una sola línea que apunta al comentario'))
    assert.ok(despacho.includes('`avisar` mientras trabaja, para un cambio de reglas publicado después del despacho'))
  })
})
