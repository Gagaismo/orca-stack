import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { spawnSync } from 'node:child_process'

import { buildBlock } from '../src/marker.mjs'
import { packageVersion, samePath } from '../src/util.mjs'
import { sddConfig } from './gentle-fixture.mjs'
import { ROOT, backups, cleanup, cli, git, read, snapshot, tempDir, write } from './helpers.mjs'

const MODS = ['bandeja-mensajes', 'grilling-ok', 'guardia-despacho', 'modo-autonomo', 'puente-gentle', 'reloj-cache', 'tablero-despacho']

let home
beforeEach(() => {
  home = tempDir('home')
})
afterEach(() => cleanup(home))

const settingsPath = () => path.join(home, '.claude', 'settings.json')
const claudeMdPath = () => path.join(home, '.claude', 'CLAUDE.md')

describe('global', () => {
  test('installs an offline command that reports the version global ran', () => {
    const commandDir = path.join(home, 'path-bin')
    write(path.join(commandDir, '.probe'), '')
    if (process.platform === 'win32') write(path.join(commandDir, 'npm.cmd'), `@echo off\r\necho ${commandDir}\r\n`)
    const envPath = [commandDir, path.dirname(process.execPath)].join(path.delimiter)
    const installed = cli(home, ['global', '--skip-pi'], { env: { PATH: envPath } })
    assert.equal(installed.status, 0, installed.out)
    const command = process.platform === 'win32' ? 'orca-stack.cmd' : 'orca-stack'
    const executable = path.join(commandDir, command)
    assert.ok(existsSync(executable), installed.out)
    const version = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: envPath },
    })
    assert.equal(version.status, 0, version.stdout + version.stderr)
    assert.equal(version.stdout.trim(), JSON.parse(read(path.join(ROOT, 'package.json'))).version)
  })

  test('Windows installs PowerShell and Git Bash launchers in the npm global prefix', { skip: process.platform !== 'win32' }, () => {
    const shellPathDir = path.join(home, 'shell-path')
    const npmPrefix = path.join(home, 'npm-prefix')
    const toolsDir = path.join(home, 'tools')
    write(path.join(shellPathDir, '.probe'), '')
    write(path.join(npmPrefix, '.probe'), '')
    const npm = path.join(toolsDir, 'npm.cmd')
    write(npm, `@echo off\r\necho ${npmPrefix}\r\n`)
    const envPath = [shellPathDir, npmPrefix, toolsDir, path.dirname(process.execPath)].join(path.delimiter)
    const installed = cli(home, ['global', '--skip-pi'], { env: { PATH: envPath } })
    assert.equal(installed.status, 0, installed.out)

    const cmdShim = path.join(npmPrefix, 'orca-stack.cmd')
    const bashShim = path.join(npmPrefix, 'orca-stack')
    assert.ok(existsSync(cmdShim), installed.out)
    assert.ok(existsSync(bashShim), installed.out)
    assert.match(read(bashShim), /^#!\/bin\/sh\r?\nexec node /)
    assert.equal(existsSync(path.join(shellPathDir, 'orca-stack.cmd')), false)
    assert.equal(existsSync(path.join(shellPathDir, 'orca-stack')), false)

    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const fromPowerShell = spawnSync(powershell, ['-NoProfile', '-Command', 'orca-stack --version'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: envPath },
    })
    assert.equal(fromPowerShell.status, 0, fromPowerShell.stdout + fromPowerShell.stderr)
    assert.equal(fromPowerShell.stdout.trim(), JSON.parse(read(path.join(ROOT, 'package.json'))).version)

    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find(existsSync)
    assert.ok(gitBash, 'Git Bash must be available on Windows')
    const fromGitBash = spawnSync(gitBash, ['-c', 'command -v orca-stack && orca-stack --version'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: envPath },
    })
    assert.equal(fromGitBash.status, 0, fromGitBash.stdout + fromGitBash.stderr)
    assert.equal(fromGitBash.stdout.trim().split(/\r?\n/).at(-1), JSON.parse(read(path.join(ROOT, 'package.json'))).version)
  })

  test('Windows falls back to ~/.orca-stack/bin instead of a shell-specific PATH directory', { skip: process.platform !== 'win32' }, () => {
    const shellPathDir = path.join(home, 'shell-path')
    write(path.join(shellPathDir, '.probe'), '')
    const envPath = [shellPathDir, path.dirname(process.execPath)].join(path.delimiter)
    const installed = cli(home, ['global', '--skip-pi'], { env: { PATH: envPath } })
    assert.equal(installed.status, 0, installed.out)
    assert.match(installed.out, /No writable npm global prefix was found on PATH/)
    assert.ok(existsSync(path.join(home, '.orca-stack', 'bin', 'orca-stack.cmd')))
    assert.ok(existsSync(path.join(home, '.orca-stack', 'bin', 'orca-stack')))
    assert.equal(existsSync(path.join(shellPathDir, 'orca-stack.cmd')), false)
    assert.equal(existsSync(path.join(shellPathDir, 'orca-stack')), false)
  })

  test('does not overwrite an untracked command already on PATH', () => {
    const commandDir = path.join(home, 'path-bin')
    const command = process.platform === 'win32' ? 'orca-stack.cmd' : 'orca-stack'
    const existing = path.join(commandDir, command)
    write(existing, 'foreign command\n')
    const result = cli(home, ['global', '--skip-pi'], { env: { PATH: [commandDir, path.dirname(process.execPath)].join(path.delimiter) } })
    assert.equal(result.status, 0, result.out)
    assert.equal(read(existing), 'foreign command\n')
    assert.match(result.out, /already exists on PATH and was not written/)
  })

  test('ignores its npx shim, installs outside npx .bin, and doctor checks the installed command', () => {
    const packageDir = path.join(home, 'npm-cache', 'node_modules', 'orca-stack')
    const npxBinDir = path.join(home, 'npm-cache', 'node_modules', '.bin')
    const installDir = path.join(home, 'path-bin')
    const commandName = process.platform === 'win32' ? 'orca-stack.cmd' : 'orca-stack'
    const packageBin = path.join(packageDir, 'bin', 'orca-stack.mjs')
    const npxShim = path.join(npxBinDir, commandName)
    for (const dir of ['bin', 'src', 'assets', 'mods', 'shared']) {
      cpSync(path.join(ROOT, dir), path.join(packageDir, dir), { recursive: true })
    }
    cpSync(path.join(ROOT, 'package.json'), path.join(packageDir, 'package.json'))
    mkdirSync(installDir, { recursive: true })
    if (process.platform === 'win32') {
      write(npxShim, `@echo off\r\nnode "${packageBin}" %*\r\n`)
      write(path.join(installDir, 'npm.cmd'), `@echo off\r\necho ${installDir}\r\n`)
    } else {
      write(npxShim, `#!/bin/sh\nexec node '${packageBin}' "$@"\n`)
      chmodSync(npxShim, 0o755)
    }
    const originalPathDirs = (process.env.PATH || process.env.Path || '')
      .split(path.delimiter)
      .filter(dir => dir && !samePath(dir, npxBinDir))
    const env = { PATH: [npxBinDir, installDir, ...originalPathDirs].join(path.delimiter) }
    const npxCli = (args) => spawnSync(process.execPath, [packageBin, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ORCA_STACK_HOME: home,
        ORCA_STACK_ORCA_DIR: path.join(home, 'no-orca'),
        NPM_CONFIG_PREFIX: path.join(home, 'npm-global'),
        ...env,
      },
    })

    const installed = npxCli(['global', '--skip-pi'])
    assert.equal(installed.status, 0, installed.stdout + installed.stderr)
    assert.ok(existsSync(path.join(installDir, commandName)), installed.stdout)
    assert.equal(existsSync(path.join(npxBinDir, commandName)), true)
    assert.doesNotMatch(installed.stdout + installed.stderr, /already exists on PATH and was not written/)
    assert.doesNotMatch(read(path.join(home, '.orca-stack', 'state.json')), new RegExp(npxBinDir.replaceAll('\\', '\\\\')))

    const installedEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ORCA_STACK_HOME: home,
      PATH: [installDir, ...originalPathDirs].join(path.delimiter),
    }
    const shell = process.platform === 'win32'
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'sh'
    const shellArgs = process.platform === 'win32' ? ['-NoProfile', '-Command'] : ['-c']
    const throughInstalled = spawnSync(shell, [...shellArgs, 'orca-stack global --skip-pi'], { encoding: 'utf8', env: installedEnv })
    assert.equal(throughInstalled.status, 0, throughInstalled.stdout + throughInstalled.stderr)
    const shellVersion = spawnSync(shell, [...shellArgs, 'orca-stack --version'], { encoding: 'utf8', env: installedEnv })
    assert.equal(shellVersion.status, 0, shellVersion.stdout + shellVersion.stderr)
    assert.equal(shellVersion.stdout.trim(), packageVersion())
    const secondNpxRun = npxCli(['global', '--skip-pi'])
    assert.equal(secondNpxRun.status, 0, secondNpxRun.stdout + secondNpxRun.stderr)
    assert.match(secondNpxRun.stdout, /already up to date/)
    assert.doesNotMatch(secondNpxRun.stdout + secondNpxRun.stderr, /already exists on PATH and was not written/)

    const doctor = npxCli(['doctor', '--offline', '--skip-pi'])
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr)
    assert.match(doctor.stdout, new RegExp(`orca-stack.*${packageVersion().replaceAll('.', '\\.')}`))
    assert.doesNotMatch(doctor.stdout, new RegExp(npxBinDir.replaceAll('\\', '\\\\')))
  })

  test('chooses a PATH directory, reports idempotence, and doctor checks its version', () => {
    const commandDir = path.join(home, process.platform === 'win32' ? 'npm-prefix' : 'path-bin')
    const toolsDir = path.join(home, 'tools')
    write(path.join(commandDir, '.probe'), '')
    const pathDirs = [commandDir]
    if (process.platform === 'win32') {
      write(path.join(toolsDir, 'npm.cmd'), `@echo off\r\necho ${commandDir}\r\n`)
      pathDirs.push(toolsDir)
    }
    pathDirs.push(path.dirname(process.execPath))
    const env = { PATH: pathDirs.join(path.delimiter) }
    const first = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(first.status, 0, first.out)
    if (process.platform === 'win32') {
      assert.ok(existsSync(path.join(commandDir, 'orca-stack.cmd')), first.out)
      assert.ok(existsSync(path.join(commandDir, 'orca-stack')), first.out)
    }
    const second = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(second.status, 0, second.out)
    assert.match(second.out, /orca-stack.*(actualizado|up to date)/i)
    const checked = cli(home, ['doctor', '--offline', '--skip-pi'], { env })
    const checkLine = checked.out.split(/\r?\n/).find(line => /✔ orca-stack -/.test(line))?.trim()
    assert.equal(checkLine, `✔ orca-stack - version ${packageVersion()} on PATH`)
  })

  test('finishes without a writable PATH directory and doctor warns with the PATH fix', () => {
    const result = cli(home, ['global', '--skip-pi'], { env: { PATH: path.join(home, 'missing-path') } })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /PATH/)
    const doctor = cli(home, ['doctor', '--offline', '--skip-pi'], { env: { PATH: path.join(home, 'missing-path') } })
    assert.match(doctor.out, /orca-stack.*PATH/i)
  })

  test('remove deletes only the tracked command and preserves a foreign command', () => {
    const commandDir = path.join(home, 'path-bin')
    write(path.join(commandDir, '.probe'), '')
    const env = { PATH: [commandDir, path.dirname(process.execPath)].join(path.delimiter) }
    cli(home, ['global', '--skip-pi'], { env })
    const commandName = process.platform === 'win32' ? 'orca-stack.cmd' : 'orca-stack'
    const installed = path.join(commandDir, commandName)
    const bashShim = path.join(commandDir, 'orca-stack')
    const foreign = path.join(commandDir, process.platform === 'win32' ? 'other.cmd' : 'other')
    write(foreign, 'keep me\n')
    const removed = cli(home, ['remove'], { env })
    assert.equal(removed.status, 0, removed.out)
    assert.equal(existsSync(installed), false)
    if (process.platform === 'win32') assert.equal(existsSync(bashShim), false)
    assert.equal(read(foreign), 'keep me\n')
  })

  test('--dry-run writes nothing at all', () => {
    const before = snapshot(home)
    const result = cli(home, ['global', '--dry-run', '--skip-pi'])
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\[simulación\]/)
    assert.match(result.out, /CLAUDE_CODE_PLUGIN_DIRS/)
    assert.deepEqual(snapshot(home), before)
    assert.equal(existsSync(path.join(home, '.orca-stack')), false)
  })

  test('installs policy, wrappers, skills, mods, settings, config and state, and writes no methodology into CLAUDE.md', () => {
    const result = cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    assert.equal(result.status, 0, result.out)
    const ext = process.platform === 'win32' ? 'cmd' : 'sh'
    for (const agent of ['claude', 'codex', 'agy']) {
      assert.ok(existsSync(path.join(home, 'orca', 'stack', 'scripts', `${agent}-orca-stack.${ext}`)), agent)
    }
    assert.ok(existsSync(path.join(home, 'orca', 'stack', 'ORCA-STACK.md')))
    assert.doesNotMatch(read(path.join(home, 'orca', 'stack', 'ORCA-STACK.md')), /\{\{/)
    for (const root of ['.claude', '.agents']) {
      const policy = read(path.join(home, root, 'skills', 'orca-stack-policy', 'SKILL.md'))
      assert.ok(policy.includes(path.join(home, 'orca', 'stack', 'ORCA-STACK.md')), 'policy path rendered')
      assert.ok(existsSync(path.join(home, root, 'skills', 'ponytail-review', 'SKILL.md')))
    }
    for (const mod of MODS) {
      assert.ok(existsSync(path.join(home, '.claude', 'mods', mod, '.claude-plugin', 'plugin.json')), mod)
      assert.ok(existsSync(path.join(home, '.claude', 'mods', mod, 'hooks', 'hooks.json')), mod)
    }
    assert.equal(existsSync(path.join(home, '.claude', 'mods', 'puente-gentle', 'tests')), false)
    const dirs = JSON.parse(read(settingsPath())).env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter)
    assert.deepEqual(dirs, MODS.map(m => path.join(home, '.claude', 'mods', m)))
    assert.equal(existsSync(claudeMdPath()), false, 'global leaves the methodology to the project')
    assert.deepEqual(JSON.parse(read(path.join(home, '.orca-stack', 'config.json'))), { humano: 'Ana' })
    const state = JSON.parse(read(path.join(home, '.orca-stack', 'state.json')))
    assert.equal(state.tool, 'orca-stack')
    assert.equal(state.claudeMd, null)
  })

  test('a second run is idempotent: same bytes, no backups, no duplicate plugin dirs', () => {
    cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    const first = snapshot(home)
    const second = cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    assert.equal(second.status, 0, second.out)
    assert.deepEqual(snapshot(home), first)
    assert.deepEqual(backups(home), [])
    const dirs = JSON.parse(read(settingsPath())).env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter)
    assert.equal(new Set(dirs).size, dirs.length)
  })

  test('settings.json merge keeps foreign keys and the existing plugin dirs, and remove restores them', () => {
    const foreign = path.join(home, 'mis-mods', 'otro')
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(git status)'] },
      env: { FOO: 'bar', CLAUDE_CODE_PLUGIN_DIRS: foreign },
      hooks: { Stop: [] },
    }
    write(settingsPath(), JSON.stringify(original, null, 2) + '\n')
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 0, result.out)
    const merged = JSON.parse(read(settingsPath()))
    assert.equal(merged.model, 'opus')
    assert.deepEqual(merged.permissions, original.permissions)
    assert.deepEqual(merged.hooks, original.hooks)
    assert.equal(merged.env.FOO, 'bar')
    const dirs = merged.env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter)
    assert.equal(dirs[0], foreign, 'foreign entry stays first')
    assert.equal(dirs.length, 1 + MODS.length)
    assert.equal(backups(home).filter(b => b.includes('settings.json')).length, 1)

    cli(home, ['global', '--skip-pi'])
    assert.equal(JSON.parse(read(settingsPath())).env.CLAUDE_CODE_PLUGIN_DIRS, merged.env.CLAUDE_CODE_PLUGIN_DIRS)

    assert.equal(cli(home, ['remove']).status, 0)
    assert.deepEqual(JSON.parse(read(settingsPath())), original)
  })

  test('a settings.json that is not valid JSON is refused and left untouched', () => {
    write(settingsPath(), '{ nope')
    const result = cli(home, ['global', '--skip-pi'])
    assert.equal(result.status, 1)
    assert.match(result.out, /settings\.json/)
    assert.equal(read(settingsPath()), '{ nope')
  })

  describe('a block left in CLAUDE.md by an older install', () => {
    const before = '# Mis reglas\n\nNo tocar esto.\n'
    const after = '\n<!-- gentle-ai:sdd-orchestrator -->\nbloque ajeno\n<!-- /gentle-ai:sdd-orchestrator -->\n'
    const old = `${before}\n${buildBlock('Política canónica: vieja')}\n${after}`
    const statePath = () => path.join(home, '.orca-stack', 'state.json')

    test('global takes it out with a backup, keeps everything else, and a second run changes nothing', () => {
      sddConfig(home, 'full') // this fixture's gentle-ai block is not a real one: keep lazy mode away from it
      write(claudeMdPath(), old)
      const result = cli(home, ['global', '--skip-pi'])
      assert.equal(result.status, 0, result.out)
      assert.match(result.out, /saqué el bloque orca-stack: la política ahora llega por el proyecto/)
      assert.equal(read(claudeMdPath()), before + after)
      const saved = backups(home).filter(name => name.endsWith('CLAUDE.md'))
      assert.equal(saved.length, 1)
      assert.equal(read(path.join(home, saved[0])), old)

      const snap = snapshot(home)
      const again = cli(home, ['global', '--skip-pi'])
      assert.equal(again.status, 0, again.out)
      assert.match(again.out, /sin bloque orca-stack/)
      assert.deepEqual(snapshot(home), snap)
    })

    test('the legacy markers go too, and --dry-run only narrates', () => {
      write(claudeMdPath(), `${before}\n<!-- orca-stack:auto -->\nviejo\n<!-- /orca-stack:auto -->\n`)
      const dry = cli(home, ['global', '--dry-run', '--skip-pi'])
      assert.match(dry.out, /\[simulación\] actualizo .*CLAUDE\.md \(sin el bloque orca-stack\)/)
      assert.ok(read(claudeMdPath()).includes('orca-stack:auto'))
      assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
      assert.equal(read(claudeMdPath()), before)
    })

    test('a file that only held the block, created by an older installer, is deleted', () => {
      cli(home, ['global', '--skip-pi'])
      const state = JSON.parse(read(statePath()))
      state.claudeMd = { file: claudeMdPath(), createdFile: true }
      write(statePath(), JSON.stringify(state))
      write(claudeMdPath(), buildBlock('Política canónica: vieja') + '\n')
      assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
      assert.equal(existsSync(claudeMdPath()), false)
      assert.equal(backups(home).filter(name => name.endsWith('CLAUDE.md')).length, 1)
      assert.equal(JSON.parse(read(statePath())).claudeMd, null)
    })

    test('remove still cleans an old install that recorded the block in its state', () => {
      cli(home, ['global', '--skip-pi'])
      const state = JSON.parse(read(statePath()))
      state.claudeMd = { file: claudeMdPath(), createdFile: false }
      write(statePath(), JSON.stringify(state))
      write(claudeMdPath(), old)
      assert.equal(cli(home, ['remove']).status, 0)
      assert.equal(read(claudeMdPath()), before + after)
    })

    test('doctor warns about it instead of failing, and is quiet once global removed it', () => {
      cli(home, ['global', '--skip-pi'])
      write(claudeMdPath(), old)
      const warned = cli(home, ['doctor', '--offline', '--skip-pi'])
      assert.match(warned.out, /⚠ bloque orca-stack viejo en ~\/\.claude\/CLAUDE\.md - .*corré `orca-stack global` para sacarlo/)
      assert.equal(warned.status, 0, warned.out)
      cli(home, ['global', '--skip-pi'])
      assert.doesNotMatch(cli(home, ['doctor', '--offline', '--skip-pi']).out, /bloque orca-stack viejo en/)
    })
  })

  test('with --force a different pre-existing file is backed up (outside its folder) and restored by remove', () => {
    const file = path.join(home, 'orca', 'stack', 'ORCA-STACK.md')
    write(file, 'mi versión')
    cli(home, ['global', '--skip-pi', '--force'])
    assert.notEqual(read(file), 'mi versión')
    const saved = backups(home).filter(b => b.includes('ORCA-STACK.md'))
    assert.equal(saved.length, 1)
    assert.ok(saved[0].startsWith('.orca-stack/backups/'), saved[0])
    cli(home, ['remove'])
    assert.equal(read(file), 'mi versión')
  })

  test('install then remove leaves the home as it was, apart from backups', () => {
    const pristine = snapshot(home)
    assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
    assert.notDeepEqual(snapshot(home), pristine)
    const dry = snapshot(home)
    assert.equal(cli(home, ['remove', '--dry-run']).status, 0)
    assert.deepEqual(snapshot(home), dry, 'remove --dry-run changes nothing')
    const removed = cli(home, ['remove'])
    assert.equal(removed.status, 0, removed.out)
    const left = Object.keys(snapshot(home)).filter(name => !name.includes('.orca-stack/backups/'))
    assert.deepEqual(
      left.filter(name => !name.endsWith('/')),
      [],
    )
    assert.equal(existsSync(path.join(home, '.orca-stack', 'state.json')), false)
  })

  test('remove keeps a config.json the user edited', () => {
    cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    const config = path.join(home, '.orca-stack', 'config.json')
    write(config, JSON.stringify({ humano: 'Ana', mensajes: { destinatarios: ['Beto'] } }))
    cli(home, ['remove'])
    assert.ok(existsSync(config))
  })

  test('remove without an install says there is nothing to undo', () => {
    const result = cli(home, ['remove'])
    assert.equal(result.status, 0)
    assert.match(result.out, /nada que deshacer/)
  })
})

describe('wrappers', () => {
  test('the wrapper of this platform passes its own self-test', () => {
    cli(home, ['global', '--skip-pi'])
    const ext = process.platform === 'win32' ? 'cmd' : 'sh'
    const file = path.join(home, 'orca', 'stack', 'scripts', `claude-orca-stack.${ext}`)
    const run = spawnSync(file, ['--orca-stack-self-test'], { encoding: 'utf8', shell: process.platform === 'win32' })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /ORCA_STACK_MODE=auto/)
    assert.match(run.stdout, /ORCA_STACK_CAVEMAN_LEVEL=full/)
    assert.match(run.stdout, /ORCA_STACK_PONYTAIL_LEVEL=full/)
    assert.ok(run.stdout.includes(path.join(home, 'orca', 'stack', 'ORCA-STACK.md')), run.stdout)
  })

  test('the POSIX flavour is generated on request and passes its self-test under sh', t => {
    const result = cli(home, ['global', '--skip-pi'], { env: { ORCA_STACK_PLATFORM: 'linux' } })
    assert.equal(result.status, 0, result.out)
    for (const agent of ['claude', 'codex', 'agy']) {
      assert.ok(existsSync(path.join(home, 'orca', 'stack', 'scripts', `${agent}-orca-stack.sh`)), agent)
    }
    const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' })
    if (sh.status !== 0) {
      t.skip('sh no disponible')

      return
    }
    const file = path.join(home, 'orca', 'stack', 'scripts', 'agy-orca-stack.sh')
    const run = spawnSync('sh', [file, '--orca-stack-self-test'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /ORCA_STACK_MODE=auto/)
    assert.match(run.stdout, /ORCA_STACK_POLICY_PATH=.*ORCA-STACK\.md/)
    // never named like the real binary, so it cannot call itself
    assert.ok(!existsSync(path.join(home, 'orca', 'stack', 'scripts', 'agy')))
  })
})

describe('doctor', () => {
  test('a clean offline install passes; a missing wrapper fails with a non-zero exit', () => {
    cli(home, ['global', '--skip-pi', '--humano', 'Ana'])
    const ok = cli(home, ['doctor', '--offline', '--skip-pi'])
    assert.equal(ok.status, 0, ok.out)
    assert.match(ok.out, /✔ claude-orca-stack --orca-stack-self-test/)
    assert.match(ok.out, /✔ tablero-despacho/)
    const ext = process.platform === 'win32' ? 'cmd' : 'sh'
    cli(home, ['remove', '--dry-run'])
    write(path.join(home, 'orca', 'stack', 'scripts', `codex-orca-stack.${ext}`), 'roto')
    const broken = cli(home, ['doctor', '--offline', '--skip-pi'])
    assert.equal(broken.status, 1)
    assert.match(broken.out, /✖ codex-orca-stack/)
  })

  test('a mod missing from CLAUDE_CODE_PLUGIN_DIRS is reported', () => {
    cli(home, ['global', '--skip-pi'])
    const settings = JSON.parse(read(settingsPath()))
    settings.env.CLAUDE_CODE_PLUGIN_DIRS = settings.env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter).slice(1).join(path.delimiter)
    write(settingsPath(), JSON.stringify(settings))
    const result = cli(home, ['doctor', '--offline', '--skip-pi'])
    assert.equal(result.status, 1)
    assert.match(result.out, /✖ bandeja-mensajes - no está en env\.CLAUDE_CODE_PLUGIN_DIRS/)
  })

  test('checks despacho with the same layering as the mods (committed, then local)', () => {
    cli(home, ['global', '--skip-pi'])
    const repo = path.join(tempDir('repo'), 'proyecto')
    write(path.join(repo, 'README.md'), '# proyecto\n')
    git(repo, 'init', '-q', '-b', 'main')
    const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
    try {
      write(path.join(repo, '.orca-stack.local.json'), '{"despacho":{"script":"scripts/despachar.sh"}}\n')
      assert.match(doctor().out, /⚠ despacho\.script - scripts\/despachar\.sh no existe en el proyecto/)

      write(path.join(repo, '.orca-stack.json'), '{"version":1,"despacho":{"script":"scripts/despachar.sh"}}\n')
      write(path.join(repo, '.orca-stack.local.json'), '{"despacho":null}\n')
      assert.doesNotMatch(doctor().out, /despacho\.script/)
    } finally {
      cleanup(path.dirname(repo))
    }
  })

  test('the machine-specific launchers live in the rendered ORCA-STACK.md, not in the project contract', () => {
    cli(home, ['global', '--skip-pi'])
    const policy = read(path.join(home, 'orca', 'stack', 'ORCA-STACK.md'))
    assert.match(policy, /## Launching agents/)
    assert.match(policy, /ticket authoring rules.*AGENTS\.md/i)
    assert.doesNotMatch(policy, /{{[A-Z_]+}}/)
    for (const agent of ['claude:', 'agy:', 'codex:', 'codex-cc:', 'pi (Gentle Shell):']) assert.ok(policy.includes(`- ${agent}`), agent)
    assert.match(policy, /claude-orca-stack/)
    assert.match(policy, /model_provider=cc/)
    const contract = read(path.join(ROOT, 'assets', 'stack', 'CONTRATO.md'))
    assert.doesNotMatch(contract, /model_provider=cc|orca-stack.cmd|auth.json/)
  })

  test('warns about a legacy block and a pending setup, and stays quiet once both are fixed', () => {
    cli(home, ['global', '--skip-pi'])
    const repo = path.join(tempDir('repo'), 'proyecto')
    write(path.join(repo, 'README.md'), '# proyecto\n')
    git(repo, 'init', '-q', '-b', 'main')
    const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
    try {
      write(path.join(repo, 'AGENTS.md'), '<!-- orca-stack:auto -->\nviejo\n<!-- /orca-stack:auto -->\n')
      write(path.join(repo, '.orca-stack.json'), '{"version":1}\n')
      const warned = doctor()
      assert.match(warned.out, /⚠ AGENTS\.md: bloque orca-stack viejo - `orca-stack init` lo migra y además agrega el contrato de trabajo completo/)
      assert.match(warned.out, /⚠ \.orca-stack\.json: setup pendiente - abrí una sesión de Claude en el checkout principal/)

      write(path.join(repo, 'AGENTS.md'), '# Contrato\n')
      write(path.join(repo, '.orca-stack.json'), '{"version":1,"setup":"completo"}\n')
      const clean = doctor()
      assert.doesNotMatch(clean.out, /bloque orca-stack viejo|setup pendiente/)
    } finally {
      cleanup(path.dirname(repo))
    }
  })

  test('warns when configured deploy verification has no real functional check, but not when deploy is disabled', () => {
    cli(home, ['global', '--skip-pi'])
    const repo = path.join(tempDir('repo'), 'proyecto')
    write(path.join(repo, 'README.md'), '# proyecto\n')
    git(repo, 'init', '-q', '-b', 'main')
    const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: repo })
    try {
      write(path.join(repo, '.orca-stack.json'), JSON.stringify({
        version: 1,
        setup: 'completo',
        despliegue: { comando: 'deploy', verificacion: 'revisar el estado del servicio' },
      }))
      assert.match(doctor().out, /despliegue\.pruebaFuncional - falta un recorrido funcional real hasta un destino permitido/)

      write(path.join(repo, '.orca-stack.json'), JSON.stringify({
        version: 1,
        setup: 'completo',
        despliegue: { despues: false },
      }))
      assert.doesNotMatch(doctor().out, /despliegue\.pruebaFuncional/)

      write(path.join(repo, '.orca-stack.json'), JSON.stringify({
        version: 1,
        setup: 'completo',
        despliegue: {
          comando: 'deploy',
          verificacion: 'revisar el estado del servicio',
          pruebaFuncional: 'enviar un mensaje real al número de prueba permitido',
        },
      }))
      assert.doesNotMatch(doctor().out, /despliegue\.pruebaFuncional/)
    } finally {
      cleanup(path.dirname(repo))
    }
  })

  test('reads the Orca agent overrides without writing', () => {
    cli(home, ['global', '--skip-pi'])
    const orca = path.join(home, 'orca-app')
    const ext = process.platform === 'win32' ? 'cmd' : 'sh'
    const scripts = path.join(home, 'orca', 'stack', 'scripts')
    const data = JSON.stringify({
      settings: {
        agentCmdOverrides: {
          claude: path.join(scripts, `claude-orca-stack.${ext}`),
          codex: '/otro/codex',
        },
      },
    })
    write(path.join(orca, 'profiles', 'p1', 'orca-data.json'), data)
    const before = snapshot(orca)
    const result = cli(home, ['doctor', '--offline', '--skip-pi'], { env: { ORCA_STACK_ORCA_DIR: orca } })
    assert.match(result.out, /✔ Orca \[p1\] claude - apunta al wrapper/)
    assert.match(result.out, /⚠ Orca \[p1\] codex - apunta a \/otro\/codex/)
    assert.match(result.out, /⚠ Orca \[p1\] antigravity - sin override/)
    assert.deepEqual(snapshot(orca), before)
  })
})
