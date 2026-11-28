import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { ROOT } from './helpers.mjs'

const ADR = path.join(ROOT, 'docs', 'adr', '0002-deprecate-ponytail-adopt-comment-rule.md')
const STANDARDS = path.join(ROOT, 'CODING_STANDARDS.md')
const ASSETS_STANDARDS = path.join(ROOT, 'assets', 'lint', 'CODING_STANDARDS.md')
const TWEET = 'https://x.com/mattpocockuk/status/2123798388227403983'

const tableRows = text => {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === '| Type | Action |')
  assert.notEqual(start, -1, 'the comment-rule table header is required')
  const rows = []
  for (const line of lines.slice(start)) {
    if (!line.startsWith('|')) break
    rows.push(line.trim())
  }
  return rows
}

describe('#419 CODING_STANDARDS.md', () => {
  test('S1: CODING_STANDARDS.md holds the comment-rule table exactly as ADR 0002 has it, with the tweet as source', () => {
    const adrRows = tableRows(readFileSync(ADR, 'utf8'))
    assert.equal(adrRows.length, 6)
    const standards = readFileSync(STANDARDS, 'utf8')
    assert.deepEqual(tableRows(standards), adrRows)
    assert.ok(standards.includes(TWEET), 'the tweet source URL is required')
  })

  test('S4, S5: the lint section names the clear tautology examples and the checkable stale case, and the judgment rules cover the rest', () => {
    const standards = readFileSync(STANDARDS, 'utf8')
    assert.ok(standards.includes('`// increment i`'))
    assert.ok(standards.includes('`// return the result`'))
    assert.match(standards, /llamada `nombre\(\)` a una función que no está definida ni importada en el archivo/)
    assert.match(standards, /identificador entre backticks nunca se marca/)
    assert.match(standards, /## Reglas de juicio/)
    assert.match(standards, /docs\/adr\/0002-deprecate-ponytail-adopt-comment-rule\.md/)
    assert.match(standards, /docs\/adr\/0003-ast-grep-for-lint\.md/)
  })

  test('S3, S4: the lint section matches the code: uppercase markers, the temporary-file exception and the tautology size limit', () => {
    const standards = readFileSync(STANDARDS, 'utf8')
    assert.match(standards, /`TODO`, `FIXME`, `HACK` o `XXX` en mayúsculas/)
    assert.match(standards, /"temporary" seguido de file, directory/)
    assert.match(standards, /de dos a seis palabras/)
  })

  test('R4: CODING_STANDARDS.md and assets/lint/CODING_STANDARDS.md allow ADR, #n or owner/repo#n while keeping the ADR 0002 table unchanged', () => {
    const adrRows = tableRows(readFileSync(ADR, 'utf8'))
    const ruleSentence = 'El único comentario permitido es un Decision Record que cita un ADR o un issue `#n` (o `owner/repo#n` si es de otro repo).'
    const standards = readFileSync(STANDARDS, 'utf8')
    const assetsStandards = readFileSync(ASSETS_STANDARDS, 'utf8')
    for (const text of [standards, assetsStandards]) {
      assert.ok(text.includes(ruleSentence), 'missing updated Decision Record sentence')
      assert.deepEqual(tableRows(text), adrRows)
    }
    assert.match(standards, /un comentario que cita `#123`, `owner\/repo#123`, `ADR 0002` o un link a `docs\/adr\/0002-…` pasa/)
  })
})
