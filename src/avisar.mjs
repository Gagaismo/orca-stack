import { getCommonDir, getStackAccount } from './consultas.mjs'
import { AGENTS, defaultIo, getRemoteOrigin, shellPrompt } from './despacho.mjs'
import { samePath } from './util.mjs'

// Agents whose TUI takes a line typed during a running turn. codex and agy join once their mid-turn Enter test passes
// (#166, UNKNOWN / MUST VERIFY); Pi runs headless (`pi -p`) and has no TUI to ring.
export const AVISAR_AGENTS = ['claude']

export const doorbellLine = url => `Message from main: ${url}`

const COMMENT_URL = /^https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)$/
// Orca's agent states: working, or blocked/waiting (a permission or question dialog), or done.
const LIVE = ['working', 'blocked', 'waiting']
// Claude's spinner while a turn runs ("✢ Churning… (1m 2s · ↓ 3k tokens)"); a settled turn reads "✻ Baked for 2m 5s".
// A positive signal: if a Claude release changes it, avisar refuses instead of typing into an unknown screen.
const TURN_RUNNING = /^\s*[·✢✳✶✻✽]\s+\S[^\n]*…\s*\(\d+[smh]/mu
const DIALOG = /trust this folder\?|Do you want to proceed\?|Esc to cancel/i
// The spinner and dialogs render at the bottom; the transcript above them may quote the same words.
const SPINNER_LINES = 25
const DIALOG_LINES = 15

const parse = res => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    return undefined
  }
}
const detail = res => (res.stderr || res.stdout || String(res.error ?? '')).trim().split(/\r?\n/)[0]
const paneKey = terminal => `${terminal.tabId}:${terminal.leafId}`

const worktreeRows = io => {
  const res = io.sh('orca', ['worktree', 'ps', '--json'])
  const rows = res.status === 0 ? parse(res)?.result?.worktrees : undefined
  if (!Array.isArray(rows)) throw new Error(`Orca no contesta (orca worktree ps): ${detail(res)}`)

  return rows
}
const rowAt = (rows, worktree) => rows.find(row => row.path && samePath(row.path, worktree))
const paneAgents = row => new Map((row?.agents ?? []).map(agent => [agent.paneKey, agent]))

// Orca's `issue:<n>` and `branch:<head>` selectors span every repo Orca manages, so a worker's worktree is picked among
// this repo's own worktrees (`git worktree list`), as despachar and guardia-despacho do (#191): Orca's rows, each with
// its git branch.
export const repoWorktrees = (root, io) => {
  const listed = io.sh('git', ['worktree', 'list', '--porcelain'], { cwd: root })
  if (listed.status !== 0) throw new Error(`git worktree list falló: ${detail(listed)}`)
  const mine = listed.stdout.split(/\r?\n\s*\r?\n/).map(entry => ({ path: /^worktree (.+)$/m.exec(entry)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] })).filter(entry => entry.path)

  return worktreeRows(io).flatMap(row => {
    const git = row.path ? mine.find(entry => samePath(entry.path, row.path)) : undefined
    return git ? [{ row, branch: git.branch }] : []
  })
}

// The worktree is linked to its issue; a rebote author is reached through the PR's branch.
const workerWorktree = (n, root, io) => {
  const ours = repoWorktrees(root, io)
  let hits = ours.filter(({ row }) => String(row.linkedIssue) === n)
  if (hits.length === 0) {
    const pr = io.sh('gh', ['pr', 'view', n, '--json', 'headRefName'], { cwd: root })
    const head = pr.status === 0 ? parse(pr)?.headRefName : undefined
    hits = head ? ours.filter(({ branch }) => branch === head) : []
  }
  if (hits.length === 0) throw new Error(`No encuentro un worktree de este repo para #${n}, ni enlazado al issue ni en la rama de un PR: no aviso.`)
  if (hits.length > 1) throw new Error(`Hay ${hits.length} worktrees de este repo para #${n} (${hits.map(({ row }) => row.path).join(', ')}): no adivino cuál.`)

  return hits[0].row
}

const workerTerminals = (worktree, n, io) => {
  const res = io.sh('orca', ['terminal', 'list', '--worktree', `path:${worktree}`, '--json'])
  const terminals = res.status === 0 ? parse(res)?.result?.terminals : undefined
  if (!Array.isArray(terminals)) throw new Error(`orca terminal list falló para #${n}: ${detail(res)}`)
  // Fail closed: a terminal that does not name its worktree, or names another one, is never a target.
  const stray = terminals.find(terminal => !terminal.worktreePath || !samePath(terminal.worktreePath, worktree))
  if (stray) throw new Error(`Orca devolvió la terminal ${stray.handle} con worktreePath ${stray.worktreePath ?? '(ninguno)'}, no ${worktree}: no aviso.`)

  return terminals
}

// The title fallback (despachar names the terminal after its agent) only picks a target together with a live Orca
// agent record: a dead terminal keeps that title.
const identityOf = (terminal, record) => terminal.agentIdentity ?? record?.agentType ?? (AGENTS.includes(terminal.title) ? terminal.title : undefined)

const readScreen = (io, handle) => {
  const res = io.sh('orca', ['terminal', 'read', '--terminal', handle, '--screen', '--json'])
  const tail = res.status === 0 ? parse(res)?.result?.terminal?.tail : undefined
  if (tail === undefined) throw new Error(`No pude leer la pantalla de ${handle}: ${detail(res)}`)

  return (Array.isArray(tail) ? tail.join('\n') : String(tail)).split(/\r?\n/)
}

export const avisarCommand = async (flags = {}, item, url, io = defaultIo()) => {
  const say = io.out
  if (!/^\d+$/.test(String(item ?? '')) || !url) throw new Error('Uso: orca-stack avisar <issue|pr> <url-del-comentario>.')
  const n = String(Number(item))
  const { root } = getCommonDir(io)
  const remote = getRemoteOrigin(root, io)
  const match = COMMENT_URL.exec(url)
  if (!match || match[1].toLowerCase() !== remote.ownerRepo.toLowerCase()) {
    throw new Error(`La URL tiene que ser la de un comentario de ${remote.ownerRepo} (…/issues/<n>#issuecomment-<id> o …/pull/<n>#issuecomment-<id>): ${url}`)
  }
  if (match[2] !== n) throw new Error(`La URL apunta a #${match[2]}, no a #${n}: el aviso apunta a la respuesta donde preguntó el worker.`)

  // Every session shares one gh account, so a comment by any other account is not main's (#128, decision 7).
  const res = io.sh('gh', ['api', `repos/${remote.ownerRepo}/issues/comments/${match[3]}`], { cwd: root })
  const comment = res.status === 0 ? parse(res) : undefined
  if (!comment) throw new Error(`No pude leer el comentario ${url}: ${detail(res)}`)
  const author = String(comment.user?.login ?? '').trim().toLowerCase()
  const stack = getStackAccount(io)
  if (author !== stack) throw new Error(`El comentario es de ${author || '(cuenta desconocida)'}, no de la cuenta del stack (${stack}): no aviso.`)
  // The same account also posts the workers' `Consulta:` and the `Rebote:` markers: only an answer carries a marker.
  if (!/^(?:Respuesta de main:|Respuesta del humano:)/.test(String(comment.body ?? '').trimStart())) {
    throw new Error('El comentario no empieza con `Respuesta de main:` ni `Respuesta del humano:`: no es una respuesta para el worker. No aviso.')
  }
  // The worker opens the URL itself: it must be the comment's real address (host, item and id), not one that only parses.
  if (String(comment.html_url ?? '').toLowerCase() !== url.toLowerCase()) {
    throw new Error(`El comentario ${match[3]} está en ${comment.html_url ?? '(sin URL)'}: la URL no apunta a donde dice.`)
  }

  const worktree = workerWorktree(n, root, io)
  const records = paneAgents(worktree)
  const workers = workerTerminals(worktree.path, n, io).map(terminal => {
    const record = records.get(paneKey(terminal))
    return { terminal, record, identity: identityOf(terminal, record) }
  })
  const live = workers.filter(worker => LIVE.includes(worker.record?.state))
  if (live.length > 1) throw new Error(`Hay ${live.length} terminales con un agente vivo en #${n} (${live.map(worker => worker.terminal.handle).join(', ')}): no adivino a cuál avisar.`)
  const target = live[0]
  // Headless Pi may have no live Orca record, so without a live target any Pi terminal of the worktree decides.
  if (target ? target.identity === 'pi' : workers.some(worker => worker.identity === 'pi')) {
    throw new Error(`El worker de #${n} es Pi, que corre sin TUI (pi -p): no hay terminal donde avisar. Pi relee los comentarios antes de abrir su PR.`)
  }
  const unsupported = target ? (AVISAR_AGENTS.includes(target.identity) ? undefined : target.identity ?? '(agente desconocido)') : workers.find(worker => worker.identity && !AVISAR_AGENTS.includes(worker.identity))?.identity
  if (unsupported) {
    throw new Error(`avisar todavía no toca la terminal de ${unsupported}: falta su prueba de Enter a mitad de turno. Por ahora solo avisa a ${AVISAR_AGENTS.join(', ')}.`)
  }
  if (!target) {
    if (workers.some(worker => worker.record?.state === 'done')) {
      throw new Error(`El turno del worker de #${n} ya terminó: no aviso, para no arrancarle un turno nuevo. El worker relee los comentarios antes de abrir su PR.`)
    }
    throw new Error(`No hay un agente vivo en las terminales de #${n} (un shell, o el worker ya salió): no aviso.`)
  }

  const { handle } = target.terminal
  if (target.record.state !== 'working') throw new Error(`La terminal ${handle} de #${n} muestra un diálogo (${target.record.state}): no aviso encima.`)
  const screen = readScreen(io, handle)
  const lastLine = screen.filter(line => line.trim() !== '').at(-1) ?? ''
  if (shellPrompt(lastLine)) throw new Error(`La terminal ${handle} de #${n} muestra un shell prompt: el worker ya no está en su TUI. No aviso.`)
  if (DIALOG.test(screen.slice(-DIALOG_LINES).join('\n'))) throw new Error(`La terminal ${handle} de #${n} muestra un diálogo: no aviso encima.`)
  if (!TURN_RUNNING.test(screen.slice(-SPINNER_LINES).join('\n'))) throw new Error(`No veo el turno en curso en la pantalla de ${handle} (#${n}): pudo haber terminado. No aviso.`)
  // Read the state again right before sending: it shrinks the window in which the turn settles or a dialog opens.
  const now = paneAgents(rowAt(worktreeRows(io), worktree.path)).get(paneKey(target.terminal))?.state
  if (now !== 'working') throw new Error(`El agente de ${handle} cambió a ${now ?? 'sin estado'} mientras lo revisaba: no aviso.`)

  const line = doorbellLine(url)
  const argv = ['terminal', 'send', '--terminal', handle, '--text', line, '--enter', '--wait-submit', '10', '--json']
  if (flags.dryRun) {
    say(`[simulación] orca ${argv.map(arg => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`)
    say(`Terminal: ${handle} (${target.terminal.title ?? 'sin título'}), worker de #${n} en ${worktree.path}`)
    say(`Línea: ${line}`)

    return 0
  }

  // One send, never repeated: a second one could type the line twice or press Enter on a dialog.
  const sent = io.sh('orca', argv)
  const receipt = parse(sent)?.result?.send
  const prompt = receipt?.prompt
  const stages = Array.isArray(prompt?.stages) ? prompt.stages : []
  if (sent.status === 0 && receipt?.accepted === true && prompt?.requestId && stages.includes('input_accepted') && prompt.observation === 'supported') {
    say(`✔ Aviso enviado a ${handle} (#${n}): ${line}`)
    if (stages.includes('turn_started')) say(`⚠ Orca vio un turno nuevo: si el turno del worker ya había terminado, la línea arrancó uno.`)

    return 0
  }
  if (receipt?.accepted === false || /No input was sent/i.test(`${sent.stdout}${sent.stderr}`)) {
    throw new Error(`orca terminal send no envió nada a ${handle}: ${receipt?.refusedReason ?? detail(sent)}. No reintento.`)
  }
  const observed = prompt?.observation ? ` (observation: ${prompt.observation})` : ''
  const dialog = prompt?.observation === 'permission' ? ' El Enter pudo haber confirmado un diálogo.' : ''
  throw new Error(`No hay recibo de entrega de orca terminal send en ${handle}${observed}: la línea pudo haber llegado. No la reenvío; revisá la terminal antes de volver a avisar.${dialog}`)
}
