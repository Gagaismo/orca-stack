import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { PACKAGE_ROOT } from '../src/util.mjs'

test('Rule 1: AGENTS.md says confirmed consult blocker is published in review format with Revisor pi and bounces with rebote', () => {
  const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
  const projectRules = agents.split('## Project rules')[1]
  assert.ok(projectRules, 'AGENTS.md has no Project rules section')
  const bullet = projectRules.split('\n').find(line => line.startsWith('- **No reviews in this repo for now'))
  assert.ok(bullet, 'AGENTS.md has no No reviews bullet')

  assert.match(bullet, /When the Gentle Shell consult of a PR finds a blocker and main has confirmed it in the code/)
  assert.match(bullet, /main publishes it with `--body-file` as a comment in the review format/)
  assert.match(bullet, /`Revisor: pi \(consulta <tema>, publicada por main\)`/)
  assert.match(bullet, /`Commit: <headRefOid>`/)
  assert.match(bullet, /`## BLOQUEA`/)
  assert.match(bullet, /`## SUGERENCIAS`/)
  assert.match(bullet, /`orca-stack rebote <pr>`/)
})

test('Rule 2: AGENTS.md says fix merges only with CI green and Verificado por main, re-consulting Gentle Shell if fix changes more', () => {
  const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
  const projectRules = agents.split('## Project rules')[1]
  const bullet = projectRules.split('\n').find(line => line.startsWith('- **No reviews in this repo for now'))
  assert.ok(bullet, 'AGENTS.md has no No reviews bullet')

  assert.match(bullet, /After the author's fix, main merges only with CI green on the new head/)
  assert.match(bullet, /`Verificado por main: hallazgos <n,…> corregidos en <sha>`/)
  assert.match(bullet, /`Commit: <sha>`/)
  assert.match(bullet, /written after reading `gh pr diff` against each finding/)
  assert.match(bullet, /when the fix changes more than the findings, main consults Gentle Shell again in the same tema before merging/)
})

test('Rule 3: AGENTS.md negative rule: unconfirmed consult finding is not published as BLOQUEA and shows Lautaro both positions', () => {
  const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
  const projectRules = agents.split('## Project rules')[1]
  const bullet = projectRules.split('\n').find(line => line.startsWith('- **No reviews in this repo for now'))
  assert.ok(bullet, 'AGENTS.md has no No reviews bullet')

  assert.match(bullet, /A consult finding that main could not confirm is not published as `## BLOQUEA`/)
  assert.match(bullet, /main shows Lautaro both positions with their reasons, as today/)
})

test('Rule 4: docs/manual.md section rebote says in a repo without reviews the blocking comment can come from a confirmed consult', () => {
  const manual = readFileSync(path.join(PACKAGE_ROOT, 'docs', 'manual.md'), 'utf8')
  const reboteSection = manual.split('#### `rebote`')[1]?.split('####')[0]
  assert.ok(reboteSection, 'docs/manual.md has no rebote section')

  assert.match(reboteSection, /En un repo sin reviews, el comentario bloqueante puede venir de una consulta confirmada\./)
})

test('Rule 5 (preserve): touched public entries none (documentation only); contract duplicates test stays green', () => {
  const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes('<!-- orca-stack:begin -->'))
  assert.ok(agents.includes('<!-- orca-stack:end -->'))
  assert.ok(agents.includes('## Project rules'))
})
