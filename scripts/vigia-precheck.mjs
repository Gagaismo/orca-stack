import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MATCHING_COMMENT_RE = /^\s*(?:Consulta|Diagn[óo?]stico):/
// Keep gh well under Orca's 60-second precheck timeout (#515).
const DEFAULT_TIMEOUT_MS = 25_000
const MAX_SEEN_IDS = 5000

const isFile = p => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const which = (name, env = process.env) => {
  const win = process.platform === 'win32'
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  const exts = win ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  const hasExt = win && path.extname(name) !== ''
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = path.join(dir, name + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

const quoteWin = arg => (/[\s"&|<>^%]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)

const execGhDefault = (args, timeout) => {
  const cmd = which('gh') ?? 'gh'
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
  const options = {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }
  const result = viaShell
    ? spawnSync([quoteWin(cmd), ...args.map(quoteWin)].join(' '), { ...options, shell: true })
    : spawnSync(cmd, args, options)
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  }
}

const defaultIo = () => ({
  cwd: process.cwd(),
  execGh: execGhDefault,
  readFile: file => readFileSync(file, 'utf8'),
  writeFile: (file, text) => writeFileSync(file, text, 'utf8'),
  rename: (from, to) => renameSync(from, to),
  mkdirp: dir => mkdirSync(dir, { recursive: true }),
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
})

const parseArgs = argv => {
  let reposRaw
  let statePath
  let timeout = DEFAULT_TIMEOUT_MS
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repos') {
      if (i + 1 >= argv.length) throw new Error('falta el valor de --repos')
      reposRaw = argv[++i]
    } else if (arg === '--state') {
      if (i + 1 >= argv.length) throw new Error('falta el valor de --state')
      statePath = argv[++i]
    } else if (arg === '--timeout') {
      if (i + 1 >= argv.length) throw new Error('falta el valor de --timeout')
      const raw = argv[++i]
      if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`--timeout inválido: ${raw}`)
      timeout = Number(raw)
    } else {
      throw new Error(`argumento no reconocido: ${arg}`)
    }
  }
  if (!reposRaw) throw new Error('falta --repos <owner/repo,...>')
  if (!statePath) throw new Error('falta --state <ruta>')
  const repos = reposRaw.split(',').map(s => s.trim()).filter(Boolean)
  if (repos.length === 0) throw new Error('--repos no puede estar vacío')
  for (const repo of repos) {
    if (!REPO_RE.test(repo)) throw new Error(`repositorio inválido: ${repo}`)
  }
  return { repos, statePath, timeout }
}

const buildQuery = repos => {
  const fields = repos.map((repo, index) => {
    const [owner, name] = repo.split('/')
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
  issues(first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number comments(last: 10) { nodes { databaseId body } } }
  }
  pullRequests(first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number comments(last: 10) { nodes { databaseId body } } }
  }
  openPrs: pullRequests(first: 50, states: OPEN) {
    nodes { number headRefOid mergeable }
  }
}`
  }).join('\n')
  return `query {\n${fields}\n}`
}

const collectComments = (nodes, ids) => {
  for (const item of nodes ?? []) {
    for (const comment of item?.comments?.nodes ?? []) {
      if (typeof comment?.body === 'string' && comment.databaseId != null && MATCHING_COMMENT_RE.test(comment.body)) {
        ids.add(String(comment.databaseId))
      }
    }
  }
}

const extractSnapshot = (data, repos) => {
  const commentIds = new Set()
  const conflicts = new Set()
  for (let i = 0; i < repos.length; i += 1) {
    const node = data?.[`r${i}`]
    if (!node) throw new Error(`la respuesta de GitHub no trae ${repos[i]}`)
    collectComments(node.issues?.nodes, commentIds)
    collectComments(node.pullRequests?.nodes, commentIds)
    for (const pr of node.openPrs?.nodes ?? []) {
      if (pr?.mergeable === 'CONFLICTING' && pr.number != null && pr.headRefOid) {
        conflicts.add(`${repos[i]}#${pr.number}@${pr.headRefOid}`)
      }
    }
  }
  return {
    commentIds: [...commentIds].sort(),
    conflicts: [...conflicts].sort(),
  }
}

const readPreviousState = (file, io) => {
  try {
    const parsed = JSON.parse(io.readFile(file))
    if (!parsed || !Array.isArray(parsed.seenCommentIds) || !Array.isArray(parsed.conflictingPrs)) return null
    return {
      seenCommentIds: parsed.seenCommentIds.map(String),
      conflictingPrs: parsed.conflictingPrs.map(String),
    }
  } catch {
    return null
  }
}

const saveState = (file, state, io) => {
  try {
    io.mkdirp(path.dirname(file))
    const tmp = `${file}.${process.pid}.tmp`
    io.writeFile(tmp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`)
    io.rename(tmp, file)
  } catch (error) {
    io.err(`vigia-precheck: no pude guardar ${file} (${error.message}): la próxima corrida tampoco se saltea`)
  }
}

// Fail open with exit 0 so Orca launches the agent instead of skipping forever (#515).
export const runVigiaPrecheck = (argv, io = defaultIo()) => {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    io.err(`vigia-precheck: ${error.message}; sigue la automatización para que el agente lo informe`)
    return 0
  }

  let snapshot
  try {
    const res = io.execGh(['api', 'graphql', '-f', `query=${buildQuery(opts.repos)}`], opts.timeout)
    if (res.error) throw res.error
    if (res.status !== 0) {
      const detail = (res.stderr || res.stdout || `gh salió con ${res.status}`).trim().split('\n')[0]
      throw new Error(detail)
    }
    const parsed = JSON.parse(res.stdout)
    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
      throw new Error(parsed.errors[0]?.message ?? 'error de GraphQL')
    }
    snapshot = extractSnapshot(parsed?.data, opts.repos)
  } catch (error) {
    io.err(`vigia-precheck: no pude consultar GitHub (${error.message}); sigue la automatización para que el agente lo informe`)
    return 0
  }

  const stateFile = path.resolve(io.cwd, opts.statePath)
  const prev = readPreviousState(stateFile, io)
  if (!prev) {
    saveState(stateFile, { seenCommentIds: snapshot.commentIds, conflictingPrs: snapshot.conflicts }, io)
    io.out('vigia-precheck: primera corrida, sigue la automatización')
    return 0
  }

  const prevSeen = new Set(prev.seenCommentIds)
  const prevConflicts = new Set(prev.conflictingPrs)
  const newComments = snapshot.commentIds.filter(id => !prevSeen.has(id))
  const newConflicts = snapshot.conflicts.filter(key => !prevConflicts.has(key))

  const mergedSeen = new Set(prev.seenCommentIds)
  for (const id of snapshot.commentIds) {
    mergedSeen.delete(id)
    mergedSeen.add(id)
  }
  const nextState = {
    seenCommentIds: [...mergedSeen].slice(-MAX_SEEN_IDS),
    conflictingPrs: snapshot.conflicts,
  }

  if (newComments.length > 0 || newConflicts.length > 0) {
    saveState(stateFile, nextState, io)
    io.out(`vigia-precheck: novedades en GitHub (${newComments.length} comentarios, ${newConflicts.length} conflictos nuevos), sigue la automatización`)
    return 0
  }

  if (snapshot.conflicts.length !== prevConflicts.size || snapshot.conflicts.some(key => !prevConflicts.has(key))) {
    saveState(stateFile, nextState, io)
  }
  io.out('vigia-precheck: sin novedades en GitHub desde la última corrida, Orca la saltea')
  return 1
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
const isDirect = Boolean(
  invokedPath
  && (invokedPath === fileURLToPath(import.meta.url)
    || (process.platform === 'win32' && invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase())),
)
if (isDirect) {
  process.exitCode = runVigiaPrecheck(process.argv.slice(2))
}
