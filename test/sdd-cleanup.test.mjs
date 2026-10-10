import assert from 'node:assert/strict'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { cleanupKnownSdd } from '../src/sdd-cleanup.mjs'
import { cleanup, cli, read, tempDir, write } from './helpers.mjs'

let home
beforeEach(() => { home = tempDir('sdd-cleanup') })
afterEach(() => cleanup(home))

const knownFiles = [
  '.claude/agents/sdd-apply.md',
  '.claude/skills/_shared/sdd-orchestrator-sections.md',
  '.agents/skills/sdd-apply/SKILL.md',
  '.claude/commands/gentle-sdd-apply.md',
]
const phaseNames = ['apply', 'archive', 'design', 'explore', 'init', 'onboard', 'propose', 'research', 'spec', 'tasks', 'verify']
const knownInventory = [
  ...phaseNames.map(name => `.claude/agents/sdd-${name}.md`),
  ...phaseNames.map(name => `.claude/skills/sdd-${name}`),
  ...['sdd-orchestrator-sections.md', 'sdd-orchestrator-workflow.md', 'sdd-phase-common.md', 'sdd-status-contract.md']
    .map(name => `.claude/skills/_shared/${name}`),
  ...phaseNames.map(name => `.agents/skills/sdd-${name}`),
  ...['apply', 'archive', 'continue', 'explore', 'ff', 'init', 'new', 'onboard', 'research', 'status', 'verify']
    .map(name => `.claude/commands/gentle-sdd-${name}.md`),
  ...['apply', 'archive', 'continue', 'explore', 'ff', 'init', 'new', 'onboard', 'research', 'status', 'verify']
    .map(name => `.claude/skills/gentle-sdd-${name}`),
]

describe('explicit SDD cleanup', () => {
  test('global help documents cleanup as explicit and backup-only', () => {
    const result = cli(home, ['global', '--help'])

    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /--limpiar-sdd/)
    assert.match(result.out, /backup|respaldo/i)
  })

  test('doctor lists present known leftovers and the exact opt-in cleanup command', () => {
    write(path.join(home, knownFiles[0]), 'leftover')

    const result = cli(home, ['doctor', '--offline', '--skip-pi'])

    assert.match(result.out, /SDD.*orca-stack global --limpiar-sdd/i)
    assert.match(result.out, new RegExp(knownFiles[0].replaceAll('/', '[\\\\/]')))
  })

  test('doctor lists every known path family and cleanup removes the inventory', () => {
    for (const entry of knownInventory) {
      const file = entry.endsWith('.md') ? entry : `${entry}/SKILL.md`
      write(path.join(home, file), `leftover:${entry}`)
    }

    const doctorBefore = cli(home, ['doctor', '--offline', '--skip-pi'])
    for (const entry of knownInventory) {
      assert.match(doctorBefore.out, new RegExp(entry.replaceAll('/', '[\\\\/]')))
    }
    assert.match(doctorBefore.out, /orca-stack global --limpiar-sdd/)
    assert.equal((doctorBefore.out.match(/orca-stack global --limpiar-sdd/g) ?? []).length, 1)

    const result = cli(home, ['global', '--limpiar-sdd', '--skip-pi'])
    assert.equal(result.status, 0, result.out)
    const doctorAfter = cli(home, ['doctor', '--offline', '--skip-pi'])
    assert.doesNotMatch(doctorAfter.out, /restos SDD conocidos/)
  })

  test('cleanup leaves unknown SDD-named files untouched', () => {
    const unknown = path.join(home, '.claude', 'agents', 'sdd-my-custom-agent.md')
    write(unknown, 'user-owned')

    const result = cli(home, ['global', '--limpiar-sdd', '--skip-pi'])

    assert.equal(result.status, 0, result.out)
    assert.equal(read(unknown), 'user-owned')
  })

  test('explicit cleanup backs up known files while preserving paths', () => {
    for (const file of knownFiles) write(path.join(home, file), `contents:${file}`)

    const result = cli(home, ['global', '--limpiar-sdd', '--skip-pi'])

    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Se respaldaron 4 restos SDD conocidos/i)
    const backupRoot = path.join(home, '.orca-stack', 'backups')
    const backups = readdirSync(backupRoot).filter(name => name.startsWith('sdd-'))
    assert.equal(backups.length, 1)
    for (const file of knownFiles) {
      assert.equal(existsSync(path.join(home, file)), false, file)
      assert.equal(read(path.join(backupRoot, backups[0], file)), `contents:${file}`)
    }
  })

  test('ordinary global leaves known SDD files and unknown SDD names untouched', () => {
    const known = path.join(home, knownFiles[0])
    const unknown = path.join(home, '.claude', 'agents', 'sdd-my-custom-agent.md')
    write(known, 'known')
    write(unknown, 'unknown')

    const result = cli(home, ['global', '--skip-pi'])

    assert.equal(result.status, 0, result.out)
    assert.equal(read(known), 'known')
    assert.equal(read(unknown), 'unknown')
    assert.equal(existsSync(path.join(home, '.orca-stack', 'backups')), false)
  })

  test('--dry-run previews cleanup without moving files or creating backups', () => {
    const known = path.join(home, knownFiles[0])
    write(known, 'known')

    const result = cli(home, ['global', '--limpiar-sdd', '--dry-run', '--skip-pi'])

    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Se respaldar\u00EDan 1 restos SDD conocidos/)
    assert.equal(read(known), 'known')
    assert.equal(existsSync(path.join(home, '.orca-stack', 'backups')), false)
  })

  test('empty explicit cleanup succeeds with a clear no-leftovers message', () => {
    const result = cli(home, ['global', '--limpiar-sdd', '--skip-pi'])

    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /No hay restos SDD conocidos/i)
  })

  test('partial backup failures keep failed paths and allow retry of the remainder', () => {
    for (const file of knownFiles) write(path.join(home, file), `contents:${file}`)
    const backupRoot = path.join(home, '.orca-stack', 'backups', 'sdd-203008150930')
    write(path.join(backupRoot, '.claude', 'agents'), 'blocks this subtree')
    const messages = []

    const partial = cleanupKnownSdd(home, {
      now: new Date('2030-08-15T09:30:00Z'),
      say: message => messages.push(message),
      move: (source, destination) => {
        if (source.endsWith('sdd-apply.md')) throw new Error('simulated move failure')
        return renameSync(source, destination)
      },
    })

    assert.equal(partial.status, 1, messages.join('\n'))
    assert.equal(existsSync(path.join(home, knownFiles[0])), true)
    assert.ok(partial.moved.length > 0)
    assert.match(messages.join('\n'), /No se pudo respaldar.*sdd-apply/)
    assert.match(messages.join('\n'), /Volv\u00E9 a ejecutar orca-stack global --limpiar-sdd/)

    cleanup(path.join(backupRoot, '.claude', 'agents'))
    const retry = cli(home, ['global', '--limpiar-sdd', '--skip-pi'])
    assert.equal(retry.status, 0, retry.out)
    for (const file of knownFiles) assert.equal(existsSync(path.join(home, file)), false, file)
  })
})
