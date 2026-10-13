import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { INSTALL_HINTS, PINNED } from '../src/constants.mjs'
import { ROOT, backups, cleanup, cli, git, read, snapshot, tempDir, write } from './helpers.mjs'

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
    const pathDir = path.join(home, 'path-bin')
    write(path.join(pathDir, '.probe'), '')
    if (process.platform === 'win32') write(path.join(pathDir, 'npm.cmd'), `@echo off\r\necho ${pathDir}\r\n`)
    const env = {
      PATH: [pathDir, path.dirname(process.execPath)].join(path.delimiter),
      NPM_CONFIG_PREFIX: pathDir,
    }
    assert.equal(cli(home, ['global', '--skip-pi'], { env }).status, 0)
    // an aborted run left files and settings entries but no state.json
    cleanup(path.join(home, '.orca-stack', 'state.json'))
    const rerun = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(rerun.status, 0, rerun.out)
    const state = JSON.parse(read(path.join(home, '.orca-stack', 'state.json')))
    assert.ok(Object.keys(state.files).length > 50, 'identical files are claimed')
    assert.ok(state.files[path.join(home, '.orca-stack', 'cli', 'bin', 'orca-stack.mjs')], 'the copied CLI package is adopted')
    assert.ok(state.files[path.join(pathDir, process.platform === 'win32' ? 'orca-stack.cmd' : 'orca-stack')], 'the PATH command is adopted')
    if (process.platform === 'win32') {
      assert.ok(state.files[path.join(pathDir, 'orca-stack')], 'the Windows extensionless shim is adopted')
    }
    assert.equal(state.settings.pluginDirsAdded.length, 7, 'already-present plugin dirs are claimed')
    assert.equal(cli(home, ['remove'], { env }).status, 0)
    // Only the shared files (whose creation this run cannot know) and the personal config stay.
    assert.deepEqual(
      allFiles(home).filter(name => !name.includes('.orca-stack/backups/')),
      [
        '.claude/settings.json',
        '.orca-stack/config.json',
        'path-bin/.probe',
        ...(process.platform === 'win32' ? ['path-bin/npm.cmd'] : []),
      ],
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

// Fake pi, npm and engram on PATH: each call is logged; versions come from FAKE_PI_VERSION and FAKE_ENGRAM_VERSION.
const fakeBin = () => {
  const bin = path.join(home, 'fake-bin')
  const win = process.platform === 'win32'
  write(
    path.join(bin, 'tool.js'),
    [
      "const fs = require('fs')",
      "const [name, ...args] = process.argv.slice(2)",
      "fs.appendFileSync(process.env.FAKE_LOG, name + ' ' + args.join(' ') + '\\n')",
      "if (name === 'pi' && args[0] === '--version') console.log(process.env.FAKE_PI_VERSION || '1.2.0')",
      "if (name === 'pi' && args[0] === 'install' && process.env.FAKE_PI_FAIL) { console.error('npm error boom'); process.exit(1) }",
      "if (name === 'npm' && args[0] === 'root') console.log(process.env.FAKE_NPM_ROOT)",
      "if (name === 'engram' && args[0] === '--version') console.log('engram ' + (process.env.FAKE_ENGRAM_VERSION || '3.4.0'))",
      '',
    ].join('\n'),
  )
  for (const name of ['pi', 'npm', 'engram']) {
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

describe('4. Pi packages the user already had are never recorded as ours', () => {
  test('a package already present (any version) is not recorded; remove --with-pi leaves it alone', () => {
    const fake = fakeBin()
    write(path.join(home, '.pi', 'agent', 'npm', 'node_modules', 'gentle-pi', 'package.json'), '{"version":"3.0.0"}')
    write(path.join(home, 'npm-global', 'gentle-pi', 'package.json'), '{"version":"3.0.0"}')
    const result = cli(home, ['global'], { env: fake.env() })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /ejecuto: pi install npm:gentle-pi@4\.2\.0 \(ya tenías la 3\.0\.0/)
    assert.match(result.out, /ejecuto: npm i -g gentle-pi@4\.2\.0/)
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
    assert.match(result.out, /✖ falló pi install npm:gentle-pi@4\.2\.0: npm error boom/)
    // what did get written is still recorded, so remove can undo it
    assert.ok(existsSync(path.join(home, '.orca-stack', 'state.json')))
  })
})

describe('6. Pi 1.2.0, gentle-pi 4.2.0 and Engram 3.4.0 (#115)', () => {
  const piModules = name => path.join(home, '.pi', 'agent', 'npm', 'node_modules', name, 'package.json')
  const doctorLines = out => out.split(/\r?\n/).map(line => line.trim())

  test('rule 1: pins Pi 1.2.0 and gentle-pi 4.2.0; with Pi 1.2.0 and nothing else, global installs gentle-pi@4.2.0 in Pi and globally', () => {
    assert.equal(PINNED.pi, '1.2.0')
    assert.equal(PINNED.gentlePi, '4.2.0')
    const fake = fakeBin()
    const result = cli(home, ['global'], { env: fake.env() })
    assert.equal(result.status, 0, result.out)
    const log = readFileSync(fake.log, 'utf8')
    assert.match(log, /^pi install npm:gentle-pi@4\.2\.0$/m)
    assert.match(log, /^npm i -g gentle-pi@4\.2\.0$/m)
  })

  test('rule 2: with Pi 1.1.0, global installs no gentle-pi and fails naming both versions and the Pi install hint', () => {
    const fake = fakeBin()
    const result = cli(home, ['global'], { env: fake.env({ FAKE_PI_VERSION: '1.1.0' }) })
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /✖ gentle-pi 4\.2\.0 necesita Pi 1\.2\.0 o más nuevo y tenés Pi 1\.1\.0/)
    for (const line of INSTALL_HINTS.pi) {
      assert.ok(result.out.includes(line), line)
    }
    assert.doesNotMatch(readFileSync(fake.log, 'utf8'), /gentle-pi@/)
  })

  test('rule 2: doctor reports Pi 1.1.0 as a failure naming both versions and the Pi install hint', () => {
    const fake = fakeBin()
    const result = cli(home, ['doctor', '--offline'], { env: fake.env({ FAKE_PI_VERSION: '1.1.0' }) })
    const line = doctorLines(result.out).find(text => text.includes(' pi 1.1.0'))
    assert.match(line ?? result.out, /^✖ pi 1\.1\.0 - gentle-pi 4\.2\.0 necesita Pi 1\.2\.0 o más nuevo y tenés Pi 1\.1\.0: actualizalo con el instalador oficial \(.*pi\.dev\/install/)
  })

  test('rule 3: pi-claude-bridge stays at 0.9.2 and global installs it on Pi 1.2.0', () => {
    assert.equal(PINNED.claudeBridge, '0.9.2')
    const fake = fakeBin()
    const result = cli(home, ['global'], { env: fake.env() })
    assert.equal(result.status, 0, result.out)
    assert.match(readFileSync(fake.log, 'utf8'), /^pi install npm:pi-claude-bridge@0\.9\.2$/m)
  })

  test('rule 4: doctor reports the Engram version and warns, with the update hint, below 3.4.0', () => {
    const fake = fakeBin()
    const old = doctorLines(cli(home, ['doctor', '--offline', '--skip-pi'], { env: fake.env({ FAKE_ENGRAM_VERSION: '3.3.2' }) }).out)
    assert.match(old.find(text => text.includes(' engram 3.3.2')) ?? '', /^⚠ engram 3\.3\.2 - Gentle Shell 4\.2\.0 deja la memoria apagada con un Engram anterior a 3\.4\.0: actualizalo y reiniciá el servidor \(https:\/\/github\.com\/Gentleman-Programming\/engram\/blob\/main\/docs\/INSTALLATION\.md\)$/)
    const current = doctorLines(cli(home, ['doctor', '--offline', '--skip-pi'], { env: fake.env({ FAKE_ENGRAM_VERSION: '3.4.0' }) }).out)
    assert.ok(current.includes('✔ engram 3.4.0'), current.join('\n'))
  })

  test('rule 7: README and docs/guia-setup.md name Pi 1.2.0, gentle-pi 4.2.0 and the gentle-shell update refusal', () => {
    for (const doc of ['README.md', path.join('docs', 'guia-setup.md')]) {
      const text = read(path.join(ROOT, doc))
      assert.match(text, /Pi `?1\.2\.0/, doc)
      assert.ok(text.includes('pi install npm:gentle-pi@4.2.0'), doc)
      assert.match(text, /`gentle-shell update`[^\n]*no puede probar qué paquete global es dueño de Pi/, doc)
      assert.doesNotMatch(text, /gentle-pi@4\.0\.0|Pi `1\.1\.0`/, doc)
    }
  })

  test('global (preserved): already at the pinned versions it installs nothing and says ya está instalado', () => {
    const fake = fakeBin()
    write(piModules('gentle-pi'), '{"version":"4.2.0"}')
    write(piModules('pi-claude-bridge'), '{"version":"0.9.2"}')
    write(path.join(home, 'npm-global', 'gentle-pi', 'package.json'), '{"version":"4.2.0"}')
    const result = cli(home, ['global'], { env: fake.env() })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /gentle-pi@4\.2\.0 ya está instalado/)
    assert.match(result.out, /pi-claude-bridge@0\.9\.2 ya está instalado/)
    assert.match(result.out, /gentle-pi@4\.2\.0 global ya está instalado/)
    assert.doesNotMatch(readFileSync(fake.log, 'utf8'), /^(pi install|npm i -g)/m)
  })

  test('doctor (preserved): the pinned Pi passes, a newer one only warns, and a missing engram still warns', () => {
    const fake = fakeBin()
    const pinned = doctorLines(cli(home, ['doctor', '--offline'], { env: fake.env() }).out)
    assert.ok(pinned.some(text => text.startsWith('✔ pi 1.2.0')), pinned.join('\n'))
    const newer = doctorLines(cli(home, ['doctor', '--offline'], { env: fake.env({ FAKE_PI_VERSION: '1.3.0' }) }).out)
    assert.ok(newer.includes('⚠ pi 1.3.0 - el stack se probó con 1.2.0'), newer.join('\n'))
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path')
    const noEngram = doctorLines(cli(home, ['doctor', '--offline', '--skip-pi'], { env: { [pathKey]: path.join(home, 'missing-path') } }).out)
    assert.ok(noEngram.includes('⚠ engram - no se encontró (memoria persistente)'), noEngram.join('\n'))
  })
})
