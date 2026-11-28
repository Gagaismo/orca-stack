import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, read } from './helpers.mjs'

const contract = read(path.join(ROOT, 'assets/stack/CONTRATO.md'))
const agents = read(path.join(ROOT, 'AGENTS.md'))
const main = read(path.join(ROOT, 'assets/stack/MAIN.md'))

const orchestrationLine = text => text.split(/\r?\n/).find(line => line.startsWith('- Un PR de orquestación'))
const step10 = main.split(/\r?\n/).find(line => line.startsWith('10. '))

describe('issue 509', () => {
  test('R1: a main session in Gentle Shell signs Implementador: pi', () => {
    assert.ok(orchestrationLine(contract)?.includes('(el agente de `main`, que es `pi` cuando `main` corre en Gentle Shell'), orchestrationLine(contract))
  })

  test('R2: a main session in Claude Code still signs claude', () => {
    assert.ok(orchestrationLine(contract)?.includes('y `claude` cuando corre en Claude Code, o `pi` en una sesión de planificación)'), orchestrationLine(contract))
  })

  test('R3: AGENTS.md carries the same Implementador line as the contract', () => {
    assert.equal(orchestrationLine(agents), orchestrationLine(contract))
  })

  test('R4: step 10 skips the count when no issue was ever labeled cliente-*, says so and still records the cutoff', () => {
    assert.ok(step10.includes('Si ningún issue del repo tiene ni tuvo una etiqueta `cliente-*` (`gh issue list --state all --label <etiqueta>` vacío para las cuatro), omití el conteo, decilo en una línea («sin issues `cliente-*`: no hay conteo») y registrá igual la fecha de corte.'), step10)
  })

  test('R5: with at least one issue ever labeled cliente-*, step 10 counts the four classes even when all are 0', () => {
    assert.ok(step10.includes('Con al menos un issue etiquetado `cliente-*` en cualquier momento, el conteo se hace por las cuatro clases, aunque desde la fecha de corte dé 0 en todas.'), step10)
    assert.ok(step10.includes('separados por clase de problema encontrado por el cliente (`cliente-requisito`, `cliente-integracion`, `cliente-borde`, `cliente-bug`)'), step10)
  })
})
