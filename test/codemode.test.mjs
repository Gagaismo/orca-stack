import assert from 'node:assert/strict'
import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import {
  codexCodemodeStatus,
  ensureCodexCodemode,
  ensurePiCodemode,
  piCodemodeStatus,
} from '../src/codemode.mjs'
import { checkCodemode, doctorCommand } from '../src/doctor.mjs'
import { globalCommand } from '../src/global.mjs'
import { createCtx } from '../src/ctx.mjs'
import { backups, cleanup, read, tempDir, write } from './helpers.mjs'

export const fakeCodex = (dir, { codeMode = 'false', hasCodeMode = true, enableFails = false } = {}) => {
  const win = process.platform === 'win32'
  const scriptPath = path.join(dir, 'fake-codex.mjs')
  write(
    scriptPath,
    `
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (process.env.CODEX_INVOCATION_LOG) {
  appendFileSync(process.env.CODEX_INVOCATION_LOG, JSON.stringify(args) + '\\n')
}
if (args[0] === 'features' && args[1] === 'list') {
  ${
    hasCodeMode
      ? `console.log('code_mode                                under development  ${codeMode}')`
      : `console.log('other_feature                            stable             true')`
  }
  process.exit(0)
}
if (args[0] === 'features' && args[1] === 'enable' && args[2] === 'code_mode') {
  if (${enableFails}) {
    console.error('error enabling feature')
    process.exit(1)
  }
  process.exit(0)
}
process.exit(0)
`,
  )
  const file = path.join(dir, win ? 'codex.cmd' : 'codex')
  write(file, win ? `@node "${scriptPath}" %*\r\n` : `#!/bin/sh\nnode "${scriptPath}" "$@"\n`)
  if (!win) {
    chmodSync(file, 0o755)
  }

  return file
}

describe('codemode rules 1-6', () => {
  let home
  let binDir

  beforeEach(() => {
    home = tempDir('codemode-home')
    binDir = tempDir('codemode-bin')
  })

  afterEach(() => {
    cleanup(home)
    cleanup(binDir)
  })

  test('Rule 1: pi settings.json without +codemode in defaultTools adds it and keeps every other key and defaultTools entry', () => {
    const messages = []
    const ctx = createCtx({ home, out: msg => messages.push(msg) })
    const piBin = path.join(binDir, 'pi')
    write(piBin, '#!/bin/sh\n')

    const settingsFile = path.join(ctx.L.piAgent, 'settings.json')
    const initial = {
      tuiMode: 'fullscreen',
      defaultModel: 'claude-opus-5-5',
      defaultTools: ['read', 'write'],
    }
    write(settingsFile, JSON.stringify(initial, null, 2) + '\n')

    const result = ensurePiCodemode(ctx, { piBin })
    assert.equal(result, 'updated')

    const updated = JSON.parse(read(settingsFile))
    assert.equal(updated.tuiMode, 'fullscreen')
    assert.equal(updated.defaultModel, 'claude-opus-5-5')
    assert.deepEqual(updated.defaultTools, ['read', 'write', '+codemode'])
    assert.ok(messages.some(m => m.includes('activé codemode en Pi')))
  })

  test('Rule 1: pi settings.json with -codemode replaces it with +codemode', () => {
    const ctx = createCtx({ home })
    const piBin = path.join(binDir, 'pi')
    write(piBin, '#!/bin/sh\n')

    const settingsFile = path.join(ctx.L.piAgent, 'settings.json')
    write(settingsFile, JSON.stringify({ defaultTools: ['-codemode', 'read'] }, null, 2))

    const result = ensurePiCodemode(ctx, { piBin })
    assert.equal(result, 'updated')

    const updated = JSON.parse(read(settingsFile))
    assert.deepEqual(updated.defaultTools, ['read', '+codemode'])
  })

  test('Rule 2: codex config without code_mode = true enables it with codex features enable code_mode and does not hand-edit TOML', () => {
    const messages = []
    const ctx = createCtx({ home, out: msg => messages.push(msg) })
    const logFile = path.join(home, 'codex-invocations.log')
    const codexBin = fakeCodex(binDir, { codeMode: 'false' })

    const configFile = path.join(ctx.L.codexDir, 'config.toml')
    const initialToml = '# user comment\n[features]\njs_repl = false\n'
    write(configFile, initialToml)

    const result = ensureCodexCodemode(ctx, { codexBin, env: { ...process.env, CODEX_INVOCATION_LOG: logFile } })
    assert.equal(result, 'updated')

    // TOML file is not hand-edited by orca-stack:
    assert.equal(read(configFile), initialToml)

    // The enable command was executed:
    const log = read(logFile)
    assert.ok(log.includes('["features","enable","code_mode"]'))
    assert.ok(messages.some(m => m.includes('activé codemode en codex')))
  })

  test('Rule 3: already on in both changes nothing and says so', () => {
    const messages = []
    const ctx = createCtx({ home, out: msg => messages.push(msg) })

    // Pi already on:
    const piBin = path.join(binDir, 'pi')
    write(piBin, '#!/bin/sh\n')
    const settingsFile = path.join(ctx.L.piAgent, 'settings.json')
    write(settingsFile, JSON.stringify({ defaultTools: ['+codemode'] }, null, 2))

    const piResult = ensurePiCodemode(ctx, { piBin })
    assert.equal(piResult, 'unchanged')
    assert.ok(messages.some(m => m.includes('codemode en Pi ya está activado')))

    // Codex already on:
    const logFile = path.join(home, 'codex-invocations.log')
    const codexBin = fakeCodex(binDir, { codeMode: 'true' })
    const codexResult = ensureCodexCodemode(ctx, { codexBin, env: { ...process.env, CODEX_INVOCATION_LOG: logFile } })
    assert.equal(codexResult, 'unchanged')
    assert.ok(messages.some(m => m.includes('codemode en codex ya está activado')))
    assert.ok(existsSync(logFile))
    assert.ok(!read(logFile).includes('["features","enable","code_mode"]'))
  })

  test('Rule 4: codex or pi not installed skips with a message, never an error', () => {
    const messages = []
    const ctx = createCtx({ home, out: msg => messages.push(msg) })

    const piResult = ensurePiCodemode(ctx, { piBin: null })
    assert.equal(piResult, 'skipped_not_installed')
    assert.ok(messages.some(m => m.includes('pi no está instalado: omito la configuración de codemode')))

    const codexResult = ensureCodexCodemode(ctx, { codexBin: null })
    assert.equal(codexResult, 'skipped_not_installed')
    assert.ok(messages.some(m => m.includes('codex no está instalado: omito la configuración de codemode')))

    assert.equal(ctx.failures, 0)
  })

  test('Rule 5: codex features list without code_mode row is skipped saying the feature does not exist in that version', () => {
    const messages = []
    const ctx = createCtx({ home, out: msg => messages.push(msg) })
    const codexBin = fakeCodex(binDir, { hasCodeMode: false })

    const result = ensureCodexCodemode(ctx, { codexBin })
    assert.equal(result, 'skipped_unsupported')
    assert.ok(messages.some(m => m.includes('la versión instalada de codex no incluye la feature code_mode: se omite')))
    assert.equal(ctx.failures, 0)
  })

  test('Rule 6: settings files are backed up before writing', () => {
    const ctx = createCtx({ home })
    const piBin = path.join(binDir, 'pi')
    write(piBin, '#!/bin/sh\n')
    const settingsFile = path.join(ctx.L.piAgent, 'settings.json')
    write(settingsFile, JSON.stringify({ defaultTools: ['read'] }, null, 2))

    ensurePiCodemode(ctx, { piBin })
    const piBackups = backups(home).filter(b => b.includes('settings.json'))
    assert.equal(piBackups.length, 1)

    const codexBin = fakeCodex(binDir, { codeMode: 'false' })
    const configFile = path.join(ctx.L.codexDir, 'config.toml')
    write(configFile, '# original config\n')

    ensureCodexCodemode(ctx, { codexBin })
    const codexBackups = backups(home).filter(b => b.includes('config.toml'))
    assert.equal(codexBackups.length, 1)
  })

  test('Rule 8: doctor shows a row per runtime: codemode on, off (with the command that turns it on), or not applicable', () => {
    const rows = []
    const add = (level, label, detail) => rows.push({ level, label, detail })
    const ctx = createCtx({ home })

    // Setup: Pi on, Codex off
    const piBin = path.join(binDir, 'pi')
    write(piBin, '#!/bin/sh\n')
    const settingsFile = path.join(ctx.L.piAgent, 'settings.json')
    write(settingsFile, JSON.stringify({ defaultTools: ['+codemode'] }, null, 2))

    const codexBin = fakeCodex(binDir, { codeMode: 'false' })

    const piStatus = piCodemodeStatus(ctx.L, { piBin })
    assert.equal(piStatus.status, 'on')
    assert.ok(piStatus.detail.includes('+codemode en defaultTools'))

    const codexStatus = codexCodemodeStatus(ctx.L, { codexBin })
    assert.equal(codexStatus.status, 'off')
    assert.equal(codexStatus.command, 'codex features enable code_mode')

    checkCodemode(add, { L: ctx.L, flags: { skipPi: false } })
    const labels = rows.map(r => r.label)
    assert.ok(labels.includes('Pi'))
    assert.ok(labels.includes('Codex'))
    assert.ok(labels.includes('Claude Code'))

    const claudeRow = rows.find(r => r.label === 'Claude Code')
    assert.equal(claudeRow.level, 'ok')
    assert.ok(claudeRow.detail.includes('no aplicable'))
  })

  test('Rule 8: doctor shows off with command that turns it on, and not applicable when uninstalled', () => {
    const ctx = createCtx({ home })

    // Pi uninstalled:
    const piUninstalled = piCodemodeStatus(ctx.L, { piBin: null })
    assert.equal(piUninstalled.status, 'not_applicable')
    assert.equal(piUninstalled.detail, 'no está instalado')

    // Pi installed but settings missing -> off with orca-stack global:
    const piBin = path.join(binDir, 'pi')
    write(piBin, '#!/bin/sh\n')
    const piMissingSettings = piCodemodeStatus(ctx.L, { piBin })
    assert.equal(piMissingSettings.status, 'off')
    assert.equal(piMissingSettings.command, 'orca-stack global')

    // Codex uninstalled:
    const codexUninstalled = codexCodemodeStatus(ctx.L, { codexBin: null })
    assert.equal(codexUninstalled.status, 'not_applicable')
    assert.equal(codexUninstalled.detail, 'no está instalado')

    // Codex unsupported version:
    const codexNoFeature = fakeCodex(binDir, { hasCodeMode: false })
    const codexUnsupported = codexCodemodeStatus(ctx.L, { codexBin: codexNoFeature })
    assert.equal(codexUnsupported.status, 'not_applicable')
    assert.ok(codexUnsupported.detail.includes('no soporta code_mode'))
  })

  test('PRESERVE: globalCommand runs successfully and sets up codemode without crashing', async () => {
    const prevHome = process.env.ORCA_STACK_HOME
    process.env.ORCA_STACK_HOME = home
    try {
      const exitCode = await globalCommand({ dryRun: true, skipPi: true, force: false })
      assert.equal(exitCode, 0)
    } finally {
      process.env.ORCA_STACK_HOME = prevHome
    }
  })
})
