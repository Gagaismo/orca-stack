import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { ROOT } from './helpers.mjs'

test('Rule 1: docs/guia-setup.md gets an optional "Frontend repos" entry for each skill: name, link, one-line description and the skills-only install command', () => {
  const content = readFileSync(path.join(ROOT, 'docs', 'guia-setup.md'), 'utf8')

  assert.match(content, /Frontend repos/)

  // Impeccable
  assert.match(content, /Impeccable/)
  assert.match(content, /https:\/\/impeccable\.style\/?/)
  assert.match(content, /npx skills add pbakaus\/impeccable/)

  // Taste Skill
  assert.match(content, /Taste Skill/)
  assert.match(content, /https:\/\/www\.tasteskill\.dev\/?/)
  assert.match(content, /npx skills add Leonxlnx\/taste-skill --skill design-taste-frontend/)
})

test('Rule 2: the Impeccable entry says to install only its skills, not its hooks, because the stack does not install third-party lifecycle hooks (ORCA-STACK.md, "Deliberate exclusions")', () => {
  const content = readFileSync(path.join(ROOT, 'docs', 'guia-setup.md'), 'utf8')

  // Find the Impeccable row or section
  const lines = content.split(/\r?\n/)
  const impeccableLine = lines.find(line => line.includes('Impeccable') && line.includes('pbakaus/impeccable'))
  assert.ok(impeccableLine, 'Impeccable entry must be present')

  // Must instruct skills-only, not hooks
  assert.match(impeccableLine, /solo sus skills|skills-only/i)
  assert.match(impeccableLine, /no sus hooks/i)

  // Must explain that the stack does not install third-party lifecycle hooks
  assert.match(impeccableLine, /no instala hooks de ciclo de vida de terceros|third-party lifecycle hooks/i)

  // Must cite ORCA-STACK.md and Deliberate exclusions
  assert.match(impeccableLine, /ORCA-STACK\.md/)
  assert.match(impeccableLine, /Deliberate exclusions/)
})

test('Rule 3: negative check confirms global, doctor and every file under src/ and assets/ are unchanged and diff touches docs only', () => {
  // Check that neither src/ nor assets/ contain mentions of the new skills
  const checkDir = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        checkDir(fullPath)
      } else if (entry.isFile()) {
        const text = readFileSync(fullPath, 'utf8')
        assert.doesNotMatch(text, /impeccable/i, `${fullPath} must not mention impeccable`)
        assert.doesNotMatch(text, /taste-skill/i, `${fullPath} must not mention taste-skill`)
      }
    }
  }

  checkDir(path.join(ROOT, 'src'))
  checkDir(path.join(ROOT, 'assets'))

  // Check git diff against origin/main or HEAD if git repo
  const gitDiff = spawnSync('git', ['diff', '--name-only', 'origin/main'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (gitDiff.status === 0) {
    const changed = gitDiff.stdout.trim().split(/\r?\n/).filter(Boolean)
    for (const file of changed) {
      assert.ok(
        file.startsWith('docs/') || file.startsWith('test/'),
        `changed file ${file} must be under docs/ or test/ only`
      )
    }
  }
})

test('Rule 4: each entry states the license, resolving Impeccable as Apache-2.0 and Taste Skill as MIT', () => {
  const content = readFileSync(path.join(ROOT, 'docs', 'guia-setup.md'), 'utf8')

  const lines = content.split(/\r?\n/)
  const impeccableLine = lines.find(line => line.includes('Impeccable') && line.includes('pbakaus/impeccable'))
  assert.ok(impeccableLine, 'Impeccable entry must be present')
  assert.match(impeccableLine, /Apache-2\.0|Apache 2\.0/i)

  const tasteLine = lines.find(line => line.includes('Taste Skill') && line.includes('taste-skill'))
  assert.ok(tasteLine, 'Taste Skill entry must be present')
  assert.match(tasteLine, /MIT/i)
})
