import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const BASELINE_FILE = '.orca-stack-baseline.json'
const MAX_LINES = 2000
const FINGERPRINT_LINES = 20
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
const checkedFiles = root => {
  const tracked = nulList(gitOut(root, ['ls-files', '-z']) ?? '')
  const ignored = new Set(nulList(gitOut(root, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard']) ?? ''))
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

const fingerprint = text => {
  const head = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).map(line => line.trimEnd()).filter(line => line !== '').slice(0, FINGERPRINT_LINES)
  return `sha256:${createHash('sha256').update(head.join('\n')).digest('hex').slice(0, 16)}`
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
const match = (violations, entries) => {
  const free = new Set(entries.map((_, index) => index))
  const unmatched = []
  const pending = []
  for (const violation of violations) {
    const index = [...free].find(i => entries[i].rule === violation.rule && entries[i].file === violation.file && entries[i].location === violation.location)
    if (index === undefined) pending.push(violation)
    else free.delete(index)
  }
  for (const violation of pending) {
    const index = [...free].find(i => entries[i].rule === violation.rule && entries[i].fingerprint === violation.fingerprint)
    if (index === undefined) unmatched.push(violation)
    else free.delete(index)
  }
  return { unmatched, stale: [...free].sort((a, b) => a - b).map(i => entries[i]) }
}

const byKey = (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.fingerprint.localeCompare(b.fingerprint)

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

export const lintCommand = async (flags, { cwd = process.cwd() } = {}) => {
  const root = repoRoot(cwd)
  let entries = readBaseline(root)
  const violations = longFiles(root, checkedFiles(root))

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

  const { unmatched, stale } = match(violations, entries)
  if (unmatched.length === 0 && stale.length === 0) {
    console.log(`lint OK: ninguna violación nueva ni entrada vencida (${entries.length} en la Baseline)`)
    return 0
  }
  for (const violation of unmatched) {
    console.log(`${violation.rule} ${violation.file}: ${violation.count} líneas (máximo ${MAX_LINES}) — dividí el archivo`)
  }
  for (const entry of stale) {
    console.log(`entrada vencida en ${BASELINE_FILE}: ${entry.rule} ${entry.file} (${entry.location}, ${entry.fingerprint}) — la violación ya no está en el repo: sacá esta entrada`)
  }
  console.log(`✖ lint: ${plural(unmatched.length, 'violación nueva', 'violaciones nuevas')}, ${plural(stale.length, 'entrada vencida', 'entradas vencidas')}`)
  return 1
}
