import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isFile, samePath } from '../src/util.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BIN = path.join(ROOT, 'bin', 'orca-stack.mjs')

export const tempDir = prefix => mkdtempSync(path.join(os.tmpdir(), `orca-stack-${prefix}-`))

export const cleanup = dir => rmSync(dir, { recursive: true, force: true })

export const pathKey = (env = process.env) => Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'

const ORCA_COMMANDS = process.platform === 'win32' ? ['orca-stack', 'orca-stack.cmd'] : ['orca-stack']
const TOOL_CANDIDATES = process.platform === 'win32'
  ? {
      node: ['node.exe', 'node.cmd', 'node.bat', 'node'],
      git: ['git.exe', 'git.cmd', 'git.bat', 'git'],
      npm: ['npm.cmd', 'npm.bat', 'npm.exe', 'npm'],
    }
  : {
      node: ['node'],
      git: ['git'],
      npm: ['npm'],
    }

const isInside = (dir, parent) => {
  if (!dir || !parent) return false
  const normalize = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  const rel = path.relative(normalize(parent), normalize(dir))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const hasOrcaCommand = dir => ORCA_COMMANDS.some(name => existsSync(path.join(dir, name)))

const findToolInDir = (dir, tool) => {
  for (const name of TOOL_CANDIDATES[tool]) {
    const full = path.join(dir, name)
    if (isFile(full)) return full
  }
  return null
}

const toPosixPath = p => {
  const resolved = path.resolve(p).replaceAll('\\', '/')
  return /^[A-Za-z]:\//.test(resolved) ? `/${resolved[0].toLowerCase()}${resolved.slice(2)}` : resolved
}

const writeShShim = (file, target) => {
  writeFileSync(file, `#!/bin/sh\nexec '${target.replaceAll("'", "'\\''")}' "$@"\n`)
  chmodSync(file, 0o755)
}

const shimDirs = new Map()
let cleanupRegistered = false

// Materializes a read-only bin directory containing only node/git/npm from a filtered machine PATH entry.
const shimDirFor = tools => {
  const key = JSON.stringify(tools)
  if (shimDirs.has(key)) return shimDirs.get(key)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-stack-clean-bin-'))
  if (!cleanupRegistered) {
    cleanupRegistered = true
    process.once('exit', () => {
      for (const d of shimDirs.values()) {
        try {
          if (process.platform !== 'win32') chmodSync(d, 0o755)
          rmSync(d, { recursive: true, force: true })
        } catch {}
      }
    })
  }
  for (const [tool, target] of tools) {
    if (process.platform !== 'win32') {
      writeShShim(path.join(dir, tool), target)
      continue
    }
    const ext = path.extname(target).toLowerCase()
    if (tool === 'node' && ext === '.exe') {
      const dest = path.join(dir, 'node.exe')
      try {
        linkSync(target, dest)
      } catch {
        copyFileSync(target, dest)
      }
    } else {
      writeFileSync(path.join(dir, `${tool}.cmd`), `@"${target}" %*\r\n`)
      const posixSibling = path.join(path.dirname(target), tool)
      if (isFile(posixSibling)) {
        writeShShim(path.join(dir, tool), toPosixPath(posixSibling))
      } else if (ext === '.exe') {
        writeShShim(path.join(dir, tool), toPosixPath(target))
      }
    }
  }
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o555)
  }
  shimDirs.set(key, dir)
  return dir
}

// Filters machine PATH directories that hold an orca-stack command while keeping node, git and npm reachable.
export const isolatePath = (rawPath, { ambientOnly = false, home, exclude = [] } = {}) => {
  const ambientDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)
  const execDir = path.dirname(process.execPath)
  const dirs = String(rawPath ?? '').split(path.delimiter).filter(Boolean)
  const out = []
  for (const dir of dirs) {
    if (exclude.some(ex => samePath(dir, ex))) continue
    const isMachineDir = !isInside(dir, home) && (!ambientOnly || samePath(dir, execDir) || ambientDirs.some(a => samePath(a, dir)))
    if (isMachineDir && hasOrcaCommand(dir)) {
      const tools = ['node', 'git', 'npm'].map(tool => [tool, findToolInDir(dir, tool)]).filter(([, found]) => found)
      if (tools.length > 0) out.push(shimDirFor(tools))
      continue
    }
    out.push(dir)
  }
  return out.join(path.delimiter)
}

// Runs the CLI against a throwaway home. Every home variable points at it, so nothing real can be touched.
export const cli = (home, args, { cwd = ROOT, env = {} } = {}) => {
  const merged = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ORCA_STACK_HOME: home,
    CODEX_HOME: '',
    ORCA_STACK_ORCA_DIR: path.join(home, 'no-orca'),
    NPM_CONFIG_PREFIX: path.join(home, 'npm-global'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-none'),
    ...env,
  }
  const hasEnvPath = Object.keys(env).some(key => key.toLowerCase() === 'path')
  const envKey = hasEnvPath ? pathKey(env) : 'PATH'
  const rawPath = hasEnvPath ? env[envKey] : (process.env.PATH || process.env.Path || '')
  const isolatedPath = isolatePath(rawPath, { ambientOnly: hasEnvPath, home })
  for (const key of Object.keys(merged)) {
    if (key.toLowerCase() === 'path') delete merged[key]
  }
  merged[envKey] = isolatedPath

  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: merged,
  })

  return { status: result.status, out: result.stdout + result.stderr, stdout: result.stdout }
}

// Every file under dir -> sha256 (relative path with forward slashes). Empty dirs are listed too.
export const snapshot = dir => {
  const found = {}
  const walk = (current, rel) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name)
      const relPath = rel ? `${rel}/${name}` : name
      if (statSync(full).isDirectory()) {
        found[`${relPath}/`] = 'dir'
        walk(full, relPath)
      } else {
        found[relPath] = createHash('sha256').update(readFileSync(full)).digest('hex')
      }
    }
  }
  walk(dir, '')

  return found
}

export const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

export const read = file => readFileSync(file, 'utf8')

export const backups = dir =>
  Object.keys(snapshot(dir)).filter(name => name.includes('.orca-stack/backups/') && !name.endsWith('/'))

export const git = (cwd, ...args) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(cwd, '..', 'none') } })
