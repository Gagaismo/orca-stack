import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { LAZY_SENTINEL, lazyifyBlock, restoreBlock, sddBlock, sddMode } from '../src/gentle.mjs'
import { fakeGentle, fixture, sddConfig, withPath } from './gentle-fixture.mjs'
import { backups, cleanup, cli, read, snapshot, tempDir, write } from './helpers.mjs'

const COPY = '/tmp/home/.orca-stack/gentle/sdd-orchestrator.md'

describe('lazy block helpers', () => {
  test('lazyify keeps the markers, saves the exact body and restore is lossless (LF and CRLF)', () => {
    for (const eol of ['\n', '\r\n']) {
      const text = fixture(eol)
      const { text: lazy, saved } = lazyifyBlock(text, COPY)
      assert.equal(saved, sddBlock(text).inner)
      assert.ok(lazy.includes(LAZY_SENTINEL))
      assert.ok(lazy.includes(COPY))
      assert.ok(lazy.includes('<!-- gentle-ai:sdd-orchestrator -->') && lazy.includes('<!-- /gentle-ai:sdd-orchestrator -->'))
      assert.ok(!lazy.includes('lossless body'))
      assert.ok(lazy.includes('engram body'))
      assert.ok(!(eol === '\r\n' && /[^\r]\n/.test(lazy)), 'no bare LF in a CRLF file')
      assert.equal(restoreBlock(lazy, saved), text)
    }
  })

  test('missing, duplicated or reordered markers are refused untouched', () => {
    const open = '<!-- gentle-ai:sdd-orchestrator -->'
    const close = '<!-- /gentle-ai:sdd-orchestrator -->'
    const cases = [`${open}\nbody\n`, `body\n${close}\n`, `${close}\nx\n${open}\n`, `${open}\na\n${close}\n${open}\nb\n${close}\n`, 'no block\n']
    for (const text of cases) {
      const result = lazyifyBlock(text, COPY)
      assert.equal(result.text, text)
      assert.equal(typeof result.skipped, 'string')
    }
  })

  test('sddMode defaults to lazy and rejects anything but lazy or full', () => {
    assert.equal(sddMode(null), 'lazy')
    assert.equal(sddMode({}), 'lazy')
    assert.equal(sddMode({ gentle: { sddOrchestrator: 'full' } }), 'full')
    assert.equal(sddMode({ gentle: { sddOrchestrator: 'nope' } }), null)
  })
})

describe('global and the lazy gentle-ai block', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('lazy-home')
    bin = tempDir('lazy-bin')
    fakeGentle(bin, 'on') // RDD on: the review trim never interferes
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })
  const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md')
  const copy = () => path.join(home, '.orca-stack', 'gentle', 'sdd-orchestrator.md')
  const global = (...extra) => cli(home, ['global', '--skip-pi', '--humano', 'Ana', ...extra], { env: withPath(bin) })
  const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { env: withPath(bin) })

  test('default mode: backs up, saves the full body, leaves a pointer, and a second run changes nothing', () => {
    write(claudeMd(), fixture('\n'))
    const first = global()
    assert.equal(first.status, 0, first.out)
    assert.match(first.out, /modo lazy: -\d+\.\d KB/)
    assert.match(first.out, /KB menos en cada sesión/)
    const md = read(claudeMd())
    assert.ok(md.includes(LAZY_SENTINEL))
    assert.ok(md.includes(copy()))
    assert.ok(md.includes('engram body'))
    assert.ok(!md.includes('Native Checking Contract'))
    assert.equal(read(copy()), sddBlock(fixture('\n')).inner)
    const saved = backups(home).filter(name => name.endsWith('CLAUDE.md'))
    assert.equal(saved.length, 1)
    assert.equal(read(path.join(home, saved[0])), fixture('\n'))

    const after = snapshot(home)
    const second = global()
    assert.equal(second.status, 0, second.out)
    assert.match(second.out, /ya está en modo lazy/)
    assert.deepEqual(snapshot(home), after)
  })

  test('--dry-run reports the change and writes nothing', () => {
    write(claudeMd(), fixture('\n'))
    const before = snapshot(home)
    const result = global('--dry-run')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\[simulación\] actualizo .*modo lazy/)
    assert.deepEqual(snapshot(home), before)
  })

  test('a gentle-ai sync that rewrote the block gets the copy refreshed', () => {
    write(claudeMd(), fixture('\n'))
    assert.equal(global().status, 0)
    write(claudeMd(), fixture('\n').replace('lossless body', 'lossless body v2'))
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.ok(read(copy()).includes('lossless body v2'))
    assert.ok(read(claudeMd()).includes(LAZY_SENTINEL))
    assert.ok(!read(claudeMd()).includes('lossless body'))
  })

  test('markers that are unbalanced are skipped with a reason and nothing is written', () => {
    const broken = fixture('\n').replace('<!-- /gentle-ai:sdd-orchestrator -->', '')
    write(claudeMd(), broken)
    const result = global()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /se omite y no toco nada: los marcadores del bloque de gentle-ai están incompletos/)
    assert.equal(read(claudeMd()), broken)
    assert.equal(existsSync(copy()), false)
  })

  test('a foreign file at the copy path stops the change and keeps the block', () => {
    write(claudeMd(), fixture('\n'))
    write(copy(), 'not ours')
    const result = global()
    assert.match(result.out, /no pude guardar la copia completa/)
    assert.equal(read(claudeMd()), fixture('\n'))
    assert.equal(read(copy()), 'not ours')
  })

  test('full mode restores the block from the copy (with a backup); without the copy it says so and changes nothing', () => {
    write(claudeMd(), fixture('\n'))
    assert.equal(global().status, 0)
    sddConfig(home, 'full')
    const lazy = read(claudeMd())
    const kept = read(copy())
    cleanup(path.dirname(copy()))
    const missing = global()
    assert.match(missing.out, /falta .*sdd-orchestrator\.md: corré `gentle-ai sync`/)
    assert.equal(read(claudeMd()), lazy)
    write(copy(), kept)
    const before = backups(home).length
    const restored = global()
    assert.equal(restored.status, 0, restored.out)
    assert.match(restored.out, /restaurado desde la copia/)
    assert.equal(read(claudeMd()), fixture('\n'))
    assert.equal(backups(home).length, before + 1)
  })

  test('remove restores the full block and deletes the gentle folder', () => {
    write(claudeMd(), fixture('\n'))
    assert.equal(global().status, 0)
    assert.ok(existsSync(copy()))
    const result = cli(home, ['remove'], { env: withPath(bin) })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /restauro el bloque completo de gentle-ai/)
    assert.equal(read(claudeMd()), fixture('\n'))
    assert.equal(existsSync(path.dirname(copy())), false)
  })

  test('remove --dry-run leaves the lazy block and the copy alone', () => {
    write(claudeMd(), fixture('\n'))
    assert.equal(global().status, 0)
    const before = snapshot(home)
    const result = cli(home, ['remove', '--dry-run'], { env: withPath(bin) })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\[simulación\] restauro el bloque completo/)
    assert.deepEqual(snapshot(home), before)
  })

  test('doctor: lazy mode warns on a full block, fails on a pointer without its copy, and is clean otherwise', () => {
    write(claudeMd(), fixture('\n'))
    assert.match(doctor().out, /⚠ bloque de gentle-ai en ~\/\.claude\/CLAUDE\.md - gentle-ai sync lo reescribió: corré `orca-stack global`/)
    assert.equal(global().status, 0)
    assert.doesNotMatch(doctor().out, /bloque de gentle-ai/)
    cleanup(path.dirname(copy()))
    const broken = doctor()
    assert.match(broken.out, /✖ bloque de gentle-ai en modo lazy sin su copia/)
    assert.equal(broken.status, 1)
  })

  test('doctor: full mode keeps the old checks and flags a leftover pointer', () => {
    sddConfig(home, 'full')
    write(claudeMd(), fixture('\n'))
    fakeGentle(bin, 'off')
    const out = doctor().out
    assert.match(out, /⚠ secciones de review de gentle-ai/)
    assert.doesNotMatch(out, /modo lazy/)
    sddConfig(home, 'lazy')
    assert.equal(global().status, 0)
    sddConfig(home, 'full')
    assert.match(doctor().out, /⚠ bloque de gentle-ai .* sigue en modo lazy pero gentle\.sddOrchestrator es "full"/)
  })

  test('an invalid gentle.sddOrchestrator value changes nothing and says so', () => {
    sddConfig(home, 'nope')
    write(claudeMd(), fixture('\n'))
    const result = global()
    assert.match(result.out, /tiene que ser "lazy" o "full"/)
    assert.equal(read(claudeMd()), fixture('\n'))
  })
})
