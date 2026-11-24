import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

// ADR 0003 and #419: a binary is run only after its sha256 matches this table; new platforms need a hash here.
export const AST_GREP_VERSION = '0.51.3'
export const AST_GREP_PLATFORMS = {
  'win32-x64': { package: '@ast-grep/cli-win32-x64-msvc', binary: 'ast-grep.exe', sha256: '3b416132a62c85793d655b5967cdb724b91148ef707140ebe1074b2233e53399' },
  'linux-x64': { package: '@ast-grep/cli-linux-x64-gnu', binary: 'ast-grep', sha256: '9abc33cdb0e75c909bead3cefb94deccb1e4d71751392ff5f5bff7d1d09d6861' },
}
export const AST_GREP_ENV = 'ORCA_STACK_AST_GREP'

const INSTALL = 'Instalalo con npm ci en la instalación de orca-stack (sin --omit=optional).'
const ownRequire = createRequire(import.meta.url)

const fail = (code, message) => Object.assign(new Error(message), { code })

export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`

const pinnedEntry = key => {
  const entry = AST_GREP_PLATFORMS[key]
  if (!entry) {
    throw fail('AST_GREP_UNSUPPORTED', `ast-grep ${AST_GREP_VERSION} no tiene un binario fijado para la plataforma ${key} (fijadas: ${Object.keys(AST_GREP_PLATFORMS).join(', ')}); no se ejecutó ningún binario.`)
  }
  return entry
}

const installedBinary = (entry, root) => {
  const resolver = root ? createRequire(path.join(path.resolve(root), 'package.json')) : ownRequire
  let manifest
  try {
    manifest = resolver.resolve(`${entry.package}/package.json`)
  } catch {
    throw fail('AST_GREP_MISSING', `ast-grep ${AST_GREP_VERSION} no está instalado: falta el paquete ${entry.package}. ${INSTALL}`)
  }
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'))
  if (version !== AST_GREP_VERSION) {
    throw fail('AST_GREP_VERSION', `ast-grep ${AST_GREP_VERSION} es la versión fijada, pero ${entry.package} está en ${version}; no se ejecutó el binario. ${INSTALL}`)
  }
  return path.join(path.dirname(manifest), entry.binary)
}

export const resolveAstGrep = ({ env = process.env, platform, arch, root } = {}) => {
  const entry = pinnedEntry(platformKey(platform, arch))
  const file = env[AST_GREP_ENV] ? path.resolve(env[AST_GREP_ENV]) : installedBinary(entry, root)
  return { file, entry }
}

export const verifyAstGrep = options => {
  const { file, entry } = resolveAstGrep(options)
  try {
    statSync(file)
  } catch {
    throw fail('AST_GREP_MISSING', `ast-grep ${AST_GREP_VERSION} no está instalado: no existe ${file}. ${INSTALL}`)
  }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== entry.sha256) {
    throw fail('AST_GREP_CHECKSUM', `ast-grep ${AST_GREP_VERSION}: el checksum de ${file} no coincide con el fijado (sha256 esperado ${entry.sha256}, obtenido ${actual}); no se ejecutó el binario. ${INSTALL}`)
  }
  return file
}

export const runAstGrep = (args, { input, cwd, env = process.env, platform, arch } = {}) => {
  const file = verifyAstGrep({ env, platform, arch })
  const result = spawnSync(file, args, { input, cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true })
  if (result.error) throw fail('AST_GREP_SPAWN', `ast-grep ${AST_GREP_VERSION} no se pudo ejecutar (${file}): ${result.error.message}`)
  if (result.status !== 0) {
    throw fail('AST_GREP_EXIT', `ast-grep ${AST_GREP_VERSION} terminó con código ${result.status ?? result.signal}: ${(result.stderr || result.stdout).trim()}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

export const runAstGrepJson = (args, options) => {
  const { stdout } = runAstGrep(args, options)
  try {
    return stdout.trim() ? JSON.parse(stdout) : []
  } catch (error) {
    throw fail('AST_GREP_OUTPUT', `ast-grep ${AST_GREP_VERSION} devolvió una salida que no es JSON: ${error.message}`)
  }
}
