import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { read } from './helpers.mjs'

// Issue 397 S6: MAIN.md Despacho describes supervised dispatch instead of a handoff.
const ROOT = process.cwd()
const main = read(path.join(ROOT, 'assets', 'stack', 'MAIN.md'))
const manual = read(path.join(ROOT, 'docs', 'manual.md'))
const section = (text, heading) => (text.split(`\n${heading}\n`)[1]?.split('\n### ')[0] ?? '').trim()

describe('issue 397: supervised dispatch in MAIN.md and the manual', () => {
  test('S6: MAIN.md Despacho states the supervised model and no longer the handoff', () => {
    const despacho = section(main, '### Despacho')
    for (const gone of ['El despacho es un handoff', 'no se lo supervisa con `orca orchestration`', 'salvo que el humano pida supervisar un Run', 'Elegir la marcha Proactive cuenta como pedirlo', 'colabora sin un Run de Orca']) {
      assert.ok(!despacho.includes(gone), gone)
    }
    for (const kept of [
      '`despachar` arranca cada worker con `orca orchestration worker-start` como worker supervisado del Run de Orca ligado a la sesión de `main`',
      'Mientras los workers trabajan, `main` termina su turno y la despiertan los eventos del único Monitor de `orca-stack vigilar`',
      '`worker-terminado #<n> <agente> ok|partial`',
      '`main` nunca lee terminales de workers',
      'Los reviews no cambian: `orca-stack revisar`',
      'Reglas de colaboración:',
      '`orca-stack reanudar` es la única forma en que main llega a una terminal de worker'
    ]) assert.ok(despacho.includes(kept), kept)
  })

  test('S6: the manual drops the handoff and lists the worker-terminado event of vigilar', () => {
    assert.ok(!manual.includes('El despacho es un handoff'))
    assert.ok(manual.includes('| `worker-terminado #<n> <agente> ok\\|partial` |'))
    assert.ok(manual.includes('`orca orchestration worker-start`'))
  })
})
