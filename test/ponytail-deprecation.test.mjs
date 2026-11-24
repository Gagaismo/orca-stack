import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { cleanup, cli, git, read, tempDir, write } from './helpers.mjs'

const COMMANDS = {
  global: ['global', '--skip-pi'],
  init: ['init'],
  doctor: ['doctor', '--offline', '--skip-pi'],
}
const NORMAL = {
  global: /^orca-stack global\nDestino: /m,
  init: /^creo AGENTS\.md$/m,
  doctor: /^\d+ bien, \d+ avisos, \d+ fallas$/m,
}
const WARNING = /se quita en la próxima versión/g
const ON = { perks: { ponytail: true } }
const OFF = { perks: { ponytail: false } }

const run = (command, { personal, project, local } = {}) => {
  const home = tempDir('deprec428-home')
  const repo = path.join(tempDir('deprec428-repo'), 'project')
  try {
    if (personal !== undefined) write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify(personal))
    write(path.join(repo, 'README.md'), '# project\n')
    if (project !== undefined) write(path.join(repo, '.orca-stack.json'), JSON.stringify(project))
    if (local !== undefined) write(path.join(repo, '.orca-stack.local.json'), JSON.stringify(local))
    git(repo, 'init', '-q', '-b', 'main')
    const result = cli(home, COMMANDS[command], { cwd: repo })
    const agents = command === 'init' ? read(path.join(repo, 'AGENTS.md')) : null

    return { ...result, agents, warnings: (result.out.match(WARNING) ?? []).length }
  } finally {
    cleanup(home)
    cleanup(path.dirname(repo))
  }
}
const assertNormal = (command, result) => {
  if (command !== 'doctor') assert.equal(result.status, 0, result.out)
  assert.match(result.out, NORMAL[command])
  if (command === 'init') assert.match(result.agents, /orca-stack:begin/)
}

describe('#428 Ponytail deprecation warning', () => {
  for (const command of Object.keys(COMMANDS)) {
    test(`S8/S9: ${command} warns once with the perk on, naming ponytail, CODING_STANDARDS.md and ADR 0002`, () => {
      const result = run(command, { project: ON })
      assertNormal(command, result)
      assert.equal(result.warnings, 1, result.out)
      const line = result.out.split(/\r?\n/).find(text => WARNING.test(text))
      WARNING.lastIndex = 0
      assert.match(line, /^\s*⚠ /)
      for (const part of ['ponytail', 'CODING_STANDARDS.md', 'ADR 0002']) assert.ok(line.includes(part), `${part} in: ${line}`)
    })

    test(`S10: ${command} prints no warning with the perk off or absent`, () => {
      for (const layers of [{ project: OFF }, {}, { personal: { perks: { marchas: true } } }]) {
        const result = run(command, layers)
        assertNormal(command, result)
        assert.equal(result.warnings, 0, result.out)
        assert.doesNotMatch(result.out, /ADR 0002/)
      }
    })

    test(`S12: ${command} exits with the same code with the perk on and off`, () => {
      const on = run(command, { project: ON })
      const off = run(command, { project: OFF })
      assert.equal(on.warnings, 1, on.out)
      assert.equal(on.status, off.status, `${on.out}\n---\n${off.out}`)
    })

    test(`S13: ${command} warns exactly once when the perk is on in two or three layers`, () => {
      for (const layers of [{ personal: ON, project: ON }, { personal: ON, project: ON, local: ON }]) {
        const result = run(command, layers)
        assertNormal(command, result)
        assert.equal(result.warnings, 1, result.out)
      }
    })
  }

  test('S10: a later layer that turns the perk off silences it', () => {
    for (const command of Object.keys(COMMANDS)) {
      assert.equal(run(command, { personal: ON, project: ON, local: OFF }).warnings, 0, command)
    }
  })
})
