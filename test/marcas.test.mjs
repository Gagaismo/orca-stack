import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { MARKERS, commitOf, markerLines, markerValue, normalizeBody, startsWithMarker } from '../src/marcas.mjs'

const BOM = String.fromCharCode(0xfeff)
const HEAD = 'abc1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('protocol marker normaliser (issue #365, S9)', () => {
  test('MARKERS lists every protocol marker of issue #365', () => {
    assert.deepEqual(MARKERS, [
      'Revisor', 'Commit', 'Implementador', 'Rebote', 'Rebote CI', 'Rebote conflicto', 'RDD',
      'Respuesta de main', 'Respuesta del humano', 'Verificado por main', 'Decidido por main', 'Sin review',
    ])
  })

  test('Rule 3 (#365): every marker is read the same with a leading BOM and leading whitespace as without them', () => {
    for (const marker of MARKERS) {
      for (const lead of ['', BOM, `${BOM}  \r\n`, '  \n\t']) {
        const body = `${lead}${marker}: valor de prueba\nsegunda línea`
        assert.equal(startsWithMarker(body, marker), true, `${JSON.stringify(lead)} ${marker}`)
        assert.equal(markerValue(body, marker), 'valor de prueba', `${JSON.stringify(lead)} ${marker}`)
      }
    }
  })

  test('normalizeBody strips only the leading BOM and whitespace; markerLines trims every line', () => {
    assert.equal(normalizeBody(`${BOM} \nRevisor: codex\n`), 'Revisor: codex\n')
    assert.equal(normalizeBody(undefined), '')
    assert.deepEqual(markerLines(`${BOM}Revisor: codex  \r\n  Commit: ${HEAD}\n`), ['Revisor: codex', `Commit: ${HEAD}`, ''])
  })

  test('Rule 2 (#365): a quoted `> Revisor: codex` line is not a marker, nor is a marker in the middle of a line', () => {
    assert.equal(markerValue(`> Revisor: codex\n> Commit: ${HEAD}`, 'Revisor'), undefined)
    assert.equal(commitOf(`> Revisor: codex\n> Commit: ${HEAD}`), undefined)
    assert.equal(startsWithMarker('> Consulta: claude', 'Consulta'), false)
    assert.equal(markerValue('Ver Revisor: codex', 'Revisor'), undefined)
    assert.equal(startsWithMarker('Hola\nConsulta: claude', 'Consulta'), false)
  })

  test('commitOf accepts the sha bare or in backticks (7 to 40 hex), and nothing else', () => {
    assert.equal(commitOf(`Revisor: codex\nCommit: ${HEAD}`), HEAD)
    assert.equal(commitOf(`${BOM}Revisor: codex\nCommit: \`${HEAD}\``), HEAD)
    assert.equal(commitOf('Commit: `ABC1234`'), 'abc1234')
    assert.equal(commitOf('Commit: abc123'), undefined)
    assert.equal(commitOf(`Commit: ${HEAD} y algo más`), undefined)
    assert.equal(commitOf('Commit: `abc1234'), undefined)
  })

  test('markerValue can be limited to the first lines of a body, and a longer marker is not a shorter one', () => {
    assert.equal(markerValue('a\nb\nc\nd\ne\nRevisor: codex', 'Revisor', { within: 5 }), undefined)
    assert.equal(markerValue('a\nb\nc\nd\nRevisor: codex', 'Revisor', { within: 5 }), 'codex')
    assert.equal(markerValue('Rebote CI: abc1234', 'Rebote'), undefined)
    assert.equal(markerValue('Rebote CI: abc1234', 'Rebote CI'), 'abc1234')
  })
})
