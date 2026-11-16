import path from 'node:path'

import { globToRegExp } from './estado.mjs'
import { closedIssues } from './vigilar.mjs'

// main-autonomo-2 S2: migration numbers reserved at dispatch, so parallel tickets never pick the same one and merge in
// the order they were reserved (goose rejects by merge order). The registry lives in the git common dir, shared by every
// worktree of the repo: `{ "reservas": { "<issue>": { "numero": 13, "texto": "00013", "at": "<iso>" } } }`.
export const REGISTRY_REL = ['orca-stack', 'migraciones.json']
export const registryPath = commonDir => path.join(commonDir, ...REGISTRY_REL)

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const detail = res => (res.stderr || res.stdout || String(res.error ?? '')).trim().split(/\r?\n/)[0]
const parse = res => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    return undefined
  }
}

// The `migraciones` config ({ glob, numero }), or undefined when it is absent or not that shape. A bad regex throws.
export const migrationSpec = config => {
  const spec = config?.migraciones
  if (!isPlain(spec) || typeof spec.glob !== 'string' || typeof spec.numero !== 'string') return undefined
  let numero
  try {
    numero = new RegExp(spec.numero)
  } catch {
    throw new Error(`migraciones.numero no es una expresión regular válida: ${spec.numero}`)
  }

  return { glob: spec.glob, pattern: globToRegExp(spec.glob), numero }
}

// The raw number of a migration file (its basename through `migraciones.numero`), or undefined.
export const rawNumberOf = (spec, file) => {
  const raw = spec.numero.exec(path.posix.basename(file))?.[1]

  return raw !== undefined && /^\d+$/.test(raw) ? raw : undefined
}

// The folder a migrations glob lists, up to its first wildcard segment.
export const globDir = glob => {
  const fixed = []
  for (const segment of glob.split('/')) {
    if (/[*?[]/.test(segment)) break
    fixed.push(segment)
  }

  return fixed.join('/') || '.'
}

// The migration files on origin/<base> (`git ls-tree`), or { error } with git's first line.
export const baseMigrations = (spec, base, root, io) => {
  const listed = io.sh('git', ['ls-tree', '-r', '--name-only', `origin/${base}`, '--', globDir(spec.glob)], { cwd: root })
  if (listed.status !== 0) return { error: detail(listed) }

  return { files: listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(file => file && spec.pattern.test(file)) }
}

// The registry, or { error } when it exists and is not a registry (never silently reset: it would hand out a number twice).
export const readRegistry = (file, io) => {
  if (!io.exists(file)) return { reservas: {} }
  try {
    const raw = JSON.parse(io.readFile(file))
    if (isPlain(raw) && isPlain(raw.reservas)) return { reservas: { ...raw.reservas } }
  } catch {}

  return { error: `no pude leer el registro de migraciones ${file}` }
}

// Written to a temporary file in the same folder and renamed, so a reader never sees half a file.
const writeRegistry = (file, registry, io) => {
  const temp = `${file}.${process.pid}.tmp`
  io.mkdirp(path.dirname(file))
  io.writeFile(temp, `${JSON.stringify({ reservas: registry.reservas }, null, 2)}\n`)
  io.rename(temp, file)
}

// Drops every reservation whose issue is closed, or whose PRs (a closing keyword for the issue in the body) are all
// merged or closed. A gh call that fails keeps the reservation: an unknown state never frees a number. Returns whether
// something was released.
const release = (registry, root, io) => {
  const issues = Object.keys(registry.reservas)
  if (issues.length === 0) return false
  let changed = false
  let prs
  const listPrs = () => {
    if (prs === undefined) {
      const res = io.sh('gh', ['pr', 'list', '--state', 'all', '--json', 'number,state,body', '--limit', '200'], { cwd: root })
      const listed = res.status === 0 ? parse(res) : undefined
      prs = Array.isArray(listed) ? listed : null
    }

    return prs
  }
  for (const issue of issues) {
    const res = io.sh('gh', ['issue', 'view', issue, '--json', 'state'], { cwd: root })
    const state = res.status === 0 ? String(parse(res)?.state ?? '').toUpperCase() : ''
    let gone = state === 'CLOSED'
    if (!gone && state === 'OPEN') {
      const linked = (listPrs() ?? []).filter(pr => closedIssues(pr?.body).includes(issue))
      gone = linked.length > 0 && linked.every(pr => ['MERGED', 'CLOSED'].includes(String(pr.state).toUpperCase()))
    }
    if (gone) {
      delete registry.reservas[issue]
      changed = true
    }
  }

  return changed
}

// The reservations still open, after releasing the finished ones (persisted unless dryRun), or { error }.
export const openReservations = ({ commonDir, root, io, dryRun = false }) => {
  const file = registryPath(commonDir)
  const registry = readRegistry(file, io)
  if (registry.error) return registry
  if (release(registry, root, io) && !dryRun) writeRegistry(file, registry, io)

  return { reservas: registry.reservas }
}

const isReservation = one => isPlain(one) && Number.isInteger(one.numero)

// The number reserved for `issue`: the one it already holds, or max(highest on origin/<base>, highest open reservation)
// + 1, padded to the width of the base files. dryRun computes it and writes nothing.
export const reserve = ({ issue, config, base, commonDir, root, io, dryRun = false }) => {
  const spec = migrationSpec(config)
  if (spec === undefined) return undefined
  const file = registryPath(commonDir)
  const registry = readRegistry(file, io)
  if (registry.error) throw new Error(`No reservo número de migración: ${registry.error}. Arreglalo o borralo a mano.`)
  const released = release(registry, root, io)
  const key = String(issue)
  const held = registry.reservas[key]
  if (isReservation(held)) {
    if (released && !dryRun) writeRegistry(file, registry, io)

    return { numero: held.numero, texto: typeof held.texto === 'string' ? held.texto : String(held.numero), reused: true }
  }
  const listed = baseMigrations(spec, base, root, io)
  if (listed.error !== undefined) throw new Error(`No pude leer las migraciones de origin/${base} para reservar un número: ${listed.error}`)
  const raws = listed.files.map(one => rawNumberOf(spec, one)).filter(raw => raw !== undefined)
  const width = Math.max(0, ...raws.map(raw => raw.length))
  const reserved = Object.values(registry.reservas).filter(isReservation).map(one => one.numero)
  const numero = Math.max(0, ...raws.map(Number), ...reserved) + 1
  const texto = String(numero).padStart(width, '0')
  if (!dryRun) {
    registry.reservas[key] = { numero, texto, at: new Date((io.now ?? Date.now)()).toISOString() }
    writeRegistry(file, registry, io)
  }

  return { numero, texto, reused: false }
}

// estado: why this PR waits for another one before merging. `mine` is this PR's lowest added migration ({ file, numero });
// `others` are the other open PRs ({ number, body, added: [numbers] }); reservations of other issues count too.
export const orderBlockers = ({ mine, selfIssue, selfPr, others, reservas }) => {
  const blockers = new Map()
  const hold = (key, pr, numero) => {
    const current = blockers.get(key)
    if (current === undefined || numero < current.numero) blockers.set(key, { pr, numero })
  }
  const prOfIssue = new Map()
  for (const pr of others) {
    if (pr.number === selfPr) continue
    const issue = closedIssues(pr.body)[0]
    if (issue !== undefined && !prOfIssue.has(issue)) prOfIssue.set(issue, pr.number)
    if (pr.added.length > 0) hold(issue ?? `pr-${pr.number}`, pr.number, Math.min(...pr.added))
  }
  for (const [issue, one] of Object.entries(reservas)) {
    if (issue === selfIssue || !isReservation(one)) continue
    hold(issue, prOfIssue.get(issue) ?? Number(issue), one.numero)
  }

  return [...blockers.values()]
    .filter(one => one.numero < mine.numero)
    .sort((a, b) => a.numero - b.numero || a.pr - b.pr)
    .map(one => `migración ${mine.file} (${mine.numero}): esperá el merge de #${one.pr} (migración ${one.numero} reservada antes)`)
}
