import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { compareVersions } from '../src/drift.mjs'
import { fakeGentle, fixture, sddConfig, withPath } from './gentle-fixture.mjs'
import { cleanup, cli, tempDir, write } from './helpers.mjs'

describe('compareVersions', () => {
  test('orders by major, minor, patch', () => {
    assert.ok(compareVersions('1.3.1', '1.2.3') > 0)
    assert.ok(compareVersions('1.2.3', '1.3.1') < 0)
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
    assert.equal(compareVersions('1.3.1', '1.3.1'), 0)
  })
})

describe('doctor: drift warnings', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('drift-home')
    bin = tempDir('drift-bin')
    sddConfig(home, 'full')
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })
  const plugin = (version, skills) => {
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'm', 'mattpocock-skills', version)
    write(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: skills.map(name => `./skills/engineering/${name}`) }))
    write(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'mattpocock-skills@claude-plugins-official': [{ version, installPath }] } }),
    )
  }
  const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { env: withPath(bin) }).out

  test('an old plugin, a duplicated skill, missing agent skills and untrimmed gentle-ai sections each warn', () => {
    fakeGentle(bin, 'off')
    plugin('1.2.3', ['tdd', 'pr'])
    write(path.join(home, '.claude', 'skills', 'tdd', 'SKILL.md'), 'x')
    write(path.join(home, '.agents', 'skills', 'retro', 'SKILL.md'), 'x')
    write(path.join(home, '.claude', 'CLAUDE.md'), fixture('\n'))
    const out = doctor()
    assert.match(out, /⚠ mattpocock-skills 1\.2\.3 - es anterior a 1\.3\.1.*claude plugin marketplace add mattpocock\/skills.*mattpocock-skills@mattpocock/)
    assert.match(out, /⚠ skills duplicadas en ~\/\.claude\/skills - tdd .*npx skills remove tdd -g -a claude-code -y/)
    assert.match(out, /⚠ ~\/\.agents\/skills - faltan pr, implement-spec .*npx skills add mattpocock\/skills -g -s '\*' -a codex -a antigravity-cli -y/)
    assert.doesNotMatch(out, /agents.skills - faltan [^(]*retro/)
    assert.match(out, /⚠ secciones de review de gentle-ai.*orca-stack global/)
  })

  test('a gentle-ai block that changed shape warns that trimming is paused, with the reason', () => {
    fakeGentle(bin, 'off')
    plugin('1.3.1', ['tdd'])
    write(path.join(home, '.claude', 'CLAUDE.md'), fixture('\n').replace('#### Cost and Context Balance', '#### X\nx body\n#### Cost and Context Balance'))
    const out = doctor()
    assert.match(out, /⚠ texto de gentle-ai en ~\/\.claude\/CLAUDE\.md - cambió de forma y el recorte .* en pausa.*#### X/)
    assert.doesNotMatch(out, /secciones de review de gentle-ai/)
  })

  test('a current plugin without duplicates, full agent skills and trimmed or RDD-on CLAUDE.md are clean', () => {
    fakeGentle(bin, 'on')
    plugin('1.3.1', ['tdd'])
    for (const name of ['pr', 'implement-spec', 'retro']) {
      write(path.join(home, '.agents', 'skills', name, 'SKILL.md'), 'x')
    }
    write(path.join(home, '.claude', 'CLAUDE.md'), fixture('\n'))
    const out = doctor()
    assert.match(out, /✔ skills de Matt y secciones de gentle-ai - sin deriva/)
    assert.doesNotMatch(out, /mattpocock-skills 1|duplicadas|secciones de review/)
  })
})
