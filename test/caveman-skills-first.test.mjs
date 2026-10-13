import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { WRAPPERS } from '../src/constants.mjs'
import { cleanup, cli, tempDir, write } from './helpers.mjs'

let home
beforeEach(() => {
  home = tempDir('caveman-skills')
})
afterEach(() => cleanup(home))

const installed = plugins => write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
const entry = [{ scope: 'user', installPath: 'x', version: '3.2.0' }]
const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home })

describe('#142: caveman is recommended as skills only, and the plugin gets a warning', () => {
  test('rule 3: an installed and enabled caveman plugin makes doctor warn with the disable command; the exit status is unchanged', () => {
    const before = doctor()
    assert.doesNotMatch(before.out, /plugin caveman/)
    installed({ 'caveman@caveman': entry })
    const after = doctor()
    assert.match(after.out, /⚠ plugin caveman de Claude Code - caveman@caveman está instalado: sus hooks inyectan caveman en cada subagente y duplican el control de Orca/)
    assert.match(after.out, /Desactivalo con `claude plugin disable caveman@caveman`/)
    assert.equal(after.status, before.status)
  })

  test('rule 3 negative: no plugin, or the plugin disabled in ~/.claude/settings.json, prints no caveman-plugin row and keeps the exit status', () => {
    const none = doctor()
    assert.doesNotMatch(none.out, /plugin caveman/)
    installed({ 'caveman@caveman': entry })
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'caveman@caveman': false } }))
    const disabled = doctor()
    assert.doesNotMatch(disabled.out, /plugin caveman/)
    assert.equal(disabled.status, none.status)
  })

  test('rule 4: with only the caveman skills installed, doctor passes the caveman probe and reports nothing about caveman', () => {
    assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
    for (const dir of [['.claude', 'skills'], ['.agents', 'skills']]) {
      write(path.join(home, ...dir, 'caveman', 'SKILL.md'), '---\nname: caveman\n---\n')
    }
    const out = doctor().out
    for (const agent of Object.keys(WRAPPERS)) {
      assert.match(out, new RegExp(`✔ ${agent}-orca-stack --orca-stack-self-test - marcadores y política OK`), out)
    }
    assert.doesNotMatch(out, /^\s*[✖⚠][^\n]*caveman/im)
  })
})
