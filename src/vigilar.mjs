import { renameSync } from 'node:fs'
import path from 'node:path'

import { repoWorktrees } from './avisar.mjs'
import { consultasCommand, getCommonDir } from './consultas.mjs'
import { defaultIo } from './despacho.mjs'

export const CURSOR_REL = ['orca-stack', 'vigilar.json']
export const MERGES_REL = ['orca-stack', 'vigilar-merges.json']

const USAGE = 'Uso: orca-stack vigilar <n...> [--cada <segundos>] [--una-vez] [--dry-run] [--consultas], o orca-stack vigilar --merge-de-main <pr>.'
const PR_FIELDS = 'number,state,headRefName,headRefOid,body,closingIssuesReferences,statusCheckRollup'
// A record by --merge-de-main covers a merge of its head commit seen within this window.
const MERGE_WINDOW_MS = 30 * 60 * 1000
// Polls in a row that failed to read GitHub before the watcher says it is blind (once per outage).
const BLIND_AFTER = 3
const DETAIL_MAX = 200
const CHECK_GREEN = ['SUCCESS', 'SKIPPED', 'NEUTRAL']
const CHECK_RED = ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED']
const STATUS_RED = ['FAILURE', 'ERROR']

// stdout carries events only (it runs under the Monitor tool); every diagnostic goes to stderr.
const vigilarIo = () => ({ ...defaultIo(), err: message => console.error(message), rename: renameSync, now: Date.now })

const parse = res => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    return undefined
  }
}
const detail = res => (res.stderr || res.stdout || String(res.error ?? '')).trim().split(/\r?\n/)[0]

class Blind extends Error {}

const ghJson = (io, root, args) => {
  const res = io.sh('gh', args, { cwd: root })
  const what = `gh ${args.slice(0, 2).join(' ')}`
  if (res.status !== 0) throw new Blind(`${what} falló (${detail(res)})`)
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Blind(`${what} no devolvió JSON`)
  }
}

const readJson = (file, io, warn) => {
  if (!io.exists(file)) return {}
  try {
    const value = JSON.parse(io.readFile(file))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {}
  warn(`vigilar: ${file} no es un JSON válido; lo leo vacío.`)

  return {}
}

// Written to a temporary file in the same folder and renamed, so a reader never sees half a file.
const writeJson = (file, value, io) => {
  io.mkdirp(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  io.writeFile(temp, JSON.stringify(value, null, 2) + '\n')
  io.rename(temp, file)
}

const event = (name, issue, pr, sha, text) =>
  `${name} #${issue}${pr ? ` PR #${pr.number}` : ''}${sha ? ` ${sha.slice(0, 7)}` : ''}${text ? `: ${text.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX)}` : ''}`

const isStatus = check => check.__typename === 'StatusContext'
const checkName = check => (isStatus(check) ? check.context : check.name)
const outcome = check => (isStatus(check) ? check.state : check.conclusion)
const verdict = check => {
  if (isStatus(check)) return check.state === 'SUCCESS' ? 'verde' : STATUS_RED.includes(check.state) ? 'roja' : undefined
  if (check.status !== 'COMPLETED') return undefined

  return CHECK_GREEN.includes(check.conclusion) ? 'verde' : CHECK_RED.includes(check.conclusion) ? 'roja' : undefined
}

// Two runs on one head commit (a re-run, or a body edit that re-runs CI, #197) list the same check twice: only the
// latest by startedAt counts.
const latestChecks = rollup => {
  const latest = new Map()
  for (const check of rollup ?? []) {
    const key = isStatus(check) ? `status:${check.context}` : `check:${check.workflowName ?? ''}/${check.name}`
    const seen = latest.get(key)
    if (!seen || String(check.startedAt ?? '') > String(seen.startedAt ?? '')) latest.set(key, check)
  }

  return [...latest.values()]
}

// Red as soon as a finished check failed; green once every check finished green; otherwise pending (no event).
const ciResult = rollup => {
  const checks = latestChecks(rollup)
  const red = checks.filter(check => verdict(check) === 'roja')
  if (red.length > 0) return { result: 'roja', text: red.map(check => `${checkName(check)}=${outcome(check)}`).join(', ') }

  return checks.length > 0 && checks.every(check => verdict(check) === 'verde') ? { result: 'verde' } : undefined
}

// A PR is the item's by its closing reference, the branch of this repo's worktree linked to the issue, or a
// `Closes #<n>` line in its body; never by guessing a branch name.
const linked = (pr, issue, branches) =>
  (pr.closingIssuesReferences ?? []).some(ref => String(ref.number) === issue) ||
  branches.includes(pr.headRefName) ||
  new RegExp(`^\\s*Closes\\s+#${issue}\\b`, 'im').test(pr.body ?? '')

// Everything GitHub says about the items, read before anything is printed: a failed read fails the whole poll.
const readWorld = (targets, cursor, root, io, warn) => {
  const prs = new Map(ghJson(io, root, ['pr', 'list', '--state', 'all', '--limit', '100', '--json', PR_FIELDS]).map(pr => [pr.number, pr]))
  // A PR the cursor follows is followed until it ends, even past the list's --limit.
  for (const issue of targets) {
    const known = cursor[issue]?.pr
    if (known && !prs.has(known)) prs.set(known, ghJson(io, root, ['pr', 'view', String(known), '--json', PR_FIELDS]))
  }
  let ours = []
  try {
    ours = repoWorktrees(root, io)
  } catch (error) {
    warn(`vigilar: esta vuelta no enlaza PRs por worktree: ${error.message}`)
  }

  return Object.fromEntries(targets.map(issue => {
    const branches = ours.filter(({ row }) => String(row.linkedIssue) === issue).map(({ branch }) => branch).filter(Boolean)
    const mine = [...prs.values()].filter(pr => pr.number === cursor[issue]?.pr || linked(pr, issue, branches))
    const pr = mine.sort((a, b) => b.number - a.number)[0]
    if (pr) return [issue, { pr }]

    return [issue, { issueState: ghJson(io, root, ['issue', 'view', issue, '--json', 'state']).state }]
  }))
}

// One item's events and its next cursor entry: the PR, its last head commit, the last CI result emitted for that head
// commit, and how the item ended.
const advance = (issue, seen, before, merges, now) => {
  if (!seen.pr) return { lines: [], entry: seen.issueState === 'CLOSED' ? { fin: 'issue-cerrado' } : {} }
  const { pr } = seen
  const fresh = before?.pr !== pr.number
  const entry = fresh ? { pr: pr.number } : { ...before }
  const lines = []
  if (pr.state === 'OPEN') {
    delete entry.fin
    if (fresh) lines.push(event('pr-abierto', issue, pr, pr.headRefOid))
    if (entry.head !== pr.headRefOid) {
      entry.head = pr.headRefOid
      delete entry.ci
    }
    const ci = ciResult(pr.statusCheckRollup)
    if (ci && ci.result !== entry.ci) {
      lines.push(event(`ci-${ci.result}`, issue, pr, pr.headRefOid, ci.text))
      entry.ci = ci.result
    }
  } else if (!entry.fin) {
    entry.head = pr.headRefOid
    // A merge main recorded for this head commit gives no event; the cursor marks the item ended by main, so the record
    // is never used again. Anything else, a merge by the human included, is pr-mergeado.
    const record = merges[pr.number]
    if (pr.state === 'MERGED' && record?.head === pr.headRefOid && now - Date.parse(record.at) <= MERGE_WINDOW_MS) {
      entry.fin = 'main'
    } else if (pr.state === 'MERGED') {
      lines.push(event('pr-mergeado', issue, pr, pr.headRefOid))
      entry.fin = 'mergeado'
    } else {
      lines.push(event('pr-cerrado', issue, pr))
      entry.fin = 'cerrado'
    }
  }

  return { lines, entry }
}

// All sessions share one gh account, so a merge by main looks like the human's on GitHub: main records its own merge right
// before each `gh pr merge` attempt. Only this writes vigilar-merges.json; the watcher only reads it.
const recordMainMerge = (pr, flags, io, warn) => {
  if (!/^\d+$/.test(String(pr))) throw new Error(`Uso: orca-stack vigilar --merge-de-main <pr>, con el número del PR que main está por mergear: ${pr || '(vacío)'}`)
  const n = String(Number(pr))
  const { commonDir, root } = getCommonDir(io)
  const res = io.sh('gh', ['pr', 'view', n, '--json', 'headRefOid'], { cwd: root })
  const head = res.status === 0 ? parse(res)?.headRefOid : undefined
  if (!head) throw new Error(`No pude leer el head del PR #${n} con gh pr view: ${detail(res)}. No registré nada.`)
  const file = path.join(commonDir, ...MERGES_REL)
  const now = (io.now ?? Date.now)()
  const kept = Object.entries(readJson(file, io, warn)).filter(([key, record]) => key !== n && now - Date.parse(record?.at) <= MERGE_WINDOW_MS)
  const records = { ...Object.fromEntries(kept), [n]: { head, at: new Date(now).toISOString() } }
  if (flags.dryRun) {
    warn(`[simulación] registraría el merge de main del PR #${n} en ${head.slice(0, 7)} (${file}).`)

    return 0
  }
  writeJson(file, records, io)
  warn(`Merge de main registrado: PR #${n} en ${head.slice(0, 7)}.`)

  return 0
}

export const vigilarCommand = async (flags = {}, items = [], io = vigilarIo()) => {
  const warn = io.err ?? (message => console.error(message))
  if (flags.mergeDeMain !== undefined) return recordMainMerge(flags.mergeDeMain, flags, io, warn)
  const raw = (items ?? []).map(item => String(item).trim().replace(/^#/, ''))
  if (raw.length === 0 || raw.some(item => !/^\d+$/.test(item))) throw new Error(USAGE)
  const targets = [...new Set(raw.map(item => String(Number(item))))]
  const every = flags.cada === undefined ? 60 : Number(flags.cada)
  if (!Number.isInteger(every) || every < 1) throw new Error(`--cada necesita un número entero de segundos, 1 o más: ${flags.cada}`)

  const { commonDir, root } = getCommonDir(io)
  const cursorPath = path.join(commonDir, ...CURSOR_REL)
  const mergesPath = path.join(commonDir, ...MERGES_REL)
  let failures = 0

  // Returns true when every item has ended.
  const poll = () => {
    const cursor = readJson(cursorPath, io, warn)
    let world
    try {
      world = readWorld(targets, cursor, root, io, warn)
    } catch (error) {
      if (!(error instanceof Blind)) throw error
      failures += 1
      warn(`vigilar: no pude leer GitHub (${failures} ${failures === 1 ? 'vez' : 'veces'} seguidas): ${error.message}`)
      if (failures === BLIND_AFTER) io.out(`vigilar-ciego: ${error.message}`)

      return false
    }
    failures = 0
    const merges = readJson(mergesPath, io, warn)
    const now = (io.now ?? Date.now)()
    const next = { ...cursor }
    const lines = []
    let endedNow = false
    for (const issue of targets) {
      const step = advance(issue, world[issue], cursor[issue], merges, now)
      lines.push(...step.lines)
      if (step.entry.fin && !cursor[issue]?.fin) endedNow = true
      next[issue] = step.entry
    }
    const allEnded = targets.every(issue => next[issue].fin)
    if (allEnded && endedNow) lines.push(`tanda-cerrada ${targets.map(issue => `#${issue}`).join(' ')}`)
    // Printed before the cursor is written: a crash re-emits at most one poll's lines rather than losing them.
    for (const line of lines) io.out(line)
    if (!flags.dryRun && JSON.stringify(next) !== JSON.stringify(cursor)) writeJson(cursorPath, next, io)
    if (allEnded && !endedNow) warn(`vigilar: ${targets.map(issue => `#${issue}`).join(' ')} ya habían terminado; no queda nada que vigilar.`)

    return allEnded
  }

  for (;;) {
    const done = poll()
    // One Monitor in Proactive: the consultas check runs on every poll, unchanged, and its failure never stops the poll.
    if (flags.consultas) {
      try {
        await consultasCommand({ dryRun: flags.dryRun }, targets, io)
      } catch (error) {
        warn(`vigilar: el chequeo de consultas falló: ${error.message}`)
      }
    }
    if (done || flags.unaVez || flags.dryRun) return 0
    await io.sleep(every * 1000)
  }
}
