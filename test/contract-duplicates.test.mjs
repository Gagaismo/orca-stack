import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

const ASSET_DIR = path.join(process.cwd(), 'assets', 'stack')
const MARKDOWN_LIST_ITEM = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/

const units = text => text
  .split(/\r?\n\s*\r?\n/)
  .flatMap(block => {
    const lines = block.split(/\r?\n/)
    if (!lines.some(line => MARKDOWN_LIST_ITEM.test(line))) return [block]

    const items = []
    for (const line of lines) {
      if (MARKDOWN_LIST_ITEM.test(line)) items.push(line)
      else if (items.length) items[items.length - 1] += ` ${line.trim()}`
    }
    return items.length ? items : [block]
  })
  .map(unit => unit.trim().replace(/\s+/g, ' '))
  .filter(Boolean)

const duplicatesIn = files => {
  const duplicates = []
  for (const [file, text] of Object.entries(files)) {
    const seen = new Set()
    for (const unit of units(text)) {
      if (unit.length < 80) continue
      if (seen.has(unit)) duplicates.push(`${file}: repeated "${unit.slice(0, 60)}"`)
      else seen.add(unit)
    }
  }
  return duplicates
}

describe('stack contract duplicate paragraphs and list items', () => {
  test('CONTRATO.md has one step 9 and steps 1 through 10 in order', () => {
    const contract = readFileSync(path.join(ASSET_DIR, 'CONTRATO.md'), 'utf8')
    const cycle = contract.split('### Ciclo de `main`')[1].split('\n### Verificación')[0]
    const steps = [...cycle.matchAll(/^(\d+)\./gm)].map(([, number]) => Number(number))
    assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  test('reports repeated whole paragraphs or list items with the filename and a 60-character preview', () => {
    const repeated = '9. Después del merge: se integra la propuesta y se verifica el despliegue antes de cerrar el trabajo.'
    const duplicates = duplicatesIn({ 'assets/stack/example.md': `${repeated}\n\n${repeated}` })
    assert.deepEqual(duplicates, [`assets/stack/example.md: repeated "${repeated.slice(0, 60)}"`])
  })

  test('ignores repeated units shorter than 80 characters', () => {
    assert.deepEqual(duplicatesIn({ 'assets/stack/example.md': 'nada\n\n| --- |\n\n| --- |\n\nnada' }), [])
  })

  test('does not flag one sentence repeated inside different longer paragraphs', () => {
    const sentence = 'A public entry is touched when its own code changed in the diff.'
    const first = `${sentence} This paragraph explains the pull request evidence requirement in more detail.`
    const second = `${sentence} This paragraph explains the review evidence requirement in more detail.`
    assert.deepEqual(duplicatesIn({ 'assets/stack/example.md': `${first}\n\n${second}` }), [])
  })

  test('allows the same unit in different files', () => {
    const repeated = 'The same long contract sentence can intentionally appear in more than one document.'
    assert.deepEqual(duplicatesIn({
      'assets/stack/one.md': repeated,
      'assets/stack/two.md': repeated,
    }), [])
  })

  test('all stack markdown files have no repeated paragraphs or list items', () => {
    const files = Object.fromEntries(readdirSync(ASSET_DIR)
      .filter(name => name.endsWith('.md'))
      .map(name => [`assets/stack/${name}`, readFileSync(path.join(ASSET_DIR, name), 'utf8')]))
    assert.deepEqual(duplicatesIn(files), [])
  })
})
