import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { WRAPPERS } from '../src/constants.mjs'
import { wrapperContent } from '../src/templates.mjs'
import { cleanup, cli, git, read, ROOT, tempDir, write } from './helpers.mjs'

const BULLET = '- Caveman sigue el ajuste Auto/Off del stack y comprime solo prosa pesada en tokens. Conservá el código, los comandos, las rutas, los errores exactos, las decisiones, los riesgos, las dudas, los tests y la evidencia de aceptación.'
const POINTER = 'Sus reglas están en `~/orca/stack/CAVEMAN.md`, el fragmento del perk de caveman.'
const CORE = ['ORCA-STACK.md', 'ROLE-BRIEFS.md', 'MAIN.md']
const win = process.platform === 'win32'
const flat = text => text.replace(/\s+/g, ' ')
// The stack markers start unset, so a probe never inherits them from the session running the tests.
const NO_MARKERS = { ORCA_STACK_MODE: undefined, ORCA_STACK_CAVEMAN_LEVEL: undefined, ORCA_STACK_PONYTAIL_LEVEL: undefined }

// The temp dirs avoid the word "caveman": the rendered docs carry the home path.
// `global` into a fresh home with the given personal config, then `init` in a fresh repo.
const setup = ({ personal } = {}) => {
  const home = tempDir('perk-c-home')
  const repo = path.join(tempDir('perk-c-repo'), 'project')
  if (personal !== undefined) write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify(personal))
  const global = cli(home, ['global', '--skip-pi'])
  assert.equal(global.status, 0, global.out)
  write(path.join(repo, 'README.md'), '# project\n')
  git(repo, 'init', '-q', '-b', 'main')
  const init = cli(home, ['init'], { cwd: repo })
  assert.equal(init.status, 0, init.out)

  return { home, repo, block: read(path.join(repo, 'AGENTS.md')).replace(/\r\n/g, '\n'), stack: path.join(home, 'orca', 'stack') }
}
const teardown = ({ home, repo }) => {
  cleanup(home)
  cleanup(path.dirname(repo))
}
const wrapper = (home, agent) => path.join(home, 'orca', 'stack', 'scripts', `${agent}-orca-stack.${win ? 'cmd' : 'sh'}`)
const doctor = home => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home, env: NO_MARKERS }).out
const probeRow = agent => new RegExp(`✔ ${agent}-orca-stack --orca-stack-self-test - marcadores y política OK`)
const STALE = /✖ claude-orca-stack --orca-stack-self-test - marcadores desactualizados: volvé a correr `orca-stack global`/

describe('#394 Caveman as a perk', () => {
  test('S4: with Caveman off by default, the wrappers write off instead of the Auto trigger, and the contract, core docs and policy skill carry no Caveman text', () => {
    for (const agent of Object.keys(WRAPPERS)) {
      for (const flavour of [true, false]) {
        const text = wrapperContent(agent, flavour)
        assert.doesNotMatch(text, /ORCA_STACK_MODE=auto/, `${agent} ${flavour ? 'cmd' : 'sh'}`)
        assert.match(text, flavour ? /set "ORCA_STACK_MODE=off"/ : /^ORCA_STACK_MODE=off$/m)
        assert.match(text, flavour ? /set "ORCA_STACK_CAVEMAN_LEVEL=off"/ : /^ORCA_STACK_CAVEMAN_LEVEL=off$/m)
      }
    }
    const env = setup()
    try {
      for (const agent of Object.keys(WRAPPERS)) assert.doesNotMatch(read(wrapper(env.home, agent)), /ORCA_STACK_MODE=auto/, agent)
      assert.doesNotMatch(env.block, /caveman|perk:/i)
      assert.ok(env.block.includes('tests que se piden: son lo que el humano espera recibir.\n- Engram es solo memoria'), 'no empty line left')
      for (const name of CORE) assert.doesNotMatch(read(path.join(env.stack, name)), /caveman/i, name)
      for (const root of ['.claude', '.agents']) {
        assert.doesNotMatch(read(path.join(env.home, root, 'skills', 'orca-stack-policy', 'SKILL.md')), /caveman/i, root)
      }
      assert.ok(existsSync(path.join(env.stack, 'CAVEMAN.md')), 'CAVEMAN.md installed')
      assert.match(doctor(env.home), /✔ CAVEMAN\.md/)
    } finally {
      teardown(env)
    }
  })

  test('S6: with Caveman on in the personal layer, the wrappers write Auto and the caveman level, the contract keeps the bullet and points to CAVEMAN.md, which carries today’s Caveman rules', () => {
    for (const agent of Object.keys(WRAPPERS)) {
      const on = { caveman: true }
      assert.match(wrapperContent(agent, false, on), /^ORCA_STACK_MODE=auto\nORCA_STACK_CAVEMAN_LEVEL=caveman$/m, agent)
      assert.ok(wrapperContent(agent, true, on).includes('set "ORCA_STACK_MODE=auto"\r\nset "ORCA_STACK_CAVEMAN_LEVEL=caveman"'), agent)
    }
    const env = setup({ personal: { perks: { caveman: true } } })
    try {
      const installed = read(wrapper(env.home, 'claude'))
      assert.match(installed, /ORCA_STACK_MODE=auto/)
      assert.match(installed, /ORCA_STACK_CAVEMAN_LEVEL=caveman/)
      assert.ok(env.block.includes(`${BULLET} ${POINTER}\n`), env.block)
      assert.doesNotMatch(env.block, /perk:/)
      const fragment = flat(read(path.join(env.stack, 'CAVEMAN.md')))
      assert.match(fragment, /\*\*Caveman \(modular\)\*\*: communication compression\. Orca Auto applies it when the work is token-heavy/)
      assert.match(fragment, /Its level is a caveman 3\.2\.0 mode: `caveman`, `ultracave` or `megacave` \(the wrappers set `caveman`\)\./)
      assert.match(fragment, /Caveman communication policy\./)
      assert.match(fragment, /Caveman is communication-only\. In `auto`, compress filler and repetitive prose only when it saves tokens/)
      assert.match(fragment, /`ORCA_STACK_MODE`, `ORCA_STACK_CAVEMAN_LEVEL`/)
      assert.match(fragment, /`caveman` — communication-only mode; Auto is selected in Orca, not by a provider hook\./)
      assert.match(fragment, /Caveman follows the Orca Agent Stack setting for the summary only; preserve citations and uncertainty even when compressed\./)
      assert.match(fragment, /Caveman only compresses optional prose/)
      assert.match(doctor(env.home), probeRow('claude'))
    } finally {
      teardown(env)
    }
  })

  test('S7: doctor accepts off or absent markers for a perk that is off, requires today’s values for a perk that is on, and fails a Ponytail level lite', () => {
    const env = setup()
    try {
      const file = wrapper(env.home, 'claude')
      const off = readFileSync(file, 'utf8')
      let out = doctor(env.home)
      for (const agent of Object.keys(WRAPPERS)) assert.match(out, probeRow(agent), out)
      // Off and absent: the assignments removed, the self-test prints them empty.
      writeFileSync(file, off.replace(/^.*ORCA_STACK_(MODE|CAVEMAN_LEVEL|PONYTAIL_LEVEL)=off"?\r?\n/gm, ''))
      assert.match(doctor(env.home), probeRow('claude'))
      // A perk that is off with another value is a stale marker too.
      writeFileSync(file, off.replace('ORCA_STACK_MODE=off', 'ORCA_STACK_MODE=auto'))
      assert.match(doctor(env.home), STALE)

      write(path.join(env.home, '.orca-stack', 'config.json'), JSON.stringify({ perks: { caveman: true, ponytail: true } }))
      // On with the off wrapper: stale.
      writeFileSync(file, off)
      assert.match(doctor(env.home), STALE)
      assert.equal(cli(env.home, ['global', '--skip-pi']).status, 0)
      const on = readFileSync(file, 'utf8')
      out = doctor(env.home)
      for (const agent of Object.keys(WRAPPERS)) assert.match(out, probeRow(agent), out)
      writeFileSync(file, on.replace('ORCA_STACK_PONYTAIL_LEVEL=full', 'ORCA_STACK_PONYTAIL_LEVEL=lite'))
      assert.match(doctor(env.home), STALE)
    } finally {
      teardown(env)
    }
  })
})

describe('#394 docs', () => {
  test('S8: the setup guide and the manual describe Ponytail and Caveman as optional perks, off by default', () => {
    for (const file of [path.join('docs', 'guia-setup.md'), path.join('docs', 'manual.md')]) {
      const text = read(path.join(ROOT, file))
      assert.match(text, /"perks": \{ "ponytail": true \}/, file)
      assert.match(text, /"perks": \{ "caveman": true \}/, file)
      assert.match(text, /Ponytail y Caveman son perks opcionales, apagados por defecto/, file)
      assert.match(text, /PONYTAIL\.md/, file)
      assert.match(text, /CAVEMAN\.md/, file)
      assert.doesNotMatch(text, /todavía no cambian nada/, file)
    }
  })
})
