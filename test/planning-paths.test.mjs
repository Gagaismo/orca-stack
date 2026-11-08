import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { read } from './helpers.mjs'

const root = process.cwd()
const file = rel => read(path.join(root, rel))
const contract = file('assets/stack/CONTRATO.md')
const agents = file('AGENTS.md')
// Issue 325: main's cycle and Marchas moved to MAIN.md; Agentes and Skills de Matt stay in the contract.
const main = file('assets/stack/MAIN.md')
const step = (text, n) => text.split(/\r?\n/).find(line => line.startsWith(`${n}. `)) ?? ''
const section = (text, heading) => text.split(`### ${heading}`)[1]?.split('\n### ')[0] ?? ''

describe('planning paths (#267)', () => {
  test('Rule 1: step 1 defines the Straight shot by the ODD small test, with its examples and the #199 negative', () => {
    for (const text of [main]) {
      const s1 = step(text, 1)
      assert.ok(s1.includes('**Straight shot**'))
      assert.ok(s1.includes('se sabe qué y dónde cambiar; no toca una ruta de `riesgo` ni una puerta de una vía; se podría retomar solo con el pedido y el `git diff`'))
      assert.ok(s1.includes('no deja abierta ninguna decisión de producto'))
      assert.ok(s1.includes('`main` se salta `grill-with-docs` y `to-spec`, escribe el ticket él mismo (paso 2) con `## Reglas`, propone los ejemplos, al menos uno negativo, y el humano los confirma en un mensaje antes del despacho'))
      assert.ok(s1.includes('renombrar un flag de la CLI o #268 (filas solo de docs)'))
      assert.ok(s1.includes('"`vigilar` debería avisar de un worker que se detuvo antes de su PR" (#199) no es Straight shot aunque el diff sea chico, porque qué señal cuenta es una decisión abierta'))
    }
  })

  test('Rule 2: step 1 sends every other idea to grill-with-docs, then to-spec and to-tickets, and line counts never decide', () => {
    for (const text of [main]) {
      const s1 = step(text, 1)
      assert.ok(s1.includes('**Mediano o grande**: si no, `main` propone primero `grill-with-docs` y después `to-spec` y `to-tickets`'))
      assert.ok(s1.includes('la cantidad de líneas nunca decide cuál'))
      assert.ok(s1.includes('un cambio de 10 líneas a una regla del contrato que deja abierta una decisión de producto va por acá'))
    }
  })

  test('Rule 3: step 1 proposes wayfinder only after a grill-with-docs session outgrows itself, never for an idea with no grilling', () => {
    for (const text of [main]) {
      const s1 = step(text, 1)
      assert.ok(s1.includes('`main` propone `wayfinder` solo cuando una sesión de `grill-with-docs` se le va de las manos, nunca para una idea nueva que todavía no pasó por `grill-with-docs`, y la dispara el humano (por ejemplo "/wayfinder let\'s turn this into a map")'))
    }
  })

  test('Rule 4: the contract names grill-with-docs, never grilling, in step 1, Agentes, Marchas and Skills de Matt', () => {
    assert.ok(step(main, 1).includes('`grill-with-docs`'))
    assert.doesNotMatch(step(main, 1), /`grilling`/)
    assert.ok(section(main, 'Marchas').includes('A Proactive cuando empieza la planificación (`grill-with-docs`, `to-spec`, `to-tickets` o charting de un map)'))
    for (const text of [contract, agents]) {
      assert.ok(section(text, 'Agentes').includes('Planificación con las skills de Matt (`grill-with-docs`, `to-spec`, `to-tickets`, disparadas por el humano)'))
      assert.ok(section(text, 'Skills de Matt').includes('`grill-with-docs`, `to-spec`, `to-tickets`, `wayfinder`, `triage`, `retro` y `ask-matt` solo las puede disparar el humano'))
    }
    for (const text of [contract, agents, main]) assert.doesNotMatch(text, /`grilling`|\(grilling,/)
  })

  test('Rule 5: step 2 adds ## Pedido original and ## Tareas to every new ticket and keeps older tickets valid', () => {
    for (const text of [main]) {
      const s2 = step(text, 2)
      assert.ok(s2.includes('Cada ticket nuevo lleva además `## Pedido original`, con el pedido del humano textual (citado, nunca parafraseado), y `## Tareas`, numeradas `T1`..`Tn` con la regla que cubre cada una, que el worker va tildando'))
      assert.ok(s2.includes('Las reglas citan textuales las cadenas y los ejemplos exactos del humano cuando los dio'))
      assert.ok(s2.includes('los tickets anteriores sin esas secciones siguen siendo válidos'))
    }
  })

  test('Rule 7: manual, setup guide, ORCA-STACK, ROLE-BRIEFS and the ticket brief template name grill-with-docs, and the manual describes the two paths', () => {
    const docs = ['docs/manual.md', 'docs/guia-setup.md', 'assets/stack/ORCA-STACK.md', 'assets/stack/ROLE-BRIEFS.md', 'assets/stack/brief-ticket.md']
    for (const rel of docs) assert.doesNotMatch(file(rel), /`grilling`|\(grilling,/, rel)
    for (const rel of ['docs/manual.md', 'docs/guia-setup.md', 'assets/stack/ORCA-STACK.md']) assert.ok(file(rel).includes('grill-with-docs'), rel)
    assert.ok(file('assets/stack/ORCA-STACK.md').includes('Planning follows Matt\'s skills (`grill-with-docs`, `to-spec`, `to-tickets`, triggered'))
    const guide = file('docs/guia-setup.md')
    assert.ok(guide.includes('**`/grill-with-docs`** primero; si la planificación se va de las manos, **`/wayfinder`** la convierte en un mapa de tickets de decisión. Nunca arranques con `/wayfinder`.'))
    assert.doesNotMatch(guide, /normalmente `\/wayfinder`/)
    const manual = file('docs/manual.md')
    assert.ok(manual.includes('| 1 | Idea nueva o ambigua | Straight shot o `grill-with-docs`, `to-spec`, `to-tickets`'))
    assert.ok(manual.includes('**Dos caminos de planificación.** Un cambio chico según el test de ODD que no deja abierta ninguna decisión de producto es un **Straight shot**'))
    assert.ok(manual.includes('Todo lo demás arranca con `grill-with-docs`'))
    assert.ok(manual.includes('`wayfinder` llega solo cuando una sesión de `grill-with-docs` se va de las manos'))
  })

  test('Issue 322 Rule 1: steps 1, 2 and 5 apply cuts C1-C12 while keeping required rules and markers', () => {
    for (const text of [file('assets/stack/MAIN.md')]) {
      const s1 = step(text, 1)
      const s2 = step(text, 2)
      const s5 = step(text, 5)
      // C1:
      assert.ok(s1.includes('pedí ejemplos concretos y al menos un ejemplo negativo: cuándo debería rechazar o negarse.'))
      assert.ok(!s1.includes('de lo que debería pasar'))
      // C2:
      assert.ok(s1.includes('Proponé la skill que corresponde y esperá al humano.'))
      // C3:
      assert.ok(s2.includes('criterios de aceptación y `## Reglas`:'))
      // C4:
      assert.ok(s2.includes('`main` lo clasifica y aplica al issue una única etiqueta de clase: `cliente-requisito`, `cliente-integracion`, `cliente-borde` o `cliente-bug`.'))
      // C5:
      assert.ok(s2.includes('El ticket que corrige un problema del cliente incluye en `## Reglas` una regla que lo reproduce con su ejemplo,'))
      // C6:
      assert.ok(s2.includes('vinculá el reporte al ticket existente en vez de abrir un duplicado.'))
      assert.ok(!s2.includes('no lo cuentes otra vez'))
      // C7:
      assert.ok(s2.includes('o `inferido` (también una regla cuyo ejemplo el cliente no dio reproducible). Los valores `inferido` van a la agenda de la próxima llamada con el cliente y se marcan en el guion de demo hasta que el cliente los confirme.'))
      // C8:
      assert.ok(s2.includes('Checklist al escribir las reglas: qué pasa si falla o no responde una llamada externa, si algo falla entre dos escrituras, si llega null o vacío, o si se llama dos veces o en paralelo. Solo las preguntas que aplican a ese ticket se convierten en reglas.'))
      // C9:
      assert.ok(s2.includes('`## Reglas` reemplaza a `## Modos de falla` como sección requerida; los tickets con ese formato siguen siendo válidos.'))
      // C10:
      assert.ok(s2.includes('si hace falta una decisión de producto, preguntásela al humano.'))
      // C11:
      assert.ok(s5.includes('en busca de comentarios `Consulta:` (vía `orca-stack consultas`).'))
      // C12:
      assert.ok(s5.includes('Ante `worker-en-pausa #<n> <agente>`, main responde la `Consulta:` donde se hizo y corre `orca-stack reanudar <issue> <url-del-comentario>`.'))
      assert.ok(s5.includes('Ante `pr-en-conflicto #<n> PR #<pr> <sha>`, el PR quedó en conflicto con la base y GitHub no le corre la CI: corré `orca-stack rebote <pr>` una vez que su worker se detuvo'))
    }
  })

  test('Issue 322 Rule 2: negative examples and essential rules are preserved', () => {
    for (const text of [file('assets/stack/MAIN.md')]) {
      const s1 = step(text, 1)
      const s2 = step(text, 2)
      assert.ok(s2.includes('Si el cliente vuelve a reportar el mismo problema, vinculá el reporte al ticket existente en vez de abrir un duplicado'))
      assert.ok(s1.includes('#199'))
      assert.ok(s1.includes('#268'))
      assert.ok(s2.includes('Los riesgos que conocés van al ticket, no al review: así el implementador los prueba en vez de enterarse por un rebote.'))
    }
  })

  test('Issue 322 Rule 5: lines 1, 2 and 5 shrink by at least 350 bytes', () => {
    const text = file('assets/stack/MAIN.md')
    const s1 = step(text, 1)
    const s2 = step(text, 2)
    const s5 = step(text, 5)
    const currentBytes = Buffer.byteLength(s1, 'utf8') + Buffer.byteLength(s2, 'utf8') + Buffer.byteLength(s5, 'utf8')
    const drop = 4864 - currentBytes
    assert.ok(drop >= 350, `Expected drop >= 350 bytes, got ${drop}`)
  })
})
