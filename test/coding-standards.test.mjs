import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { ROOT } from './helpers.mjs'

const ADR = path.join(ROOT, 'docs', 'adr', '0002-deprecate-ponytail-adopt-comment-rule.md')
const STANDARDS = path.join(ROOT, 'CODING_STANDARDS.md')
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
    assert.match(standards, /identificador que ya no existe en el archivo/)
    assert.match(standards, /## Reglas de juicio/)
    assert.match(standards, /docs\/adr\/0002-deprecate-ponytail-adopt-comment-rule\.md/)
    assert.match(standards, /docs\/adr\/0003-ast-grep-for-lint\.md/)
  })
})
