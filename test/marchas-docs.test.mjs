import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { ROOT } from './helpers.mjs'

test('marchas docs explain the command, gears, gate and off switch', () => {
  const readme = readFileSync(`${ROOT}/README.md`, 'utf8')
  assert.match(readme, /`\/marcha` muestra o cambia la marcha de `main`: Lazy, Medium o Proactive/)
  assert.match(readme, /`\/marcha lazy`, `\/marcha medium` o `\/marcha proactive`/)
  assert.match(readme, /claude plugin disable marchas@inline --scope user/)
  assert.match(readme, /`--scope local`.*`--scope project`/)
})
