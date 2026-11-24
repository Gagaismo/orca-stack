import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadConfig } from './despacho.mjs'
import { commentViolations, isCommentRule, reportComment } from './lint-comments.mjs'
import { homeDir } from './util.mjs'

export const BASELINE_FILE = '.orca-stack-baseline.json'
const MAX_LINES = 2000
const ENTRY_KEYS = ['rule', 'file', 'location', 'fingerprint']

const gitOut = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) return undefined
  return result.stdout
}

const repoRoot = cwd => {
  const top = gitOut(cwd, ['rev-parse', '--show-toplevel'])
  if (top === undefined) throw new Error('orca-stack lint se corre dentro de un repo git.')
  return top.trim()
}

const nulList = text => text.split('\0').filter(Boolean)

// Tracked files minus the tracked ones that .gitignore now excludes: untracked and ignored files are never checked.
const listFiles = (root, args) => {
  const out = gitOut(root, ['ls-files', '-z', ...args])
  if (out === undefined) throw new Error(`git ls-files falló en ${root}: el lint no puede saber qué archivos revisar.`)
  return nulList(out)
}

const checkedFiles = root => {
  const tracked = listFiles(root, [])
  const ignored = new Set(listFiles(root, ['--cached', '--ignored', '--exclude-standard']))
  return [...new Set(tracked)].filter(file => !ignored.has(file)).sort()
}

const readText = full => {
  let stat
  try {
    stat = lstatSync(full)
  } catch {
    return undefined
  }
  if (!stat.isFile()) return undefined
  const bytes = readFileSync(full)
  if (bytes.subarray(0, 8000).includes(0)) return undefined
  return bytes.toString('utf8')
}

const countLines = text => {
  if (text === '') return 0
  const breaks = text.split('\n').length - 1
  return text.endsWith('\n') ? breaks : breaks + 1
}

// The whole file, so two files that share only a header (a license, the imports) never share a fingerprint.
const fingerprint = text => {
  const normalized = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n')
  return `sha256:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`
}

const longFiles = (root, files) => {
  const found = []
  for (const file of files) {
    const text = readText(path.join(root, file))
    if (text === undefined) continue
    const count = countLines(text)
    if (count > MAX_LINES) found.push({ rule: 'long-file', file, location: 'file', fingerprint: fingerprint(text), count })
  }
  return found
}

const invalid = reason => new Error(`${BASELINE_FILE} no es una Baseline válida: ${reason}. Arreglalo a mano: el lint no lo reescribe.`)

const readBaseline = root => {
  const full = path.join(root, BASELINE_FILE)
  if (!existsSync(full)) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8'))
  } catch (error) {
    throw invalid(`no es JSON (${error.message})`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid('se espera un objeto {"version":1,"entries":[…]}')
  if (parsed.version !== 1) throw invalid('"version" tiene que ser 1')
  if (!Array.isArray(parsed.entries)) throw invalid('"entries" tiene que ser una lista')
  parsed.entries.forEach((entry, index) => {
    const ok = entry && typeof entry === 'object' && !Array.isArray(entry)
      && ENTRY_KEYS.every(key => typeof entry[key] === 'string' && entry[key] !== '')
    if (!ok) throw invalid(`la entrada ${index + 1} necesita ${ENTRY_KEYS.join(', ')} como textos`)
  })
  return parsed.entries
}

// Each entry matches at most one violation: same rule and file first, then same rule and fingerprint (moved code).
// A second copy of a baselined violation finds its entry taken and counts as new.
// #419: a comment entry also needs its fingerprint in the same-file pass, since one symbol can hold several comments.
const sameFile = (entry, violation) => entry.rule === violation.rule && entry.file === violation.file && entry.location === violation.location
  && (!isCommentRule(violation.rule) || entry.fingerprint === violation.fingerprint)
const sameLocation = (entry, violation) => entry.rule === violation.rule && entry.fingerprint === violation.fingerprint && entry.location === violation.location
const sameText = (entry, violation) => entry.rule === violation.rule && entry.fingerprint === violation.fingerprint

const match = (violations, entries) => {
  const free = new Set(entries.map((_, index) => index))
  let pending = violations
  for (const same of [sameFile, sameLocation, sameText]) {
    const left = []
    for (const violation of pending) {
      const index = [...free].find(i => same(entries[i], violation))
      if (index === undefined) left.push(violation)
      else free.delete(index)
    }
    pending = left
  }
  return { unmatched: pending, stale: [...free].sort((a, b) => a - b).map(i => entries[i]) }
}

const ALCANCE_KEY = 'lint.comentarios.alcance'

const alcanceOf = config => {
  const value = config.lint?.comentarios?.alcance
  if (value === undefined || value === 'repo' || value === 'diff') return value ?? 'repo'
  throw new Error(`${ALCANCE_KEY} tiene que ser "repo" o "diff", no ${JSON.stringify(value)} (en .orca-stack.json, .orca-stack.local.json o ~/.orca-stack/config.json).`)
}

const mergeBase = (root, base) => {
  if (typeof base !== 'string' || base === '') throw new Error(`${ALCANCE_KEY} "diff" necesita ramaBase en la configuración del repo.`)
  const ref = [base, `origin/${base}`].find(candidate => gitOut(root, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]) !== undefined)
  if (ref === undefined) throw new Error(`${ALCANCE_KEY} "diff": no se encontró la rama base ${base} ni origin/${base}; traéla con git fetch origin ${base}.`)
  const found = gitOut(root, ['merge-base', 'HEAD', ref])
  if (found === undefined) throw new Error(`${ALCANCE_KEY} "diff": HEAD no tiene merge-base con ${ref} (en un clon shallow, corré git fetch --unshallow).`)
  return found.trim()
}

const addedLines = (root, base) => {
  const commit = mergeBase(root, base)
  const out = gitOut(root, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '-U0', '--src-prefix=a/', '--dst-prefix=b/', commit, '--'])
  if (out === undefined) throw new Error(`git diff ${commit} falló: el lint no puede saber qué líneas agrega el cambio.`)
  const added = new Map()
  let lines
  let pending = 0
  for (const line of out.split('\n')) {
    if (pending > 0) {
      if (line.startsWith('+') || line.startsWith('-')) pending--
      continue
    }
    if (line.startsWith('+++ ')) {
      lines = line.startsWith('+++ b/') ? new Set() : undefined
      if (lines) added.set(line.slice(6).replace(/\r$/, ''), lines)
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!hunk) continue
    const start = Number(hunk[2])
    const count = Number(hunk[3] ?? 1)
    pending = Number(hunk[1] ?? 1) + count
    for (let n = start; n < start + count; n++) lines?.add(n)
  }
  return added
}

const onAddedLine = added => violation => {
  const lines = added.get(violation.file)
  if (!lines) return false
  for (let n = violation.line; n <= violation.endLine; n++) if (lines.has(n)) return true
  return false
}

const byKey = (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.location.localeCompare(b.location) || a.fingerprint.localeCompare(b.fingerprint)

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

export const lintCommand = async (flags, { cwd = process.cwd(), home = homeDir() } = {}) => {
  if (flags.dryRun) throw new Error('lint no acepta --dry-run: sin --sembrar no escribe nada, y --sembrar existe para escribir la Baseline.')
  const root = repoRoot(cwd)
  let entries = readBaseline(root)
  const config = loadConfig(home, root)
  const diff = alcanceOf(config) === 'diff'
  const added = diff ? addedLines(root, config.ramaBase) : undefined
  const files = checkedFiles(root)
  const comments = commentViolations(root, files)
  const violations = [...longFiles(root, files), ...(diff ? comments.filter(onAddedLine(added)) : comments)]

  if (flags.sembrar) {
    const { unmatched } = match(violations, entries)
    if (unmatched.length === 0 && existsSync(path.join(root, BASELINE_FILE))) {
      console.log(`Baseline: sin cambios (${BASELINE_FILE})`)
    } else {
      const added = unmatched.map(({ rule, file, location, fingerprint: print }) => ({ rule, file, location, fingerprint: print }))
      entries = [...entries, ...added].sort(byKey)
      writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
      console.log(`Baseline: ${plural(added.length, 'entrada nueva', 'entradas nuevas')} en ${BASELINE_FILE}`)
    }
  }

  const { unmatched, stale: expired } = match(violations, entries)
  const stale = diff ? expired.filter(entry => !isCommentRule(entry.rule)) : expired
  if (unmatched.length === 0 && stale.length === 0) {
    console.log(`lint OK: ninguna violación nueva ni entrada vencida (${entries.length} en la Baseline)`)
    return 0
  }
  for (const violation of unmatched) {
    console.log(isCommentRule(violation.rule) ? reportComment(violation) : `${violation.rule} ${violation.file}: ${violation.count} líneas (máximo ${MAX_LINES}) — dividí el archivo`)
  }
  for (const entry of stale) {
    console.log(`entrada vencida en ${BASELINE_FILE}: ${entry.rule} ${entry.file} (${entry.location}, ${entry.fingerprint}) — la violación ya no está en el repo: sacá esta entrada`)
  }
  console.log(`✖ lint: ${plural(unmatched.length, 'violación nueva', 'violaciones nuevas')}, ${plural(stale.length, 'entrada vencida', 'entradas vencidas')}`)
  return 1
}
