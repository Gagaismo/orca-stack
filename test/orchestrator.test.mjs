import assert from 'node:assert/strict'
import { existsSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { LAZY_SENTINEL, sddBlock } from '../src/gentle.mjs'
import { fakeGentle, fixtureV4, withPath } from './gentle-fixture.mjs'
import { backups, cleanup, cli, read, tempDir, write } from './helpers.mjs'

const NEW_COPY = home => path.join(home, '.orca-stack', 'gentle', 'orchestrator.md')
const OLD_COPY = home => path.join(home, '.orca-stack', 'gentle', 'sdd-orchestrator.md')
const OLD_POINTER_LINES = copy => [
  LAZY_SENTINEL,
  'gentle-ai ODD orchestrator / Judgment Day: only when the human explicitly asks for it.',
  `Before any gentle-ai ODD or Judgment-Day command or phase, read in full \`${copy}\`.`,
  "When a sub-agent or tool returns a blocking prompt, menu or consent envelope, present it complete and unsummarized, and never answer on the human's behalf.",
]
const oldLazyBlock = (text, copy) => {
  const block = sddBlock(text)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const inner = [eol, ...OLD_POINTER_LINES(copy)].join(eol) + eol

  return text.slice(0, block.from) + inner + text.slice(block.end)
}
const config = (home, gentle) => write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ gentle }))

describe('issue 101: lazy gentle-ai orchestrator migration', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('orchestrator-home')
    bin = tempDir('orchestrator-bin')
    fakeGentle(bin, 'off')
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })
  const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md')
  const global = (...extra) => cli(home, ['global', '--skip-pi', '--humano', 'Ana', ...extra], { env: withPath(bin) })
  const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { env: withPath(bin) })

  test('rule 1: a fresh v4 lazy block says ODD is the default and points to the new copy', () => {
    const full = fixtureV4('\n')
    write(claudeMd(), full)
    const result = global()
    assert.equal(result.status, 0, result.out)
    const md = read(claudeMd())
    assert.ok(md.includes(LAZY_SENTINEL))
    assert.ok(md.includes('ODD is the default workflow'))
    assert.ok(md.includes('see the agent-routing block'))
    assert.ok(md.includes(NEW_COPY(home)))
    assert.ok(md.includes('when you are the orchestrating session (`main`)'))
    assert.doesNotMatch(md, /only when the human explicitly asks|SDD|sdd-orchestrator-workflow/)
    assert.equal(read(NEW_COPY(home)), sddBlock(full).inner)
    assert.doesNotMatch(doctor().out, /bloque de gentle-ai/)
  })

  test('rule 2: global refreshes an old lazy pointer and is idempotent afterward', () => {
    const copy = OLD_COPY(home)
    write(claudeMd(), oldLazyBlock(fixtureV4('\n'), copy))
    write(copy, 'saved full body\n')
    const first = global()
    assert.equal(first.status, 0, first.out)
    const refreshed = read(claudeMd())
    assert.ok(refreshed.includes('ODD is the default workflow'))
    assert.ok(refreshed.includes(NEW_COPY(home)))
    assert.doesNotMatch(refreshed, /only when the human explicitly asks/)
    assert.equal(read(NEW_COPY(home)), 'saved full body\n')
    const after = read(claudeMd())
    const second = global()
    assert.equal(second.status, 0, second.out)
    assert.equal(read(claudeMd()), after)
  })

  test('rule 3: the legacy config key remains active and doctor recommends the rename', () => {
    config(home, { sddOrchestrator: 'lazy' })
    write(claudeMd(), fixtureV4('\n'))
    const before = doctor()
    assert.match(before.out, /gentle\.sddOrchestrator.*gentle\.orchestrator/)
    assert.equal(global().status, 0)
    assert.ok(read(claudeMd()).includes('ODD is the default workflow'))
    assert.equal(existsSync(NEW_COPY(home)), true)
  })

  test('rule 4: the new config key wins when both keys conflict and doctor says so', () => {
    config(home, { orchestrator: 'lazy', sddOrchestrator: 'full' })
    write(claudeMd(), fixtureV4('\n'))
    assert.match(doctor().out, /gentle\.orchestrator gana sobre.*gentle\.sddOrchestrator/i)
    assert.equal(global().status, 0)
    assert.ok(read(claudeMd()).includes(LAZY_SENTINEL))
    assert.equal(existsSync(NEW_COPY(home)), true)
  })

  test('rule 5: the legacy copy moves, collisions keep the newest content and back up the other', () => {
    const full = fixtureV4('\n')
    const old = OLD_COPY(home)
    write(claudeMd(), oldLazyBlock(full, old))
    write(old, sddBlock(full).inner)
    assert.equal(global().status, 0)
    assert.equal(read(NEW_COPY(home)), sddBlock(full).inner)
    assert.equal(existsSync(old), false)

    const remove = cli(home, ['remove'], { env: withPath(bin) })
    assert.equal(remove.status, 0, remove.out)
    assert.equal(read(claudeMd()), full)

    const fullModeHome = tempDir('orchestrator-full-migration')
    try {
      config(fullModeHome, { orchestrator: 'full' })
      write(claudeMdAt(fullModeHome), full)
      write(OLD_COPY(fullModeHome), 'saved legacy copy in full mode\n')
      const result = cli(fullModeHome, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
      assert.equal(result.status, 0, result.out)
      assert.equal(read(NEW_COPY(fullModeHome)), 'saved legacy copy in full mode\n')
      assert.equal(existsSync(OLD_COPY(fullModeHome)), false)
    } finally {
      cleanup(fullModeHome)
    }

    const collisionHome = tempDir('orchestrator-collision')
    try {
      const current = NEW_COPY(collisionHome)
      const legacy = OLD_COPY(collisionHome)
      write(claudeMdAt(collisionHome), oldLazyBlock(full, legacy))
      write(current, 'newer canonical content\n')
      write(legacy, 'older legacy content\n')
      const now = Date.now() / 1000
      utimesSync(current, now, now)
      utimesSync(legacy, now - 120, now - 120)
      const result = cli(collisionHome, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
      assert.equal(result.status, 0, result.out)
      assert.equal(read(current), 'newer canonical content\n')
      assert.equal(existsSync(legacy), false)
      assert.ok(backups(collisionHome).some(name => name.endsWith('sdd-orchestrator.md')))

      write(legacy, 'newer legacy content\n')
      write(current, 'older canonical content\n')
      utimesSync(current, now - 120, now - 120)
      utimesSync(legacy, now, now)
      const second = cli(collisionHome, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
      assert.equal(second.status, 0, second.out)
      assert.equal(read(current), 'newer legacy content\n')
      assert.equal(existsSync(legacy), false)
      assert.ok(backups(collisionHome).some(name => name.endsWith('orchestrator.md')))
    } finally {
      cleanup(collisionHome)
    }
  })

  test('rule 6: full mode restores the saved block byte for byte when RDD is on', () => {
    const full = fixtureV4('\r\n')
    fakeGentle(bin, 'on')
    write(claudeMd(), oldLazyBlock(full, OLD_COPY(home)))
    write(OLD_COPY(home), sddBlock(full).inner)
    config(home, { orchestrator: 'full' })
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.equal(read(claudeMd()), full)
    assert.equal(existsSync(OLD_COPY(home)), false)
    assert.equal(existsSync(NEW_COPY(home)), true)
  })

  test('rule 7: RDD on leaves a fresh full block unchanged and creates no copy', () => {
    const full = fixtureV4('\n')
    fakeGentle(bin, 'on')
    write(claudeMd(), full)
    config(home, { orchestrator: 'lazy' })
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.equal(read(claudeMd()), full)
    assert.equal(existsSync(NEW_COPY(home)), false)
    assert.doesNotMatch(doctor().out, /gentle-ai en ~\/\.claude/)
  })
})

const claudeMdAt = home => path.join(home, '.claude', 'CLAUDE.md')
