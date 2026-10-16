import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { PACKAGE_ROOT } from '../src/util.mjs'

test('Rule 10: the puente-gentle row of README.md tells main to pass pr or issue instead of pasting them', () => {
  const readme = readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8')
  const row = readme.split('\n').find(line => line.startsWith('| `puente-gentle` |'))
  assert.ok(row, 'README.md has no puente-gentle row')
  assert.match(row, /pasale `pr` o `issue` en vez de pegar el cuerpo, los comentarios o el diff en el planteo/)
})
