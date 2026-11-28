import path from 'node:path'

import { AGENTS, WORKER_AGENTS, agyNotDelivered, blockOf, defaultIo, dismissAgySplash, getRemoteOrigin, lastBounceMark, launchInWorktree, loadConfig, needsPin, piProfileFor, piProfileLines, piProfileStored, rddConsentPolicy, readPin, refuseGlobalOverStalePin, refuseMissingGentleAi, shellPrompt, startWorker, supervisedTask, writePin, writeRddConsent } from './despacho.mjs'
import { pendingAfterSwitch } from './orca.mjs'
import { getStackAccount } from './repo.mjs'
import { samePath } from './util.mjs'
import { identityOf, paneAgents, readScreen, repoWorktrees, stackAgent, workerTerminals, worktreeRows } from './worker-terminals.mjs'

const SPINNER_LINES = 25
const DIALOG_LINES = 15
const PI_FRAME = /^\s*╭?─ [✿❀❁✾] /u
const PI_IDLE = /^\s*(?:╭─ ✿ ─+╮\s*$|─ ✿ waiting for input ─)/u
const DIALOG = /trust this folder\?|Do you want to proceed\?/i
const ESC_TO_CANCEL = /Esc to cancel/i
const QUESTION = /\?\s*$/m
const piFrame = screen => screen.slice(-SPINNER_LINES).findLast(line => PI_FRAME.test(line)) ?? ''
const piIdle = screen => PI_IDLE.test(piFrame(screen))
const isDialog = screen => {
  const text = screen.slice(-DIALOG_LINES).join('\n')

  return DIALOG.test(text) || (ESC_TO_CANCEL.test(text) && QUESTION.test(text))
}
const rowAt = (rows, worktree) => rows.find(row => row.path && samePath(row.path, worktree))

// #128: every session shares one gh account, so a comment by any other account is not main's; only Respuesta de main: or Respuesta del humano: counts.
export const validateAnswerComment = (item, url, root, remote, io) => {
  const match = COMMENT_URL.exec(url)
  if (!match || match[1].toLowerCase() !== remote.ownerRepo.toLowerCase()) {
    throw new Error(`La URL tiene que ser la de un comentario de ${remote.ownerRepo} (\u2026/issues/<n>#issuecomment-<id> o \u2026/pull/<n>#issuecomment-<id>): ${url}`)
  }
  if (match[3] !== item) throw new Error(`La URL apunta a #${match[3]}, no a #${item}: el aviso apunta a la respuesta donde preguntó el worker.`)

  const res = io.sh('gh', ['api', `repos/${remote.ownerRepo}/issues/comments/${match[4]}`], { cwd: root })
  const comment = res.status === 0 ? parse(res) : undefined
  if (!comment) throw new Error(`No pude leer el comentario ${url}: ${detail(res)}`)
  const author = String(comment.user?.login ?? '').trim().toLowerCase()
  const stack = getStackAccount(io)
  if (author !== stack) throw new Error(`El comentario es de ${author || '(cuenta desconocida)'}, no de la cuenta del stack (${stack}).`)
  if (!/^(?:Respuesta de main:|Respuesta del humano:)/.test(String(comment.body ?? '').trimStart())) {
    throw new Error('El comentario no empieza con `Respuesta de main:` ni `Respuesta del humano:`: no es una respuesta para el worker.')
  }
  if (String(comment.html_url ?? '').toLowerCase() !== url.toLowerCase()) {
    throw new Error(`El comentario ${match[4]} está en ${comment.html_url ?? '(sin URL)'}: la URL no apunta a donde dice.`)
  }

  return match
}

const LIVE = ['working', 'running', 'active', 'blocked', 'waiting']
const ATTEMPTS_REL = ['orca-stack', 'reanudar.json']
const COMMENT_URL = /^https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/(issues|pull)\/(\d+)#issuecomment-(\d+)$/
const parse = res => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    return undefined
  }
}
const detail = res => (res.stderr || res.stdout || String(res.error ?? '')).trim().split(/\r?\n/)[0]
// main-autonomo S5: a worker's own turn, told apart from a review or a subagent in the same worktree: no parent pane, and
// its prompt names a brief in ~/orca/briefs that is not a review brief (ticket, reanudar, rebote or continuation).
const BRIEF_IN_PROMPT = /[\\/]orca[\\/]briefs[\\/]([^\s\\/]+)\.md\b/
const isWorkerRecord = record => {
  const brief = BRIEF_IN_PROMPT.exec(String(record?.prompt ?? ''))?.[1]
  return !record?.parentPaneKey && brief !== undefined && !/(?:^|-)revision-/.test(brief)
}
const REVIEW_WORKTREE = /^revision-(\d+)-([^/\\]+)$/
const worktreeBaseName = file => String(file ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
const isReviewRecord = record => {
  const brief = BRIEF_IN_PROMPT.exec(String(record?.prompt ?? ''))?.[1]
  return !record?.parentPaneKey && brief !== undefined && /(?:^|-)revision-/.test(brief)
}
// #454: a relaunched worker's worker_done is accepted only from the terminal that owns the dispatch, so the Task "#<n>
// <agente>" of main's Run, when its dispatch closed, gets a new one on the new terminal. #463: any other case relaunches
// supervised too, on a new Task: "#<n> <agente> reanudado" while that Task is still dispatched, else "#<n> <agente>".
const closedRunTask = (io, root, n, agent) => {
  const current = io.sh('orca', ['orchestration', 'run-current', '--json'], { cwd: root })
  const run = current.status === 0 ? parse(current)?.result?.runId : undefined
  if (typeof run !== 'string' || run === '') return undefined
  const listed = io.sh('orca', ['orchestration', 'task-list', '--run', run, '--json'], { cwd: root })
  const tasks = listed.status === 0 ? parse(listed)?.result?.tasks : undefined
  if (!Array.isArray(tasks)) throw new Error(`No pude leer las tareas del Run ${run}: ${detail(listed)}. No relanzo.`)
  const task = tasks.find(candidate => String(candidate?.title ?? '') === `#${n} ${agent}`)
  if (!task?.id) return undefined
  if (task.status === 'ready') return { run, task: task.id }
  return task.status === 'dispatched' ? { dispatched: true } : undefined
}
const CLOSED_DISPATCH = new Set(['failed', 'stopped', 'succeeded', 'fenced', 'cancelled'])
// #521: Orca permanently revokes a dispatch capability on worker_done failed; sending a raw line triggers consumer_fenced.
const closedTerminalDispatch = (io, root, handle) => {
  const current = io.sh('orca', ['orchestration', 'run-current', '--json'], { cwd: root })
  const runId = current.status === 0 ? parse(current)?.result?.runId ?? parse(current)?.result?.run?.id : undefined
  if (typeof runId !== 'string' || runId === '') return undefined
  const listed = io.sh('orca', ['orchestration', 'worker-list', '--run', runId, '--json'], { cwd: root })
  const workers = listed.status === 0 ? parse(listed)?.result?.workers : undefined
  if (!Array.isArray(workers)) {
    throw new Error(`No pude comprobar si el dispatch de ${handle} en el Run ${runId} está cerrado (orca orchestration worker-list): ${detail(listed)}. No envío una línea a la terminal para evitar consumer_fenced.`)
  }
  const row = workers.find(w => (w?.terminal ?? w?.agentTerminalHandle) === handle)
  const state = String(row?.state ?? '').toLowerCase()
  return row && CLOSED_DISPATCH.has(state) ? { runId, dispatchId: row.dispatchId, taskId: row.taskId, state } : undefined
}
const recordTime = record => Number(record?.updatedAt ?? record?.stateStartedAt ?? 0) || 0
const prMatchesIssue = (pr, issue, branches) =>
  (pr.closingIssuesReferences ?? []).some(ref => String(ref.number) === issue) ||
  branches.includes(pr.headRefName) ||
  new RegExp(`^\\s*Closes\\s+#${issue}\\b`, 'im').test(pr.body ?? '')

const sendToPaused = async (flags, n, url, briefPath, target, io, markAttempt, beforeSend, { isReview = false, checkClosed, resumeSpecPath, repo } = {}) => {
  const { handle } = target.terminal
  const screen = readScreen(io, handle)
  const lastLine = screen.filter(line => line.trim() !== '').at(-1) ?? ''
  if (shellPrompt(lastLine)) return false
  if (isDialog(screen)) throw new Error(`La terminal ${handle} de #${n} muestra un di\u{e1}logo: no reanudo encima.`)
  // A positive signal for Pi (#277): its prompt frame at rest, with nothing running or queued.
  if (target.identity === 'pi' && !piIdle(screen)) throw new Error(`No veo a Pi en reposo en la pantalla de ${handle} (#${n}): no reanudo.`)

  const row = rowAt(worktreeRows(io), target.worktree)
  const current = paneAgents(row).get(target.record.paneKey)
  const state = String(current?.state ?? current?.status ?? '').toLowerCase()
  if (state !== 'done') throw new Error(`El agente de ${handle} cambi\u{f3} a ${state || 'sin estado'} mientras lo revisaba: no reanudo.`)

  const closedDispatch = checkClosed?.()
  const line = answerLine(url, briefPath, isReview)
  if (closedDispatch) {
    const title = `#${n} ${target.identity} reanudado`
    const dryCmd = ['orchestration', 'worker-start', '--run', closedDispatch.runId, '--terminal', handle, '--spec-file', resumeSpecPath, '--task-title', title, '--json']
    if (flags.dryRun) {
      if (target.identity === 'agy' && /esc to dismiss/i.test(screen.join('\n'))) io.out(`[simulaci\u{f3}n] cerrar el aviso de agy con Esc en ${handle} antes de abrir el dispatch`)
      io.out(`[simulaci\u{f3}n] El dispatch ${closedDispatch.dispatchId} de ${handle} est\u{e1} cerrado (${closedDispatch.state}); abrir\u{ed}a un dispatch nuevo en esa terminal.`)
      io.out(`[simulaci\u{f3}n] orca ${dryCmd.map(arg => (/\s|"/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`)
      io.out(`Terminal: ${handle}, worker de #${n} en ${target.worktree}`)
      io.out(`L\u{ed}nea: ${line}`)
      return true
    }
    if (target.identity === 'agy') await dismissAgySplash(io, handle, screen, briefPath)
    beforeSend()
    io.mkdirp(path.dirname(resumeSpecPath))
    io.writeFile(resumeSpecPath, `${line}\n`)
    markAttempt()
    try {
      await startWorker(io, io.out, { agent: target.identity, handle, briefPath: resumeSpecPath, supervised: { runId: closedDispatch.runId, title, objective: supervisedTask(repo, title).objective } })
    } catch (error) {
      if (error.orchestration) {
        throw new Error(`${error.message}\nEl dispatch ${closedDispatch.dispatchId} de ${handle} est\u{e1} cerrado (${closedDispatch.state}) y no pude abrir uno nuevo; no env\u{ed}o una l\u{ed}nea suelta para evitar consumer_fenced. Cerr\u{e1} la terminal con \`orca terminal close --terminal ${handle} --json\` y volv\u{e9} a correr \`orca-stack reanudar ${n} <url-del-comentario-nuevo>\` con el worktree limpio.`)
      }
      throw error
    }
    io.out(`Nuevo dispatch abierto en ${handle} (#${n}, anterior ${closedDispatch.dispatchId} cerrado en ${closedDispatch.state}): ${line}`)
    return true
  }

  const argv = lineArgv(handle, line)
  if (flags.dryRun) {
    if (target.identity === 'agy' && /esc to dismiss/i.test(screen.join('\n'))) io.out(`[simulaci\u{f3}n] cerrar el aviso de agy con Esc en ${handle} antes de enviar la l\u{ed}nea`)
    io.out(`[simulaci\u{f3}n] orca ${argv.map(arg => (/\s|"/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`)
    io.out(`Terminal: ${handle}, worker de #${n} en ${target.worktree}`)
    io.out(`L\u{ed}nea: ${line}`)
    return true
  }

  // agy's "esc to dismiss" banner or splash (#357): dismissed before anything else reaches the terminal.
  if (target.identity === 'agy') await dismissAgySplash(io, handle, screen, briefPath)
  beforeSend()
  markAttempt()
  sendLine(io, n, handle, target.identity, line, briefPath)
  return true
}

const answerLine = (url, briefPath, isReview = false) => `Message from main: ${url} . Continue the ${isReview ? 'review' : 'ticket'} per your brief: ${briefPath}.`
const lineArgv = (handle, line) => ['terminal', 'send', '--terminal', handle, '--text', line, '--enter', '--wait-submit', '10', '--json']
const sendLine = (io, n, handle, identity, line, briefPath) => {
  const sent = io.sh('orca', lineArgv(handle, line))
  const receipt = parse(sent)?.result?.send
  const prompt = receipt?.prompt
  const stages = Array.isArray(prompt?.stages) ? prompt.stages : []
  if (sent.status === 0 && receipt?.accepted === true && prompt?.requestId && stages.includes('input_accepted') && prompt.observation === 'supported') {
    io.out(`Reanudaci\u{f3}n enviada a ${handle} (#${n}): ${line}`)
    return
  }
  if (receipt?.accepted === false || /No input was sent/i.test(`${sent.stdout}${sent.stderr}`)) {
    if (identity === 'agy') throw new Error(agyNotDelivered(handle, briefPath))
    throw new Error(`orca terminal send no envi\u{f3} nada a ${handle}: ${receipt?.refusedReason ?? detail(sent)}. No reintento.`)
  }
  // The no-resend guard stays; agy, whose empty prompt kept the line out before (#357), names the line to paste instead.
  if (identity === 'agy') throw new Error(agyNotDelivered(handle, briefPath))
  throw new Error(`No hay recibo de entrega de orca terminal send en ${handle}: la l\u{ed}nea pudo haber llegado. No la reenv\u{ed}o; revis\u{e1} la terminal antes de volver a reanudar.`)
}

export const reanudarCommand = async (flags = {}, item, url, io = defaultIo()) => {
  if (!/^\d+$/.test(String(item ?? '')) || !url) throw new Error('Uso: orca-stack reanudar <issue> <url-del-comentario> [--terminal <handle>] [--confirmado] [--perfil-pi <nombre>] [--dry-run].')
  const n = String(Number(item))
  const git = io.sh('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], { cwd: io.cwd })
  if (git.status !== 0) throw new Error('Corr\u{e9} este comando dentro del checkout principal de un repo git.')
  const [gitDir, commonDir, top] = git.stdout.split(/\r?\n/).map(line => line.trim())
  if (!samePath(gitDir, commonDir)) throw new Error('Esto es un worktree: corr\u{e9} el comando desde el checkout principal del repo (la sesi\u{f3}n de main).')
  const root = path.resolve(top)
  const config = loadConfig(io.home, root)
  if (config.setup !== 'completo') throw new Error(`El setup de orca-stack est\u{e1} pendiente en ${root}: hacelo antes de reanudar.`)
  if (config.modo === 'un-agente') throw new Error('El modo del repo es "un-agente": no hay workers que reanudar.')

  const remote = getRemoteOrigin(root, io)
  const repo = remote.ownerRepo.split('/').at(-1)
  const link = COMMENT_URL.exec(url)
  if (!link || link[1].toLowerCase() !== remote.ownerRepo.toLowerCase()) {
    throw new Error(`La URL tiene que apuntar a un comentario de ${remote.ownerRepo} (/issues/${n} o su PR abierto).`)
  }
  const isPr = link[2] === 'pull'
  const targetItem = link[3]
  const commentId = link[4]

  if (!isPr && targetItem !== n) {
    throw new Error(`La URL apunta a #${targetItem}, no a #${n}: el aviso apunta a la respuesta donde preguntó el worker.`)
  }
  validateAnswerComment(targetItem, url, root, remote, io)

  const attemptsPath = path.join(commonDir, ...ATTEMPTS_REL)
  let attempts = {}
  if (io.exists(attemptsPath)) {
    try {
      attempts = JSON.parse(io.readFile(attemptsPath))
      if (!attempts || typeof attempts !== 'object' || Array.isArray(attempts)) throw new Error('invalid')
    } catch {
      throw new Error(`No pude leer el registro ${attemptsPath}; no reanudo para evitar duplicar una entrega.`)
    }
  }
  if (attempts[commentId]) {
    const at = attempts[commentId].at ?? 'hora desconocida'
    throw new Error(`Ya intenté reanudar con el comentario ${commentId} (${at}); no reenvío ni relanzo. Si ese intento no llegó (mirá el estado del agente y su terminal), publicá una nueva Respuesta de main: en #${n} y corré orca-stack reanudar ${n} <url-del-comentario-nuevo>.`)
  }
  const markAttempt = () => {
    const next = { ...attempts, [commentId]: { issue: n, at: new Date((io.now ?? Date.now)()).toISOString() } }
    const temp = `${attemptsPath}.${process.pid}.tmp`
    io.mkdirp(path.dirname(attemptsPath))
    io.writeFile(temp, JSON.stringify(next, null, 2) + '\n')
    io.rename(temp, attemptsPath)
    attempts = next
  }

  const allWorktrees = repoWorktrees(root, io)
  const ours = allWorktrees.filter(({ row }) => String(row.linkedIssue) === n)
  if (ours.length > 1) throw new Error(`Hay ${ours.length} worktrees de este repo para #${n}: no adivino cuál reanudar.`)

  let isReview = false
  let reviewName
  let reviewAgent
  let row
  let branch
  if (ours.length === 1) {
    const prs = io.sh('gh', ['pr', 'list', '--state', 'open', '--json', 'number,closingIssuesReferences,headRefName,body'], { cwd: root })
    const pullRequests = prs.status === 0 ? parse(prs) : undefined
    if (!Array.isArray(pullRequests)) throw new Error(`No pude leer los PRs abiertos de #${n}: ${detail(prs)}`)

    ;({ row, branch } = ours[0])
    const pr = pullRequests.find(candidate => prMatchesIssue(candidate, n, [branch].filter(Boolean)))
    if (isPr) {
      if (!pr) {
        throw new Error(`El issue #${n} no tiene un PR abierto: la URL tiene que apuntar a un comentario de #${n} o de su PR abierto.`)
      }
      if (String(pr.number) !== targetItem) {
        throw new Error(`La URL tiene que apuntar a un comentario del PR abierto de #${n} (#${pr.number}): ${url}`)
      }
    } else if (pr) {
      // A bounce marked on the current head whose author stopped is resumed by `rebote --continuar` (#292).
      const view = io.sh('gh', ['pr', 'view', String(pr.number), '--json', 'headRefOid,comments,reviews'], { cwd: root })
      const bounce = view.status === 0 ? parse(view) : undefined
      const bounced = Boolean(bounce?.headRefOid) && lastBounceMark([...(bounce.reviews ?? []), ...(bounce.comments ?? [])]) === bounce.headRefOid
      throw new Error(`El issue #${n} ya tiene un PR abierto (#${pr.number}); usá \`orca-stack rebote ${pr.number}\`.${bounced ? ` Si el autor del rebote se cortó, usá orca-stack rebote ${pr.number} --continuar.` : ''}`)
    }
  } else {
    const reviews = allWorktrees.flatMap(entry => {
      const name = worktreeBaseName(entry.row.path)
      const match = REVIEW_WORKTREE.exec(name)
      return match?.[1] === n ? [{ ...entry, name, reviewAgent: match[2] }] : []
    })
    if (reviews.length === 0) throw new Error(`No encuentro un worktree de este repo para #${n}: no reanudo.`)
    if (reviews.length > 1) throw new Error(`Hay ${reviews.length} worktrees de review de este repo para #${n} (${reviews.map(entry => entry.name).join(', ')}): no adivino cuál reanudar.`)
    isReview = true
    ;({ row, branch, name: reviewName, reviewAgent } = reviews[0])
    if (targetItem !== n) throw new Error(`La URL apunta a #${targetItem}, no a #${n}: el aviso apunta a la respuesta donde preguntó el revisor.`)
  }

  const terminals = workerTerminals(row.path, n, io)
  const agentRecords = row.agents ?? []
  const stateOf = agent => String(agent?.state ?? agent?.status ?? '').toLowerCase()
  const unknown = agentRecords.find(agent => !LIVE.includes(stateOf(agent)) && stateOf(agent) !== 'done')
  if (unknown) throw new Error(`El agente de #${n} est\u{e1} en un estado que no conozco (${stateOf(unknown) || 'sin estado'}): no reanudo ni relanzo.`)
  const live = agentRecords.filter(agent => LIVE.includes(stateOf(agent)))
  if (live.length > 1) throw new Error(`Hay ${live.length} agentes vivos en el worktree de #${n}: no adivino a cu\u{e1}l reanudar.`)
  if (live.length === 1) {
    const state = String(live[0].state ?? live[0].status ?? '').toLowerCase()
    if (state === 'blocked' || state === 'waiting') throw new Error(`La terminal del agente de #${n} muestra un di\u{e1}logo (${state}): no reanudo encima.`)
    throw new Error(isReview
      ? `El revisor de #${n} está working: no reanudo encima.`
      : `El agente de #${n} est\u{e1} working: mandale el cambio por el buz\u{f3}n del Run con \`orca orchestration send --to dispatch:<id> --subject "${n}: reglas cambiadas" --body "<url-del-comentario>"\`.`)
  }

  const done = agentRecords.filter(agent => stateOf(agent) === 'done')
  const records = paneAgents(row)
  const workers = terminals.map(terminal => ({ terminal, record: records.get(`${terminal.tabId}:${terminal.leafId}`), identity: identityOf(terminal, records.get(`${terminal.tabId}:${terminal.leafId}`)) }))
  const identifiedWorkers = workers.filter(worker => worker.identity)
  // Which done agent to resume: --terminal names it; otherwise the only one, or the newest worker record's terminal.
  let chosen = done.length === 1 ? done[0] : undefined
  if (flags.terminal !== undefined) {
    const handle = String(flags.terminal)
    const picked = workers.find(worker => worker.terminal.handle === handle)
    if (!picked) throw new Error(`La terminal ${handle} no est\u{e1} en el worktree de #${n} (${workers.map(worker => worker.terminal.handle).join(', ') || 'ninguna'}): no reanudo.`)
    if (stateOf(picked.record) !== 'done') throw new Error(`La terminal ${handle} de #${n} no tiene un agente en done (${stateOf(picked.record) || 'sin agente'}): no reanudo.`)
    chosen = picked.record
  } else if (done.length > 1) {
    const newest = done.filter(isReview ? isReviewRecord : isWorkerRecord).sort((a, b) => recordTime(b) - recordTime(a))[0]
    if (!newest || !workers.some(worker => worker.record?.paneKey === newest.paneKey)) {
      const handles = workers.filter(worker => stateOf(worker.record) === 'done').map(worker => worker.terminal.handle)
      throw new Error(`Hay ${done.length} agentes done en el worktree de #${n}: no adivino a cu\u{e1}l reanudar. Eleg\u{ed} uno con --terminal <handle> (${handles.join(', ') || 'ninguna terminal listada'}).`)
    }
    chosen = newest
  }
  if (agentRecords.length === 0) {
    for (const { terminal } of workers) {
      const screen = readScreen(io, terminal.handle)
      const lastLine = screen.filter(line => line.trim() !== '').at(-1) ?? ''
      if (!shellPrompt(lastLine)) {
        throw new Error(`La terminal ${terminal.handle} de #${n} no muestra un shell prompt y Orca no lista su agente: puede haber un worker corriendo sin registro. No relanzo.`)
      }
    }
  }
  const target = chosen
    ? workers.find(worker => worker.record?.paneKey === chosen.paneKey) ?? { record: chosen, identity: stackAgent(chosen.agentType) }
    : identifiedWorkers.length === 1 ? identifiedWorkers[0] : undefined
  let agent = target?.identity ?? stackAgent(target?.record?.agentType)
  const originalPath = path.join(io.home, 'orca', 'briefs', isReview ? `${repo}-${reviewName}.md` : `${repo}-${n}.md`)
  let originalBrief
  if (!agent && agentRecords.length === 0 && identifiedWorkers.length === 0) {
    if (isReview) agent = reviewAgent
    else if (io.exists(originalPath)) {
      originalBrief = io.readFile(originalPath)
      const match = /^You are the implementer \((\S+)\) of issue #(\d+)\./m.exec(originalBrief)
      if (match?.[2] === n) agent = match[1]
    }
  }
  if (isReview && agent === 'claude') throw new Error('claude ya no es un agente worker (ADR 0006): despachá a pi, agy o codex.')
  if (!agent || !(isReview ? WORKER_AGENTS : AGENTS).includes(agent)) throw new Error(`No puedo identificar un agente conocido para #${n}; no reanudo ni relanzo.`)
  if (!config.agentes?.usa?.includes(agent)) throw new Error(`${agent} no est\u{e1} en agentes.usa de este repo (${(config.agentes?.usa ?? []).join(', ') || 'vac\u{ed}o'}).`)
  const blocked = blockOf(config, agent, (io.now ?? Date.now)())
  if (blocked) throw new Error(`No relanzo a ${agent}: ${blocked}`)
  if ((config.agentes?.preguntarAntes ?? []).includes(agent) && !flags.confirmado) {
    throw new Error(`${agent} figura en agentes.preguntarAntes: main tiene que preguntarle al humano antes de relanzarlo. Si dijo que s\u{ed}, repet\u{ed} el comando con --confirmado.`)
  }
  if (flags.perfilPi !== undefined && agent !== 'pi') throw new Error('--perfil-pi solo vale para el agente pi.')
  const consent = isReview ? undefined : rddConsentPolicy(config, agent)
  // main-autonomo S3: the worker's own candidate is declined; written just before the line or the relaunch reaches it.
  const writeConsent = () => { if (consent === 'politica') writeRddConsent(io, row.path, [], { keepExisting: true }) }
  // Like rebote: the worktree pin decides, so the orchestrator follows the same profile as the subagents. --perfil-pi
  // replaces a pin that can no longer be honored; with neither (and no config), a relaunch fails closed. Sending a line
  // to a paused pi launches nothing, so it needs no profile; a --perfil-pi there is still checked and rewrites the pin,
  // so the subagents the paused pi launches next follow it.
  const pin = agent === 'pi' ? readPin(io, row.path) : undefined
  if (agent === 'pi') refuseGlobalOverStalePin(io, pin, flags.perfilPi)
  if (agent === 'pi' && !isReview) await refuseMissingGentleAi(io)
  const resolveProfile = () => {
    try {
      return piProfileFor({ flag: flags.perfilPi, pin, config, home: io.home, commonDir, io })
    } catch (error) {
      if (flags.perfilPi === undefined && pin !== undefined && !piProfileStored(io, pin)) error.message += ` Repet\u{ed} con --perfil-pi <nombre> para fijar otro perfil en el worktree.`
      throw error
    }
  }
  let profile = agent === 'pi' && flags.perfilPi !== undefined ? resolveProfile() : undefined

  if (!io.exists(originalPath)) throw new Error(`No encuentro el brief original ${originalPath}; no relanzo sin \u{e9}l.`)

  // #431: a worker an account switch left pending is relaunched, work in progress included: its paused session would keep
  // the old account.
  const afterSwitch = isReview ? false : pendingAfterSwitch(io, commonDir, agent, n)
  const briefStem = isReview ? `${repo}-${reviewName}` : `${repo}-${n}`
  const resumeSpecPath = path.join(io.home, 'orca', 'briefs', `${briefStem}-reanudar-msg.md`)
  if (!afterSwitch && target?.terminal && stateOf(target.record) === 'done') {
    target.worktree = row.path
    const handled = await sendToPaused(flags, n, url, originalPath, target, io, markAttempt, () => {
      if (needsPin(profile)) writePin(io, row.path, commonDir, profile.name)
      writeConsent()
    }, { isReview, checkClosed: () => isReview ? undefined : closedTerminalDispatch(io, root, target.terminal.handle), resumeSpecPath, repo })
    if (handled) return 0
  }
  if (agent === 'pi') profile ??= resolveProfile()

  const status = io.sh('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: row.path })
  if (status.status !== 0) throw new Error(`No pude comprobar el worktree ${row.path}: ${detail(status)}`)
  if (status.stdout.trim() !== '' && !afterSwitch) throw new Error(`El worktree ${row.path} est\u{e1} sucio; guard\u{e1} o descart\u{e1} sus cambios antes de relanzar.`)

  const task = isReview ? undefined : closedRunTask(io, root, n, agent)
  // #454: with a ready Task, Orca's worker-start delivers the brief once (#397), and the answer goes as its own line.
  const rebind = task?.task && { ...task, deliver: handle => sendLine(io, n, handle, agent, answerLine(url, originalPath), originalPath) }
  const supervised = isReview || rebind ? undefined : supervisedTask(path.basename(root), `#${n} ${agent}${task?.dispatched ? ' reanudado' : ''}`)
  originalBrief ??= io.readFile(originalPath)
  if (profile) for (const line of piProfileLines(profile)) io.out(`${flags.dryRun ? '[simulaci\u{f3}n] ' : ''}${line}`)
  if (needsPin(profile) && !flags.dryRun) writePin(io, row.path, commonDir, profile.name)
  const brief = `Message from main: ${url}\n\n${originalBrief}${profile ? `\n${piProfileLines(profile).join('\n')}\n` : ''}`
  const briefPath = path.join(io.home, 'orca', 'briefs', `${briefStem}-reanudar.md`)
  if (!flags.dryRun) {
    io.mkdirp(path.dirname(briefPath))
    io.writeFile(briefPath, brief)
    markAttempt()
    writeConsent()
  }
  const session = `${briefStem}-reanudar-${(io.now ?? Date.now)()}`
  await launchInWorktree({ agent, mode: isReview ? 'review' : 'ticket', worktree: row.path, briefPath, brief, session, config, win: io.win, home: io.home, skills: agent === 'pi' ? io.gentleSkills(io.home) : null, piModel: profile?.model, piThinking: profile?.thinking, repositoryRoot: root, io, dryRun: flags.dryRun, piSessionAfter: agent === 'pi' ? (io.now ?? Date.now)() : 0, issue: isReview ? undefined : n, rebind, supervised })
  if (rebind && flags.dryRun) io.out(`[simulaci\u{f3}n] orca ${lineArgv('<terminal>', answerLine(url, originalPath)).map(arg => (/\s|"/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`)
  if (afterSwitch && !flags.dryRun) pendingAfterSwitch(io, commonDir, agent, n, true)

  return 0
}
