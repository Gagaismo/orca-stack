import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { RETIRED_MODS } from '../src/constants.mjs'
import { RETIRED_PONYTAIL_SKILLS } from '../src/global.mjs'
import { sha256 } from '../src/util.mjs'
import { cleanup, cli, read, tempDir, write } from './helpers.mjs'

const DOCTOR = ['doctor', '--offline', '--skip-pi']

const lines = out => out.split(/\r?\n/)
const failLines = out => lines(out).filter(line => line.trimStart().startsWith('✖'))

const installedHome = prefix => {
  const home = tempDir(prefix)
  const res = cli(home, ['global', '--skip-pi'])
  assert.equal(res.status, 0, res.out)

  return home
}

const seedStaleInstalledCopy = home => {
  const copy = path.join(home, '.orca-stack', 'cli')
  const bin = path.join(copy, 'bin', 'orca-stack.mjs')
  assert.equal(existsSync(bin), true, `global must install its package copy at ${copy}`)
  for (const skill of RETIRED_PONYTAIL_SKILLS) {
    write(path.join(copy, 'assets', 'skills', skill, 'SKILL.md'), `# ${skill}\n`)
  }
  for (const mod of RETIRED_MODS) {
    write(path.join(copy, 'mods', mod, '.claude-plugin', 'plugin.json'), `{"name":"${mod}"}\n`)
    write(path.join(copy, 'mods', mod, 'hooks', 'hooks.json'), '{"modules":[]}\n')
  }
  const stateFile = path.join(home, '.orca-stack', 'state.json')
  const state = JSON.parse(read(stateFile))
  state.skills = [...(state.skills ?? []), ...RETIRED_PONYTAIL_SKILLS]
  state.mods = [...(state.mods ?? []), ...RETIRED_MODS]
  write(stateFile, JSON.stringify(state, null, 2))

  return bin
}

describe('#497 doctor and retired Ponytail skills and mods', () => {
  test('R1: doctor run from a copy that still carries retired Ponytail skills and puente-gentle requires none of them', () => {
    const home = installedHome('d497-r1')
    try {
      const reference = cli(home, DOCTOR)
      const bin = seedStaleInstalledCopy(home)
      const res = cli(home, DOCTOR, { bin })
      assert.equal(res.status, reference.status, res.out)
      assert.deepEqual(failLines(res.out), failLines(reference.out))
      for (const line of failLines(res.out)) {
        assert.doesNotMatch(line, /ponytail|puente-gentle/i)
      }
      const skillLines = lines(res.out).filter(line => /^\s*[✔✖] ~[\\/]\.(claude|agents)[\\/]skills - /.test(line))
      assert.equal(skillLines.length, 2, res.out)
      for (const line of skillLines) {
        assert.match(line, /^\s*✔ /)
      }
      assert.doesNotMatch(res.out, /puente-gentle/i)
    } finally {
      cleanup(home)
    }
  })

  test('R2: a retired mod folder holding only files orca-stack did not install gives one warn to delete it by hand, without asking for orca-stack global', () => {
    const home = installedHome('d497-r2')
    try {
      const clean = cli(home, DOCTOR)
      const modDir = path.join(home, '.claude', 'mods', 'puente-gentle')
      write(path.join(modDir, 'tsconfig.json'), '{}\n')
      write(path.join(modDir, 'tests', 'harness.ts'), 'export {}\n')
      const global = cli(home, ['global', '--skip-pi'])
      assert.equal(global.status, 0, global.out)
      assert.match(global.out, /⚠ .*puente-gentle[\\/]tsconfig\.json.*no lo instaló orca-stack/i)
      assert.equal(read(path.join(modDir, 'tsconfig.json')), '{}\n')

      const res = cli(home, DOCTOR)
      assert.equal(res.status, clean.status, res.out)
      const mentions = lines(res.out).filter(line => line.includes('puente-gentle'))
      assert.equal(mentions.length, 1, res.out)
      assert.match(mentions[0], /^\s*⚠ mod puente-gentle retirado - /)
      assert.ok(mentions[0].includes(path.join('~', '.claude', 'mods', 'puente-gentle')), mentions[0])
      assert.match(mentions[0], /a mano/)
      assert.doesNotMatch(mentions[0], /orca-stack global/)

      const tracked = path.join(modDir, 'hooks', 'puente.ts')
      write(tracked, 'export const OLD = true\n')
      const stateFile = path.join(home, '.orca-stack', 'state.json')
      const state = JSON.parse(read(stateFile))
      state.files[tracked] = { sha256: sha256(Buffer.from('export const OLD = true\n', 'utf8')), backup: null, existedBefore: false }
      write(stateFile, JSON.stringify(state, null, 2))
      const pending = cli(home, DOCTOR)
      const pendingMentions = lines(pending.out).filter(line => line.includes('puente-gentle'))
      assert.equal(pendingMentions.length, 1, pending.out)
      assert.match(pendingMentions[0], /^\s*⚠ mod puente-gentle retirado - .*corré `orca-stack global`/)
    } finally {
      cleanup(home)
    }
  })

  test('R3: a current skill or mod that is missing still fails while retired ones are skipped', () => {
    const home = installedHome('d497-r3')
    try {
      const bin = seedStaleInstalledCopy(home)
      rmSync(path.join(home, '.claude', 'skills', 'arena'), { recursive: true, force: true })
      rmSync(path.join(home, '.claude', 'mods', 'bandeja-mensajes', 'hooks', 'hooks.json'))
      const res = cli(home, DOCTOR, { bin })
      assert.equal(res.status, 1, res.out)
      const skills = failLines(res.out).find(line => line.includes('faltan:'))
      assert.ok(skills, res.out)
      assert.match(skills, /^\s*✖ ~[\\/]\.claude[\\/]skills - faltan: arena$/)
      assert.ok(
        failLines(res.out).some(line => /^\s*✖ bandeja-mensajes - carpeta incompleta o ausente /.test(line)),
        res.out,
      )
      for (const line of failLines(res.out)) {
        assert.doesNotMatch(line, /ponytail|puente-gentle/i)
      }
    } finally {
      cleanup(home)
    }
  })
})
