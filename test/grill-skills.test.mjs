import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { ROOT, backups, cleanup, cli, read, tempDir, write } from './helpers.mjs'

const SKILLS = path.join(ROOT, 'assets', 'skills')
const GRILL = ['grilling', 'grill-me', 'grill-with-docs']
const shipped = (name, file = 'SKILL.md') => readFileSync(path.join(SKILLS, name, file), 'utf8')
const MATT = '---\nname: grilling\ndescription: Grill the user relentlessly.\n---\n\nInterview the user relentlessly.\n'

describe('grill skills: shipped text (S6, S7)', () => {
  test('S6: grilling keeps the Q<n> chat format with a recommendation, and marks assumptions with A<n>, never Q<n>', () => {
    const text = shipped('grilling')
    assert.ok(text.includes('❓ **Q1** - **<question title>**: '))
    assert.ok(text.includes('➡️ <your recommended answer>'))
    assert.ok(text.includes('word each question so "yes" accepts your recommendation'))
    assert.match(text, /📌 \*\*A1\*\* - /)
    assert.doesNotMatch(text, /📌 \*\*Q\d/)
  })

  test('S7: grill-me loads grilling, grill-with-docs loads grilling and domain-modeling, both only by the human; each folder carries Matt\'s MIT LICENSE', () => {
    assert.match(shipped('grill-me'), /disable-model-invocation: true/)
    assert.match(shipped('grill-me'), /`grilling`/)
    assert.match(shipped('grill-with-docs'), /disable-model-invocation: true/)
    assert.match(shipped('grill-with-docs'), /`grilling`/)
    assert.match(shipped('grill-with-docs'), /`domain-modeling`/)
    for (const name of GRILL) {
      assert.match(shipped(name), new RegExp(`^---\\nname: ${name}\\n`))
      assert.match(shipped(name, 'LICENSE'), /Copyright \(c\) 2026 Matt Pocock/)
    }
  })
})

describe('grill skills: install and drift', () => {
  let home
  beforeEach(() => {
    home = tempDir('grill-home')
  })
  afterEach(() => cleanup(home))

  const skillFile = (root, name) => path.join(home, root, 'skills', name, 'SKILL.md')
  const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi']).out

  test('S8: global replaces Matt\'s grilling SKILL.md with a backup and one line; a foreign arena SKILL.md is still skipped', () => {
    write(skillFile('.agents', 'grilling'), MATT)
    write(skillFile('.agents', 'arena'), 'mine')
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 0, result.out)
    assert.equal(read(skillFile('.agents', 'grilling')), shipped('grilling'))
    assert.equal(read(skillFile('.claude', 'grilling')), shipped('grilling'))
    const saved = backups(home).filter(b => b.endsWith('grilling/SKILL.md'))
    assert.equal(saved.length, 1, backups(home).join('\n'))
    assert.equal(read(path.join(home, saved[0])), MATT)
    const lines = result.out.split(/\r?\n/).filter(line => line.includes('no era de orca-stack'))
    assert.equal(lines.length, 1, result.out)
    assert.match(lines[0], /~[\\/]\.agents[\\/]skills[\\/]grilling[\\/]SKILL\.md/)
    // Negative: any other shipped skill keeps today's behavior.
    assert.equal(read(skillFile('.agents', 'arena')), 'mine')
    assert.match(result.out, /⚠ ~[\\/]\.agents[\\/]skills[\\/]arena[\\/]SKILL\.md ya existe y no es de orca-stack: lo dejo como está/)
    // remove gives Matt's copy back.
    assert.equal(cli(home, ['remove']).status, 0)
    assert.equal(read(skillFile('.agents', 'grilling')), MATT)
  })

  test('S8 preserve: --force still replaces a foreign arena SKILL.md with a backup', () => {
    write(skillFile('.agents', 'arena'), 'mine')
    const result = cli(home, ['global', '--skip-pi', '--force'])
    assert.equal(result.status, 0, result.out)
    assert.equal(read(skillFile('.agents', 'arena')), shipped('arena'))
    assert.equal(backups(home).filter(b => b.endsWith('arena/SKILL.md')).length, 1)
  })

  test('S9: doctor warns when an installed grill SKILL.md differs from the shipped one, with the global hint, and is quiet when it matches', () => {
    assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
    assert.doesNotMatch(doctor(), /skill grill/)
    write(skillFile('.agents', 'grill-with-docs'), MATT)
    const out = doctor()
    assert.match(out, /⚠ skill grill-with-docs en ~\/\.agents\/skills - .*orca-stack global/)
    assert.doesNotMatch(out, /⚠ skill grill-with-docs en ~\/\.claude\/skills/)
    assert.doesNotMatch(out, /⚠ skill grilling en/)
  })

  test('S9: the duplicated-skills warning leaves out the three grill names but still lists other plugin skills', () => {
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'm', 'mattpocock-skills', '1.3.1')
    write(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: ['./skills/engineering/tdd', ...GRILL.map(name => `./skills/productivity/${name}`)] }))
    write(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'mattpocock-skills@mattpocock': [{ version: '1.3.1', installPath }] } }),
    )
    assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
    write(skillFile('.claude', 'tdd'), 'x')
    const out = doctor()
    const line = out.split(/\r?\n/).find(l => l.includes('skills duplicadas')) ?? ''
    assert.match(line, /- tdd\b/)
    assert.doesNotMatch(line, /grill/)
  })
})
