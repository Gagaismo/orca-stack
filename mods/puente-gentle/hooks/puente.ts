import type { Intercambio } from '../types'
import { FAMILIES, blockOf, familyOf } from './orca-config'
import type { StackConfig } from './orca-config'

export const READ_ONLY_TOOLS = 'read,grep,find,ls,codemode'
// Variables this session inherits from its Orca terminal. A consult must not carry them: Pi's Orca
// extensions would report as this terminal (Orca then sees this pane as `pi`), and the ORCA_STACK_* markers
// belong to our stack, not to Gentle Shell's. Set over the host environment, an empty value unsets them.
export const ORCA_VARS_CLEARED = [
  'ORCA_AGENT_HOOK_ENDPOINT', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN', 'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION', 'ORCA_AGENT_HOOK_TRANSPORT', 'ORCA_AGENT_LAUNCH', 'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_PANE', 'ORCA_PANE_KEY', 'ORCA_TAB_ID', 'ORCA_WORKTREE_ID', 'ORCA_TERMINAL_HANDLE',
  'ORCA_STACK_AGENT', 'ORCA_STACK_MODE', 'ORCA_STACK_POLICY_PATH', 'ORCA_STACK_PONYTAIL_LEVEL',
  'ORCA_STACK_CAVEMAN_LEVEL',
] as const

// claudeConfigDir: the Claude account Pi's provider (pi-claude-bridge) uses; unset = the host's own.
export const consultEnv = (engramPath: string, claudeConfigDir?: string): Record<string, string> => ({
  ENGRAM_DATA_DIR: engramPath,
  ...Object.fromEntries(ORCA_VARS_CLEARED.map(name => [name, ''])),
  ...(claudeConfigDir === undefined ? {} : { CLAUDE_CONFIG_DIR: claudeConfigDir }),
})

// agentes.pi.claudeConfigDir from the text of the PERSONAL config (~/.orca-stack/config.json) only:
// a committed project file must not redirect where Pi's credentials come from. A leading ~ is the home.
export const piClaudeConfigDir = (personalConfig: string | undefined, home: string): string | undefined => {
  if (personalConfig === undefined) {
    return undefined
  }
  let dir: unknown
  try {
    dir = (JSON.parse(personalConfig.replace(/^﻿/, '')) as { agentes?: { pi?: { claudeConfigDir?: unknown } } })
      .agentes?.pi?.claudeConfigDir
  } catch {
    return undefined
  }
  if (typeof dir !== 'string' || dir.trim() === '') {
    return undefined
  }
  const value = dir.trim()

  if (value === '~') {
    return home
  }

  return value.startsWith('~/') || value.startsWith('~\\') ? joinPath(home, value.slice(2)) : value
}
// Paths are built with the separator the base already uses (C:\Users\x on Windows, /home/x elsewhere).
export const joinPath = (base: string, ...parts: string[]): string => {
  const sep = base.includes('\\') ? '\\' : '/'
  let root = base
  while (root.length > 1 && (root.endsWith('/') || root.endsWith('\\'))) {
    root = root.slice(0, -1)
  }

  return [root, ...parts].join(sep)
}

export const engramDir = (home: string): string => joinPath(home, '.gentle-shell', 'engram')
export const launcherPath = (home: string): string => joinPath(home, '.pi', 'agent', 'bin', 'pi-launcher.js')

// Gentle Shell's own skills (the only ones the consult loads: ~/.agents/skills holds our methodology,
// which Pi would otherwise pick up). Pi's own package dir first, then the npm-global install.
export const skillsInPi = (home: string): string =>
  joinPath(home, '.pi', 'agent', 'npm', 'node_modules', 'gentle-pi', 'skills')
export const skillsInGlobal = (npmRoot: string): string => joinPath(npmRoot.trim(), 'gentle-pi', 'skills')
export const TIMEOUT_MS = 10 * 60 * 1000
export const AUTH_MESSAGE =
  'Gentle Shell no tiene una cuenta conectada: abrí una terminal, corré pi y usá /login.'
export const BIG_PR_LINES = 400
export const MAX_PER_TEMA = 20
export const MAX_TEMAS = 30
export const PLANTEO_STORED = 2000
export const PLANTEO_SENT = 12000

export const MARCO =
  'Claude, otro orquestador del proyecto que trabaja con otra metodología, te consulta como par. ' +
  'Trabajá con tu propio criterio y tu propia forma de trabajar; no adoptes la de quien te consulta. ' +
  'Podés leer el código que necesites (solo lectura). ' +
  'Respondé: cómo leés el problema, en qué coincidís y en qué no y por qué, qué riesgos ves, y qué harías distinto. ' +
  'Si te falta información, decí cuál. ' +
  'Estás en modo no interactivo: no uses herramientas de preguntas al usuario; poné tus preguntas en la respuesta.'

export const section = (humano: string): string =>
  'Gentle Shell (Pi) es otro orquestador, par con otra metodología; consultalo con `consultar_gentle_shell` en los puntos de decisión: ' +
  'elegir entre enfoques, después de una propuesta o diseño, antes de mergear PRs grandes, y cuando la causa de un bug sigue sin estar clara después de un intento.\n' +
  'El planteo va neutral: el problema, las restricciones, nuestra propuesta y los archivos. ' +
  'Si la consulta es sobre un PR o un issue, pasá `pr` o `issue` en vez de pegar el cuerpo, los comentarios o el diff en el planteo: el mod los lee con gh y se los pasa en archivos. ' +
  'No le mandes reglas del stack de Orca ni de nuestra metodología; AGENTS.md lo lee él solo.\n' +
  `Si discrepa en algo material, mostrale ${humano.trim() === '' ? 'al usuario' : `a ${humano.trim()}`} las dos posturas con sus razones; no descartes su opinión por tu cuenta.`

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [recortado]`

// A safe session-id / store key: lowercase, ascii, dashes.
export const slug = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

export const buildMessage = (planteo: string, pregunta: string): string =>
  `## Planteo\n${truncate(planteo.trim(), PLANTEO_SENT)}\n\n## Pregunta\n${pregunta.trim()}`

// Arguments after the launcher: every flag the bridge relies on, in one place.
// --model is only passed when an override is set; otherwise Gentle Shell's own config picks the model.
export const buildArgs = (tema: string, modelo: string, message: string, skills?: string): string[] => [
  '-p',
  '--mode',
  'json',
  '--no-skills',
  ...(skills === undefined ? [] : ['--skill', skills]),
  '--session-id',
  `gentle-${tema}`,
  '--tools',
  READ_ONLY_TOOLS,
  ...(modelo.trim() === '' ? [] : ['--model', modelo.trim()]),
  '--append-system-prompt',
  MARCO,
  message,
]

// ---- preload: an issue or a PR, read with gh by the mod (Pi has no gh) and written to files Pi reads --------------
// The message is a command-line argument, capped near 32767 characters on Windows: preloaded texts never go in it.

export const ISSUE_FIELDS = 'number,title,url,body,comments'
export const PR_FIELDS_PRELOAD = 'number,title,url,baseRefName,headRefOid,body,comments,reviews'

// Absent, or a positive integer: anything else is refused before running gh.
export const preloadInputError = (field: 'pr' | 'issue', value: unknown): string | undefined =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0)
    ? undefined
    : `El campo ${field} tiene que ser un entero positivo; recibí ${JSON.stringify(value)}. No consulté a Gentle Shell.`

export const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? ''

export const readError = (what: 'el PR' | 'el issue', n: number, call: string, detail: string): string =>
  `No pude leer ${what} #${n} con ${call}: ${detail}. No consulté a Gentle Shell.`

export const NOT_JSON = 'la respuesta no es JSON válido'

type Note = { author?: { login?: unknown }; createdAt?: unknown; submittedAt?: unknown; state?: unknown; body?: unknown }
type Entry = { heading: string; at: string; body: string }

export const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const parseObject = (stdout: string): Record<string, unknown> | undefined => {
  try {
    const data: unknown = JSON.parse(stdout)

    return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
const notes = (value: unknown): Note[] => (Array.isArray(value) ? (value as Note[]) : [])
const entry = (heading: string, at: string, body: unknown, state = ''): Entry => ({
  heading: [heading, at, state].filter(part => part !== '').join(' · '),
  at,
  body: str(body).trim(),
})
const entries = (title: string, list: Entry[]): string =>
  `## ${title} (${list.length}), del más viejo al más nuevo\n` +
  [...list]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map(one => `\n### ${one.heading}\n\n${one.body === '' ? '(sin texto)' : one.body}\n`)
    .join('')

// `gh issue view --json number,title,url,body,comments`, as a file; undefined when it is not a JSON object.
export const issueFile = (stdout: string): string | undefined => {
  const data = parseObject(stdout)
  if (data === undefined) {
    return undefined
  }
  const comments = notes(data['comments']).map(one => entry(str(one.author?.login), str(one.createdAt), one.body))

  return `# Issue #${String(data['number'])}: ${str(data['title'])}\n\nURL: ${str(data['url'])}\n\n## Cuerpo\n\n${str(data['body']).trim()}\n\n${entries('Comentarios', comments)}`
}

// `gh pr view --json number,title,url,baseRefName,headRefOid,body,comments,reviews`, as a file with its head commit;
// undefined when it is not a JSON object with a head commit.
export const prFile = (stdout: string): { text: string; headRefOid: string } | undefined => {
  const data = parseObject(stdout)
  const headRefOid = str(data?.['headRefOid'])
  if (data === undefined || headRefOid === '') {
    return undefined
  }
  const list = [
    ...notes(data['comments']).map(one => entry(`Comentario de ${str(one.author?.login)}`, str(one.createdAt), one.body)),
    ...notes(data['reviews']).map(one => entry(`Review de ${str(one.author?.login)}`, str(one.submittedAt), one.body, str(one.state))),
  ]
  const text =
    `# PR #${String(data['number'])}: ${str(data['title'])}\n\n` +
    `URL: ${str(data['url'])}\nRama base: ${str(data['baseRefName'])}\nCommit de cabeza: ${headRefOid}\n\n` +
    `## Cuerpo\n\n${str(data['body']).trim()}\n\n${entries('Comentarios y reviews', list)}`

  return { text, headRefOid }
}

// The .diff file when `gh pr diff` gave nothing usable: why, and the files of `gh pr view <n> --json files` if it answered.
export const diffUnavailable = (n: number, detail: string, filesStdout: string | undefined): string => {
  const files = filesStdout === undefined ? [] : notes(parseObject(filesStdout)?.['files'])
  const list = (files as { path?: unknown; additions?: unknown; deletions?: unknown }[])
    .map(one => `- ${str(one.path)} (+${String(one.additions ?? 0)} -${String(one.deletions ?? 0)})\n`)
    .join('')

  return `diff no disponible: ${detail}\n${list === '' ? '' : `\nArchivos del PR (gh pr view ${n} --json files):\n${list}`}`
}

// The one section the message gains: where the files are and, for a PR, its full head commit.
export const precargaSection = (paths: string[], head?: { pr: number; headRefOid: string }): string =>
  '## Precarga\n' +
  'Lo que sigue lo leyó el mod de GitHub con gh antes de lanzarte (vos no tenés gh); leé estos archivos con read:\n' +
  paths.map(path => `- ${path}\n`).join('') +
  (head === undefined ? '' : `Commit de cabeza del PR #${head.pr}: ${head.headRefOid}\n`)

type Block = { type?: string; text?: string }
type Message = {
  role?: string
  content?: unknown
  stopReason?: string
  errorMessage?: string
}

const textOf = (message: Message): string => {
  if (typeof message.content === 'string') {
    return message.content
  }
  if (!Array.isArray(message.content)) {
    return ''
  }

  return (message.content as Block[])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

export type Parsed = { text: string; error?: string }

type StreamEvent = {
  type?: string
  message?: Message
  assistantMessageEvent?: { type?: string; delta?: string }
}

// The JSONL stream: the last completed assistant message is the answer (message_end is authoritative).
export const parseStream = (stdout: string): Parsed => {
  let last: Message | undefined
  let deltas = ''
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) {
      continue
    }
    let event: StreamEvent
    try {
      event = JSON.parse(line) as StreamEvent
    } catch {
      continue
    }
    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      deltas = ''
    } else if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      deltas += event.assistantMessageEvent.delta ?? ''
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      last = event.message
    }
  }
  if (last === undefined) {
    return { text: deltas.trim() }
  }
  const text = textOf(last).trim() || deltas.trim()
  if (last.stopReason === 'error' || last.stopReason === 'aborted') {
    return { text, error: last.errorMessage ?? `Gentle Shell terminó con ${last.stopReason}` }
  }

  return { text }
}

const AUTH = /no api key|\/login|not logged|unauthori[sz]ed|\b401\b|invalid api key|authentication|credential/i

export const isAuthError = (text: string): boolean => AUTH.test(text)

export type Outcome = { ok: true; respuesta: string } | { ok: false; error: string }

export const interpret = (run: { exitCode: number; stdout: string; stderr: string }): Outcome => {
  const parsed = parseStream(run.stdout)
  const diagnostics = `${run.stderr}\n${parsed.error ?? ''}`
  if (isAuthError(diagnostics)) {
    return { ok: false, error: AUTH_MESSAGE }
  }
  if (run.exitCode !== 0 || parsed.error !== undefined) {
    const detail = truncate((parsed.error ?? run.stderr).trim().split('\n')[0] ?? '', 300)

    return { ok: false, error: `Gentle Shell falló (salida ${run.exitCode})${detail ? `: ${detail}` : ''}` }
  }
  if (parsed.text === '') {
    return { ok: false, error: 'Gentle Shell no devolvió texto.' }
  }

  return { ok: true, respuesta: parsed.text }
}

// /pi <tema>: <pregunta>  - or just a question, whose first words become the tema.
export const parsePiArgs = (args: string): { tema: string; pregunta: string } | undefined => {
  const text = args.trim()
  if (text === '') {
    return undefined
  }
  const prefixed = /^([A-Za-z0-9._-]{1,40})\s*:\s*([\s\S]+)$/.exec(text)
  if (prefixed?.[1] !== undefined && prefixed[2] !== undefined) {
    const tema = slug(prefixed[1])
    if (tema !== '') {
      return { tema, pregunta: prefixed[2].trim() }
    }
  }
  const derived = slug(text.split(/\s+/).slice(0, 4).join(' '))

  return { tema: derived === '' ? 'consulta' : derived, pregunta: text }
}

export const piPrompt = (tema: string, pregunta: string): string =>
  `Consultá a Gentle Shell (tema ${tema}) sobre: ${pregunta}. ` +
  'Usá consultar_gentle_shell con un planteo neutral y después mostrame las dos posturas.'

// ---- stored exchanges -------------------------------------------------------

export type Memoria = Record<string, Intercambio[]>

export const loadMemoria = (kept: unknown): Memoria =>
  kept !== null && typeof kept === 'object' && !Array.isArray(kept) ? (kept as Memoria) : {}

export const remember = (memoria: Memoria, tema: string, item: Intercambio): Memoria => {
  const next: Memoria = { ...memoria, [tema]: [item, ...(memoria[tema] ?? [])].slice(0, MAX_PER_TEMA) }
  const newest = (key: string): number => next[key]?.[0]?.at ?? 0
  const kept = Object.keys(next)
    .sort((a, b) => newest(b) - newest(a))
    .slice(0, MAX_TEMAS)

  return Object.fromEntries(kept.map(key => [key, next[key] ?? []]))
}

// Temas newest first, for the pane.
export const vista = (memoria: Memoria): { tema: string; items: Intercambio[] }[] =>
  Object.entries(memoria)
    .map(([tema, items]) => ({ tema, items }))
    .sort((a, b) => (b.items[0]?.at ?? 0) - (a.items[0]?.at ?? 0))

// ---- merge gate -------------------------------------------------------------

// Split a command on && || ; | and newlines, outside quotes.
export const segments = (command: string): string[] => {
  const out: string[] = []
  let current = ''
  let quote = ''
  for (const ch of command) {
    if (quote !== '') {
      current += ch
      if (ch === quote) {
        quote = ''
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === '&' || ch === '|' || ch === ';' || ch === '\n' || ch === '\r') {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)

  return out.map(one => one.trim()).filter(one => one !== '')
}

const words = (segment: string): string[] =>
  (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(word => word.replace(/^["']|["']$/g, ''))

const VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit'])
const REPO_FLAGS = new Set(['-R', '--repo'])

export type Merge = { number: string; repo?: string }

// Every `gh pr merge <n>` in the command; a merge without a number is skipped.
export const merges = (command: string): Merge[] => {
  const found: Merge[] = []
  for (const segment of segments(command)) {
    const w = words(segment)
    if (w[0] !== 'gh' && w[0] !== 'gh.exe') {
      continue
    }
    let repo: string | undefined
    const rest: string[] = []
    for (let i = 1; i < w.length; i += 1) {
      const word = w[i] ?? ''
      if (REPO_FLAGS.has(word)) {
        repo = w[i + 1]
        i += 1
      } else if (word.startsWith('--repo=')) {
        repo = word.slice(7)
      } else {
        rest.push(word)
      }
    }
    if (rest[0] !== 'pr' || rest[1] !== 'merge') {
      continue
    }
    for (let i = 2; i < rest.length; i += 1) {
      const word = rest[i] ?? ''
      if (VALUE_FLAGS.has(word)) {
        i += 1
        continue
      }
      const match = /^(\d+)$/.exec(word) ?? /\/pull\/(\d+)/.exec(word)
      if (match?.[1] !== undefined) {
        found.push(repo === undefined ? { number: match[1] } : { number: match[1], repo })
        break
      }
    }
  }

  return found
}

export const bigPrReason = (n: string, total: number): string =>
  `PR #${n} grande (${total} líneas): consultá a Gentle Shell (tema pr-${n}) antes de mergear.`

export const prSize = (stdout: string): number | undefined => {
  try {
    const data = JSON.parse(stdout) as { additions?: unknown; deletions?: unknown }
    if (typeof data.additions === 'number' && typeof data.deletions === 'number') {
      return data.additions + data.deletions
    }
  } catch {
    // fall through
  }

  return undefined
}

// ---- risk-path trigger ------------------------------------------------------------------------

// Minimal glob: * and ? stay inside one path segment, ** crosses segments, `**/` may match nothing,
// a trailing / means "everything under". Node 20 has no path.matchesGlob.
export const globToRegExp = (glob: string): RegExp => {
  const g = glob.endsWith('/') ? `${glob}**` : glob
  let out = ''
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i] ?? ''
    if (ch === '*' && g[i + 1] === '*') {
      i += 1
      if (g[i + 1] === '/') {
        i += 1
        out += '(?:.*/)?'
      } else {
        out += '.*'
      }
    } else if (ch === '*') {
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }

  return new RegExp(`^${out}$`)
}

export const riskyFile = (files: string[], globs: string[]): string | undefined => {
  const patterns = globs.filter(one => typeof one === 'string' && one.trim() !== '').map(one => globToRegExp(one.trim()))

  return files.find(file => patterns.some(pattern => pattern.test(file.replace(/\\/g, '/'))))
}

export type PrFacts = { files: string[]; headRefOid: string; bodies: string[]; implementer: string | undefined }

// Same parse as src/despacho.mjs (revisar): the first `Implementador: <agent>` line of the PR body, lowercased.
export const implementerOf = (body: string): string | undefined =>
  /^\s*Implementador:\s*(\S+)/im.exec(body)?.[1]?.trim().toLowerCase()

// `gh pr view --json files,headRefOid,body,comments,reviews`: `gh pr review --comment` bodies live in `reviews`,
// plain PR comments in `comments`. The PR body only says who implemented it; it is never a review.
export const prFacts = (stdout: string): PrFacts | undefined => {
  try {
    const data = JSON.parse(stdout) as {
      files?: { path?: unknown }[]
      headRefOid?: unknown
      body?: unknown
      comments?: { body?: unknown }[]
      reviews?: { body?: unknown }[]
    }
    if (typeof data.headRefOid !== 'string' || !Array.isArray(data.files)) {
      return undefined
    }
    const bodies = [...(data.comments ?? []), ...(data.reviews ?? [])]
      .map(one => one?.body)
      .filter((body): body is string => typeof body === 'string')

    return {
      files: data.files.map(one => one?.path).filter((path): path is string => typeof path === 'string'),
      headRefOid: data.headRefOid,
      bodies,
      implementer: typeof data.body === 'string' ? implementerOf(data.body) : undefined,
    }
  } catch {
    return undefined
  }
}

export type Review = { reviewer: string; clean: boolean }

// The reviews of exactly this commit: `Revisor: <agent>` and `Commit: <sha>` among the first lines of one body (the
// sha may be abbreviated to 7+ characters). Clean: the first non-empty line after `## BLOQUEA` is `nada`.
export const reviewsOf = (bodies: string[], headRefOid: string): Review[] =>
  bodies.flatMap(body => {
    const lines = body.split(/\r?\n/).map(line => line.trim())
    const head = lines.slice(0, 5)
    const reviewer = head.map(line => /^Revisor:\s*(\S+)$/i.exec(line)?.[1]).find(name => name !== undefined)
    const commit = head.map(line => /^Commit:\s*([0-9a-f]{7,40})$/i.exec(line)?.[1]).find(sha => sha !== undefined)
    if (reviewer === undefined || commit === undefined || !headRefOid.toLowerCase().startsWith(commit.toLowerCase())) {
      return []
    }
    const at = lines.findIndex(line => /^##\s*BLOQUEA\b/i.test(line))
    const verdict = at < 0 ? undefined : lines.slice(at + 1).find(line => line !== '')

    return [{ reviewer: reviewer.toLowerCase(), clean: verdict?.toLowerCase() === 'nada' }]
  })

// Why a PR touching a riesgo path cannot merge yet, or undefined. Every review counted is of the head commit.
// - A review of the head commit with blockers stops it: on a riesgo path the human settles a blocker, not main.
// - Implemented by pi: clean reviews from two model families other than pi's. A family comes from the model each
//   reviewer has configured to review (familyOf); a reviewer whose model has no known family does not count.
// - Implemented by anyone else: a clean pi review, the second review the contract asks for.
export const riskDeny = (n: string, file: string, facts: PrFacts, config: StackConfig, now: number): string | undefined => {
  const sha = facts.headRefOid.slice(0, 7)
  const prefix = `PR #${n} toca una ruta de riesgo (${file})`
  const agents: readonly string[] = FAMILIES.agents
  if (facts.implementer === undefined || !agents.includes(facts.implementer)) {
    return (
      `${prefix} y su body no tiene una línea "Implementador: <agente>" con uno de ${agents.join(', ')}: ` +
      `sin ella no sé quién puede revisarlo. Agregala con \`gh pr edit ${n} --body-file <archivo>\`.`
    )
  }
  const reviews = reviewsOf(facts.bodies, facts.headRefOid)
  const blocked = reviews.find(review => !review.clean)
  if (blocked !== undefined) {
    return (
      `${prefix} y el review de ${blocked.reviewer} sobre el commit ${sha} tiene bloqueos. ` +
      'En una ruta de riesgo un bloqueo no se salda con "Decidido por main": corregilo y pedí un review nuevo, o pasale la decisión al humano.'
    )
  }
  const reviewers = [...new Set(reviews.map(review => review.reviewer))]
  if (facts.implementer !== 'pi') {
    return reviewers.includes('pi')
      ? undefined
      : `${prefix}: falta un review de pi sobre el commit ${sha}. Corré \`orca-stack revisar ${n} pi\` y mergeá cuando el review esté limpio.`
  }

  const own = familyOf(config, 'pi', 'ticket').family
  const covered = new Set<string>()
  const skipped: string[] = []
  for (const reviewer of reviewers) {
    const { family, model } = familyOf(config, reviewer, 'review')
    if (!agents.includes(reviewer)) {
      skipped.push(`${reviewer}: no es un agente del stack`)
    } else if (family === undefined && model === undefined) {
      skipped.push(`${reviewer}: no tiene modelo para revisar en agentes.modelos, así que no sé su familia`)
    } else if (family === undefined) {
      skipped.push(`${reviewer}: su modelo ${model} no tiene una familia reconocida (agregá su patrón en FAMILIES)`)
    } else if (family !== own) {
      covered.add(family)
    }
  }
  if (covered.size >= 2) {
    return undefined
  }

  // Who can still add a family: in agentes.usa (as revisar reads it), not blocked, with a known family that is neither
  // pi's nor covered. Within a family, an agent that needs no OK from the human goes first.
  const usa = config.agentes?.usa ?? []
  const ask = config.agentes?.preguntarAntes ?? []
  const options = new Map<string, string>()
  for (const agent of agents) {
    const { family } = familyOf(config, agent, 'review')
    if (usa.includes(agent) && blockOf(config, agent, now) === undefined && family !== undefined && family !== own && !covered.has(family)) {
      const current = options.get(family)
      if (current === undefined || (ask.includes(current) && !ask.includes(agent))) options.set(family, agent)
    }
  }
  const have = covered.size === 0 ? 'Hay 0' : `Hay 1 (${[...covered].join(', ')})`
  const notCounted = skipped.length === 0 ? '' : ` No cuento ${skipped.join('; ')}.`
  const missing = 2 - covered.size
  const picks = [...options.values()].slice(0, missing)
  const next =
    picks.length < missing
      ? ` Con los agentes disponibles (agentes.usa, sin bloqueos) no alcanzan las familias: decidilo con el humano.`
      : ` Corré ${picks.map(agent => `\`orca-stack revisar ${n} ${agent}\``).join(' y ')}.` +
        picks.filter(agent => ask.includes(agent)).map(agent => ` ${agent} está en preguntarAntes: pedile el OK al humano y agregá --confirmado.`).join('')

  return (
    `${prefix} y lo escribió pi: faltan reviews limpios sobre el commit ${sha} de dos familias de modelo distintas ` +
    `que no sean la de pi (${own ?? '?'}). ${have}.${notCounted}${next}`
  )
}

export const clock = (at: number): string => {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')

  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
