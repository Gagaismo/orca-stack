import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { ponytailPluginIds } from '../src/doctor.mjs'
import { cleanup, cli, tempDir, write } from './helpers.mjs'

let home
beforeEach(() => {
  home = tempDir('ponytail-plugin')
})
afterEach(() => cleanup(home))

const installed = plugins => write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
const entry = [{ scope: 'user', installPath: 'x', version: '5.2.0' }]
const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home })

describe('#139 rule 2: doctor warns when the ponytail plugin is installed for Claude Code', () => {
  test('an installed ponytail plugin prints a warning that names how to disable it, and the exit status is unchanged', () => {
    const before = doctor()
    assert.doesNotMatch(before.out, /plugin ponytail/)
    installed({ 'ponytail@ponytail': entry, 'caveman@caveman': entry })
    const after = doctor()
    assert.match(after.out, /⚠ plugin ponytail de Claude Code - ponytail@ponytail está instalado/)
    assert.match(after.out, /claude plugin disable ponytail@ponytail/)
    assert.equal(after.status, before.status)
  })

  test('negative: no plugin, another plugin, an unreadable file or a disabled plugin prints no ponytail-plugin row', () => {
    assert.deepEqual(ponytailPluginIds(home), [])
    installed({ 'caveman@caveman': entry, 'ponytail-like@other': entry })
    assert.deepEqual(ponytailPluginIds(home), [])
    write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), '{ broken')
    assert.deepEqual(ponytailPluginIds(home), [])
    installed({ 'ponytail@ponytail': entry })
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'ponytail@ponytail': false } }))
    assert.deepEqual(ponytailPluginIds(home), [])
    assert.doesNotMatch(doctor().out, /plugin ponytail/)
  })
})
