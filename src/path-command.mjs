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

const pathDirs = () => [...new Set((process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean))]

const writablePathDirs = () =>
  pathDirs().filter(dir => {
    try {
      return existsSync(dir) && (accessSync(dir, constants.W_OK), true)
    } catch {
      return false
    }
  })

const npmPrefixOnPath = dirs => {
  if (process.platform !== 'win32') return null
  const npm = which('npm')
  if (!npm) return null
  const result = run(npm, ['prefix', '-g'], { timeout: 10_000 })
  if (result.status !== 0) return null
  const prefix = result.stdout.trim()
  return dirs.find(dir => samePath(dir, prefix)) ?? null
}

const isTracked = (ctx, file) =>
  Boolean(ctx.state.files[file]) || [ctx.state.command?.file, ctx.state.command?.shellFile].some(owned => owned && samePath(owned, file))

export const installPathCommand = ctx => {
  const win = process.platform === 'win32'
  const dirs = writablePathDirs()
  const existing = which('orca-stack')
  const visibleFiles = pathDirs().flatMap(dir => win ? [path.join(dir, 'orca-stack'), path.join(dir, 'orca-stack.cmd')] : [path.join(dir, 'orca-stack')])
  const foreign = visibleFiles.find(file => existsSync(file) && !isTracked(ctx, file))
  if (foreign || (existing && !isTracked(ctx, existing))) {
    const conflict = foreign ?? existing
    ctx.say(`\nGlobal command orca-stack\n  ${conflict} already exists on PATH and was not written by this installation; leaving it unchanged.`)
    ctx.state.command = null
    return
  }

  const npmPrefix = npmPrefixOnPath(dirs)
  const trackedDir = !win && ctx.state.command?.file ? dirs.find(dir => samePath(dir, path.dirname(ctx.state.command.file))) : null
  const commandDir = npmPrefix ?? (win ? null : trackedDir ?? dirs[0]) ?? path.join(ctx.L.ownDir, 'bin')
  const file = path.join(commandDir, commandName())
  const shellFile = win ? path.join(commandDir, 'orca-stack') : null
  const packageDir = path.join(ctx.L.ownDir, 'cli')
  ctx.say('\nGlobal command orca-stack')
  if (win ? !npmPrefix : !existing && dirs.length === 0) {
    ctx.say(`  ${win ? 'No writable npm global prefix was found on PATH' : 'No writable directory was found on PATH'}. Installed under ${path.join(ctx.L.ownDir, 'bin')}; add that directory to PATH.`)
  }
  for (const dir of packageDirs) {
    for (const rel of listFiles(path.join(PACKAGE_ROOT, dir))) {
      const source = path.join(PACKAGE_ROOT, dir, ...rel.split('/'))
      ctx.writeOwned(path.join(packageDir, dir, ...rel.split('/')), readFileSync(source))
    }
  }
  ctx.writeOwned(path.join(packageDir, 'package.json'), readFileSync(path.join(PACKAGE_ROOT, 'package.json')))
  const status = ctx.writeOwned(file, commandContent(packageDir, win), { mode: win ? undefined : 0o755 })
  const shellStatus = shellFile ? ctx.writeOwned(shellFile, commandContent(packageDir, false), { mode: 0o755 }) : status
  if (!ctx.dryRun) {
    ctx.state.command = { file, ...(shellFile ? { shellFile } : {}), packageDir, version: packageVersion() }
  }
  const unchanged = status === 'unchanged' && shellStatus === 'unchanged'
  ctx.say(`  ${unchanged ? 'orca-stack is already up to date' : `Installed ${file}${shellFile ? ` and ${shellFile}` : ''}`} (version ${packageVersion()})`)
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
