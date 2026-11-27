import { accessSync, constants, existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { listFiles } from './templates.mjs'
import { PACKAGE_ROOT, packageVersion, run, samePath, which } from './util.mjs'

const packageDirs = ['assets', 'bin', 'mods', 'shared', 'src']

const normPath = file => {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const isUnderDir = (file, dir) => {
  const rel = path.relative(normPath(dir), normPath(file))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

const listDiskEntries = (root, onReadError) => {
  const files = []
  const dirs = []
  const walk = current => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    } catch (error) {
      if (error?.code !== 'ENOENT') onReadError(current, error)
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        dirs.push(full)
      } else {
        files.push({ file: full, symlink: entry.isSymbolicLink() })
      }
    }
  }
  walk(root)
  return { files, dirs }
}

const ancestorDirsOf = (root, files, { includeRoot = false } = {}) => {
  const rootNorm = normPath(root)
  const dirs = new Set(includeRoot ? [rootNorm] : [])
  for (const file of files) {
    let dir = path.dirname(path.resolve(file))
    while (isUnderDir(dir, root) || (includeRoot && normPath(dir) === rootNorm)) {
      const key = normPath(dir)
      if (dirs.has(key)) break
      dirs.add(key)
      if (key === rootNorm) break
      dir = path.dirname(dir)
    }
  }
  return dirs
}

const deleteTracked = (files, target) => {
  for (const key of Object.keys(files)) {
    if (samePath(key, target)) delete files[key]
  }
}

const removeStaleFile = (file, symlink, { unlink, rmdir }) => {
  try {
    unlink(file)
  } catch (error) {
    if (process.platform === 'win32' && symlink && error?.code === 'EPERM') {
      rmdir(file)
      return
    }
    throw error
  }
}

const prunePackageDir = (ctx, packageDir, expected, { unlink, rmdir }) => {
  const expectedSet = new Set(expected.map(normPath))
  const expectedDirs = ancestorDirsOf(packageDir, expected, { includeRoot: true })
  const failedFiles = new Set()
  let failures = 0
  const failPrune = msg => {
    failures += 1
    ctx.fail(msg)
  }

  if (existsSync(packageDir)) {
    const { files, dirs } = listDiskEntries(packageDir, (dir, error) => {
      failPrune(`no pude leer ${ctx.show(dir)}: ${error.message}`)
    })
    const staleFiles = files.filter(({ file }) => isUnderDir(file, packageDir) && !expectedSet.has(normPath(file)))
    for (const { file, symlink } of staleFiles) {
      if (ctx.dryRun) {
        ctx.act(`borro ${ctx.show(file)}`)
        continue
      }
      try {
        removeStaleFile(file, symlink, { unlink, rmdir })
        ctx.act(`borro ${ctx.show(file)}`)
        deleteTracked(ctx.state.files, file)
      } catch (error) {
        if (error?.code === 'ENOENT') {
          deleteTracked(ctx.state.files, file)
        } else {
          failedFiles.add(normPath(file))
          failPrune(`no pude borrar ${ctx.show(file)}: ${error.message}`)
        }
      }
    }

    const dirsWithStaleFiles = ancestorDirsOf(packageDir, staleFiles.map(({ file }) => file))
    const staleDirs = dirs.filter(dir => isUnderDir(dir, packageDir) && !expectedDirs.has(normPath(dir)))
    for (const dir of staleDirs) {
      const loggedViaFiles = dirsWithStaleFiles.has(normPath(dir))
      if (ctx.dryRun) {
        if (!loggedViaFiles) ctx.act(`borro ${ctx.show(dir)}`)
        continue
      }
      let entries
      try {
        entries = readdirSync(dir)
      } catch (error) {
        if (error?.code !== 'ENOENT') failPrune(`no pude leer ${ctx.show(dir)}: ${error.message}`)
        continue
      }
      if (entries.length > 0) continue
      try {
        rmdir(dir)
        if (!loggedViaFiles) ctx.act(`borro ${ctx.show(dir)}`)
      } catch (error) {
        if (error?.code !== 'ENOENT') failPrune(`no pude borrar ${ctx.show(dir)}: ${error.message}`)
      }
    }
  }

  if (!ctx.dryRun) {
    for (const key of Object.keys(ctx.state.files)) {
      if (isUnderDir(key, packageDir) && !expectedSet.has(normPath(key)) && !failedFiles.has(normPath(key)) && !existsSync(key)) {
        delete ctx.state.files[key]
      }
    }
  }

  return failures
}

const commandName = () => (process.platform === 'win32' ? 'orca-stack.cmd' : 'orca-stack')

const commandContent = (packageDir, win) => {
  const entry = path.join(packageDir, 'bin', 'orca-stack.mjs')
  if (win) {
    return `@echo off\r\nnode "${entry}" %*\r\nexit /b %ERRORLEVEL%\r\n`
  }
  return `#!/bin/sh\nexec node '${entry.replaceAll("'", "'\\''")}' "$@"\n`
}

const pathDirs = () => [...new Set((process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean))]

const isOwnNpxBinDir = dir =>
  path.basename(dir) === '.bin' && samePath(path.resolve(dir, '..', path.basename(PACKAGE_ROOT)), PACKAGE_ROOT)

const commandPathDirs = () => pathDirs().filter(dir => !isOwnNpxBinDir(dir))

const commandOnPath = () =>
  which('orca-stack', { ...process.env, PATH: commandPathDirs().join(path.delimiter) })

const writablePathDirs = () =>
  commandPathDirs().filter(dir => {
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

export const installPathCommand = (ctx, { unlink = unlinkSync, rmdir = rmdirSync } = {}) => {
  const win = process.platform === 'win32'
  const dirs = writablePathDirs()
  const npmPrefix = npmPrefixOnPath(dirs)
  const trackedDir = !win && ctx.state.command?.file ? dirs.find(dir => samePath(dir, path.dirname(ctx.state.command.file))) : null
  const commandDir = npmPrefix ?? (win ? null : trackedDir ?? dirs[0]) ?? path.join(ctx.L.ownDir, 'bin')
  const file = path.join(commandDir, commandName())
  const shellFile = win ? path.join(commandDir, 'orca-stack') : null
  const packageDir = path.join(ctx.L.ownDir, 'cli')
  const isAdoptable = (target, content) => {
    if (!target || (!samePath(target, file) && (!shellFile || !samePath(target, shellFile)))) return false
    try {
      return readFileSync(target).equals(Buffer.from(content))
    } catch {
      return false
    }
  }
  const shimContent = target =>
    commandContent(packageDir, !(shellFile && samePath(target, shellFile)) && win)
  const existing = commandOnPath()
  const visibleFiles = commandPathDirs().flatMap(dir => win ? [path.join(dir, 'orca-stack'), path.join(dir, 'orca-stack.cmd')] : [path.join(dir, 'orca-stack')])
  const foreign = visibleFiles.find(target => {
    if (!existsSync(target) || isTracked(ctx, target)) return false
    return !isAdoptable(target, shimContent(target))
  })
  if (foreign || (existing && !isTracked(ctx, existing) && !isAdoptable(existing, shimContent(existing)))) {
    const conflict = foreign ?? existing
    ctx.say(`\nGlobal command orca-stack\n  ${conflict} already exists on PATH and was not written by this installation; leaving it unchanged.`)
    ctx.state.command = null
    return
  }

  ctx.say('\nGlobal command orca-stack')
  if (win ? !npmPrefix : !existing && dirs.length === 0) {
    ctx.say(`  ${win ? 'No writable npm global prefix was found on PATH' : 'No writable directory was found on PATH'}. Installed under ${path.join(ctx.L.ownDir, 'bin')}; add that directory to PATH.`)
  }
  const expected = []
  for (const dir of packageDirs) {
    for (const rel of listFiles(path.join(PACKAGE_ROOT, dir))) {
      const source = path.join(PACKAGE_ROOT, dir, ...rel.split('/'))
      const dest = path.join(packageDir, dir, ...rel.split('/'))
      expected.push(dest)
      ctx.writeOwned(dest, readFileSync(source))
    }
  }
  const packageJson = path.join(packageDir, 'package.json')
  expected.push(packageJson)
  ctx.writeOwned(packageJson, readFileSync(path.join(PACKAGE_ROOT, 'package.json')))
  const pruneFailures = prunePackageDir(ctx, packageDir, expected, { unlink, rmdir })
  const status = ctx.writeOwned(file, commandContent(packageDir, win), { mode: win ? undefined : 0o755 })
  const shellStatus = shellFile ? ctx.writeOwned(shellFile, commandContent(packageDir, false), { mode: 0o755 }) : status
  if (!ctx.dryRun) {
    ctx.state.command = { file, ...(shellFile ? { shellFile } : {}), packageDir, version: packageVersion() }
  }
  const unchanged = status === 'unchanged' && shellStatus === 'unchanged'
  if (pruneFailures > 0) {
    ctx.say(`  Quedaron ${pruneFailures} restos sin borrar en ${ctx.show(packageDir)}; volvé a correr \`orca-stack global\` cuando no estén en uso.`)
  } else {
    ctx.say(`  ${unchanged ? 'orca-stack is already up to date' : `Installed ${file}${shellFile ? ` and ${shellFile}` : ''}`} (version ${packageVersion()})`)
  }
}

export const checkPathCommand = (state, add) => {
  const expected = state?.command
  const actual = commandOnPath()
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
