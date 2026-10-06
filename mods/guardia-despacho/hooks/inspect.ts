// Pure command inspection for the dispatch guard (no engine access).

import type { StackConfig } from './orca-config'

export type Block = { agent: string; untilMs: number; reason: string }
export type Rules = {
  dispatch: string // basename of the dispatch script (despacho.script)
  review: string | undefined // basename of the review script (despacho.revisar)
  blocks: Block[]
  model: string | undefined // guardia.modeloClaude
  notes: string[] // rules that were ignored, and why (shown once as a toast)
}

// Config comes from a committed file of a possibly untrusted repo: whatever ends up inside a rewritten
// shell command or is matched against a command must be plain.
const SAFE_MODEL = /^[A-Za-z0-9._:-]+$/
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

export const isSafePath = (value: unknown): value is string =>
  typeof value === 'string' && SAFE_PATH.test(value) && !value.split('/').includes('..')

export type Shell = 'bash' | 'powershell'
export type Verdict =
  | { kind: 'pass' }
  | { kind: 'deny'; reason: string }
  | { kind: 'rewrite'; command: string }

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

// "2026-10-29" -> local midnight of that day; an agent is blocked while now < that instant.
export const parseUntil = (date: string): number | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (match === null) {
    return undefined
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const at = new Date(year, month - 1, day)
  // Round trip: 2026-02-30 would silently become 2026-03-02.
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) {
    return undefined
  }

  return at.getTime()
}

export const blockReason = (agent: string, until: string, motivo: string | undefined): string =>
  motivo !== undefined && motivo.trim() !== '' ? motivo : `${agent} está bloqueado hasta el ${until}.`

export const modelReason = (model: string): string =>
  `Los claude que implementan van en ${model}: anteponé CLAUDE_MODELO=${model}.`

// The guard is OFF (undefined) unless the project config declares despacho.script.
export const buildRules = (config: StackConfig): Rules | undefined => {
  const notes: string[] = []
  const script = config.despacho?.script
  if (script === undefined) {
    return undefined
  }
  if (!isSafePath(script)) {
    return undefined // guard off: an odd script path is never matched against commands
  }
  const revisar = config.despacho?.revisar
  const hasReview = revisar !== undefined && revisar !== ''
  if (hasReview && !isSafePath(revisar)) {
    notes.push('despacho.revisar ignorado: tiene que ser una ruta relativa simple.')
  }
  const blocks: Block[] = []
  for (const rule of config.guardia?.bloquear ?? []) {
    const untilMs = typeof rule?.hasta === 'string' ? parseUntil(rule.hasta) : undefined
    if (typeof rule?.agente !== 'string' || rule.agente === '') {
      continue
    }
    if (untilMs === undefined) {
      notes.push(`Regla de ${rule.agente} ignorada: la fecha "hasta" no es una fecha AAAA-MM-DD válida.`)
      continue
    }
    blocks.push({
      agent: rule.agente.toLowerCase(),
      untilMs,
      reason: blockReason(rule.agente, rule.hasta, rule.motivo),
    })
  }
  const model = config.guardia?.modeloClaude
  let safeModel: string | undefined
  if (typeof model === 'string' && model.trim() !== '') {
    if (SAFE_MODEL.test(model.trim())) {
      safeModel = model.trim()
    } else {
      notes.push('guardia.modeloClaude ignorado: solo admite letras, números y . _ : -')
    }
  }

  return {
    dispatch: baseName(script),
    review: hasReview && isSafePath(revisar) ? baseName(revisar) : undefined,
    blocks,
    model: safeModel,
    notes,
  }
}

const WRAPPERS = new Set(['bash', 'sh', 'env', 'time'])
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const BASH_EXPORT = /^\s*export\s+CLAUDE_MODELO=['"]?([^'"\s]*)/
const PS_MODEL = /^\$env:CLAUDE_MODELO\s*=\s*['"]?([^'";\s]*)/i
const SEPARATOR = /(&&|\|\||;|\||\r?\n)/

const unquote = (token: string): string => token.replace(/^['"]|['"]$/g, '')

type Call = { script: string; positional: string[]; env: Record<string, string> }

// The dispatch call a segment makes, if its command word is one of the scripts.
const callOf = (segment: string, scripts: ReadonlySet<string>): Call | undefined => {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  const env: Record<string, string> = {}
  let i = 0
  for (; i < tokens.length; i += 1) {
    const token = tokens[i] ?? ''
    if (ENV_ASSIGN.test(token)) {
      const at = token.indexOf('=')
      env[token.slice(0, at)] = unquote(token.slice(at + 1))
    } else if (!WRAPPERS.has(token)) {
      break
    }
  }
  const script = baseName(unquote(tokens[i] ?? ''))
  if (!scripts.has(script)) {
    return undefined
  }
  const positional = tokens
    .slice(i + 1)
    .map(unquote)
    .filter(token => !token.startsWith('-'))

  return { script, positional, env }
}

export const inspect = (command: string, nowMs: number, rules: Rules, shell: Shell = 'bash'): Verdict => {
  const scripts = new Set([rules.dispatch, ...(rules.review === undefined ? [] : [rules.review])])
  const parts = command.split(SEPARATOR)
  let exported: string | undefined // from an earlier `export CLAUDE_MODELO=...` / `$env:CLAUDE_MODELO=...`
  let wasRewritten = false

  for (let p = 0; p < parts.length; p += 2) {
    const segment = parts[p] ?? ''
    exported = BASH_EXPORT.exec(segment)?.[1] ?? PS_MODEL.exec(segment.trim())?.[1] ?? exported

    const call = callOf(segment, scripts)
    if (call === undefined) {
      continue
    }
    const agent = call.positional.map(word => word.toLowerCase())
    const blocked = rules.blocks.find(rule => nowMs < rule.untilMs && agent.includes(rule.agent))
    if (blocked !== undefined) {
      return { kind: 'deny', reason: blocked.reason }
    }
    if (rules.model === undefined || call.script !== rules.dispatch || !agent.includes('claude')) {
      continue
    }
    const model = call.env.CLAUDE_MODELO ?? exported
    if (model === rules.model) {
      continue
    }
    if (model !== undefined && model !== '') {
      return { kind: 'deny', reason: modelReason(rules.model) }
    }
    const prefix =
      shell === 'bash' ? `CLAUDE_MODELO=${rules.model} ` : `$env:CLAUDE_MODELO='${rules.model}'; `
    const lead = /^\s*/.exec(segment)?.[0] ?? ''
    parts[p] = `${lead}${prefix}${segment.slice(lead.length)}`
    wasRewritten = true
  }

  return wasRewritten ? { kind: 'rewrite', command: parts.join('') } : { kind: 'pass' }
}

// ---- worktree removal ---------------------------------------------------------------------------
// `orca worktree rm` also deletes the local branch, even with commits that exist nowhere else.

export type Removal = { by: 'path' | 'branch' | 'name' | 'issue' | 'none'; value: string }
export type Worktree = { path: string; branch: string | undefined }
export type RunGit = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>

const tokensOf = (segment: string): string[] =>
  (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote).filter(token => token !== '&')

const selectorOf = (value: string | undefined): Removal => {
  if (value === undefined || value === '') {
    return { by: 'none', value: '' }
  }
  const at = value.indexOf(':')
  const kind = at > 0 ? value.slice(0, at) : ''
  const rest = value.slice(at + 1)
  if (kind === 'branch') {
    return { by: 'branch', value: rest.replace(/^refs\/heads\//, '') }
  }
  if (kind === 'issue' || kind === 'name') {
    return { by: kind, value: rest }
  }
  if (kind === 'id') {
    return { by: 'path', value: rest.includes('::') ? rest.slice(rest.indexOf('::') + 2) : rest }
  }
  // `path:<p>` or a bare path (git worktree remove <p>). A Windows drive letter is not a selector kind.
  return { by: 'path', value: kind === 'path' ? rest : value }
}

// Every `orca worktree rm` / `git worktree remove` in the command (bash and PowerShell forms).
export const worktreeRemovals = (command: string): Removal[] => {
  const found: Removal[] = []
  for (const segment of command.split(SEPARATOR)) {
    const tokens = tokensOf(segment)
    let i = 0
    while (i < tokens.length && (ENV_ASSIGN.test(tokens[i] ?? '') || WRAPPERS.has(tokens[i] ?? ''))) {
      i += 1
    }
    const word = baseName(tokens[i] ?? '').replace(/\.(exe|cmd|ps1)$/i, '')
    const args = tokens.slice(i + 1)
    if (word === 'orca' && args[0] === 'worktree' && args[1] === 'rm') {
      const flag = args.findIndex(arg => arg === '--worktree' || arg.startsWith('--worktree='))
      const raw = args[flag]
      found.push(selectorOf(flag === -1 ? undefined : raw?.startsWith('--worktree=') ? raw.slice(11) : args[flag + 1]))
    } else if (word === 'git') {
      let j = 0
      while (j < args.length && args[j] !== 'worktree') {
        j += args[j] === '-C' || args[j] === '-c' ? 2 : 1
      }
      if (args[j] === 'worktree' && args[j + 1] === 'remove') {
        found.push(selectorOf(args.slice(j + 2).find(arg => !arg.startsWith('-'))))
      }
    }
  }

  return found
}

export const parseWorktrees = (porcelain: string): Worktree[] =>
  porcelain
    .split(/\r?\n\r?\n/)
    .map(block => {
      const lines = block.split(/\r?\n/)
      const path = lines.find(line => line.startsWith('worktree '))?.slice(9)
      const branch = lines.find(line => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '')

      return path === undefined ? undefined : { path, branch }
    })
    .filter((one): one is Worktree => one !== undefined)

const norm = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// undefined: no worktree matches. A worktree without a branch (detached) has `branch` undefined.
const find = (removal: Removal, list: Worktree[]): Worktree | undefined => {
  const value = norm(removal.value)
  const tail = (path: string): string => norm(path).split('/').pop() ?? ''
  switch (removal.by) {
    case 'branch':
      return list.find(one => one.branch === removal.value)
    case 'path':
      return list.find(one => norm(one.path) === value || norm(one.path).endsWith(`/${value.replace(/^(\.\.?\/)+/, '')}`))
    case 'issue':
      return list.find(one => tail(one.path) === `issue-${value}`)
    case 'name':
      return list.find(one => tail(one.path) === value || one.branch === removal.value)
    default:
      return undefined
  }
}

const PERMISSION = 'Remover un worktree necesita el OK del humano (CONTRATO.md, "Permisos").'

export const unmergedReason = (branch: string, commits: string[]): string =>
  `La rama ${branch} tiene ${commits.length} commit(s) que no están en ningún remoto: ${commits.slice(0, 5).join(' | ')}. ` +
  `Remover su worktree borra también la rama local y esos commits se pierden. ${PERMISSION} ` +
  'Pusheá la rama antes, o pedile el OK al humano.'

export const unresolvedReason = (why: string): string =>
  `No pude comprobar si el worktree tiene commits sin publicar (${why}). ${PERMISSION}`

// undefined: every removal in the command is safe. Anything that cannot be resolved is denied (fail closed).
export const checkRemovals = async (command: string, git: RunGit): Promise<string | undefined> => {
  const removals = worktreeRemovals(command)
  if (removals.length === 0) {
    return undefined
  }
  let list: Worktree[]
  try {
    const out = await git(['git', 'worktree', 'list', '--porcelain'])
    if (out.exitCode !== 0) {
      return unresolvedReason('git worktree list falló')
    }
    list = parseWorktrees(out.stdout)
  } catch {
    return unresolvedReason('no pude correr git')
  }
  for (const removal of removals) {
    const target = find(removal, list)
    if (target === undefined) {
      return unresolvedReason(`no encuentro el worktree ${removal.value === '' ? '(sin selector)' : removal.value}`)
    }
    if (target.branch === undefined) {
      continue // detached: nothing to lose, no branch is deleted
    }
    try {
      const log = await git(['git', 'log', `refs/heads/${target.branch}`, '--not', '--remotes', '--oneline'])
      if (log.exitCode !== 0) {
        return unresolvedReason(`git log de ${target.branch} falló`)
      }
      const commits = log.stdout.split(/\r?\n/).filter(line => line.trim() !== '')
      if (commits.length > 0) {
        return unmergedReason(target.branch, commits)
      }
    } catch {
      return unresolvedReason('no pude correr git')
    }
  }

  return undefined
}
