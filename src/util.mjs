import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const packageVersion = () =>
  JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version

// ORCA_STACK_HOME lets tests (and curious users) install into a throwaway home.
export const homeDir = () => process.env.ORCA_STACK_HOME || os.homedir()

// ORCA_STACK_PLATFORM only chooses which wrapper flavour is generated: 'win32' or anything else.
export const platform = () => process.env.ORCA_STACK_PLATFORM || process.platform
export const isWindows = () => platform() === 'win32'

// Where the wrappers live, relative to the home: shared with the launchers, which build it for the target platform.
export const SCRIPTS_REL = ['orca', 'stack', 'scripts']

export const layout = (home = homeDir()) => ({
  home,
  stackDir: path.join(home, 'orca', 'stack'),
  scriptsDir: path.join(home, ...SCRIPTS_REL),
  claudeDir: path.join(home, '.claude'),
  agentsDir: path.join(home, '.agents'),
  settings: path.join(home, '.claude', 'settings.json'),
  claudeMd: path.join(home, '.claude', 'CLAUDE.md'),
  modsDir: path.join(home, '.claude', 'mods'),
  claudeSkills: path.join(home, '.claude', 'skills'),
  agentsSkills: path.join(home, '.agents', 'skills'),
  ownDir: path.join(home, '.orca-stack'),
  state: path.join(home, '.orca-stack', 'state.json'),
  config: path.join(home, '.orca-stack', 'config.json'),
  gentleDir: path.join(home, '.orca-stack', 'gentle'),
  sddCopy: path.join(home, '.orca-stack', 'gentle', 'sdd-orchestrator.md'),
  piAgent: path.join(home, '.pi', 'agent'),
  codexDir: path.join(home, '.codex'),
  codexAgentsMd: path.join(home, '.codex', 'AGENTS.md'),
})

export const tilde = (p, home = homeDir()) => {
  const rel = path.relative(home, p)

  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join('~', rel) : p
}

export const sha256 = data => createHash('sha256').update(data).digest('hex')

export const isFile = p => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export const readTextIfExists = p => (existsSync(p) ? readFileSync(p, 'utf8') : null)

// Environment for child processes: they must see the same home the installer targets.
export const childEnv = () => {
  const env = { ...process.env }
  if (process.env.ORCA_STACK_HOME) {
    env.HOME = process.env.ORCA_STACK_HOME
    env.USERPROFILE = process.env.ORCA_STACK_HOME
  }

  return env
}

export const which = (name, env = process.env) => {
  const win = process.platform === 'win32'
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  const exts = win ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  const hasExt = win && path.extname(name) !== ''
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = path.join(dir, name + ext)
      if (isFile(candidate)) {
        return candidate
      }
    }
  }

  return null
}

const quoteWin = arg => (/[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)

// Runs a command and never throws: { status, stdout, stderr, error, timedOut }.
export const run = (cmd, args = [], { cwd, env, timeout = 120_000, input } = {}) => {
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
  const options = {
    cwd,
    env: env ?? childEnv(),
    timeout,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }
  const result = viaShell
    ? spawnSync([quoteWin(cmd), ...args.map(quoteWin)].join(' '), { ...options, shell: true })
    : spawnSync(cmd, args, options)

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
  }
}

export const timestamp = (date = new Date()) => {
  const pad = n => String(n).padStart(2, '0')

  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export const samePath = (a, b) => {
  const norm = p => path.resolve(String(p).replace(/[\\/]+$/, ''))
  const x = norm(a)
  const y = norm(b)

  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

export const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
