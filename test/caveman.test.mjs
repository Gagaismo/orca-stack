import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { INSTALL_HINTS, STACK_LEVELS, WRAPPERS } from '../src/constants.mjs'
import { launcherFor } from '../src/despacho.mjs'
import { cmdWrapper, shWrapper } from '../src/templates.mjs'
import { ROOT, cleanup, cli, tempDir } from './helpers.mjs'

const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n')
// caveman v3.2.0, src/hooks/caveman-config.js: VALID_MODES has one id per voice skill; LEGACY_MODES keeps the old
// levels only as read aliases ("no write ever emits one").
const VOICE_MODES = ['caveman', 'ultracave', 'megacave']
const LEGACY_LEVEL = /`(lite|full|ultra|wenyan(-lite|-full|-ultra)?)`/
// Paragraphs and bullets that talk about caveman.
const cavemanPassages = text => text.split(/\n(?=- |\n)/).filter(passage => /caveman/i.test(passage))

describe('caveman 3.2.0', () => {
  test('rule 1: caveman is installed from the origin, and the docs name 3.2.0 next to the install command', () => {
    // The command itself is #142 rule 1 (test/caveman-skills-first.test.mjs): skills only, from "Small rock: the skill".
    assert.ok(!existsSync(path.join(ROOT, 'assets', 'skills', 'caveman')), 'caveman is installed from its origin, not vendored')
    for (const doc of [['README.md'], ['docs', 'guia-setup.md']]) {
      const line = read(...doc).split('\n').find(text => text.includes(INSTALL_HINTS.caveman[0]))
      assert.ok(line, `${doc.join('/')} shows the install command`)
      assert.match(line, /3\.2\.0/, `${doc.join('/')} names the version the stack was checked with`)
    }
  })

  test('rule 2: every wrapper carries a caveman 3.2.0 mode, not a legacy level or off, and the policy uses the new names', () => {
    // `full` became the `caveman` skill in 3.2.0.
    assert.equal(STACK_LEVELS.caveman, 'caveman')
    assert.ok(VOICE_MODES.includes(STACK_LEVELS.caveman))
    for (const agent of Object.keys(WRAPPERS)) {
      assert.match(shWrapper(agent), /^ORCA_STACK_CAVEMAN_LEVEL=caveman$/m, agent)
      assert.ok(cmdWrapper(agent).includes('set "ORCA_STACK_CAVEMAN_LEVEL=caveman"'), agent)
    }
    const caveman = cavemanPassages(read('assets', 'stack', 'ORCA-STACK.md')).find(passage => passage.startsWith('- **Caveman (modular)**'))
    assert.match(caveman.replace(/\s+/g, ' '), /`caveman`, `ultracave` or `megacave`/)
    assert.match(caveman.replace(/\s+/g, ' '), /the wrappers set `caveman`/)
  })

  test('rule 3: despachar workers that get the stack markers are interactive; pi, the headless one, gets none', () => {
    const base = { mode: 'ticket', config: {}, win: false, home: '/h', briefPath: '/b.md', session: 's', skills: '/s' }
    for (const agent of ['claude', 'agy', 'codex', 'codex-cc']) {
      const launcher = launcherFor({ ...base, agent })
      assert.ok(launcher.includes('-orca-stack.sh"'), `${agent} goes through its wrapper, which sets the markers`)
      // From the wrapper on: codex-cc reads its key with `node -p` before it.
      const call = launcher.slice(launcher.indexOf('-orca-stack.sh"'))
      assert.doesNotMatch(call, /\s(-p|--print|exec)(\s|$)/, `${agent} is an interactive session, not headless`)
    }
    const pi = launcherFor({ ...base, agent: 'pi' })
    assert.match(pi, /^unset [^;]*\bORCA_STACK_CAVEMAN_LEVEL\b/)
    assert.match(pi, /; pi -p /)
    // The consult clears the same markers before its own `pi -p`.
    const puente = read('mods', 'puente-gentle', 'hooks', 'puente.ts')
    assert.match(/export const ORCA_VARS_CLEARED = \[([\s\S]*?)\] as const/.exec(puente)[1], /'ORCA_STACK_CAVEMAN_LEVEL'/)
    assert.match(puente, /export const buildArgs = [^\n]*\n {2}'-p',/)
    // ORCA-STACK.md already says so: Gentle Shell gets none of the stack markers.
    const policy = read('assets', 'stack', 'ORCA-STACK.md').replace(/\s+/g, ' ')
    assert.match(policy, /pi \(Gentle Shell\): headless, no TUI/)
    assert.match(policy, /clears the Orca and `ORCA_STACK_\*` variables \(the same list the pi consult bridge clears\)/)
  })

  test('rule 4: the policy files keep Auto/Off and communication-only, and name no caveman level 3.2.0 dropped', () => {
    const policy = read('assets', 'stack', 'ORCA-STACK.md')
    const briefs = read('assets', 'stack', 'ROLE-BRIEFS.md')
    const skill = read('assets', 'skills', 'orca-stack-policy', 'SKILL.md')
    const flat = text => text.replace(/\s+/g, ' ')
    assert.match(flat(policy), /\*\*Caveman \(modular\)\*\*: communication compression\. Orca Auto applies it when the work is token-heavy/)
    assert.match(flat(policy), /Caveman is communication-only\. In `auto`, compress filler/)
    assert.match(flat(policy), /`caveman` — communication-only mode; Auto is selected in Orca, not by a provider hook\./)
    assert.match(flat(briefs), /Caveman follows the Orca Agent Stack setting/)
    assert.match(flat(skill), /Caveman only compresses optional prose/)
    for (const text of [policy, briefs, skill]) {
      for (const passage of cavemanPassages(text)) assert.doesNotMatch(passage, LEGACY_LEVEL, passage)
    }
  })
})

describe('caveman 3.2.0: doctor', () => {
  let home
  beforeEach(() => {
    home = tempDir('caveman-home')
  })
  afterEach(() => cleanup(home))
  const wrapper = agent => path.join(home, 'orca', 'stack', 'scripts', `${agent}-orca-stack.${process.platform === 'win32' ? 'cmd' : 'sh'}`)
  const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi']).out

  test('PRESERVE doctor: the wrappers global writes pass the self-test probe', () => {
    assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
    const out = doctor()
    for (const agent of Object.keys(WRAPPERS)) assert.match(out, new RegExp(`✔ ${agent}-orca-stack --orca-stack-self-test - marcadores y política OK`), out)
  })

  test('rule 2 negative: a wrapper with a legacy or unknown caveman level fails doctor and says to rerun global', () => {
    assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
    const file = wrapper('claude')
    const original = readFileSync(file, 'utf8')
    for (const level of ['full', 'bogus']) {
      writeFileSync(file, original.replace('ORCA_STACK_CAVEMAN_LEVEL=caveman', `ORCA_STACK_CAVEMAN_LEVEL=${level}`))
      assert.match(doctor(), /✖ claude-orca-stack --orca-stack-self-test - marcadores desactualizados: volvé a correr `orca-stack global`/, level)
    }
  })
})
