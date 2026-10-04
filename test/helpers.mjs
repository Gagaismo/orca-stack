import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BIN = path.join(ROOT, 'bin', 'orca-stack.mjs')

export const tempDir = prefix => mkdtempSync(path.join(os.tmpdir(), `orca-stack-${prefix}-`))

export const cleanup = dir => rmSync(dir, { recursive: true, force: true })

// Runs the CLI against a throwaway home. Every home variable points at it, so nothing real can be touched.
export const cli = (home, args, { cwd = ROOT, env = {} } = {}) => {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ORCA_STACK_HOME: home,
      ORCA_STACK_ORCA_DIR: path.join(home, 'no-orca'),
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-none'),
      ...env,
    },
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
