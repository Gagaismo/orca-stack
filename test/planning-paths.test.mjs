import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { read } from './helpers.mjs'

const root = process.cwd()
const file = rel => read(path.join(root, rel))
const contract = file('assets/stack/CONTRATO.md')
const agents = file('AGENTS.md')
const step = (text, n) => text.split(/\r?\n/).find(line => line.startsWith(`${n}. `)) ?? ''
const section = (text, heading) => text.split(`### ${heading}`)[1]?.split('\n### ')[0] ?? ''

describe('planning paths (#267)', () => {
  test('Rule 1: step 1 defines the Straight shot by the ODD small test, with its examples and the #199 negative', () => {
    for (const text of [contract, agents]) {
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
    for (const text of [contract, agents]) {
      const s1 = step(text, 1)
      assert.ok(s1.includes('**Mediano o grande**: si no, `main` propone primero `grill-with-docs` y después `to-spec` y `to-tickets`'))
      assert.ok(s1.includes('la cantidad de líneas nunca decide cuál'))
      assert.ok(s1.includes('un cambio de 10 líneas a una regla del contrato que deja abierta una decisión de producto va por acá'))
    }
  })

  test('Rule 3: step 1 proposes wayfinder only after a grill-with-docs session outgrows itself, never for an idea with no grilling', () => {
    for (const text of [contract, agents]) {
      const s1 = step(text, 1)
      assert.ok(s1.includes('`main` propone `wayfinder` solo cuando una sesión de `grill-with-docs` se le va de las manos, nunca para una idea nueva que todavía no pasó por `grill-with-docs`, y la dispara el humano (por ejemplo "/wayfinder let\'s turn this into a map")'))
    }
  })

  test('Rule 4: the contract names grill-with-docs, never grilling, in step 1, Agentes, Marchas and Skills de Matt', () => {
    for (const text of [contract, agents]) {
      assert.ok(step(text, 1).includes('`grill-with-docs`'))
      assert.doesNotMatch(step(text, 1), /`grilling`/)
      assert.ok(section(text, 'Agentes').includes('Planificación con las skills de Matt (`grill-with-docs`, `to-spec`, `to-tickets`, disparadas por el humano)'))
      assert.ok(section(text, 'Marchas').includes('A Proactive cuando empieza la planificación (`grill-with-docs`, `to-spec`, `to-tickets` o charting de un map)'))
      assert.ok(section(text, 'Skills de Matt').includes('`grill-with-docs`, `to-spec`, `to-tickets`, `wayfinder`, `triage`, `retro` y `ask-matt` solo las puede disparar el humano'))
      assert.doesNotMatch(text, /`grilling`|\(grilling,/)
    }
  })

  test('Rule 5: step 2 adds ## Pedido original and ## Tareas to every new ticket and keeps older tickets valid', () => {
    for (const text of [contract, agents]) {
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
})
