import assert from 'node:assert/strict'
import { chmodSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { LAZY_SENTINEL, rddMode, restoreBlock, sddBlock, trimReviewSections } from '../src/gentle.mjs'
import { sddConfig, withPath } from './gentle-fixture.mjs'
import { ROOT, cleanup, cli, read, tempDir, write } from './helpers.mjs'

// Copied from a real `gentle-ai sync --agents claude-code` and `gentle-ai review mode status` of v5.1.0, run with a
// throwaway HOME/USERPROFILE (#413).
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'gentle-ai-v5.1.0')
const SYNCED = readFileSync(path.join(FIXTURES, 'CLAUDE.md'), 'utf8')
const STATUS_OFF = path.join(FIXTURES, 'review-mode-status-off.txt')
const STATUS_DEFAULT = path.join(FIXTURES, 'review-mode-status-default.txt')

const gentleAnswering = (dir, statusFile) => {
  const win = process.platform === 'win32'
  const file = path.join(dir, win ? 'gentle-ai.cmd' : 'gentle-ai')
  write(file, win ? `@type "${statusFile}"\r\n` : `#!/bin/sh\ncat "${statusFile}"\n`)
  if (!win) {
    chmodSync(file, 0o755)
  }

  return file
}
const gentleRows = out => out.split(/\r?\n/).map(line => line.trim()).filter(line => /gentle-ai/.test(line) && /^[⚠✗]/.test(line))

describe('gentle-ai v5.1.0 review mode status', () => {
  let bin
  beforeEach(() => {
    bin = tempDir('v5-status-bin')
  })
  afterEach(() => cleanup(bin))

  test('rule 5: the first line of a real v5.1.0 status is read as mode and source', () => {
    assert.deepEqual(rddMode(gentleAnswering(bin, STATUS_DEFAULT)), { mode: 'on', source: 'default' })
    assert.deepEqual(rddMode(gentleAnswering(bin, STATUS_OFF)), { mode: 'off', source: 'global' })
  })

  test('rule 5: a status in a format it does not recognize is unknown, without an exception', () => {
    const other = path.join(bin, 'other.txt')
    write(other, '{"mode":"on","source":"default"}\n')
    assert.deepEqual(rddMode(gentleAnswering(bin, other)), { mode: null, source: null })
  })
})

describe('global and doctor against a gentle-ai v5.1.0 sync', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('v5-home')
    bin = tempDir('v5-bin')
    gentleAnswering(bin, STATUS_OFF)
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })
  const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md')
  const copy = () => path.join(home, '.orca-stack', 'gentle', 'orchestrator.md')
  const global = () => cli(home, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
  const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { env: withPath(bin) })

  test('rule 3: lazy mode finds the v5.1.0 orchestrator block and replaces it with the pointer to its copy', () => {
    write(claudeMd(), SYNCED)
    assert.equal(sddBlock(SYNCED).status, 'ok')
    assert.deepEqual(gentleRows(doctor().out), ['⚠ bloque de gentle-ai en ~/.claude/CLAUDE.md - gentle-ai sync lo reescribió: corré `orca-stack global` (gentle.orchestrator es "lazy")'])
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /modo lazy: -\d+\.\d KB/)
    const md = read(claudeMd())
    assert.ok(md.includes(LAZY_SENTINEL) && md.includes(copy()))
    assert.equal(read(copy()), sddBlock(SYNCED).inner)
    assert.equal(restoreBlock(md, read(copy())), SYNCED)
    assert.deepEqual(gentleRows(doctor().out), [])
  })

  test('rule 3: full mode with RDD off trims the v5.1.0 review sections and doctor reports no other drift', () => {
    sddConfig(home, 'full')
    write(claudeMd(), SYNCED)
    assert.deepEqual(gentleRows(doctor().out), ['⚠ secciones de review de gentle-ai en ~/.claude/CLAUDE.md - siguen presentes con RDD apagado y se cargan en cada sesión: corré `orca-stack global` de nuevo (gentle-ai sync las restaura)'])
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /sin las secciones de review de gentle-ai/)
    const trimmed = trimReviewSections(SYNCED)
    assert.equal(trimmed.skipped, undefined)
    assert.ok(trimmed.removed > 0)
    assert.equal(read(claudeMd()), trimmed.text)
    assert.deepEqual(gentleRows(doctor().out), [])
  })

  test('rule 4: an instructions file without any orchestrator block gets no gentle-ai block row from doctor', () => {
    const plain = SYNCED.slice(0, SYNCED.indexOf('<!-- gentle-ai:orchestrator -->'))
    write(claudeMd(), plain)
    assert.equal(sddBlock(plain).status, 'none')
    assert.deepEqual(gentleRows(doctor().out), [])
    assert.match(global().out, /se omite y no toco nada: no hay bloque gentle-ai/)
  })
})
