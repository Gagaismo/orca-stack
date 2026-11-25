import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PROJECT_CONFIG, PROJECT_LOCAL_CONFIG } from './constants.mjs'
import { loadConfig } from './despacho.mjs'
import { globToRegExp } from './estado.mjs'
import { commentViolations, isCommentRule, reportComment } from './lint-comments.mjs'
import { cycleEntry, isCycleEntry, matchCycles, moduleCycles, reportCycle, validCycleEntry } from './lint-cycles.mjs'
import { DESIGN_REPORT, TANGLE_RULE, designChecks, reportTangle } from './lint-design.mjs'
import { LANGUAGE_EXTENSIONS, languageOf } from './lint-graph.mjs'
import { homeDir, layout } from './util.mjs'

export const BASELINE_FILE = '.orca-stack-baseline.json'
const MAX_LINES = 2000
const MAX_ENTRIES = 15
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

// Entries are the tracked files and the subdirectories holding one, so an empty or untracked-only directory never counts.
// The fingerprint is the path itself: a renamed directory is a new violation, never a match for its old entry.
const wideDirectories = files => {
  const children = new Map()
  for (const file of files) {
    const parts = file.split('/')
    if (parts.includes('node_modules')) continue
    for (let depth = 0; depth < parts.length; depth += 1) {
      const dir = depth === 0 ? './' : `${parts.slice(0, depth).join('/')}/`
      if (!children.has(dir)) children.set(dir, new Set())
      children.get(dir).add(parts[depth])
    }
  }
  return [...children]
    .filter(([, names]) => names.size > MAX_ENTRIES)
    .map(([dir, names]) => ({ rule: 'wide-directory', file: dir, location: 'directory', fingerprint: fingerprint(dir), count: names.size }))
    .sort((a, b) => (a.file < b.file ? -1 : 1))
}

const REPORT = {
  'long-file': ({ file, count }) => `long-file ${file}: ${count} líneas (máximo ${MAX_LINES}) — dividí el archivo`,
  'wide-directory': ({ file, count }) => `wide-directory ${file}: ${count} entradas (máximo ${MAX_ENTRIES}) — agrupá los archivos relacionados en subdirectorios`,
  ...DESIGN_REPORT,
}

const isTangleEntry = entry => entry.rule === TANGLE_RULE
const isMemberEntry = entry => isCycleEntry(entry) || isTangleEntry(entry)

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
    if (isMemberEntry(entry) && !validCycleEntry(entry)) throw invalid(`la entrada ${index + 1} de ${entry.rule} necesita members como una lista de ${isTangleEntry(entry) ? 'cosas' : 'rutas'}`)
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

const LAYERS = '(en .orca-stack.json, .orca-stack.local.json o ~/.orca-stack/config.json)'
const VALID_LANGUAGES = new Set(Object.keys(LANGUAGE_EXTENSIONS))
const VALID_MODES = new Set(['blocking', 'warning'])
const PYTHON_CI_STEP = /\b(?:pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|uv\s+run\s+pytest|poetry\s+run\s+pytest|tox|nox)\b/

const lintEnabled = config => {
  const value = config.lint?.enabled
  if (value === undefined || typeof value === 'boolean') return value !== false
  throw new Error(`lint.enabled tiene que ser true o false, no ${JSON.stringify(value)} ${LAYERS}.`)
}

const excludedMatchers = config => {
  const value = config.lint?.excluir
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`lint.excluir tiene que ser una lista de globs no vacíos, no ${JSON.stringify(value)} ${LAYERS}.`)
  }
  return value.map(glob => globToRegExp(glob.trim().replace(/\\/g, '/').replace(/^\.\//, '')))
}

const filterExcluded = (files, matchers) => (matchers.length === 0 ? files : files.filter(file => !matchers.some(re => re.test(file))))

// #423: Python defaults to warning unless a GitHub Actions workflow runs a Python test suite.
const ciRunsPython = root => {
  const dir = path.join(root, '.github', 'workflows')
  if (!existsSync(dir)) return false
  for (const name of readdirSync(dir).filter(one => /\.ya?ml$/i.test(one))) {
    const text = readFileSync(path.join(dir, name), 'utf8')
    const steps = text.split(/\r?\n/).filter(line => !/^\s*(?:#|(?:-\s*)?name\s*:)/.test(line)).join('\n')
    if (PYTHON_CI_STEP.test(steps)) return true
  }
  return false
}

const languageModes = (root, config) => {
  const modes = { js: 'blocking', go: 'blocking', python: ciRunsPython(root) ? 'blocking' : 'warning', shell: 'blocking' }
  const raw = config.lint?.lenguajes
  if (raw === undefined) return modes
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`lint.lenguajes tiene que ser un objeto {lenguaje: "blocking" | "warning"}, no ${JSON.stringify(raw)} ${LAYERS}.`)
  }
  for (const [lang, mode] of Object.entries(raw)) {
    if (!VALID_LANGUAGES.has(lang)) {
      throw new Error(`lint.lenguajes no conoce el lenguaje ${JSON.stringify(lang)} (válidos: ${[...VALID_LANGUAGES].join(', ')}) ${LAYERS}.`)
    }
    if (!VALID_MODES.has(mode)) {
      throw new Error(`lint.lenguajes.${lang} tiene que ser "blocking" o "warning", no ${JSON.stringify(mode)} ${LAYERS}.`)
    }
    modes[lang] = mode
  }
  return modes
}

const entryLanguage = (entry, files) => {
  if (entry.rule === 'long-file' || entry.rule === 'wide-directory') return undefined
  const direct = languageOf(entry.file)
  if (direct) return direct
  if (Array.isArray(entry.members) && entry.members.length > 0) {
    const first = entry.members[0].split(':')[0]
    const fromMember = languageOf(first)
    if (fromMember) return fromMember
  }
  const prefix = entry.file === '.' || entry.file === './' ? '' : `${entry.file.replace(/\/$/, '')}/`
  const under = files.filter(file => (prefix === '' ? !file.includes('/') : file.startsWith(prefix)))
  if (under.some(file => file === `${prefix}__init__.py`)) return 'python'
  if (under.some(file => /^index\.(?:[cm]?[jt]s|[jt]sx)$/.test(file.slice(prefix.length)))) return 'js'
  const sample = under.find(file => languageOf(file) !== undefined)
  return sample ? languageOf(sample) : undefined
}

const layerJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

// #424: loadConfig merges the layers in this order, so the last one that sets lint.enabled is where it is set.
const enabledSource = (home, root) => [
  [layout(home).config, '~/.orca-stack/config.json'],
  [path.join(root, PROJECT_CONFIG), PROJECT_CONFIG],
  [path.join(root, PROJECT_LOCAL_CONFIG), PROJECT_LOCAL_CONFIG],
].filter(([file]) => layerJson(file)?.lint?.enabled !== undefined).at(-1)?.[1]

export const lintOff = (home, root) => `lint apagado: lint.enabled es false en ${enabledSource(home, root)}; no se revisó nada.`

const mergeBase = (root, base) => {
  if (typeof base !== 'string' || base === '') throw new Error(`${ALCANCE_KEY} "diff" necesita ramaBase en la configuración del repo.`)
  const ref = [base, `origin/${base}`].find(candidate => gitOut(root, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]) !== undefined)
  if (ref === undefined) throw new Error(`${ALCANCE_KEY} "diff": no se encontró la rama base ${base} ni origin/${base}; traéla con git fetch origin ${base}.`)
  const found = gitOut(root, ['merge-base', 'HEAD', ref])
  if (found === undefined) throw new Error(`${ALCANCE_KEY} "diff": HEAD no tiene merge-base con ${ref} (en un clon shallow, corré git fetch --unshallow).`)
  return found.trim()
}

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

// #419: git ends a path with a space with a TAB and C-quotes unusual names (octal escapes are UTF-8 bytes).
const diffPath = raw => {
  const text = raw.replace(/\r$/, '').replace(/\t$/, '')
  if (!text.startsWith('"')) return text.startsWith('b/') ? text.slice(2) : undefined
  const bytes = []
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i]
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'))
      continue
    }
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1))
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      i += 3
    } else {
      bytes.push(C_ESCAPES[text[i + 1]] ?? text.charCodeAt(i + 1))
      i++
    }
  }
  const unquoted = Buffer.from(bytes).toString('utf8')
  return unquoted.startsWith('b/') ? unquoted.slice(2) : undefined
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
      const file = diffPath(line.slice(4))
      lines = file === undefined ? undefined : new Set()
      if (lines) added.set(file, lines)
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

const inspect = (root, config, files) => {
  const diff = alcanceOf(config) === 'diff'
  const added = diff ? addedLines(root, config.ramaBase) : undefined
  const comments = commentViolations(root, files)
  const sources = files.filter(file => languageOf(file) !== undefined && readText(path.join(root, file)) !== undefined)
  const design = designChecks(root, sources)
  const violations = [...longFiles(root, files), ...wideDirectories(files), ...comments, ...design.violations]
  const cycles = moduleCycles(root, sources)
  // #419: diff mode matches every violation, so old ones keep their entries, and then reports only comments on added lines.
  const inScope = diff ? (violation => !isCommentRule(violation.rule) || onAddedLine(added)(violation)) : () => true
  // #419: out-of-scope violations match first, so a new identical comment never takes an old one's entry; the report keeps violation order.
  const ordered = [...violations.filter(violation => !inScope(violation)), ...violations.filter(inScope)]
  // #420, #421: module-cycle and tangle entries match by member set, apart from the one-to-one match of the other rules.
  const matchInScope = entries => {
    const { unmatched, stale } = match(ordered, entries.filter(entry => !isMemberEntry(entry)))
    const left = new Set(unmatched)
    const cycleMatch = matchCycles(cycles, entries.filter(isCycleEntry))
    const tangleMatch = matchCycles({ cycles: design.tangles, selfImports: new Set() }, entries.filter(isTangleEntry))
    return {
      unmatched: violations.filter(violation => left.has(violation) && inScope(violation)),
      stale,
      cycles: [...cycleMatch.unmatched, ...tangleMatch.unmatched],
      staleCycles: [...cycleMatch.stale, ...tangleMatch.stale],
    }
  }
  return { diff, matchInScope }
}

const sembrar = (root, entries, matchInScope) => {
  const { unmatched, cycles: newCycles } = matchInScope(entries)
  if (unmatched.length === 0 && newCycles.length === 0 && existsSync(path.join(root, BASELINE_FILE))) return { entries, added: undefined }
  const added = [...unmatched.map(({ rule, file, location, fingerprint: print }) => ({ rule, file, location, fingerprint: print })), ...newCycles.map(cycleEntry)]
  const next = [...entries, ...added].sort(byKey)
  writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify({ version: 1, entries: next }, null, 2)}\n`)
  return { entries: next, added: added.length }
}

// #424: init seeds the Baseline of a repo it wires over the tracked files plus the ones it wrote and the Baseline
// itself, so the lint passes once the human commits init's output.
export const seedBaseline = (cwd, { home = homeDir(), extraFiles = [] } = {}) => {
  const root = repoRoot(cwd)
  const config = loadConfig(home, root)
  if (!lintEnabled(config)) return { disabled: true }
  const matchers = excludedMatchers(config)
  const candidates = [...new Set([...extraFiles, BASELINE_FILE])]
  const ignored = new Set(nulList(spawnSync('git', ['check-ignore', '--no-index', '-z', '--', ...candidates], { cwd: root, encoding: 'utf8' }).stdout ?? ''))
  const files = filterExcluded([...new Set([...checkedFiles(root), ...candidates.filter(file => !ignored.has(file))])].sort(), matchers)
  const { matchInScope } = inspect(root, config, files)
  return sembrar(root, readBaseline(root), matchInScope)
}

export const lintCommand = async (flags, { cwd = process.cwd(), home = homeDir() } = {}) => {
  if (flags.dryRun) throw new Error('lint no acepta --dry-run: sin --sembrar no escribe nada, y --sembrar existe para escribir la Baseline.')
  const root = repoRoot(cwd)
  const config = loadConfig(home, root)
  if (!lintEnabled(config)) {
    console.log(lintOff(home, root))
    return 0
  }
  const matchers = excludedMatchers(config)
  const modes = languageModes(root, config)
  const files = filterExcluded(checkedFiles(root), matchers)
  let entries = readBaseline(root)
  const { diff, matchInScope } = inspect(root, config, files)

  if (flags.sembrar) {
    const seeded = sembrar(root, entries, matchInScope)
    entries = seeded.entries
    console.log(seeded.added === undefined ? `Baseline: sin cambios (${BASELINE_FILE})` : `Baseline: ${plural(seeded.added, 'entrada nueva', 'entradas nuevas')} en ${BASELINE_FILE}`)
  }

  const { unmatched, stale: expired, cycles: newCycles, staleCycles } = matchInScope(entries)
  const allStale = [...(diff ? expired.filter(entry => !isCommentRule(entry.rule)) : expired), ...staleCycles]
  const isWarning = lang => lang !== undefined && modes[lang] === 'warning'
  const blocking = unmatched.filter(item => !isWarning(item.lang))
  const warnViolations = unmatched.filter(item => isWarning(item.lang))
  const blockingCycles = newCycles.filter(item => !isWarning(item.lang))
  const warnCycles = newCycles.filter(item => isWarning(item.lang))
  const stale = allStale.filter(entry => !isWarning(entryLanguage(entry, files)))
  const warnStale = allStale.filter(entry => isWarning(entryLanguage(entry, files)))

  const formatViolation = violation => (isCommentRule(violation.rule) ? reportComment(violation) : REPORT[violation.rule](violation))
  const formatCycle = cycle => (cycle.rule === TANGLE_RULE ? reportTangle(cycle) : reportCycle(cycle))
  const formatStale = entry => `entrada vencida en ${BASELINE_FILE}: ${entry.rule} ${entry.file} (${entry.location}, ${entry.fingerprint}) — la violación ya no está en el repo: sacá esta entrada`

  for (const violation of blocking) console.log(formatViolation(violation))
  for (const cycle of blockingCycles) console.log(formatCycle(cycle))
  for (const entry of stale) console.log(formatStale(entry))
  for (const violation of warnViolations) console.log(`warning: ${formatViolation(violation)}`)
  for (const cycle of warnCycles) console.log(`warning: ${formatCycle(cycle)}`)
  for (const entry of warnStale) console.log(`warning: ${formatStale(entry)}`)

  const totalWarnings = warnViolations.length + warnCycles.length + warnStale.length
  if (blocking.length === 0 && blockingCycles.length === 0 && stale.length === 0) {
    const suffix = totalWarnings === 0 ? '' : `, ${plural(totalWarnings, 'aviso', 'avisos')}`
    console.log(`lint OK: ninguna violación nueva ni entrada vencida (${entries.length} en la Baseline${suffix})`)
    return 0
  }
  console.log(`✖ lint: ${plural(blocking.length + blockingCycles.length, 'violación nueva', 'violaciones nuevas')}, ${plural(stale.length, 'entrada vencida', 'entradas vencidas')}`)
  return 1
}
