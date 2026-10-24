import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { codexTrustStatus } from '../src/doctor.mjs'
import { cleanup, cli, git, read, tempDir, write } from './helpers.mjs'

const dirs = []
const sampleRoot = () => path.resolve(os.homedir(), 'Documents', 'orca-stack')
const tomlPath = value => value.replaceAll('/', '\\')
const temp = prefix => {
  const dir = tempDir(prefix)
  dirs.push(dir)

  return dir
}

afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop())
})

describe('doctor: Codex project trust', () => {
  test('Rule 3: doctor warns for retired agent values in every config layer without editing them', () => {
    const home = temp('retired-agent-doctor-home')
    const repo = temp('retired-agent-doctor-repo')
    assert.equal(git(repo, 'init').status, 0)
    const layers = [
      { file: path.join(home, '.orca-stack', 'config.json'), label: '~/.orca-stack/config.json' },
      { file: path.join(repo, '.orca-stack.json'), label: '.orca-stack.json' },
      { file: path.join(repo, '.orca-stack.local.json'), label: '.orca-stack.local.json' },
    ]
    const values = [
      ['agentes.usa', { agentes: { usa: ['codex-cc'] } }],
      ['agentes.preguntarAntes', { agentes: { preguntarAntes: ['codex-cc'] } }],
      ['agentes.modelos', { agentes: { modelos: { 'codex-cc': { modelo: 'gpt-6-luna' } } } }],
    ]

    for (const layer of layers) {
      for (const [key, value] of values) {
        for (const candidate of layers) write(candidate.file, JSON.stringify({ setup: 'completo', agentes: { usa: ['claude'], preguntarAntes: [], modelos: {} } }))
        write(layer.file, JSON.stringify({ setup: 'completo', ...value }))
        const before = layers.map(candidate => read(candidate.file))
        const result = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
        assert.ok(result.out.includes(`codex-cc ya no existe: sacalo de ${layer.label} (${key}).`), result.out)
        assert.deepEqual(layers.map(candidate => read(candidate.file)), before)
      }
    }
  })

  test('a trusted entry for the repo root reports ok', () => {
    const root = sampleRoot()
    const file = path.join(temp('codex-trust'), 'config.toml')
    write(file, `[projects.'${tomlPath(root).toLowerCase()}']\ntrust_level = "trusted"\n`)

    assert.deepEqual(codexTrustStatus(root, file), { level: 'ok', detail: '' })
  })

  test('path comparison ignores case and treats slash styles alike', () => {
    const root = sampleRoot()
    const file = path.join(temp('codex-trust'), 'config.toml')
    write(file, `[projects.'${tomlPath(root).toLowerCase()}']\ntrust_level = "trusted"\n`)

    assert.deepEqual(codexTrustStatus(root.toUpperCase().replaceAll('\\', '/'), file), { level: 'ok', detail: '' })
  })

  test('literal and basic TOML project keys both match the repo root', () => {
    const root = sampleRoot()
    const literal = path.join(temp('codex-literal'), 'config.toml')
    const basic = path.join(temp('codex-basic'), 'config.toml')
    write(literal, `[projects.'${tomlPath(root).toLowerCase()}']\ntrust_level = "trusted"\n`)
    write(basic, `[projects."${tomlPath(root).toLowerCase().replaceAll('\\', '\\\\')}"]\ntrust_level = "trusted"\n`)

    assert.equal(codexTrustStatus(root, literal).level, 'ok')
    assert.equal(codexTrustStatus(root, basic).level, 'ok')
  })

  test('an entry with a trust level other than trusted warns with dispatch exact Codex trust hint', () => {
    const root = sampleRoot()
    const file = path.join(temp('codex-untrusted'), 'config.toml')
    write(file, `[projects.'${tomlPath(root)}']\ntrust_level = "untrusted"\n`)

    const result = codexTrustStatus(root, file)
    assert.equal(result.level, 'warn')
    assert.ok(result.detail.includes(`Confiá la raíz del repo en Codex: [projects.'${root}'] trust_level = "trusted" en ~/.codex/config.toml.`))
  })

  test('missing, unreadable, and malformed config warn without throwing', () => {
    const root = sampleRoot()
    const home = temp('codex-config-errors')
    const missing = path.join(home, 'missing.toml')
    const unreadable = path.join(home, 'directory.toml')
    const malformed = path.join(home, 'malformed.toml')
    // A directory at the config path makes readFileSync fail on Windows and POSIX.
    mkdirSync(unreadable)
    write(malformed, `[projects.'${tomlPath(root)}']\ntrust_level = [\n`)

    const absent = codexTrustStatus(root, missing)
    assert.equal(absent.level, 'warn')
    assert.ok(absent.detail.includes(`Confiá la raíz del repo en Codex: [projects.'${root}'] trust_level = "trusted" en ~/.codex/config.toml.`))
    assert.match(codexTrustStatus(root, unreadable).detail, /directory\.toml/)
    assert.match(codexTrustStatus(root, malformed).detail, /malformed\.toml/)
  })

  test('#83 rule 1: CODEX_HOME set, doctor checks trust in $CODEX_HOME/config.toml and its hint names that file', () => {
    const home = temp('codex-home-doctor')
    const repo = temp('codex-home-repo')
    const codexDir = temp('codex-home-dir')
    const codexConfig = path.join(codexDir, 'config.toml')
    write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ agentes: { usa: ['codex'] } }))
    assert.equal(git(repo, 'init').status, 0)

    write(codexConfig, '[projects."unused"]\ntrust_level = "trusted"\n')
    const untrusted = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo, env: { CODEX_HOME: codexDir } })
    assert.match(untrusted.out, /⚠ codex repo root trust/)
    assert.ok(untrusted.out.includes(`en ${codexConfig.replaceAll('\\', '/')}.`), untrusted.out)

    write(codexConfig, `[projects.'${repo.replaceAll('/', '\\')}']\ntrust_level = "trusted"\n`)
    const trusted = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo, env: { CODEX_HOME: codexDir } })
    assert.match(trusted.out, /✔ codex repo root trust/)
    assert.equal(existsSync(path.join(home, '.codex')), false)
  })

  test('doctor checks only a merged project config that enables Codex, and never writes Codex config', () => {
    const home = temp('codex-doctor-home')
    const repo = temp('codex-doctor-repo')
    const codexConfig = path.join(home, '.codex', 'config.toml')
    write(codexConfig, '[projects."unused"]\ntrust_level = "trusted"\n')
    write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ agentes: { usa: ['codex'] } }))
    write(path.join(repo, '.orca-stack.json'), JSON.stringify({ agentes: { usa: ['claude'] } }))
    write(path.join(repo, '.orca-stack.local.json'), JSON.stringify({ agentes: { usa: ['codex-cc'] } }))
    assert.equal(git(repo, 'init').status, 0)
    const before = read(codexConfig)

    const enabled = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
    assert.match(enabled.out, /codex-cc ya no existe: sacalo de \.orca-stack\.local\.json \(agentes\.usa\)\./)
    assert.doesNotMatch(enabled.out, /codex repo root trust/)
    assert.equal(read(codexConfig), before)

    write(path.join(repo, '.orca-stack.local.json'), JSON.stringify({ agentes: { usa: ['codex'] } }))
    write(codexConfig, `[projects.'${repo.replaceAll('/', '\\')}']\ntrust_level = "trusted"\n`)
    const trusted = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
    assert.match(trusted.out, /✔ codex repo root trust/)
    assert.doesNotMatch(trusted.out, /⚠ codex repo root trust/)
    const trustedConfig = read(codexConfig)

    write(path.join(repo, '.orca-stack.local.json'), JSON.stringify({ agentes: { usa: ['claude'] } }))
    const disabled = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
    assert.doesNotMatch(disabled.out, /codex repo root trust/)

    const outside = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: temp('codex-outside') })
    assert.doesNotMatch(outside.out, /codex repo root trust/)
    assert.equal(existsSync(codexConfig), true)
    assert.equal(read(codexConfig), trustedConfig)
  })
})
