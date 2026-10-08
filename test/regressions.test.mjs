import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { backups, cleanup, cli, git, read, snapshot, tempDir, write } from './helpers.mjs'

let home
beforeEach(() => {
  home = tempDir('reg')
})
afterEach(() => cleanup(home))

const settingsPath = () => path.join(home, '.claude', 'settings.json')
const claudeMdPath = () => path.join(home, '.claude', 'CLAUDE.md')
const BEGIN = '<!-- orca-stack:begin -->'
const END = '<!-- orca-stack:end -->'

const allFiles = dir => Object.keys(snapshot(dir)).filter(name => !name.endsWith('/'))

describe('1. global validates before writing and never orphans files', () => {
  test('settings.json with comments (JSONC): non-zero exit, nothing written', () => {
    write(settingsPath(), '{\n  // mi comentario\n  "model": "opus"\n}\n')
    const before = snapshot(home)
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /settings\.json/)
    assert.deepEqual(snapshot(home), before)
    assert.equal(existsSync(path.join(home, '.orca-stack')), false)
  })

  test('CLAUDE.md with unbalanced markers: non-zero exit, nothing written', () => {
    write(claudeMdPath(), `hola\n${BEGIN}\nsin fin\n`)
    const before = snapshot(home)
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /incompletos/)
    assert.deepEqual(snapshot(home), before)
  })

  test('also under --dry-run the broken file is reported', () => {
    write(settingsPath(), '{ nope')
    assert.equal(cli(home, ['global', '--dry-run', '--skip-pi']).status, 1)
  })

  test('orphans of an aborted run are adopted by the next run, and remove then cleans everything', () => {
    assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
    // an aborted run left files and settings entries but no state.json
    cleanup(path.join(home, '.orca-stack', 'state.json'))
    const rerun = cli(home, ['global', '--skip-pi'])
    assert.equal(rerun.status, 0, rerun.out)
    const state = JSON.parse(read(path.join(home, '.orca-stack', 'state.json')))
    assert.ok(Object.keys(state.files).length > 50, 'identical files are claimed')
    assert.equal(state.settings.pluginDirsAdded.length, 7, 'already-present plugin dirs are claimed')
    assert.equal(cli(home, ['remove']).status, 0)
    // Only the shared files (whose creation this run cannot know) and the personal config stay.
    assert.deepEqual(
      allFiles(home).filter(name => !name.includes('.orca-stack/backups/')),
      ['.claude/settings.json', '.orca-stack/config.json'],
    )
    assert.equal(JSON.parse(read(settingsPath())).env?.CLAUDE_CODE_PLUGIN_DIRS, undefined)
  })
})

describe('5. duplicated marker pairs are refused', () => {
  const twice = `${BEGIN}\na\n${END}\n\n${BEGIN}\nb\n${END}\n`

  test('global refuses a CLAUDE.md with two blocks and writes nothing', () => {
    write(claudeMdPath(), twice)
    const before = snapshot(home)
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /duplicados/)
    assert.deepEqual(snapshot(home), before)
  })

  test('init refuses duplicated blocks and leaves the whole project untouched', () => {
    const repo = path.join(tempDir('repo'), 'p')
    write(path.join(repo, 'README.md'), 'x\n')
    git(repo, 'init', '-q', '-b', 'main')
    write(path.join(repo, 'AGENTS.md'), twice)
    const before = snapshot(repo)
    const result = cli(home, ['init'], { cwd: repo })
    assert.equal(result.status, 1, result.out)
    assert.deepEqual(snapshot(repo), before)
    cleanup(path.dirname(repo))
  })
})

describe('3. foreign files are not overwritten; backups live outside the files’ folders', () => {
  const skill = () => path.join(home, '.claude', 'skills', 'ponytail', 'SKILL.md')

  test('a pre-existing different skill is skipped with a warning', () => {
    write(skill(), 'mi ponytail\n')
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /⚠ .*SKILL\.md ya existe y no es de orca-stack/)
    assert.equal(read(skill()), 'mi ponytail\n')
    assert.deepEqual(backups(home), [])
    // and a second run still leaves it alone
    cli(home, ['global', '--skip-pi'])
    assert.equal(read(skill()), 'mi ponytail\n')
  })

  test('--force replaces it; every backup is under ~/.orca-stack/backups and none next to a file', () => {
    write(skill(), 'mi ponytail\n')
    write(settingsPath(), JSON.stringify({ model: 'opus' }))
    write(claudeMdPath(), 'reglas mías\n')
    assert.equal(cli(home, ['global', '--skip-pi', '--force']).status, 0)
    assert.notEqual(read(skill()), 'mi ponytail\n')
    assert.equal(allFiles(home).filter(name => name.includes('.bak-orca-stack-')).length, 0)
    const saved = backups(home)
    for (const needle of ['ponytail/SKILL.md', 'settings.json']) {
      assert.ok(saved.some(name => name.endsWith(needle)), needle)
    }
    for (const name of saved) {
      assert.match(name, /^\.orca-stack\/backups\/\d{8}-\d{6}\//)
    }
    assert.equal(cli(home, ['remove']).status, 0)
    assert.equal(read(skill()), 'mi ponytail\n')
    assert.equal(read(claudeMdPath()), 'reglas mías\n')
  })
})

describe('4. Pi packages the user already had are never recorded as ours', () => {
  const fakeBin = () => {
    const bin = path.join(home, 'fake-bin')
    const win = process.platform === 'win32'
    write(
      path.join(bin, 'tool.js'),
      [
        "const fs = require('fs')",
        "const [name, ...args] = process.argv.slice(2)",
        "fs.appendFileSync(process.env.FAKE_LOG, name + ' ' + args.join(' ') + '\\n')",
        "if (name === 'pi' && args[0] === '--version') console.log('0.99.1')",
        "if (name === 'pi' && args[0] === 'install' && process.env.FAKE_PI_FAIL) { console.error('npm error boom'); process.exit(1) }",
        "if (name === 'npm' && args[0] === 'root') console.log(process.env.FAKE_NPM_ROOT)",
        '',
      ].join('\n'),
    )
    for (const name of ['pi', 'npm']) {
      if (win) {
        write(path.join(bin, `${name}.cmd`), `@node "%~dp0tool.js" ${name} %*\r\n`)
      } else {
        const file = path.join(bin, name)
        write(file, `#!/bin/sh\nexec node "$(dirname "$0")/tool.js" ${name} "$@"\n`)
        chmodSync(file, 0o755)
      }
    }
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path')

    return {
      log: path.join(home, 'fake.log'),
      env: (extra = {}) => ({
        [pathKey]: bin + path.delimiter + process.env[pathKey],
        FAKE_LOG: path.join(home, 'fake.log'),
        FAKE_NPM_ROOT: path.join(home, 'npm-global'),
        ...extra,
      }),
    }
  }

  test('a package already present (any version) is not recorded; remove --with-pi leaves it alone', () => {
    const fake = fakeBin()
    write(path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'gentle-pi', 'package.json'), '{"version":"3.0.0"}')
    write(path.join(home, 'npm-global', 'gentle-pi', 'package.json'), '{"version":"3.0.0"}')
    const result = cli(home, ['global'], { env: fake.env() })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /ejecuto: pi install npm:gentle-pi@4\.0\.0 \(ya tenías la 3\.0\.0/)
    assert.match(result.out, /ejecuto: npm i -g gentle-pi@4\.0\.0/)
    const state = JSON.parse(read(path.join(home, '.orca-stack', 'state.json')))
    assert.deepEqual(state.pi.packagesInstalled, ['pi-claude-bridge@0.9.2'])
    assert.equal(state.pi.npmGlobalInstalled, false)

    const removed = cli(home, ['remove', '--with-pi'], { env: fake.env() })
    assert.equal(removed.status, 0, removed.out)
    const log = readFileSync(fake.log, 'utf8')
    assert.match(log, /pi remove npm:pi-claude-bridge/)
    assert.doesNotMatch(log, /pi remove npm:gentle-pi/)
    assert.doesNotMatch(log, /npm rm -g/)
  })

  test('a failing pi install makes global exit non-zero and says why', () => {
    const fake = fakeBin()
    const result = cli(home, ['global'], { env: fake.env({ FAKE_PI_FAIL: '1' }) })
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /✖ falló pi install npm:gentle-pi@4\.0\.0: npm error boom/)
    // what did get written is still recorded, so remove can undo it
    assert.ok(existsSync(path.join(home, '.orca-stack', 'state.json')))
  })
})
