import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { listFiles } from './templates.mjs'
import { PACKAGE_ROOT, packageVersion, run, samePath, which } from './util.mjs'

const packageDirs = ['assets', 'bin', 'mods', 'shared', 'src']

const commandName = () => (process.platform === 'win32' ? 'orca-stack.cmd' : 'orca-stack')

const commandContent = (packageDir, win) => {
  const entry = path.join(packageDir, 'bin', 'orca-stack.mjs')
  if (win) {
    return `@echo off\r\nnode "${entry}" %*\r\nexit /b %ERRORLEVEL%\r\n`
  }
  return `#!/bin/sh\nexec node '${entry.replaceAll("'", "'\\''")}' "$@"\n`
}

const writablePathDirs = () => {
  const dirs = [...new Set((process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean))]
  return dirs.filter(dir => {
    try {
      return existsSync(dir) && (accessSync(dir, constants.W_OK), true)
    } catch {
      return false
    }
  })
}

export const installPathCommand = ctx => {
  const win = process.platform === 'win32'
  const existing = which('orca-stack')
  const tracked = ctx.state.command?.file
  if (existing && (!tracked || !samePath(existing, tracked))) {
    ctx.say(`\nGlobal command orca-stack\n  ${existing} already exists on PATH and was not written by this installation; leaving it unchanged.`)
    ctx.state.command = null
    return
  }

  const dirs = writablePathDirs()
  const commandDir = existing ? path.dirname(existing) : dirs[0] ?? path.join(ctx.L.ownDir, 'bin')
  const file = existing ?? path.join(commandDir, commandName())
  const packageDir = path.join(ctx.L.ownDir, 'cli')
  ctx.say('\nGlobal command orca-stack')
  if (!existing && dirs.length === 0) {
    ctx.say(`  No writable directory was found on PATH. Installed under ${path.join(ctx.L.ownDir, 'bin')}; add that directory to PATH.`)
  }
  for (const dir of packageDirs) {
    for (const rel of listFiles(path.join(PACKAGE_ROOT, dir))) {
      const source = path.join(PACKAGE_ROOT, dir, ...rel.split('/'))
      ctx.writeOwned(path.join(packageDir, dir, ...rel.split('/')), readFileSync(source))
    }
  }
  ctx.writeOwned(path.join(packageDir, 'package.json'), readFileSync(path.join(PACKAGE_ROOT, 'package.json')))
  const status = ctx.writeOwned(file, commandContent(packageDir, win), { mode: win ? undefined : 0o755 })
  if (!ctx.dryRun) {
    ctx.state.command = { file, packageDir, version: packageVersion() }
  }
  ctx.say(`  ${status === 'unchanged' ? 'orca-stack is already up to date' : `Installed ${file}`} (version ${packageVersion()})`)
}

export const checkPathCommand = (state, add) => {
  const expected = state?.command
  const actual = which('orca-stack')
  if (!expected) {
    add('warn', 'orca-stack', 'not tracked by global; run orca-stack global')
    return
  }
  if (!actual || !samePath(actual, expected.file)) {
    add('warn', 'orca-stack', `${expected.file} is not available on PATH; add its directory to PATH or run orca-stack global`)
    return
  }
  const result = run(actual, ['--version'], { timeout: 10_000 })
  const version = result.status === 0 ? result.stdout.trim() : ''
  if (version === expected.version && expected.version === state.version) {
    add('ok', 'orca-stack', `version ${version} on PATH`)
  } else {
    add('warn', 'orca-stack', `version ${version || 'unreadable'}; expected ${state.version}. Run orca-stack global`)
  }
}
