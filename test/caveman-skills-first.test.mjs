import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { INSTALL_HINTS, WRAPPERS } from '../src/constants.mjs'
import { cmdWrapper, policyBlock, shWrapper } from '../src/templates.mjs'
import { ROOT, cleanup, cli, tempDir, write } from './helpers.mjs'

const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n')
const flat = text => text.replace(/\s+/g, ' ')
// #142: the skills-only command from caveman's README, and the plugin commands it no longer recommends.
const SKILLS = 'npx skills add JuliusBrussee/caveman -g'
const PLUGIN = 'claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman'

let home
beforeEach(() => {
  // No "caveman" in the prefix: doctor prints the home path in some rows, and rule 4 looks for caveman in any row.
  home = tempDir('skills-first')
})
afterEach(() => cleanup(home))

const installed = plugins => write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
const entry = [{ scope: 'user', installPath: 'x', version: '3.2.0' }]
const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home })

describe('#142: caveman is recommended as skills only, and the plugin gets a warning', () => {
  test('rule 1: INSTALL_HINTS, global, README and docs/guia-setup.md recommend the skills-only install, not the plugin', () => {
    assert.equal(INSTALL_HINTS.caveman[0], SKILLS)
    for (const line of INSTALL_HINTS.caveman) assert.doesNotMatch(line, /claude plugin (marketplace add|install)/, line)
    const global = cli(home, ['global', '--skip-pi'])
    assert.equal(global.status, 0, global.out)
    assert.match(global.stdout, /^ +Caveman: +npx skills add JuliusBrussee\/caveman -g$/m)
    assert.doesNotMatch(global.out, /claude plugin (marketplace add|install) [^\n]*caveman/)
    for (const doc of [['README.md'], ['docs', 'guia-setup.md']]) {
      const text = read(...doc)
      assert.ok(text.includes(SKILLS), `${doc.join('/')} shows ${SKILLS}`)
      assert.ok(!text.includes(PLUGIN), `${doc.join('/')} no longer recommends the plugin`)
      assert.doesNotMatch(text, /claude plugin install caveman/, doc.join('/'))
    }
  })

  test('rule 2: README, right after the ponytail plugin bullet, says to disable the caveman plugin in Orca sessions and why', () => {
    const lines = read('README.md').split('\n')
    const ponytail = lines.findIndex(line => line.startsWith('- **El plugin `ponytail` de Claude Code**'))
    assert.ok(ponytail >= 0, 'the ponytail plugin bullet from PR #140 is there')
    const caveman = lines[ponytail + 1]
    assert.match(caveman, /^- \*\*El plugin `caveman` de Claude Code\*\*: si lo tenés instalado, desactivalo en las sesiones de Orca \(`claude plugin disable caveman@caveman`\)/)
    assert.match(caveman, /sus hooks inyectan caveman en cada subagente y duplican el control de Orca/)
  })

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

  test('rule 5: without the plugin hooks, caveman reaches workers through the wrappers, the project contract and the policy', () => {
    // Nothing the stack recommends installs a caveman hook.
    for (const line of INSTALL_HINTS.caveman) assert.doesNotMatch(line, /claude plugin/, line)
    // ORCA-STACK.md: "Auto is selected in Orca, not by a provider hook". The wrappers carry Auto and the mode.
    for (const agent of Object.keys(WRAPPERS)) {
      assert.match(shWrapper(agent), /^ORCA_STACK_MODE=auto$/m, agent)
      assert.match(shWrapper(agent), /^ORCA_STACK_CAVEMAN_LEVEL=caveman$/m, agent)
      assert.ok(cmdWrapper(agent).includes('set "ORCA_STACK_MODE=auto"'), agent)
      assert.ok(cmdWrapper(agent).includes('set "ORCA_STACK_CAVEMAN_LEVEL=caveman"'), agent)
    }
    // The orca-stack block every project's AGENTS.md carries tells the worker what caveman does there.
    assert.ok(
      policyBlock({ policyPath: 'p', briefsPath: 'b' }).includes(
        '- Caveman sigue el ajuste Auto/Off del stack y comprime solo prosa pesada en tokens.',
      ),
    )
    // The policy still excludes the hooks and keeps the skill hook-free and communication-only.
    const policy = flat(read('assets', 'stack', 'ORCA-STACK.md'))
    assert.match(policy, /Do not install the full Ponytail or Caveman lifecycle-hook stacks\. Their always-on hooks, session-start codebase map, subagent injection/)
    assert.match(policy, /`caveman` — communication-only mode; Auto is selected in Orca, not by a provider hook\./)
    assert.match(policy, /Caveman is communication-only\./)
    assert.match(flat(read('assets', 'stack', 'ROLE-BRIEFS.md')), /Caveman follows the Orca Agent Stack setting/)
  })
})
