import { renameSync } from 'node:fs'
import path from 'node:path'

import { identityOf, paneAgents, paneKey, readScreen, repoWorktrees, stackAgent, turnRunning, workerTerminals } from './avisar.mjs'
import { analyzeChecks, checkRunId, isHigherRunId, isStatus, latestChecks } from './checks.mjs'
import { consultasCommand } from './consultas.mjs'
import { defaultIo, quotaLine, shellPrompt } from './despacho.mjs'
import { commitOf, markerValue } from './marcas.mjs'
import { switchAccount } from './orca.mjs'
import { watchParent } from './parent-watch.mjs'
import { getCommonDir } from './repo.mjs'
import { sha256 } from './util.mjs'

export const CURSOR_REL = ['orca-stack', 'vigilar.json']
export const MERGES_REL = ['orca-stack', 'vigilar-merges.json']

const USAGE = 'Uso: orca-stack vigilar <n...> [--cada <segundos>] [--una-vez] [--dry-run] [--consultas], o orca-stack vigilar --merge-de-main <pr>.'
const PR_FIELDS = 'number,state,headRefName,headRefOid,mergedAt,body,closingIssuesReferences,statusCheckRollup,mergeable'
// A record by --merge-de-main covers a merge of its head commit made within this window after the record.
const MERGE_WINDOW_MS = 30 * 60 * 1000
// Polls in a row that failed to read GitHub before the watcher says it is blind (once per outage).
const BLIND_AFTER = 3
const DETAIL_MAX = 200
const STALL_WORKING_MS = 30 * 60 * 1000
const STALL_IDLE_MS = 4 * 60 * 1000
const WATCHDOG_EMITTED_MAX = 20
const CHECK_GREEN = ['SUCCESS', 'SKIPPED', 'NEUTRAL']
const CHECK_RED = ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED']
const STATUS_RED = ['FAILURE', 'ERROR']
const LIVE_WORKER_STATES = new Set(['working', 'running', 'active', 'blocked', 'waiting'])
// How many batches a cursor entry remembers having told about its PR (pr-abierto), the oldest dropped first.
const TOLD_MAX = 20

// stdout carries events only (it runs under the Monitor tool); every diagnostic goes to stderr.
// A Monitor that stops leaves this process running with nobody reading its output: the watch ends it (#281).
const vigilarIo = () => ({ ...defaultIo(), err: message => console.error(message), rename: renameSync, now: Date.now, watchParent: () => watchParent('vigilar') })

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

// A PR is the item's by its closing reference, the branch of this repo's worktree linked to the issue, or a GitHub
// closing keyword for `#<n>` anywhere in its body (`Closes #7`, `fixes #7`, `Closes: #7`, `resolves #7`); never by
// guessing a branch name.
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi
export const closedIssues = body => [...String(body ?? '').matchAll(CLOSING)].map(match => match[1])
export const closesIssue = (body, issue) => closedIssues(body).includes(String(issue))
const linked = (pr, issue, branches) =>
  (pr.closingIssuesReferences ?? []).some(ref => String(ref.number) === issue) ||
  branches.includes(pr.headRefName) ||
  closesIssue(pr.body, issue)

const agentState = record => String(record?.state ?? record?.status ?? '').trim().toLowerCase()
const recordTime = record => Number(record?.updatedAt ?? record?.stateStartedAt ?? 0) || 0
const candidateTime = candidate => Math.max(recordTime(candidate.record), Number(candidate.terminal?.lastOutputAt ?? 0) || 0)
const lastRawLine = screen => Array.isArray(screen) ? (screen.map(line => String(line)).reverse().find(line => line.trim() !== '') ?? '') : ''
const truncateChars = (text, max = DETAIL_MAX) => Array.from(String(text ?? '')).slice(0, max).join('')
const normalizeScreenLine = line => truncateChars(String(line ?? '').replace(/\s+/g, ' ').trim(), DETAIL_MAX)
const screenDigest = screen => Array.isArray(screen) ? sha256(screen.map(line => String(line).trimEnd()).join('\n').replace(/\n+$/, '')) : null
const agentIdentity = raw => {
  const norm = String(raw ?? '').trim().toLowerCase()
  return norm ? stackAgent(norm) : ''
}

const inspectWorker = (issue, worktrees, hasOpenPr, io, warn) => {
  if (worktrees.length > 1) {
    warn(`vigilar: hay ${worktrees.length} worktrees para el worker de #${issue}; no adivino cuál.`)
    return { unreadable: false, worker: null, probe: null }
  }
  if (worktrees.length === 0) return { unreadable: false, worker: null, probe: null }
  const row = worktrees[0].row
  const allAgents = (row.agents ?? []).filter(agent => !agent?.parentPaneKey)
  const fallbackAgent = allAgents.slice().sort((a, b) =>
    (agentState(b) === 'working' ? 1 : 0) -
    (agentState(a) === 'working' ? 1 : 0) ||
    recordTime(b) - recordTime(a),
  )[0]
  const fallbackIdentity = agentIdentity(fallbackAgent?.agentType)
  const fallbackState = agentState(fallbackAgent)
  const fallbackWorker = fallbackIdentity && fallbackState ? { state: fallbackState, agent: fallbackIdentity } : null

  if (hasOpenPr && !allAgents.some(agent => agentState(agent) === 'working')) {
    return { unreadable: false, worker: allAgents.length === 1 ? fallbackWorker : null, probe: null }
  }

  let terminals
  try {
    terminals = workerTerminals(row.path, issue, io)
  } catch (error) {
    warn(`vigilar: no pude leer la terminal de #${issue}: ${error.message}`)
    return { unreadable: true, worker: fallbackWorker, probe: null }
  }

  const byPane = paneAgents(row)
  const matched = []
  for (const terminal of terminals) {
    const record = byPane.get(paneKey(terminal)) ?? (allAgents.length === 1 && !allAgents[0].paneKey && terminals.length === 1 ? allAgents[0] : undefined)
    if (record?.parentPaneKey) continue
    const agent = agentIdentity(identityOf(terminal, record))
    if (!agent) continue
    matched.push({ terminal, record, agent })
  }

  if (matched.length === 0) {
    if (!hasOpenPr && fallbackWorker) {
      return {
        unreadable: false,
        worker: fallbackWorker,
        probe: {
          workerId: fallbackAgent?.paneKey || fallbackIdentity,
          agent: fallbackIdentity,
          state: fallbackState,
          screenHash: null,
          lastLine: '',
          quota: undefined,
          isQuotaStop: false,
          isShellStop: false,
          isDoneStop: fallbackState === 'done',
          isLiveWorking: fallbackState === 'working',
        },
      }
    }
    return { unreadable: false, worker: allAgents.length === 1 ? fallbackWorker : null, probe: null }
  }

  const screens = []
  for (const { terminal } of matched) {
    try {
      screens.push(readScreen(io, terminal.handle))
    } catch (error) {
      warn(`vigilar: no pude leer la terminal de #${issue} (${terminal.handle}): ${error.message}`)
      return { unreadable: true, worker: fallbackWorker, probe: null }
    }
  }

  const candidates = matched.map(({ terminal, record, agent }, index) => {
    const screen = screens[index]
    const state = agentState(record)
    const rawLast = lastRawLine(screen)
    const lastLine = normalizeScreenLine(rawLast)
    const quota = quotaLine(screen)
    const isQuotaStop = Boolean(quota) && (state !== 'working' || !turnRunning(agent, screen))
    const isShellStop = Boolean(rawLast && shellPrompt(rawLast))
    const isDoneStop = state === 'done'
    const isLiveWorking = state === 'working' && !isQuotaStop && !isShellStop
    const workerId = record?.paneKey || (terminal.tabId && terminal.leafId ? paneKey(terminal) : terminal.handle ? String(terminal.handle) : agent)
    return { index, terminal, record, agent, state, screenHash: screenDigest(screen), lastLine, quota, isQuotaStop, isShellStop, isDoneStop, isLiveWorking, workerId }
  })

  const live = candidates.filter(candidate => candidate.isLiveWorking)
  if (live.length > 0) {
    const chosen = live.sort((a, b) => candidateTime(b) - candidateTime(a) || b.index - a.index)[0]
    return { unreadable: false, worker: { state: 'working', agent: chosen.agent }, probe: chosen }
  }
  const chosen = candidates.sort((a, b) => candidateTime(b) - candidateTime(a) || (b.record ? 1 : 0) - (a.record ? 1 : 0) || b.index - a.index)[0]
  return { unreadable: false, worker: chosen.state ? { state: chosen.state, agent: chosen.agent } : null, probe: chosen }
}

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
    const commentsResult = io.sh('gh', ['issue', 'view', issue, '--json', 'comments'], { cwd: root })
    const issueComments = commentsResult.status === 0 ? parse(commentsResult)?.comments : undefined
    const commentsReadable = Array.isArray(issueComments)
    if (!commentsReadable) warn(`vigilar: no pude leer comentarios de #${issue}; lo sigo vigilando.`)
    if (pr) {
      let inspected = { unreadable: !workersReadable, worker: null, probe: null }
      if (workersReadable && pr.state === 'OPEN') {
        const linkedWt = ours.filter(({ row }) => String(row.linkedIssue) === issue)
        const candidates = linkedWt.length > 0 ? linkedWt : ours.filter(({ branch }) => branch === pr.headRefName)
        inspected = inspectWorker(issue, candidates, true, io, warn)
      }

      const discussion = ghJson(io, root, ['pr', 'view', String(pr.number), '--json', 'comments,reviews'])
      return [issue, { pr, discussion, issueComments, commentsReadable, workersReadable, worker: inspected.worker, probe: inspected.probe, watchdogUnreadable: inspected.unreadable, replacedWorkflows: replacedRuns(pr, root, io) }]
    }

    const res = io.sh('gh', ['issue', 'view', issue, '--json', 'state'], { cwd: root })
    const issueState = res.status === 0 ? parse(res)?.state : undefined
    if (!issueState) warn(`vigilar: no pude leer el estado de #${issue} (${detail(res)}); lo sigo vigilando.`)

    if (issueState === 'CLOSED') return [issue, { issueState, issueComments, commentsReadable, workersReadable, worker: null, probe: null, watchdogUnreadable: false }]
    if (!workersReadable) return [issue, { issueState, issueComments, commentsReadable, workersReadable: false, worker: null, probe: null, watchdogUnreadable: true }]

    const worktrees = ours.filter(({ row }) => String(row.linkedIssue) === issue)
    const inspected = inspectWorker(issue, worktrees, false, io, warn)

    return [issue, { issueState, issueComments, commentsReadable, workersReadable: true, worker: inspected.worker, probe: inspected.probe, watchdogUnreadable: inspected.unreadable }]
  }))
}

const evaluateWatchdog = (issue, seen, before, entry, now) => {
  if (seen.watchdogUnreadable) {
    if (before?.watchdog) entry.watchdog = before.watchdog
    return []
  }
  const probe = seen.probe
  if (!probe) {
    delete entry.watchdog
    return []
  }

  const prev = before?.watchdog
  const sameWorker = prev?.workerId === probe.workerId
  const isWorking = probe.state === 'working'
  const screenChanged = probe.screenHash !== null && (!sameWorker || prev.screen !== probe.screenHash)
  const workingChanged = sameWorker && prev?.working !== undefined && prev.working !== isWorking
  let emittedList = sameWorker && Array.isArray(prev.emitted) ? [...prev.emitted] : []
  if (probe.isLiveWorking) emittedList = emittedList.filter(key => !key.startsWith('stopped:'))
  if (screenChanged) emittedList = emittedList.filter(key => !key.startsWith('stalled:'))
  const emittedSet = new Set(emittedList)
  const screenSince = probe.screenHash === null ? undefined : (screenChanged || workingChanged || prev?.screenSince === undefined ? now : prev.screenSince)
  const openWithoutPr = !seen.pr && seen.issueState === 'OPEN'
  const lines = []

  let deathKey
  let deathReason
  if (openWithoutPr) {
    if (probe.isQuotaStop) {
      deathKey = 'stopped:quota'
      const quotaNorm = normalizeScreenLine(probe.quota)
      deathReason = probe.lastLine && probe.lastLine !== quotaNorm ? `cuota \u2014 ${quotaNorm} \u2014 ${probe.lastLine}` : `cuota \u2014 ${quotaNorm}`
    } else if (probe.isShellStop) {
      deathKey = 'stopped:shell'
      deathReason = probe.lastLine ? `volvi\u00F3 al shell \u2014 ${probe.lastLine}` : 'volvi\u00F3 al shell'
    } else if (probe.isDoneStop) {
      deathKey = 'stopped:done'
      deathReason = probe.lastLine ? `termin\u00F3 sin abrir un PR \u2014 ${probe.lastLine}` : 'termin\u00F3 sin abrir un PR'
    }
  }

  if (deathKey) {
    if (!emittedSet.has(deathKey)) {
      lines.push(`worker-detenido #${issue} ${probe.agent}: ${deathReason}`)
      emittedSet.add(deathKey)
    }
  } else if (probe.screenHash !== null && screenSince !== undefined) {
    const eligible = openWithoutPr || (isWorking && seen.pr?.state === 'OPEN')
    if (eligible && now - screenSince >= (isWorking ? STALL_WORKING_MS : STALL_IDLE_MS)) {
      const workingKey = `stalled:30m:${probe.screenHash}`
      const stallKey = isWorking ? workingKey : `stalled:4m:${probe.screenHash}`
      const alreadyReported = emittedSet.has(stallKey) || (!isWorking && emittedSet.has(workingKey))
      if (!alreadyReported) {
        const label = isWorking ? 'sin cambios por 30m' : 'sin cambios por 4m'
        const stallReason = probe.lastLine ? `${label} \u2014 ${probe.lastLine}` : label
        lines.push(`worker-trabado #${issue} ${probe.agent}: ${stallReason}`)
        emittedSet.add(stallKey)
      }
    }
  }

  const nextEmitted = [...emittedSet].slice(-WATCHDOG_EMITTED_MAX)
  entry.watchdog = {
    workerId: probe.workerId,
    working: isWorking,
    ...(probe.screenHash !== null ? { screen: probe.screenHash, screenSince } : {}),
    ...(nextEmitted.length > 0 ? { emitted: nextEmitted } : {}),
  }

  return lines
}

// One item's events and its next cursor entry: the PR, its last head commit, the last CI result emitted for that head
// commit (with the run of the last red one), the batches already told the PR opened, and how the item ended.
// `batch` names this watcher by its items: the cursor is shared, so a PR another batch's watcher already knew is still
// news to this one (once), while the same batch re-armed resumes without repeating it.
const advance = (issue, seen, before, merges, emitted, batch, now) => {
  if (!seen.commentsReadable) return { lines: [], entry: before ?? {} }
  const diagnoses = new Set(before?.diagnoses ?? [])
  const lines = []
  for (const comment of [...(seen.issueComments ?? []), ...(seen.discussion?.comments ?? [])]) {
    const agent = markerValue(comment.body, 'Diagn\u00f3stico')?.split(/\s+/)[0]
    if (!comment.id || !agent || agent.toLowerCase() === 'main' || diagnoses.has(comment.id)) continue
    const key = `diagnosis:${comment.id}`
    if (!emitted.has(key)) lines.push(`diagnostico #${issue} ${agent}`)
    emitted.add(key)
    diagnoses.add(comment.id)
  }
  if (!seen.pr) {
    const entry = seen.issueState === 'CLOSED' ? { fin: 'issue-cerrado' } : {}
    if (diagnoses.size) entry.diagnoses = [...diagnoses]
    if (seen.workersReadable === false) {
      if (before?.worker) entry.worker = before.worker
    } else if (seen.worker) {
      entry.worker = seen.worker
    }
    if (seen.issueState !== 'CLOSED') lines.push(...evaluateWatchdog(issue, seen, before, entry, now))

    return { lines, entry }
  }
  const { pr } = seen
  const fresh = before?.pr !== pr.number
  const entry = fresh ? { ...(before?.worker ? { worker: before.worker } : {}), pr: pr.number } : { ...before }
  if (seen.workersReadable !== false && seen.worker) entry.worker = seen.worker
  if (diagnoses.size) entry.diagnoses = [...diagnoses]
  const reported = new Set(entry.reviews ?? [])
  for (const comment of [...(seen.discussion.comments ?? []), ...(seen.discussion.reviews ?? [])]) {
    const reviewer = markerValue(comment.body, 'Revisor')?.split(/\s+/)[0] || undefined
    const sha = commitOf(comment.body)
    if (!comment.id || !reviewer || !sha || reported.has(comment.id)) continue
    const section = /(?:^|\r?\n)##\s+BLOQUEA\s*(?:\r?\n|$)([\s\S]*?)(?=\r?\n##\s|$)/i.exec(comment.body)?.[1] ?? ''
    const count = [...section.matchAll(/^\s*\d+\.\s+/gm)].length
    const key = `review:${pr.number}:${comment.id}`
    if (!emitted.has(key)) lines.push(`review-publicado #${pr.number} ${reviewer} ${sha.slice(0, 7)} bloquea=${count}`)
    emitted.add(key)
    reported.add(comment.id)
  }
  if (reported.size) entry.reviews = [...reported]
  if (!fresh && entry.head && entry.head !== pr.headRefOid) {
    const key = `head:${pr.number}:${pr.headRefOid}`
    if (!emitted.has(key)) lines.push(`head-nuevo #${pr.number} ${pr.headRefOid.slice(0, 7)}`)
    emitted.add(key)
    if (pr.state !== 'OPEN') entry.head = pr.headRefOid
  }
  if (pr.state === 'OPEN') {
    delete entry.fin
    const told = Array.isArray(entry.abiertoPara) ? entry.abiertoPara : []
    if (!told.includes(batch)) {
      lines.push(event('pr-abierto', issue, pr, pr.headRefOid))
      entry.abiertoPara = [...told, batch].slice(-TOLD_MAX)
    }
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
    lines.push(...evaluateWatchdog(issue, seen, before, entry, now))
  } else if (!entry.fin) {
    delete entry.watchdog
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

// --paraguas (#370): a planning session publishes its tickets as sub-issues of the umbrella. Only that list is read, so
// comments, edits and issues that are not sub-issues never give an event. to-tickets creates them one by one: a batch is
// told once it stopped growing for one poll. Its entry lives in vigilar.json under its own key, next to the batch items.
const PARAGUAS_USAGE = 'Uso: orca-stack vigilar --paraguas <n> [--cada <segundos>] [--una-vez] [--dry-run], con el número de un solo issue paraguas y sin otros items.'
const umbrellaKey = n => `paraguas:${n}`
const subIssueNumbers = (io, root, n) => {
  const list = ghJson(io, root, ['api', `repos/{owner}/{repo}/issues/${n}/sub_issues?per_page=100`])
  if (!Array.isArray(list)) throw new Blind(`gh api sub_issues de #${n} no devolvió una lista`)

  return [...new Set(list.map(issue => issue?.number).filter(Number.isInteger))].sort((a, b) => a - b)
}
const sameList = (a, b) => Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i])

// The planning session starts with the sub-issues the umbrella already had marked as told, so a watcher armed after
// `orca-stack planificar` only reports the batches the session publishes.
export const markUmbrellaBaseline = (n, io, warn) => {
  const { commonDir, root } = getCommonDir(io)
  const cursorPath = path.join(commonDir, ...CURSOR_REL)
  const known = subIssueNumbers(io, root, n)
  const cursor = readJson(cursorPath, io, warn)
  const told = [...new Set([...(cursor[umbrellaKey(n)]?.avisados ?? []), ...known])].sort((a, b) => a - b)
  writeJson(cursorPath, { ...cursor, [umbrellaKey(n)]: { avisados: told, pendientes: [] } }, io)

  return known
}

const watchUmbrella = async (flags, items, io, warn) => {
  const raw = String(flags.paraguas ?? '').trim().replace(/^#/, '')
  if (!/^\d+$/.test(raw) || (items ?? []).length > 0 || flags.consultas) throw new Error(PARAGUAS_USAGE)
  const n = String(Number(raw))
  const every = flags.cada === undefined ? 60 : Number(flags.cada)
  if (!Number.isInteger(every) || every < 1) throw new Error(`--cada necesita un número entero de segundos, 1 o más: ${flags.cada}`)
  const { commonDir, root } = getCommonDir(io)
  const cursorPath = path.join(commonDir, ...CURSOR_REL)
  const key = umbrellaKey(n)
  let entry = readJson(cursorPath, io, warn)[key] ?? {}
  let failures = 0

  // Returns true once the umbrella is closed.
  const poll = () => {
    let state
    let numbers
    try {
      state = ghJson(io, root, ['issue', 'view', n, '--json', 'state']).state
      numbers = subIssueNumbers(io, root, n)
    } catch (error) {
      if (!(error instanceof Blind)) throw error
      failures += 1
      warn(`vigilar: no pude leer GitHub (${failures} ${failures === 1 ? 'vez' : 'veces'} seguidas): ${error.message}`)
      if (failures === BLIND_AFTER) io.out(`vigilar-ciego: ${error.message}`)

      return false
    }
    failures = 0
    const told = new Set(entry.avisados ?? [])
    const fresh = numbers.filter(number => !told.has(number))
    const next = { avisados: [...told].sort((a, b) => a - b), pendientes: fresh }
    if (fresh.length > 0 && sameList(fresh, entry.pendientes)) {
      io.out(`planificacion-publicada #${n} ${fresh.map(number => `#${number}`).join(',')}`)
      next.avisados = [...told, ...fresh].sort((a, b) => a - b)
      next.pendientes = []
    }
    if (!flags.dryRun && JSON.stringify(next) !== JSON.stringify(entry)) {
      try {
        writeJson(cursorPath, { ...readJson(cursorPath, io, warn), [key]: next }, io)
      } catch (error) {
        warn(`vigilar: no pude escribir ${cursorPath}: ${error.message}`)
      }
    }
    entry = next
    const closed = String(state ?? '').toUpperCase() === 'CLOSED'
    if (closed) warn(`vigilar: el paraguas #${n} está cerrado; no queda nada que vigilar.`)

    return closed
  }

  if (!flags.unaVez && !flags.dryRun) io.watchParent?.()
  for (;;) {
    if (poll() || flags.unaVez || flags.dryRun) return 0
    await io.sleep(every * 1000)
  }
}

// The Run mailbox (#397): the workers despachar started in the Run bound to main end with worker_done or escalate, and
// ask main with `orca orchestration ask`, which lands as a question (#398). It is
// read with `check --all`, which never marks anything read (the mailbox belongs to main's agent), and with --full, since
// the concise view keeps only payload ids and so has no outcome. Each message is told once: its id goes to the Run's
// entry in vigilar.json, pruned to the ids `check --all` still returns, so the entry stays bounded and a restart neither
// loses nor repeats a message.
const runKey = runId => `run:${runId}`
const TASK_TITLE = /^#(\d+) (\S+)(?: rebote #\d+| reanudado)?$/
const MAILBOX_TYPES = ['worker_done', 'escalation', 'question']

const orchestration = (io, root, args) => {
  const res = io.sh('orca', ['orchestration', ...args], { cwd: root })
  const body = parse(res)
  if (res.status !== 0 || !body || body.ok === false) throw new Error(`orca orchestration ${args[0]} falló (${body?.error?.message ?? detail(res)})`)

  return body.result ?? {}
}
const payloadOf = message => {
  if (message?.payload && typeof message.payload === 'object') return message.payload
  try {
    return JSON.parse(message?.payload) ?? {}
  } catch {
    return {}
  }
}

// Returns the event lines and the Run's next cursor entry; throws when Orca cannot answer, so nothing is marked told.
const readMailbox = (before, io, root) => {
  const { runId } = orchestration(io, root, ['run-current', '--json'])
  if (!runId) return { lines: [] }
  const { messages } = orchestration(io, root, ['check', '--run', runId, '--all', '--types', MAILBOX_TYPES.join(','), '--full', '--json'])
  if (!Array.isArray(messages)) throw new Error('orca orchestration check no devolvió una lista de mensajes')
  const key = runKey(runId)
  const told = new Set(before[key]?.vistos ?? [])
  const ours = messages.filter(m => m?.id && MAILBOX_TYPES.includes(m.type))
  const fresh = ours.filter(m => !told.has(m.id)).sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))
  const lines = []
  // A message whose task is not listed yet stays unseen, so a later poll tells it once the task shows up; a listed task
  // with another title is ignored for good.
  const handled = new Set()
  if (fresh.length > 0) {
    const { tasks } = orchestration(io, root, ['task-list', '--run', runId, '--json'])
    const listed = Array.isArray(tasks) ? tasks : []
    const titles = new Map(listed.map(task => [task?.id, String(task?.title ?? '')]))
    const statuses = new Map(listed.map(task => [task?.id, String(task?.status ?? '')]))
    const reported = new Set(ours.filter(m => m.type === 'worker_done').map(m => payloadOf(m).taskId))
    for (const message of fresh) {
      const payload = payloadOf(message)
      if (!titles.has(payload.taskId)) continue
      // #445: Orca's "Worker stopped without reporting" is no ending: silent while the task is dispatched (it stays
      // unseen, so a later poll tells it once the task leaves dispatched), dropped when the worker did report.
      const unreported = message.type === 'escalation' && payload.stopReason === 'finished'
      if (unreported && !reported.has(payload.taskId) && statuses.get(payload.taskId) === 'dispatched') continue
      handled.add(message.id)
      const title = TASK_TITLE.exec(titles.get(payload.taskId))
      if (!title) continue
      if (message.type === 'question') {
        lines.push(`consulta #${title[1]} ${title[2]} ${message.id}`)
        continue
      }
      if (unreported) {
        if (!reported.has(payload.taskId)) lines.push(`worker-sin-reporte #${title[1]} ${title[2]}`)
        continue
      }
      const ok = message.type === 'worker_done' && payload.outcome === 'succeeded'
      lines.push(`worker-terminado #${title[1]} ${title[2]} ${ok ? 'ok' : 'partial'}`)
    }
  }
  const vistos = ours.map(m => m.id).filter(id => told.has(id) || handled.has(id))

  return { lines, key, entry: { vistos } }
}

export const vigilarCommand = async (flags = {}, items = [], io = vigilarIo()) => {
  const warn = io.err ?? (message => console.error(message))
  if (flags.mergeDeMain !== undefined) return recordMainMerge(flags.mergeDeMain, flags, io, warn)
  if (flags.paraguas !== undefined) return watchUmbrella(flags, items, io, warn)
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
  const batch = [...targets].sort((a, b) => Number(a) - Number(b)).join(',')
  // The PRs of the items, as last read: --consultas reads their comments too, since a worker with a PR asks there.
  let linkedPrs = []

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
    linkedPrs = targets.map(issue => world[issue].pr?.number).filter(Boolean).map(String)
    const merges = readJson(mergesPath, io, warn)
    const now = (io.now ?? Date.now)()
    const next = { ...cursor }
    const lines = []
    let endedNow = false
    const emitted = new Set()
    for (const issue of targets) {
      const step = advance(issue, world[issue], cursor[issue], merges, emitted, batch, now)
      lines.push(...step.lines)
      if (step.entry.fin && !cursor[issue]?.fin) endedNow = true
      next[issue] = step.entry
    }
    const allEnded = targets.every(issue => next[issue].fin)
    if (allEnded && endedNow) lines.push(`tanda-cerrada ${targets.map(issue => `#${issue}`).join(' ')}`)
    // Diagnosis, like other events, is at-least-once: a crash after stdout and before the cursor write can repeat it.
    // Print first so that a crash does not silently lose the event.
    for (const line of lines) {
      io.out(line)
      // #431: a quota stop switches the agent to another Orca account; main resumes the worker with `reanudar`. With no
      // account left only the stop is told, as before; a failed list or select adds its error line.
      const quota = flags.dryRun ? null : /^worker-detenido #(\d+) (\S+): cuota /.exec(line)
      const switched = quota ? switchAccount(io, commonDir, quota[2], quota[1]) : {}
      if (switched.line || switched.error) io.out(switched.line ?? `cuenta no cambiada: ${quota[2]} — ${switched.error}`)
    }
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

  // Orca failing is said once per outage on stderr; GitHub keeps being watched either way. What this run told stays in
  // memory too, so a cursor that cannot be written never makes it print a message twice.
  let mailboxDown = false
  const toldHere = {}
  const pollMailbox = () => {
    let read
    try {
      const stored = readJson(cursorPath, io, warn)
      const before = { ...stored }
      for (const [key, ids] of Object.entries(toldHere)) before[key] = { vistos: [...new Set([...(stored[key]?.vistos ?? []), ...ids])] }
      read = readMailbox(before, io, root)
    } catch (error) {
      if (!mailboxDown) warn(`vigilar: no pude leer el buzón del Run de Orca: ${error.message}; sigo vigilando GitHub.`)
      mailboxDown = true

      return
    }
    mailboxDown = false
    for (const line of read.lines) io.out(line)
    if (!read.key) return
    toldHere[read.key] = read.entry.vistos
    if (flags.dryRun) return
    const stored = readJson(cursorPath, io, warn)
    if (JSON.stringify(stored[read.key]) === JSON.stringify(read.entry)) return
    try {
      writeJson(cursorPath, { ...stored, [read.key]: read.entry }, io)
    } catch (error) {
      warn(`vigilar: no pude escribir ${cursorPath}: ${error.message}`)
    }
  }

  if (!flags.unaVez && !flags.dryRun) io.watchParent?.()
  for (;;) {
    const done = poll()
    pollMailbox()
    // One Monitor: the consultas check runs on every poll, unchanged, and its failure never stops the poll.
    if (flags.consultas) {
      try {
        await consultasCommand({ dryRun: flags.dryRun }, [...new Set([...targets, ...linkedPrs])], io)
      } catch (error) {
        warn(`vigilar: el chequeo de consultas falló: ${error.message}`)
      }
    }
    if (done || flags.unaVez || flags.dryRun) return 0
    await io.sleep(every * 1000)
  }
}
