import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { ROOT } from './helpers.mjs'

const INSTALL = 'go install github.com/gentleman-programming/gentle-ai/v5/cmd/gentle-ai@v5.1.0'
const doc = rel => readFileSync(path.join(ROOT, rel), 'utf8')
const docsTree = dir => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
  const rel = path.join(dir, entry.name)
  if (entry.isDirectory()) {
    return docsTree(rel)
  }

  return entry.name.endsWith('.md') ? [rel] : []
})

describe('gentle-ai v5.1.0 documentation (#413)', () => {
  test('rule 1: README.md and docs/guia-setup.md install gentle-ai v5.1.0 and no doc installs v4', () => {
    for (const rel of ['README.md', path.join('docs', 'guia-setup.md')]) {
      assert.ok(doc(rel).includes(INSTALL), rel)
    }
    for (const rel of ['README.md', 'UPDATE.md', ...docsTree('docs')]) {
      assert.doesNotMatch(doc(rel), /\/v4\/cmd\/gentle-ai|@v4\./, rel)
    }
  })

  test('rule 6: UPDATE.md gives the five steps in order and forbids the npm gentle-pi install with the fork', () => {
    const text = doc('UPDATE.md')
    const steps = [
      'Gagaismo/gentle-shell#9',
      'git pull',
      '#321',
      INSTALL,
      'gentle-ai sync',
      'pi install <ruta-del-fork>',
      'npx github:Gagaismo/orca-stack#<versión> global',
      'orca-stack doctor',
      'Abrí sesiones nuevas',
    ]
    let from = 0
    for (const step of steps) {
      const at = text.indexOf(step, from)
      assert.ok(at >= 0, `missing or out of order: ${step}`)
      from = at + step.length
    }
    assert.match(text, /\*\*No\*\* corras `pi install npm:gentle-pi@<versión>` cuando gentle-pi viene del fork: [^\n]*reemplaza las costuras de orca \(el toggle, la guardia con `estado` y el consentimiento RDD\)/)
  })
})
