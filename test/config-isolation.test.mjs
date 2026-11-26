import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { loadConfig } from '../src/despacho.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'
import { cleanup, cli, tempDir, write } from './helpers.mjs'

const HOSTILE_LOCAL_CONFIG = {
  guardia: {
    bloquear: [{ agente: 'agy', hasta: '2099-01-01', motivo: 'x' }],
  },
  agentes: {
    modelos: {
      agy: { implementar: { modelo: 'gemini-4-neon-medium' } },
    },
  },
}

const CONFIG_COMMANDS = /\b(?:reanudarCommand|despacharCommand|revisarCommand|reboteCommand|estadoCommand|planificarCommand|briefRevisionCommand|initCommand|lintCommand|seedBaseline|doctorCommand|loadConfig)\s*\(/

describe('test config isolation (#493)', () => {
  test('R1 & R2: reanudar and main-autonomo T1 pass when the checkout cwd has a hostile .orca-stack.local.json', () => {
    const fakeCheckout = tempDir('fake-checkout-493')
    try {
      write(path.join(fakeCheckout, '.orca-stack.json'), JSON.stringify({
        setup: 'completo',
        modo: 'multiagente',
        ramaBase: 'main',
        agentes: { usa: ['agy', 'codex', 'pi'], preguntarAntes: [] },
      }))
      write(path.join(fakeCheckout, '.orca-stack.local.json'), JSON.stringify(HOSTILE_LOCAL_CONFIG))
      const env = { ...process.env }
      delete env.NODE_TEST_CONTEXT
      delete env.NODE_TEST_WORKER_ID

      const reanudar = spawnSync(
        process.execPath,
        ['--test', path.join(PACKAGE_ROOT, 'test', 'reanudar.test.mjs')],
        { cwd: fakeCheckout, encoding: 'utf8', env },
      )
      assert.equal(reanudar.status, 0, `reanudar.test.mjs read .orca-stack.local.json from cwd:\n${reanudar.stdout}\n${reanudar.stderr}`)

      const mainAutonomo = spawnSync(
        process.execPath,
        ['--test', '--test-name-pattern=main-autonomo T1', path.join(PACKAGE_ROOT, 'test', 'despacho.test.mjs')],
        { cwd: fakeCheckout, encoding: 'utf8', env },
      )
      assert.equal(mainAutonomo.status, 0, `despacho.test.mjs main-autonomo T1 failed under hostile cwd:\n${mainAutonomo.stdout}\n${mainAutonomo.stderr}`)
    } finally {
      cleanup(fakeCheckout)
    }
  })

  test('R2: no test file passes process.cwd() or the real checkout root to a config-loading command', () => {
    const testDir = path.join(PACKAGE_ROOT, 'test')
    const offenders = []

    for (const file of readdirSync(testDir).filter(name => name.endsWith('.mjs')).sort()) {
      const source = readFileSync(path.join(testDir, file), 'utf8')
      if (file === 'helpers.mjs') {
        if (/export const cli = \([^)]*\{\s*cwd\s*=\s*ROOT\b/.test(source)) {
          offenders.push('test/helpers.mjs: cli() defaults cwd to ROOT (the real checkout)')
        }
        continue
      }
      if (file === 'config-isolation.test.mjs') continue

      const hasConfigCmd = CONFIG_COMMANDS.test(source)
      if (hasConfigCmd && /\bconst\s+\w+\s*=\s*process\.cwd\(\)/.test(source)) {
        const match = source.match(/\bconst\s+(\w+)\s*=\s*process\.cwd\(\)/)
        const varName = match[1]
        if (new RegExp(`\\b(?:root|cwd)\\s*[:=]\\s*${varName}\\b`).test(source)) {
          offenders.push(`test/${file}: binds ${varName} = process.cwd() and passes it as root/cwd`)
        }
      }
      if (/spawnSync\([^)]*bin['"],\s*['"]orca-stack\.mjs['"][\s\S]*?\b(?:init|doctor|lint)\b[\s\S]*?cwd\s*:\s*(?:PACKAGE_ROOT|ROOT)\b/.test(source)) {
        offenders.push(`test/${file}: spawns orca-stack config command with cwd: PACKAGE_ROOT/ROOT`)
      }
      if (/\bdoctorCommand\s*\(/.test(source) && !/process\.chdir\s*\(/.test(source)) {
        offenders.push(`test/${file}: calls doctorCommand() in-process without chdir to a temporary directory`)
      }
    }

    assert.deepEqual(offenders, [], `Tests reading checkout config:\n${offenders.join('\n')}`)
  })

  test('R1: cli() without an explicit cwd does not read .orca-stack.local.json from the checkout', () => {
    const home = tempDir('cli-cwd-493')
    try {
      const res = cli(home, ['doctor', '--offline', '--skip-pi'])
      assert.doesNotMatch(res.out, /\.orca-stack\.local\.json/, res.out)
      assert.doesNotMatch(res.out, /\.orca-stack\.json/, res.out)
    } finally {
      cleanup(home)
    }
  })

  test('R3: three-layer config merging tests still read the personal, committed and local layers they create', () => {
    const dir = tempDir('layers-493')
    const home = path.join(dir, 'home')
    const root = path.join(dir, 'repo')
    try {
      write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({
        idioma: 'personal',
        guardia: { bloquear: [{ agente: 'codex', hasta: '2099-01-01', motivo: 'personal-block' }] },
        agentes: { modelos: { agy: { implementar: { modelo: 'from-personal' } } } },
      }))
      write(path.join(root, '.orca-stack.json'), JSON.stringify({
        idioma: 'committed',
        ramaBase: 'main',
        guardia: { bloquear: [{ agente: 'pi', hasta: '2099-01-01', motivo: 'committed-block' }] },
      }))
      write(path.join(root, '.orca-stack.local.json'), JSON.stringify({
        idioma: 'local',
        guardia: { bloquear: [{ agente: 'agy', hasta: '2099-01-01', motivo: 'local-block' }] },
        agentes: { modelos: { agy: { implementar: { modelo: 'from-local' } } } },
      }))

      const merged = loadConfig(home, root)
      assert.equal(merged.idioma, 'local')
      assert.equal(merged.ramaBase, 'main')
      assert.equal(merged.agentes.modelos.agy.implementar.modelo, 'from-local')
      assert.deepEqual(
        merged.guardia.bloquear.map(rule => rule.motivo),
        ['personal-block', 'committed-block', 'local-block'],
      )
    } finally {
      cleanup(dir)
    }
  })
})
