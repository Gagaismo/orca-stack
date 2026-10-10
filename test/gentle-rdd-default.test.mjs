import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { rddMode } from '../src/gentle.mjs'
import { driftWarnings } from '../src/drift.mjs'
import { fakeGentle, fixtureV4, sddConfig, withPath } from './gentle-fixture.mjs'
import { cleanup, cli, read, tempDir, write } from './helpers.mjs'
import { layout } from '../src/util.mjs'

const fakeGentleCustom = (dir, content) => {
  const win = process.platform === 'win32'
  const file = path.join(dir, win ? 'gentle-ai.cmd' : 'gentle-ai')
  write(file, win ? `@echo ${content}\r\n` : `#!/bin/sh\necho "${content}"\n`)
  if (!win) {
    chmodSync(file, 0o755)
  }
}

const fakeGentleRecording = (dir, logFile) => {
  const win = process.platform === 'win32'
  const file = path.join(dir, win ? 'gentle-ai.cmd' : 'gentle-ai')
  const script = win
    ? `@echo %* >> "${logFile}"\r\n@echo receipt-driven development: on (decided by default)\r\n`
    : `#!/bin/sh\necho "$*" >> "${logFile}"\necho "receipt-driven development: on (decided by default)"\n`
  write(file, script)
  if (!win) {
    chmodSync(file, 0o755)
  }
}

describe('gentle-ai v4 RDD on by default: rules 1-6', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('rdd-home')
    bin = tempDir('rdd-bin')
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })

  const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md')
  const runGlobal = () => cli(home, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
  const runDoctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { env: withPath(bin) })

  test('rule 1: status on (decided by default) makes global keep full block and warn with disable and global commands', () => {
    fakeGentleCustom(bin, 'receipt-driven development: on (decided by default)')
    write(claudeMd(), fixtureV4('\n'))
    const result = runGlobal()
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /RDD de gentle-ai prendido: el bloque queda completo/)
    assert.match(result.out, /gentle-ai review mode disable/)
    assert.match(result.out, /orca-stack global/)
    assert.match(result.out, /está prendido solo por defecto en gentle-ai v4/)
    assert.equal(read(claudeMd()), fixtureV4('\n'), 'keeps full block')

    // Also in full mode
    sddConfig(home, 'full')
    const fullResult = runGlobal()
    assert.equal(fullResult.status, 0, fullResult.out)
    assert.match(fullResult.out, /RDD\) está prendido/)
    assert.match(fullResult.out, /gentle-ai review mode disable/)
    assert.match(fullResult.out, /orca-stack global/)
    assert.match(fullResult.out, /está prendido solo por defecto en gentle-ai v4/)
  })

  test('rule 2: status on (decided by default) makes doctor show a warn row with disable and global commands', () => {
    fakeGentleCustom(bin, 'receipt-driven development: on (decided by default)')
    write(claudeMd(), fixtureV4('\n'))
    const result = runDoctor()
    assert.match(result.out, /⚠ RDD de gentle-ai - está prendido solo por defecto en gentle-ai v4: si no lo elegiste, corré `gentle-ai review mode disable` y después `orca-stack global`/)
  })

  test('rule 3: status on (decided by global) or on (decided by clone-local) produces no warning and identical output', () => {
    for (const source of ['global', 'clone-local', 'clone_local']) {
      fakeGentleCustom(bin, `receipt-driven development: on (decided by ${source})`)
      write(claudeMd(), fixtureV4('\n'))
      const globalRes = runGlobal()
      assert.equal(globalRes.status, 0, globalRes.out)
      assert.match(globalRes.out, /RDD de gentle-ai prendido: el bloque queda completo/)
      assert.doesNotMatch(globalRes.out, /está prendido solo por defecto/)
      assert.doesNotMatch(globalRes.out, /gentle-ai review mode disable/)

      const doctorRes = runDoctor()
      assert.doesNotMatch(doctorRes.out, /⚠ RDD de gentle-ai/)
      assert.doesNotMatch(doctorRes.out, /gentle-ai review mode disable/)
    }
  })

  test('rule 4: status off with any source produces no warning and identical output', () => {
    for (const source of ['default', 'global', 'clone-local']) {
      fakeGentleCustom(bin, `receipt-driven development: off (decided by ${source})`)
      write(claudeMd(), fixtureV4('\n'))
      const globalRes = runGlobal()
      assert.equal(globalRes.status, 0, globalRes.out)
      assert.match(globalRes.out, /modo lazy/)
      assert.doesNotMatch(globalRes.out, /está prendido solo por defecto/)
      assert.doesNotMatch(globalRes.out, /gentle-ai review mode disable/)

      const doctorRes = runDoctor()
      assert.doesNotMatch(doctorRes.out, /⚠ RDD de gentle-ai/)
      assert.doesNotMatch(doctorRes.out, /gentle-ai review mode disable/)
    }
  })

  test('rule 5: status without decided by or unreadable produces no warning and preserves on/off decision', () => {
    // Older gentle-ai: no (decided by ...)
    fakeGentleCustom(bin, 'receipt-driven development: on')
    write(claudeMd(), fixtureV4('\n'))
    const globalLegacy = runGlobal()
    assert.equal(globalLegacy.status, 0, globalLegacy.out)
    assert.match(globalLegacy.out, /RDD de gentle-ai prendido: el bloque queda completo/)
    assert.doesNotMatch(globalLegacy.out, /está prendido solo por defecto/)
    assert.doesNotMatch(globalLegacy.out, /gentle-ai review mode disable/)

    const doctorLegacy = runDoctor()
    assert.doesNotMatch(doctorLegacy.out, /⚠ RDD de gentle-ai/)
    assert.doesNotMatch(doctorLegacy.out, /gentle-ai review mode disable/)

    // Unreadable (exit code 1 or unparseable output)
    const win = process.platform === 'win32'
    const failFile = path.join(bin, win ? 'gentle-ai.cmd' : 'gentle-ai')
    write(failFile, win ? '@echo error>&2\r\n@exit 1\r\n' : '#!/bin/sh\necho error >&2\nexit 1\n')
    if (!win) {
      chmodSync(failFile, 0o755)
    }
    const globalFail = runGlobal()
    assert.equal(globalFail.status, 0, globalFail.out)
    assert.match(globalFail.out, /RDD de gentle-ai en un estado que no pude leer: el bloque queda completo/)
    assert.doesNotMatch(globalFail.out, /está prendido solo por defecto/)

    const doctorFail = runDoctor()
    assert.doesNotMatch(doctorFail.out, /⚠ RDD de gentle-ai/)
  })

  test('rule 6: neither global nor doctor ever runs gentle-ai review mode enable or disable', () => {
    const logFile = path.join(home, 'calls.log')
    fakeGentleRecording(bin, logFile)
    write(claudeMd(), fixtureV4('\n'))

    runGlobal()
    runDoctor()

    const calls = read(logFile) ?? ''
    assert.ok(calls.includes('review mode status'), 'calls status')
    assert.doesNotMatch(calls, /enable/, 'never calls enable')
    assert.doesNotMatch(calls, /disable/, 'never calls disable')
  })
})

describe('preserve existing public entries touched by the diff', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('preserve-home')
    bin = tempDir('preserve-bin')
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })

  test('preserve: rddMode parses on/off/null and source structure', () => {
    fakeGentleCustom(bin, 'receipt-driven development: on (decided by default)')
    const gentleBin = path.join(bin, process.platform === 'win32' ? 'gentle-ai.cmd' : 'gentle-ai')
    assert.deepEqual(rddMode(gentleBin), { mode: 'on', source: 'default' })

    fakeGentleCustom(bin, 'receipt-driven development: off (decided by global)')
    assert.deepEqual(rddMode(gentleBin), { mode: 'off', source: 'global' })

    fakeGentleCustom(bin, 'receipt-driven development: on')
    assert.deepEqual(rddMode(gentleBin), { mode: 'on', source: null })

    fakeGentleCustom(bin, 'unrelated output')
    assert.deepEqual(rddMode(gentleBin), { mode: null, source: null })
  })

  test('preserve: driftWarnings still reports other drift conditions like uncopied lazy blocks', () => {
    fakeGentleCustom(bin, 'receipt-driven development: off (decided by global)')
    sddConfig(home, 'lazy')
    const L = layout(home)
    write(L.claudeMd, '<!-- gentle-ai:orchestrator -->\n<!-- orca-stack:gentle-lazy v1 -->\n<!-- /gentle-ai:orchestrator -->')
    const warnings = driftWarnings(L)
    assert.ok(warnings.some(w => w.label.includes('bloque de gentle-ai en modo lazy sin su copia')), 'reports missing copy')
  })

  test('preserve: globalCommand converts gentle block to lazy mode when RDD is off', () => {
    fakeGentleCustom(bin, 'receipt-driven development: off (decided by global)')
    const claudeMd = path.join(home, '.claude', 'CLAUDE.md')
    write(claudeMd, fixtureV4('\n'))
    const result = cli(home, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
    assert.equal(result.status, 0)
    assert.match(result.out, /modo lazy/)
    assert.ok(read(claudeMd).includes('<!-- orca-stack:gentle-lazy v1 -->'))
  })

  test('preserve: doctorCommand reports installation status and exit status', () => {
    fakeGentleCustom(bin, 'receipt-driven development: on (decided by global)')
    const result = cli(home, ['doctor', '--offline', '--skip-pi'], { env: withPath(bin) })
    assert.match(result.out, /orca-stack doctor/)
    assert.match(result.out, /Instalación/)
  })
})
