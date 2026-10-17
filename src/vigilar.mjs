import { renameSync } from 'node:fs'
import path from 'node:path'

import { repoWorktrees } from './avisar.mjs'
import { analyzeChecks, checkRunId, isHigherRunId, isStatus, latestChecks } from './checks.mjs'
import { consultasCommand, getCommonDir } from './consultas.mjs'
import { defaultIo } from './despacho.mjs'

export const CURSOR_REL = ['orca-stack', 'vigilar.json']
export const MERGES_REL = ['orca-stack', 'vigilar-merges.json']

const USAGE = 'Uso: orca-stack vigilar <n...> [--cada <segundos>] [--una-vez] [--dry-run] [--consultas], o orca-stack vigilar --merge-de-main <pr>.'
const PR_FIELDS = 'number,state,headRefName,headRefOid,mergedAt,body,closingIssuesReferences,statusCheckRollup,mergeable'
// A record by --merge-de-main covers a merge of its head commit made within this window after the record.
const MERGE_WINDOW_MS = 30 * 60 * 1000
// Polls in a row that failed to read GitHub before the watcher says it is blind (once per outage).
const BLIND_AFTER = 3
const DETAIL_MAX = 200
const CHECK_GREEN = ['SUCCESS', 'SKIPPED', 'NEUTRAL']
const CHECK_RED = ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED']
const STATUS_RED = ['FAILURE', 'ERROR']
const LIVE_WORKER_STATES = new Set(['working', 'running', 'active', 'blocked', 'waiting'])

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

const checkName = check => (isStatus(check) ? check.context : check.name)
const outcome = check => (isStatus(check) ? check.state : check.conclusion)
const verdict = check => {
  if (isStatus(check)) return check.state === 'SUCCESS' ? 'verde' : STATUS_RED.includes(check.state) ? 'roja' : undefined
  if (check.status !== 'COMPLETED') return undefined

  return CHECK_GREEN.includes(check.conclusion) ? 'verde' : CHECK_RED.includes(check.conclusion) ? 'roja' : undefined
}

// Red as soon as a finished check failed; green once every check finished green; otherwise pending (no event). A red
// result carries its run: the most rows any failing check has. A re-run adds a row to each check it runs, so a red re-run
// has a higher run; ci-ok (needs: the matrix) gets its row later in the same run, so startedAt alone would count one run
// twice.
const ciResult = (rollup, replacedWorkflows = []) => {
  const latest = latestChecks(rollup)
  const replaced = new Set(replacedWorkflows)
  const { realFailures, unexplainedCancellations, standaloneCancelled } = analyzeChecks(latest)

  const activeCancellations = unexplainedCancellations.filter(c => c.workflow && c.runId && !replaced.has(c.workflow))
  const canceledRuns = new Set(activeCancellations.map(c => `${c.workflow}/${c.runId}`))
  const cancellations = activeCancellations.map(c => ({ runId: c.runId, checks: c.checks }))

  const checks = latest.map(({ check, runId }) => {
    if (replaced.has(check.workflowName ?? '')) return { ...check, status: 'IN_PROGRESS', conclusion: '' }
    if (runId && canceledRuns.has(`${check.workflowName ?? ''}/${runId}`) && !isStatus(check)) return { ...check, status: 'IN_PROGRESS', conclusion: '' }
    return check
  })
  const candidates = [...realFailures, ...standaloneCancelled]
  const red = candidates.filter(({ check, runId }) =>
    !replaced.has(check.workflowName ?? '') &&
    !(runId && canceledRuns.has(`${check.workflowName ?? ''}/${runId}`)),
  )
  if (red.length > 0) {
    const text = red.map(({ check }) => `${checkName(check)}=${outcome(check)}`).join(', ')
    const redRunIds = red.map(({ runId }) => runId).filter(Boolean)
    const runId = redRunIds.reduce((highest, current) => (!highest || isHigherRunId(current, highest) ? current : highest), undefined)

    return { result: 'roja', text, run: Math.max(...red.map(({ runs }) => runs ?? 1)), runId, cancellations }
  }

  return { result: cancellations.length === 0 && checks.length > 0 && checks.every(check => verdict(check) === 'verde') ? 'verde' : undefined, cancellations }
}

const replacedRuns = (pr, root, io) => {
  const cancelled = latestChecks(pr.statusCheckRollup).filter(({ check, runId }) => !isStatus(check) && runId && check.workflowName && check.conclusion === 'CANCELLED')
  const replaced = new Set()
  const checkedWorkflows = new Set()
  for (const { check, runId } of cancelled) {
    const workflow = check.workflowName ?? ''
    if (checkedWorkflows.has(workflow)) continue
    checkedWorkflows.add(workflow)
    const runs = ghJson(io, root, ['run', 'list', '--commit', pr.headRefOid, '--workflow', workflow, '--json', 'databaseId,status,conclusion'])
    if (!Array.isArray(runs)) throw new Blind('gh run list no devolvió una lista de corridas')
    if (runs.some(run => isHigherRunId(run.databaseId, runId))) replaced.add(workflow)
  }

  return [...replaced]
}

// A PR is the item's by its closing reference, the branch of this repo's worktree linked to the issue, or a
// `Closes #<n>` line in its body; never by guessing a branch name.
const linked = (pr, issue, branches) =>
  (pr.closingIssuesReferences ?? []).some(ref => String(ref.number) === issue) ||
  branches.includes(pr.headRefName) ||
  new RegExp(`^\\s*Closes\\s+#${issue}\\b`, 'im').test(pr.body ?? '')

// Everything GitHub says about the items, read before anything is printed: a failed PR read fails the whole poll. An
// issue gh cannot read (a mistyped number) only stays open, so it never blinds the rest of the batch.
const readWorld = (targets, cursor, root, io, warn) => {
  const prs = new Map(ghJson(io, root, ['pr', 'list', '--state', 'all', '--limit', '100', '--json', PR_FIELDS]).map(pr => [pr.number, pr]))
  // A PR the cursor follows is followed until it ends, even past the list's --limit.
  for (const issue of targets) {
    const known = cursor[issue]?.pr
    if (known && !prs.has(known)) prs.set(known, ghJson(io, root, ['pr', 'view', String(known), '--json', PR_FIELDS]))
  }
  let ours = []
  let workersReadable = true
  try {
    ours = repoWorktrees(root, io)
  } catch (error) {
    workersReadable = false
    warn(`vigilar: esta vuelta no enlaza PRs por worktree: ${error.message}`)
  }

  return Object.fromEntries(targets.map(issue => {
    const branches = ours.filter(({ row }) => String(row.linkedIssue) === issue).map(({ branch }) => branch).filter(Boolean)
    const mine = [...prs.values()].filter(pr => pr.number === cursor[issue]?.pr || linked(pr, issue, branches))
    const pr = mine.sort((a, b) => b.number - a.number)[0]
    if (pr) {
      let worker
      if (workersReadable) {
        const linked = ours.filter(({ row }) => String(row.linkedIssue) === issue)
        const candidates = linked.length > 0 ? linked : ours.filter(({ branch }) => branch === pr.headRefName)
        if (candidates.length > 1) warn(`vigilar: hay ${candidates.length} worktrees para el worker de #${issue}; no adivino cuál.`)
        const agents = candidates.length === 1 ? candidates[0].row.agents ?? [] : []
        const agent = agents.length === 1 ? agents[0] : undefined
        const identity = String(agent?.agentType ?? '').trim().toLowerCase()
        const state = identity && identity !== 'pi' ? String(agent?.state ?? '').trim().toLowerCase() : ''
        if (state) worker = { state, agent: identity }
      }

      return [issue, { pr, workersReadable, worker: worker ?? null, replacedWorkflows: replacedRuns(pr, root, io) }]
    }

    const res = io.sh('gh', ['issue', 'view', issue, '--json', 'state'], { cwd: root })
    const issueState = res.status === 0 ? parse(res)?.state : undefined
    if (!issueState) warn(`vigilar: no pude leer el estado de #${issue} (${detail(res)}); lo sigo vigilando.`)

    const worktrees = ours.filter(({ row }) => String(row.linkedIssue) === issue)
    const agents = worktrees.length === 1 ? worktrees[0].row.agents ?? [] : []
    const agent = agents.length === 1 ? agents[0] : undefined
    const identity = String(agent?.agentType ?? '').trim().toLowerCase()
    const workerState = identity && identity !== 'pi' ? String(agent?.state ?? '').trim().toLowerCase() : ''

    return [issue, { issueState, workersReadable, worker: workerState ? { state: workerState, agent: identity } : null }]
  }))
}

// One item's events and its next cursor entry: the PR, its last head commit, the last CI result emitted for that head
// commit (with the run of the last red one), and how the item ended.
const advance = (issue, seen, before, merges) => {
  if (!seen.pr) {
    const entry = seen.issueState === 'CLOSED' ? { fin: 'issue-cerrado' } : {}
    if (seen.workersReadable === false) {
      if (before?.worker) entry.worker = before.worker
    } else if (seen.issueState !== 'CLOSED' && seen.worker?.state === 'done') {
      entry.worker = seen.worker
      if (before?.worker?.state !== 'done') return { lines: [`worker-en-pausa #${issue} ${seen.worker.agent}`], entry }
    } else if (seen.worker) {
      entry.worker = seen.worker
    }

    return { lines: [], entry }
  }
  const { pr } = seen
  const fresh = before?.pr !== pr.number
  const entry = fresh ? { ...(before?.worker ? { worker: before.worker } : {}), pr: pr.number } : { ...before }
  if (seen.workersReadable !== false && seen.worker) entry.worker = seen.worker
  const lines = []
  if (pr.state === 'OPEN') {
    delete entry.fin
    if (fresh) lines.push(event('pr-abierto', issue, pr, pr.headRefOid))
    if (entry.head !== pr.headRefOid) {
      entry.head = pr.headRefOid
      delete entry.ci
      delete entry.corrida
      delete entry.corridaRun
      delete entry.ciRetenido
      delete entry.conflicto
    }
    // GitHub runs no pull_request workflow while the PR conflicts with its base, so no CI event would ever come: one
    // event per head, even with the worker live. UNKNOWN (still computing) is read again next poll and clears nothing.
    if (String(pr.mergeable ?? '').toUpperCase() === 'CONFLICTING' && entry.conflicto !== pr.headRefOid) {
      lines.push(event('pr-en-conflicto', issue, pr, pr.headRefOid))
      entry.conflicto = pr.headRefOid
    }
    const liveWorker = seen.workersReadable !== false && LIVE_WORKER_STATES.has(seen.worker?.state)
    const ci = ciResult(pr.statusCheckRollup, seen.replacedWorkflows)
    const cancelledRuns = new Set(Array.isArray(entry.cancelledRuns) ? entry.cancelledRuns : [])
    for (const cancellation of ci.cancellations) {
      const runId = cancellation.runId
      if (cancelledRuns.has(runId)) continue
      lines.push(event('ci-cancelada', issue, pr, pr.headRefOid, cancellation.checks.map(check => `${checkName(check)}=CANCELLED`).join(', ')))
      cancelledRuns.add(runId)
    }
    if (cancelledRuns.size > 0) entry.cancelledRuns = [...cancelledRuns]
    if (ci.result === 'roja' && (entry.ci !== 'roja' || (ci.runId && ci.runId !== entry.corridaRun) || ci.run > (entry.corrida ?? 0))) {
      lines.push(event('ci-roja', issue, pr, pr.headRefOid, ci.text))
      entry.ci = 'roja'
      entry.corrida = ci.run
      if (ci.runId) entry.corridaRun = ci.runId
      else delete entry.corridaRun
    } else if (ci.result === 'verde') {
      if (liveWorker) {
        if (entry.ciRetenido !== pr.headRefOid) {
          lines.push(event('ci-verde-retenido', issue, pr, pr.headRefOid, `${seen.worker.agent} ${seen.worker.state}`))
          entry.ciRetenido = pr.headRefOid
        }
        entry.ci = 'retenido'
      } else {
        if (entry.ci !== 'verde') lines.push(event('ci-verde', issue, pr, pr.headRefOid))
        entry.ci = 'verde'
        delete entry.ciRetenido
        delete entry.corrida
        delete entry.corridaRun
      }
    }
  } else if (!entry.fin) {
    entry.head = pr.headRefOid
    // A merge of the head commit main recorded, made after the record and within the window, gives no event, however
    // late the watcher sees it; the cursor marks the item ended by main, so the record is never used again. Anything
    // else, a merge by the human included, is pr-mergeado.
    const record = merges[pr.number]
    const sinceRecord = Date.parse(pr.mergedAt) - Date.parse(record?.at)
    if (pr.state === 'MERGED' && record?.head === pr.headRefOid && sinceRecord >= 0 && sinceRecord <= MERGE_WINDOW_MS) {
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
  const res = io.sh('gh', ['pr', 'view', n, '--json', 'headRefOid,state'], { cwd: root })
  const read = res.status === 0 ? parse(res) : undefined
  const head = read?.headRefOid
  if (!head) throw new Error(`No pude leer el head del PR #${n} con gh pr view: ${detail(res)}. No registré nada.`)
  // A PR that already ended has no merge of main's ahead of it: main learns it here instead of recording one.
  if (read.state === 'MERGED' || read.state === 'CLOSED') {
    warn(read.state === 'MERGED' ? `El PR #${n} ya está mergeado: no registré nada.` : `El PR #${n} está cerrado: no registré nada.`)

    return 1
  }
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
  let cursor = readJson(cursorPath, io, warn)
  let failures = 0

  // Returns true when every item has ended.
  const poll = () => {
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
    const next = { ...cursor }
    const lines = []
    let endedNow = false
    for (const issue of targets) {
      const step = advance(issue, world[issue], cursor[issue], merges)
      lines.push(...step.lines)
      if (step.entry.fin && !cursor[issue]?.fin) endedNow = true
      next[issue] = step.entry
    }
    const allEnded = targets.every(issue => next[issue].fin)
    if (allEnded && endedNow) lines.push(`tanda-cerrada ${targets.map(issue => `#${issue}`).join(' ')}`)
    // Printed before the cursor is written: a crash re-emits at most one poll's lines rather than losing them.
    for (const line of lines) io.out(line)
    if (!flags.dryRun && JSON.stringify(next) !== JSON.stringify(cursor)) {
      // A failed write never stops the watcher: this run keeps the cursor in memory and prints nothing twice. The file is
      // read again right before the write and only this watcher's items are replaced, so another watcher on the same
      // file keeps what it wrote since this one started.
      try {
        const mine = Object.fromEntries(targets.map(issue => [issue, next[issue]]))
        writeJson(cursorPath, { ...readJson(cursorPath, io, warn), ...mine }, io)
      } catch (error) {
        warn(`vigilar: no pude escribir ${cursorPath}: ${error.message}`)
      }
    }
    cursor = next
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
