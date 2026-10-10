import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { LAZY_SENTINEL, REVIEW_SECTIONS, lazyifyBlock, restoreBlock, sddBlock, trimReviewSections } from '../src/gentle.mjs'
import { KEPT_V4, fakeGentle, fixture, fixtureV4, sddConfig, withPath } from './gentle-fixture.mjs'
import { backups, cleanup, cli, read, snapshot, tempDir, write } from './helpers.mjs'

const COPY = '/tmp/home/.orca-stack/gentle/orchestrator.md'
const V4_OPEN = '<!-- gentle-ai:orchestrator -->'
const V4_CLOSE = '<!-- /gentle-ai:orchestrator -->'
const headings = text => text.split(/\r?\n/).filter(line => /^#{1,6} /.test(line))

describe('gentle-ai v4 block helpers', () => {
  test('rule 1: the v2/v3 block does not claim ODD is the default workflow', () => {
    const { text } = lazyifyBlock(fixture('\n'), COPY)
    assert.ok(!text.includes('ODD is the default workflow'))
    assert.ok(text.includes('The full gentle-ai coordinator rules are in'))
    assert.ok(text.includes('complete and unsummarized'))
    assert.ok(!text.includes('agent-routing block'))
    assert.ok(!text.includes('sdd-orchestrator-workflow.md'))
  })

  test('rule 2: the v4 block is found, lazyfied between its own markers and restored losslessly (LF and CRLF)', () => {
    for (const eol of ['\n', '\r\n']) {
      const text = fixtureV4(eol)
      assert.equal(sddBlock(text).status, 'ok')
      const { text: lazy, saved } = lazyifyBlock(text, COPY)
      assert.equal(saved, sddBlock(text).inner)
      assert.ok(lazy.includes(LAZY_SENTINEL) && lazy.includes(COPY))
      assert.ok(lazy.includes(V4_OPEN) && lazy.includes(V4_CLOSE))
      assert.ok(!lazy.includes('sdd-orchestrator-workflow.md'), 'v4 ships no SDD workflow file to point at')
      assert.ok(!lazy.includes('odd body') && lazy.includes('routing body') && lazy.includes('engram body'))
      assert.ok(!(eol === '\r\n' && /[^\r]\n/.test(lazy)), 'no bare LF in a CRLF file')
      assert.equal(restoreBlock(lazy, saved), text)
    }
  })

  test('rule 2: the v4 review sections are trimmed like v2, and every other heading and marker stays', () => {
    const { text, removed } = trimReviewSections(fixtureV4('\n'))
    assert.ok(removed > 0)
    assert.deepEqual(headings(text), KEPT_V4)
    for (const gone of REVIEW_SECTIONS) {
      assert.ok(!text.includes(gone), gone)
    }
    for (const body of ['defect body', 'gate body', 'checking body', 'entry body', 'table', 'concurrent body']) {
      assert.ok(!text.includes(body), body)
    }
    for (const marker of [V4_OPEN, V4_CLOSE, '<!-- gentle-ai:agent-routing -->', '<!-- /gentle-ai:agent-routing -->']) {
      assert.ok(text.includes(marker), marker)
    }
    assert.deepEqual(trimReviewSections(text), { text, removed: 0 })
  })

  test('rule 2: a file holding both a v2 and a v4 block is refused untouched', () => {
    const both = fixture('\n') + fixtureV4('\n')
    assert.equal(sddBlock(both).status, 'malformed')
    const result = lazyifyBlock(both, COPY)
    assert.equal(result.text, both)
    assert.equal(typeof result.skipped, 'string')
  })
})

describe('global, doctor and remove with a gentle-ai v4 block', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('v4-home')
    bin = tempDir('v4-bin')
    fakeGentle(bin, 'off')
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })
  const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md')
  const copy = () => path.join(home, '.orca-stack', 'gentle', 'orchestrator.md')
  const global = (...extra) => cli(home, ['global', '--skip-pi', '--humano', 'Ana', ...extra], { env: withPath(bin) })
  const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { env: withPath(bin) })

  test('rule 2: lazy mode saves the v4 body first and leaves a pointer to that copy', () => {
    write(claudeMd(), fixtureV4('\n'))
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /modo lazy: -\d+\.\d KB/)
    const md = read(claudeMd())
    assert.ok(md.includes(LAZY_SENTINEL) && md.includes(copy()) && md.includes(V4_OPEN))
    assert.equal(read(copy()), sddBlock(fixtureV4('\n')).inner)
    assert.doesNotMatch(doctor().out, /bloque de gentle-ai/)
  })

  test('rule 2: when the copy cannot be written the v4 block stays full (no pointer to a missing copy)', () => {
    write(claudeMd(), fixtureV4('\n'))
    write(copy(), 'not ours')
    const result = global()
    assert.match(result.out, /no pude guardar la copia completa/)
    assert.equal(read(claudeMd()), fixtureV4('\n'))
  })

  test('rule 2: full mode with RDD off trims the v4 review sections, and doctor reports no false drift', () => {
    sddConfig(home, 'full')
    write(claudeMd(), fixtureV4('\n'))
    const before = doctor().out
    assert.match(before, /⚠ secciones de review de gentle-ai/)
    assert.doesNotMatch(before, /cambió de forma/)
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /sin las secciones de review de gentle-ai/)
    assert.equal(read(claudeMd()), trimReviewSections(fixtureV4('\n')).text)
    assert.doesNotMatch(doctor().out, /gentle-ai en ~\/\.claude|secciones de review/)
  })

  test('rule 3: a v2 lazy block rewritten by a v4 sync makes doctor ask for global, and global refreshes the copy', () => {
    write(claudeMd(), fixture('\n'))
    assert.equal(global().status, 0)
    assert.equal(read(copy()), sddBlock(fixture('\n')).inner)
    // What v4 `gentle-ai sync` leaves: the legacy markers renamed in place and a fresh, full orchestrator body.
    write(claudeMd(), fixtureV4('\n'))
    assert.match(doctor().out, /⚠ bloque de gentle-ai en ~\/\.claude\/CLAUDE\.md - gentle-ai sync lo reescribió: corré `orca-stack global`/)
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.equal(read(copy()), sddBlock(fixtureV4('\n')).inner)
    assert.ok(read(claudeMd()).includes(LAZY_SENTINEL))
    assert.equal(restoreBlock(read(claudeMd()), read(copy())), fixtureV4('\n'))
    assert.doesNotMatch(doctor().out, /bloque de gentle-ai/)
  })

  test('rule 3: with RDD on, a v4 block after a v2 lazy one stays full and doctor is quiet about it', () => {
    write(claudeMd(), fixture('\n'))
    assert.equal(global().status, 0)
    write(claudeMd(), fixtureV4('\n'))
    fakeGentle(bin, 'on')
    assert.doesNotMatch(doctor().out, /bloque de gentle-ai/)
    const result = global()
    assert.match(result.out, /RDD de gentle-ai prendido: el bloque queda completo/)
    assert.equal(read(claudeMd()), fixtureV4('\n'))
  })

  test('rule 4: remove restores a lazy v4 block from its copy and leaves a full v4 block untouched', () => {
    write(claudeMd(), fixtureV4('\n'))
    assert.equal(global().status, 0)
    const restored = cli(home, ['remove'], { env: withPath(bin) })
    assert.equal(restored.status, 0, restored.out)
    assert.match(restored.out, /restauro el bloque completo de gentle-ai/)
    assert.equal(read(claudeMd()), fixtureV4('\n'))

    sddConfig(home, 'full')
    fakeGentle(bin, 'on') // nothing to trim: the block stays exactly as gentle-ai wrote it
    assert.equal(global().status, 0)
    assert.equal(read(claudeMd()), fixtureV4('\n'))
    const untouched = cli(home, ['remove'], { env: withPath(bin) })
    assert.equal(untouched.status, 0, untouched.out)
    assert.doesNotMatch(untouched.out, /restauro el bloque/)
    assert.equal(read(claudeMd()), fixtureV4('\n'))
  })

  test('rule 5: without any gentle-ai block global skips with a reason and writes nothing to CLAUDE.md', () => {
    const plain = '## Mine\nmy body\n'
    write(claudeMd(), plain)
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /se omite y no toco nada: no hay bloque gentle-ai/)
    assert.equal(read(claudeMd()), plain)
    assert.equal(existsSync(copy()), false)
    assert.equal(backups(home).filter(name => name.endsWith('CLAUDE.md')).length, 0)
    assert.doesNotMatch(doctor().out, /bloque de gentle-ai/)
    sddConfig(home, 'full')
    const before = snapshot(path.join(home, '.claude'))
    assert.match(global().out, /ya están recortadas \(o gentle-ai no las escribió\)/)
    assert.deepEqual(snapshot(path.join(home, '.claude')), before)
  })
})
