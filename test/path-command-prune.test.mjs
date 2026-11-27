import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { createCtx } from '../src/ctx.mjs'
import { installPathCommand } from '../src/path-command.mjs'
import { listFiles } from '../src/templates.mjs'
import { packageVersion, samePath, sha256 } from '../src/util.mjs'
import { ROOT, cleanup, cli, isolatePath, pathKey, read, snapshot, tempDir, write } from './helpers.mjs'

const PACKAGE_DIRS = ['assets', 'bin', 'mods', 'shared', 'src']

const expectedCliFiles = () => [
  ...PACKAGE_DIRS.flatMap(dir => listFiles(path.join(ROOT, dir)).map(rel => `${dir}/${rel}`)),
  'package.json',
].sort()

const snapshotFiles = dir => Object.keys(snapshot(dir)).filter(name => !name.endsWith('/')).sort()

const withCommandDirEnv = home => {
  const commandDir = path.join(home, 'path-bin')
  write(path.join(commandDir, '.probe'), '')
  if (process.platform === 'win32') {
    write(path.join(commandDir, 'npm.cmd'), `@echo off\r\necho ${commandDir}\r\n`)
  }
  const envPath = [commandDir, path.dirname(process.execPath)].join(path.delimiter)

  return { commandDir, env: { PATH: envPath }, envPath }
}

const withIsolatedPath = (home, envPath, fn) => {
  const key = pathKey()
  const previous = process.env[key]
  process.env[key] = isolatePath(envPath, { home })
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

const seedRetiredCliFiles = home => {
  const cliDir = path.join(home, '.orca-stack', 'cli')
  const retiredFiles = [
    path.join(cliDir, 'assets', 'skills', 'ponytail', 'SKILL.md'),
    path.join(cliDir, 'assets', 'skills', 'ponytail-audit', 'SKILL.md'),
    path.join(cliDir, 'assets', 'skills', 'ponytail-debt', 'SKILL.md'),
    path.join(cliDir, 'assets', 'skills', 'ponytail-help', 'SKILL.md'),
    path.join(cliDir, 'assets', 'skills', 'ponytail-review', 'SKILL.md'),
    path.join(cliDir, 'assets', 'skills', 'ponytail-upstream.json'),
    path.join(cliDir, 'mods', 'puente-gentle', '.claude-plugin', 'plugin.json'),
    path.join(cliDir, 'mods', 'puente-gentle', 'hooks', 'hooks.json'),
  ]
  for (const file of retiredFiles) {
    write(file, `retired:${path.basename(file)}\n`)
  }
  const emptyDir = path.join(cliDir, 'assets', 'skills', 'retired-empty')
  mkdirSync(emptyDir, { recursive: true })

  return { cliDir, retiredFiles, emptyDir }
}

let home
beforeEach(() => {
  home = tempDir('cli-prune')
})
afterEach(() => cleanup(home))

describe('#500 prune retired files from ~/.orca-stack/cli', () => {
  test('R1: global prunes retired files and folders from ~/.orca-stack/cli so it matches the installed package', () => {
    const { env } = withCommandDirEnv(home)
    const initial = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(initial.status, 0, initial.out)

    const { cliDir, retiredFiles, emptyDir } = seedRetiredCliFiles(home)
    const stateFile = path.join(home, '.orca-stack', 'state.json')
    const state = JSON.parse(read(stateFile))
    const deadTracked = path.join(cliDir, 'src', 'already-gone.mjs')
    state.files[retiredFiles[0]] = { sha256: sha256(Buffer.from(read(retiredFiles[0]))), backup: null, existedBefore: false }
    state.files[retiredFiles[6]] = { sha256: sha256(Buffer.from(read(retiredFiles[6]))), backup: null, existedBefore: false }
    state.files[deadTracked] = { sha256: 'dead', backup: null, existedBefore: false }
    write(stateFile, JSON.stringify(state, null, 2))

    const pruned = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(pruned.status, 0, pruned.out)

    assert.equal(existsSync(path.join(cliDir, 'assets', 'skills', 'ponytail')), false)
    assert.equal(existsSync(path.join(cliDir, 'assets', 'skills', 'ponytail-audit')), false)
    assert.equal(existsSync(path.join(cliDir, 'assets', 'skills', 'ponytail-debt')), false)
    assert.equal(existsSync(path.join(cliDir, 'assets', 'skills', 'ponytail-help')), false)
    assert.equal(existsSync(path.join(cliDir, 'assets', 'skills', 'ponytail-review')), false)
    assert.equal(existsSync(path.join(cliDir, 'assets', 'skills', 'ponytail-upstream.json')), false)
    assert.equal(existsSync(path.join(cliDir, 'mods', 'puente-gentle')), false)
    assert.equal(existsSync(emptyDir), false)

    assert.deepEqual(snapshotFiles(cliDir), expectedCliFiles())

    const nextState = JSON.parse(read(stateFile))
    for (const file of [...retiredFiles, deadTracked]) {
      assert.equal(Object.keys(nextState.files).some(key => samePath(key, file)), false, `${file} must leave state.files`)
    }
  })

  test('R2: global --dry-run reports retired ~/.orca-stack/cli files it would delete without deleting them', () => {
    const { env } = withCommandDirEnv(home)
    assert.equal(cli(home, ['global', '--skip-pi'], { env }).status, 0)

    const { retiredFiles, emptyDir } = seedRetiredCliFiles(home)
    const before = snapshot(home)

    const preview = cli(home, ['global', '--dry-run', '--skip-pi'], { env })
    assert.equal(preview.status, 0, preview.out)
    assert.match(preview.out, /\[simulación\] borro .*ponytail[\\/]SKILL\.md/)
    assert.match(preview.out, /\[simulación\] borro .*ponytail-upstream\.json/)
    assert.match(preview.out, /\[simulación\] borro .*puente-gentle[\\/]hooks[\\/]hooks\.json/)
    assert.match(preview.out, /\[simulación\] borro .*retired-empty/)
    for (const file of retiredFiles) {
      assert.equal(existsSync(file), true, file)
    }
    assert.equal(existsSync(emptyDir), true)
    assert.deepEqual(snapshot(home), before)
  })

  test('R3: a second global run is idempotent and neither deletes nor reports pruning anything', () => {
    const { env } = withCommandDirEnv(home)
    assert.equal(cli(home, ['global', '--skip-pi'], { env }).status, 0)
    seedRetiredCliFiles(home)

    const first = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(first.status, 0, first.out)
    assert.match(first.out, /\bborro\b/)
    assert.equal(existsSync(path.join(home, '.orca-stack', 'cli', 'assets', 'skills', 'ponytail')), false)
    const afterFirst = snapshot(home)

    const second = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(second.status, 0, second.out)
    assert.doesNotMatch(second.out, /\bborro\b/)
    assert.match(second.out, /orca-stack is already up to date/)
    assert.deepEqual(snapshot(home), afterFirst)
  })

  test('R4: global never deletes files outside ~/.orca-stack/cli or files the current package still ships', () => {
    const { env } = withCommandDirEnv(home)
    assert.equal(cli(home, ['global', '--skip-pi'], { env }).status, 0)

    const cliDir = path.join(home, '.orca-stack', 'cli')
    const currentCliSnapshot = snapshot(cliDir)
    const outsideOwn = path.join(home, '.orca-stack', 'custom-outside.txt')
    const siblingCli = path.join(home, '.orca-stack', 'cli-sibling', 'keep.txt')
    const homeNote = path.join(home, 'unrelated.txt')
    const symlinkTargetDir = path.join(home, 'outside-symlink-target')
    const symlinkTargetFile = path.join(symlinkTargetDir, 'keep-target.txt')
    const symlinkInsideCli = path.join(cliDir, 'assets', 'skills', 'retired-link')
    write(outsideOwn, 'keep-own\n')
    write(siblingCli, 'keep-sibling\n')
    write(homeNote, 'keep-home\n')
    write(symlinkTargetFile, 'keep-symlink-target\n')
    symlinkSync(symlinkTargetDir, symlinkInsideCli, process.platform === 'win32' ? 'junction' : 'dir')
    seedRetiredCliFiles(home)

    const result = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(result.status, 0, result.out)

    assert.equal(read(outsideOwn), 'keep-own\n')
    assert.equal(read(siblingCli), 'keep-sibling\n')
    assert.equal(read(homeNote), 'keep-home\n')
    assert.equal(read(symlinkTargetFile), 'keep-symlink-target\n')
    assert.equal(existsSync(symlinkInsideCli), false)
    assert.deepEqual(snapshot(cliDir), currentCliSnapshot)
  })

  test('R5: a deletion failure reports the path and continues pruning the rest of ~/.orca-stack/cli', async () => {
    const { env, envPath } = withCommandDirEnv(home)
    assert.equal(cli(home, ['global', '--skip-pi'], { env }).status, 0)

    const cliDir = path.join(home, '.orca-stack', 'cli')
    const lockedFile = path.join(cliDir, 'assets', 'skills', 'ponytail', 'SKILL.md')
    const removableFile = path.join(cliDir, 'mods', 'puente-gentle', 'hooks', 'hooks.json')
    const lockedDir = path.join(cliDir, 'assets', 'skills', 'locked-empty')
    write(lockedFile, 'locked\n')
    write(removableFile, '{}\n')
    mkdirSync(lockedDir, { recursive: true })

    const stateFile = path.join(home, '.orca-stack', 'state.json')
    const state = JSON.parse(read(stateFile))
    state.files[lockedFile] = { sha256: sha256(Buffer.from('locked\n')), backup: null, existedBefore: false }
    state.files[removableFile] = { sha256: sha256(Buffer.from('{}\n')), backup: null, existedBefore: false }
    write(stateFile, JSON.stringify(state, null, 2))

    const lines = []
    const ctx = createCtx({ home, out: line => lines.push(line) })
    withIsolatedPath(home, envPath, () => {
      installPathCommand(ctx, {
        unlink: file => {
          if (samePath(file, lockedFile)) {
            throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
          }
          unlinkSync(file)
        },
        rmdir: dir => {
          if (samePath(dir, lockedDir)) {
            throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
          }
          rmdirSync(dir)
        },
      })
    })
    ctx.save()

    const out = lines.join('\n')
    assert.equal(ctx.failures, 2, out)
    assert.match(out, /✖ .*ponytail[\\/]SKILL\.md.*EBUSY/)
    assert.match(out, /✖ .*locked-empty.*EBUSY/)
    assert.doesNotMatch(out, /already up to date/)
    assert.match(out, /Quedaron 2 restos sin borrar/)
    assert.equal(existsSync(lockedFile), true)
    assert.equal(existsSync(lockedDir), true)
    assert.equal(existsSync(removableFile), false)
    assert.equal(existsSync(path.join(cliDir, 'mods', 'puente-gentle')), false)
    assert.ok(Object.keys(ctx.state.files).some(key => samePath(key, lockedFile)))
    assert.equal(Object.keys(ctx.state.files).some(key => samePath(key, removableFile)), false)
    assert.ok(ctx.state.command?.file)

    const retry = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(retry.status, 0, retry.out)
    assert.equal(existsSync(path.join(cliDir, 'assets', 'skills', 'ponytail')), false)
    assert.equal(existsSync(lockedDir), false)

    const e2eRemovable = path.join(cliDir, 'mods', 'puente-gentle', 'hooks', 'hooks.json')
    write(e2eRemovable, '{}\n')
    if (process.platform === 'win32') {
      const busyDir = path.join(cliDir, 'assets', 'skills', 'busy-retired')
      mkdirSync(busyDir, { recursive: true })
      const holder = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], {
        cwd: busyDir,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      try {
        await new Promise((resolve, reject) => {
          holder.stdout.once('data', resolve)
          holder.once('error', reject)
          holder.once('exit', code => reject(new Error(`holder exited early: ${code}`)))
        })
        const failedCli = cli(home, ['global', '--skip-pi'], { env })
        assert.equal(failedCli.status, 1, failedCli.out)
        assert.match(failedCli.out, /✖ .*busy-retired/)
        assert.match(failedCli.out, /paso\(s\) fallaron/)
        assert.equal(existsSync(e2eRemovable), false)
      } finally {
        holder.kill()
        await new Promise(resolve => holder.once('close', resolve))
      }
      const afterUnlock = cli(home, ['global', '--skip-pi'], { env })
      assert.equal(afterUnlock.status, 0, afterUnlock.out)
      assert.equal(existsSync(busyDir), false)
    } else if (process.getuid?.() !== 0) {
      const roDir = path.join(cliDir, 'assets', 'skills', 'readonly-retired')
      const roFile = path.join(roDir, 'SKILL.md')
      write(roFile, 'locked\n')
      chmodSync(roDir, 0o555)
      try {
        const failedCli = cli(home, ['global', '--skip-pi'], { env })
        assert.equal(failedCli.status, 1, failedCli.out)
        assert.match(failedCli.out, /✖ .*readonly-retired\/SKILL\.md/)
        assert.match(failedCli.out, /paso\(s\) fallaron/)
        assert.equal(existsSync(e2eRemovable), false)
      } finally {
        chmodSync(roDir, 0o755)
      }
      const afterUnlock = cli(home, ['global', '--skip-pi'], { env })
      assert.equal(afterUnlock.status, 0, afterUnlock.out)
      assert.equal(existsSync(roDir), false)
    }
  })

  test('PRESERVE installPathCommand: leaves a foreign orca-stack command on PATH untouched', () => {
    const commandDir = path.join(home, 'path-bin')
    const command = process.platform === 'win32' ? 'orca-stack.cmd' : 'orca-stack'
    const foreign = path.join(commandDir, command)
    write(foreign, 'foreign-script\n')
    const envPath = [commandDir, path.dirname(process.execPath)].join(path.delimiter)

    const lines = []
    const ctx = createCtx({ home, out: line => lines.push(line) })
    withIsolatedPath(home, envPath, () => installPathCommand(ctx))

    assert.equal(ctx.state.command, null)
    assert.equal(read(foreign), 'foreign-script\n')
    assert.match(lines.join('\n'), /already exists on PATH and was not written/)
  })

  test('PRESERVE global: installs PATH command, tracks ~/.orca-stack/cli files in state, and remove cleans them', () => {
    const { commandDir, env, envPath } = withCommandDirEnv(home)
    const installed = cli(home, ['global', '--skip-pi'], { env })
    assert.equal(installed.status, 0, installed.out)

    const cliDir = path.join(home, '.orca-stack', 'cli')
    const state = JSON.parse(read(path.join(home, '.orca-stack', 'state.json')))
    assert.ok(state.files[path.join(cliDir, 'bin', 'orca-stack.mjs')])
    const executable = path.join(commandDir, process.platform === 'win32' ? 'orca-stack.cmd' : 'orca-stack')
    const version = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: envPath },
    })
    assert.equal(version.status, 0, version.stdout + version.stderr)
    assert.equal(version.stdout.trim(), packageVersion())

    const removed = cli(home, ['remove'], { env })
    assert.equal(removed.status, 0, removed.out)
    assert.equal(existsSync(cliDir), false)
  })
})
