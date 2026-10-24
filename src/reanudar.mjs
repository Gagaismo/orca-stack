import path from 'node:path'

import { AGENTS, blockOf, defaultIo, getRemoteOrigin, launchInWorktree, loadConfig, shellPrompt } from './despacho.mjs'
import { identityOf, isDialog, paneAgents, PI_IDLE, readScreen, SPINNER_LINES, repoWorktrees, rowAt, validateAnswerComment, workerTerminals, worktreeRows } from './avisar.mjs'
import { samePath } from './util.mjs'

const LIVE = ['working', 'running', 'active', 'blocked', 'waiting']
const ATTEMPTS_REL = ['orca-stack', 'reanudar.json']
const COMMENT_URL_ISSUE = /^https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)#issuecomment-(\d+)$/
const parse = res => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    return undefined
  }
}
const detail = res => (res.stderr || res.stdout || String(res.error ?? '')).trim().split(/\r?\n/)[0]
const prMatchesIssue = (pr, issue, branches) =>
  (pr.closingIssuesReferences ?? []).some(ref => String(ref.number) === issue) ||
  branches.includes(pr.headRefName) ||
  new RegExp(`^\\s*Closes\\s+#${issue}\\b`, 'im').test(pr.body ?? '')

const sendToPaused = (flags, n, url, briefPath, target, io, markAttempt) => {
  const { handle } = target.terminal
  const screen = readScreen(io, handle)
  const lastLine = screen.filter(line => line.trim() !== '').at(-1) ?? ''
  if (shellPrompt(lastLine)) return false
  if (isDialog(screen)) throw new Error(`La terminal ${handle} de #${n} muestra un di\u{e1}logo: no reanudo encima.`)
  // A positive signal for Pi (#277): its prompt frame at rest, with nothing running or queued.
  if (target.identity === 'pi' && !PI_IDLE.test(screen.slice(-SPINNER_LINES).join('\n'))) throw new Error(`No veo a Pi en reposo en la pantalla de ${handle} (#${n}): no reanudo.`)

  const row = rowAt(worktreeRows(io), target.worktree)
  const current = paneAgents(row).get(target.record.paneKey)
  const state = String(current?.state ?? current?.status ?? '').toLowerCase()
  if (state !== 'done') throw new Error(`El agente de ${handle} cambi\u{f3} a ${state || 'sin estado'} mientras lo revisaba: no reanudo.`)

  const line = `Message from main: ${url} . Continue the ticket per your brief: ${briefPath}.`
  const argv = ['terminal', 'send', '--terminal', handle, '--text', line, '--enter', '--wait-submit', '10', '--json']
  if (flags.dryRun) {
    io.out(`[simulaci\u{f3}n] orca ${argv.map(arg => (/\s|"/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`)
    io.out(`Terminal: ${handle}, worker de #${n} en ${target.worktree}`)
    io.out(`L\u{ed}nea: ${line}`)
    return true
  }

  markAttempt()
  const sent = io.sh('orca', argv)
  const receipt = parse(sent)?.result?.send
  const prompt = receipt?.prompt
  const stages = Array.isArray(prompt?.stages) ? prompt.stages : []
  if (sent.status === 0 && receipt?.accepted === true && prompt?.requestId && stages.includes('input_accepted') && prompt.observation === 'supported') {
    io.out(`Reanudaci\u{f3}n enviada a ${handle} (#${n}): ${line}`)
    return true
  }
  if (receipt?.accepted === false || /No input was sent/i.test(`${sent.stdout}${sent.stderr}`)) {
    throw new Error(`orca terminal send no envi\u{f3} nada a ${handle}: ${receipt?.refusedReason ?? detail(sent)}. No reintento.`)
  }
  throw new Error(`No hay recibo de entrega de orca terminal send en ${handle}: la l\u{ed}nea pudo haber llegado. No la reenv\u{ed}o; revis\u{e1} la terminal antes de volver a reanudar.`)
}

export const reanudarCommand = async (flags = {}, item, url, io = defaultIo()) => {
  if (!/^\d+$/.test(String(item ?? '')) || !url) throw new Error('Uso: orca-stack reanudar <issue> <url-del-comentario> [--confirmado] [--dry-run].')
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
  const link = COMMENT_URL_ISSUE.exec(url)
  if (!link || link[1].toLowerCase() !== remote.ownerRepo.toLowerCase()) {
    throw new Error(`La URL tiene que apuntar a un comentario de ${remote.ownerRepo}/issues/${n}.`)
  }
  if (link[2] !== n) throw new Error(`La URL apunta a #${link[2]}, no a #${n}: el aviso apunta a la respuesta donde pregunt\u{f3} el worker.`)
  validateAnswerComment(n, url, root, remote, io)

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
  if (attempts[link[3]]) {
    const at = attempts[link[3]].at ?? 'hora desconocida'
    throw new Error(`Ya intent\u{e9} reanudar con el comentario ${link[3]} (${at}); no reenv\u{ed}o ni relanzo. Si ese intento no lleg\u{f3} (mir\u{e1} el estado del agente y su terminal), public\u{e1} una nueva Respuesta de main: en #${n} y corr\u{e9} orca-stack reanudar ${n} <url-del-comentario-nuevo>.`)
  }
  const markAttempt = () => {
    const next = { ...attempts, [link[3]]: { issue: n, at: new Date((io.now ?? Date.now)()).toISOString() } }
    const temp = `${attemptsPath}.${process.pid}.tmp`
    io.mkdirp(path.dirname(attemptsPath))
    io.writeFile(temp, JSON.stringify(next, null, 2) + '\n')
    io.rename(temp, attemptsPath)
    attempts = next
  }

  const prs = io.sh('gh', ['pr', 'list', '--state', 'open', '--json', 'number,closingIssuesReferences,headRefName,body'], { cwd: root })
  const pullRequests = prs.status === 0 ? parse(prs) : undefined
  if (!Array.isArray(pullRequests)) throw new Error(`No pude leer los PRs abiertos de #${n}: ${detail(prs)}`)

  const ours = repoWorktrees(root, io).filter(({ row }) => String(row.linkedIssue) === n)
  if (ours.length === 0) throw new Error(`No encuentro un worktree de este repo para #${n}: no reanudo.`)
  if (ours.length > 1) throw new Error(`Hay ${ours.length} worktrees de este repo para #${n}: no adivino cu\u{e1}l reanudar.`)
  const { row, branch } = ours[0]
  const pr = pullRequests.find(candidate => prMatchesIssue(candidate, n, [branch].filter(Boolean)))
  if (pr) throw new Error(`El issue #${n} ya tiene un PR abierto (#${pr.number}); us\u{e1} \`orca-stack rebote ${pr.number}\`.`)

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
    throw new Error(`El agente de #${n} est\u{e1} working: us\u{e1} \`orca-stack avisar ${n} <url-del-comentario>\`.`)
  }

  const done = agentRecords.filter(agent => stateOf(agent) === 'done')
  if (done.length > 1) throw new Error(`Hay ${done.length} agentes done en el worktree de #${n}: no adivino a cu\u{e1}l reanudar.`)
  const records = paneAgents(row)
  const workers = terminals.map(terminal => ({ terminal, record: records.get(`${terminal.tabId}:${terminal.leafId}`), identity: identityOf(terminal, records.get(`${terminal.tabId}:${terminal.leafId}`)) }))
  const identifiedWorkers = workers.filter(worker => worker.identity)
  if (agentRecords.length === 0) {
    for (const { terminal } of workers) {
      const screen = readScreen(io, terminal.handle)
      const lastLine = screen.filter(line => line.trim() !== '').at(-1) ?? ''
      if (!shellPrompt(lastLine)) {
        throw new Error(`La terminal ${terminal.handle} de #${n} no muestra un shell prompt y Orca no lista su agente: puede haber un worker corriendo sin registro. No relanzo.`)
      }
    }
  }
  const target = done.length === 1
    ? workers.find(worker => worker.record?.paneKey === done[0].paneKey) ?? { record: done[0], identity: done[0].agentType }
    : identifiedWorkers.length === 1 ? identifiedWorkers[0] : undefined
  let agent = target?.identity ?? target?.record?.agentType
  const originalPath = path.join(io.home, 'orca', 'briefs', `${repo}-${n}.md`)
  let originalBrief
  if (!agent && agentRecords.length === 0 && identifiedWorkers.length === 0) {
    if (io.exists(originalPath)) {
      originalBrief = io.readFile(originalPath)
      const match = /^You are the implementer \((\S+)\) of issue #(\d+)\./m.exec(originalBrief)
      if (match?.[2] === n) agent = match[1]
    }
  }
  if (!agent || !AGENTS.includes(agent)) throw new Error(`No puedo identificar un agente conocido para #${n}; no reanudo ni relanzo.`)
  if (!config.agentes?.usa?.includes(agent)) throw new Error(`${agent} no est\u{e1} en agentes.usa de este repo (${(config.agentes?.usa ?? []).join(', ') || 'vac\u{ed}o'}).`)
  const blocked = blockOf(config, agent, (io.now ?? Date.now)())
  if (blocked) throw new Error(`No relanzo a ${agent}: ${blocked}`)
  if ((config.agentes?.preguntarAntes ?? []).includes(agent) && !flags.confirmado) {
    throw new Error(`${agent} figura en agentes.preguntarAntes: main tiene que preguntarle al humano antes de relanzarlo. Si dijo que s\u{ed}, repet\u{ed} el comando con --confirmado.`)
  }

  if (!io.exists(originalPath)) throw new Error(`No encuentro el brief original ${originalPath}; no relanzo sin \u{e9}l.`)

  if (target?.terminal && stateOf(target.record) === 'done') {
    target.worktree = row.path
    const handled = sendToPaused(flags, n, url, originalPath, target, io, markAttempt)
    if (handled) return 0
  }

  const status = io.sh('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: row.path })
  if (status.status !== 0) throw new Error(`No pude comprobar el worktree ${row.path}: ${detail(status)}`)
  if (status.stdout.trim() !== '') throw new Error(`El worktree ${row.path} est\u{e1} sucio; guard\u{e1} o descart\u{e1} sus cambios antes de relanzar.`)

  originalBrief ??= io.readFile(originalPath)
  const brief = `Message from main: ${url}\n\n${originalBrief}`
  const briefPath = path.join(io.home, 'orca', 'briefs', `${repo}-${n}-reanudar.md`)
  if (!flags.dryRun) {
    io.mkdirp(path.dirname(briefPath))
    io.writeFile(briefPath, brief)
    markAttempt()
  }
  const session = `${repo}-${n}-reanudar-${(io.now ?? Date.now)()}`
  await launchInWorktree({ agent, mode: 'ticket', worktree: row.path, briefPath, brief, session, config, win: io.win, home: io.home, skills: agent === 'pi' ? io.gentleSkills(io.home) : null, repositoryRoot: root, io, dryRun: flags.dryRun, piSessionAfter: agent === 'pi' ? (io.now ?? Date.now)() : 0 })

  return 0
}
