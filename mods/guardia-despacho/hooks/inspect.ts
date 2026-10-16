// Pure command inspection for the dispatch guard (no engine access).

import { parseUntil } from './orca-config'
import type { StackConfig } from './orca-config'

export { parseUntil }

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

// `repo` is the directory a `git -C <dir>` or an earlier `cd <dir>` points the removal at; absent, the session's cwd.
export type Removal = { by: 'path' | 'branch' | 'name' | 'issue' | 'none' | 'opaque'; value: string; repo?: string }
export type Worktree = { path: string; branch: string | undefined }
export type RunGit = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>

// Splits on the shell separators that sit outside quotes: `bash -c 'cd x; orca worktree rm y'` is one segment.
const splitSegments = (command: string): string[] => {
  const segments: string[] = []
  let current = ''
  let quote = ''
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? ''
    if (quote !== '') {
      current += ch
      quote = ch === quote ? '' : quote
    } else if (ch === '"' || ch === "'") {
      current += ch
      quote = ch
    } else if (ch === ';' || ch === '\n' || ch === '\r' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      segments.push(current)
      current = ''
      i += (ch === '|' || ch === '&') && command[i + 1] === ch ? 1 : 0
    } else {
      current += ch
    }
  }
  segments.push(current)

  return segments
}

type Token = { text: string; quoted: boolean }

const tokensOf = (segment: string): Token[] =>
  (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((raw): Token => {
      const quoted = raw.startsWith('"') || raw.startsWith("'")

      // Block and call punctuation glued to a word (`{orca`, `rm)`) is not part of it.
      return { text: unquote(quoted ? raw : raw.replace(/^[{(]+|[})]+$/g, '')), quoted }
    })
    .filter(token => token.text !== '' && token.text !== '&')

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'iex', 'invoke-expression'])
const SHELL_FLAG = /^(-[a-z]*c|[-/]c(o(m(m(a(n(d)?)?)?)?)?)?)$/i
// PowerShell takes any prefix of -EncodedCommand (-e, -en, -enc, ...) and its alias -ec.
// PowerShell also takes `/` as a flag prefix.
const isEncoded = (flag: string): boolean => /^[-/]e/i.test(flag) && ('encodedcommand'.startsWith(flag.slice(1).toLowerCase()) || flag.slice(1).toLowerCase() === 'ec')
const PS_VALUE_FLAGS = ['executionpolicy', 'ep', 'version', 'windowstyle', 'inputformat', 'outputformat', 'configurationname', 'psconsolefile']
const PWSH_VALUE_FLAGS = [...PS_VALUE_FLAGS, 'workingdirectory', 'settingsfile', 'custommodulepath']
// Windows PowerShell 5.1 runs the first positional argument as -Command text; `-File` and `-ExecutionPolicy x` do not.
// In PowerShell 7 (pwsh) that first positional is -File; treating it as command text anyway is deliberate: it fails toward blocking.
const psPositionalText = (args: Token[], pwsh: boolean): string => {
  const valueFlags = pwsh ? PWSH_VALUE_FLAGS : PS_VALUE_FLAGS
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    const flag = arg !== undefined && !arg.quoted && /^[-/][a-z]+$/i.test(arg.text) ? arg.text.slice(1).toLowerCase() : undefined
    if (flag === undefined) {
      return args.slice(i).map(one => one.text).join(' ')
    }
    if ('file'.startsWith(flag)) {
      return ''
    }
    i += valueFlags.some(full => full.startsWith(flag)) ? 1 : 0
  }

  return ''
}
// The executable may be quoted inside the text: & 'C:\...\orca.exe' worktree rm
const NESTED = /\borca(\.exe|\.cmd)?['"]?\s+worktree\s+rm\b|\bgit(\.exe)?['"]?[^|;&]*\bworktree\s+remove\b/i
const bare = (token: string): string => baseName(token).replace(/\.(exe|cmd|ps1)$/i, '').toLowerCase()

const UNKNOWABLE = /[$`%*?]/

// `cd b` after `cd a` (or `git -C b` after `cd a`) lands in a/b unless b is absolute.
const within = (base: string | undefined, dir: string): string =>
  base === undefined || /^([A-Za-z]:|[\\/])/.test(dir) ? dir : `${base}/${dir}`

const selectorOf = (value: string | undefined): Removal => {
  if (value === undefined || value === '') {
    return { by: 'none', value: '' }
  }
  if (UNKNOWABLE.test(value)) {
    return { by: 'none', value } // a loop variable or glob: the target cannot be known
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

// Every `orca worktree rm` / `git worktree remove` in the command, wherever it sits in a segment (after `do`, `then`,
// `{`, `sudo`, `xargs`...). A shell given the removal as text (`bash -c`, `pwsh -Command`) is opaque: denied.
export const worktreeRemovals = (command: string): Removal[] => {
  const found: Removal[] = []
  let dir: string | undefined // where the `cd`s seen so far leave the shell
  for (const segment of splitSegments(command)) {
    const tokens = tokensOf(segment)
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]
      if (token === undefined) {
        continue
      }
      // A quoted executable counts (`& "C:\Program Files\Orca\orca.exe" worktree rm`); quoted text such as
      // "orca worktree rm" has a bare name that is not `orca`, so an echo still passes.
      const word = bare(token.text)
      const args = tokens.slice(i + 1)
      const texts = args.map(arg => arg.text)
      if (SHELLS.has(word)) {
        const flag = args.findIndex(arg => !arg.quoted && SHELL_FLAG.test(arg.text))
        const ps = word === 'pwsh' || word === 'powershell'
        const encoded = ps && args.some(arg => !arg.quoted && isEncoded(arg.text))
        const positional = ps && NESTED.test(psPositionalText(args, word === 'pwsh'))
        if (encoded || positional || (flag !== -1 && texts.slice(flag + 1).some(text => NESTED.test(text))) || (word === 'iex' || word === 'invoke-expression') && texts.some(text => NESTED.test(text))) {
          found.push({ by: 'opaque', value: segment.trim() })
        }
      } else if (word === 'orca' && texts[0] === 'worktree' && texts[1] === 'rm') {
        const rest = texts.slice(2)
        const flag = rest.findIndex(arg => arg === '--worktree' || arg.startsWith('--worktree='))
        const raw = rest[flag]
        found.push(selectorOf(flag === -1 ? undefined : raw?.startsWith('--worktree=') ? raw.slice(11) : rest[flag + 1]))
      } else if (word === 'cd' && !token.quoted) {
        // A bare `cd`, `cd -` or `cd ~` goes somewhere the command does not say: `$` keeps it unknowable.
        const to = texts.find(arg => !/^-[LPe@]+$/.test(arg))
        dir = to === undefined || to === '-' || to.startsWith('~') ? '$' : within(dir, to)
      } else if (word === 'git') {
        let j = 0
        let repo = dir
        while (j < texts.length && texts[j] !== 'worktree') {
          if (texts[j] === '-C' && texts[j + 1] !== undefined) {
            repo = within(repo, texts[j + 1] ?? '')
          }
          j += texts[j] === '-C' || texts[j] === '-c' ? 2 : 1
        }
        if (texts[j] === 'worktree' && texts[j + 1] === 'remove') {
          const removal = selectorOf(texts.slice(j + 2).find(arg => !arg.startsWith('-')))
          found.push(repo === undefined ? removal : { ...removal, repo })
        }
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

// Every worktree the selector can mean. A worktree without a branch (detached) has `branch` undefined.
const find = (removal: Removal, list: Worktree[]): Worktree[] => {
  const value = norm(removal.value)
  const tail = (path: string): string => norm(path).split('/').pop() ?? ''
  switch (removal.by) {
    case 'branch':
      return list.filter(one => one.branch === removal.value)
    case 'path': {
      const exact = list.filter(one => norm(one.path) === value)

      return exact.length > 0 ? exact : list.filter(one => norm(one.path).endsWith(`/${value.replace(/^(\.\.?\/)+/, '')}`))
    }
    case 'name':
      return list.filter(one => tail(one.path) === value || one.branch === removal.value)
    default:
      return []
  }
}

const PERMISSION = 'Remover un worktree necesita el OK del humano (CONTRATO.md, "Permisos").'

export const unmergedReason = (branch: string, commits: string[]): string =>
  `La rama ${branch} tiene ${commits.length} commit(s) que no están en ningún remoto: ${commits.slice(0, 5).join(' | ')}. ` +
  `Remover su worktree borra también la rama local y esos commits se pierden. ${PERMISSION} ` +
  'Pusheá la rama antes, o pedile el OK al humano.'

export const unresolvedReason = (why: string): string =>
  `No pude comprobar si el worktree tiene commits sin publicar (${why}). ${PERMISSION}`

// The worktree Orca links to issue N, among the worktrees of this repo. A string is the reason it cannot be told.
const linkedWorktrees = async (git: RunGit, issue: string, list: Worktree[]): Promise<Worktree | string> => {
  try {
    const out = await git(['orca', 'worktree', 'ps', '--json'])
    if (out.exitCode !== 0) {
      return 'orca worktree ps falló'
    }
    const all = (JSON.parse(out.stdout) as { result?: { worktrees?: { path?: string; linkedIssue?: unknown }[] } }).result?.worktrees ?? []
    const mine = all.filter(one => String(one.linkedIssue) === issue && list.some(known => norm(known.path) === norm(one.path ?? '')))
    const hit = mine.length === 1 ? list.find(known => norm(known.path) === norm(mine[0]?.path ?? '')) : undefined

    return hit ?? `no encuentro un worktree enlazado al issue ${issue}`
  } catch {
    return 'no pude consultar a Orca'
  }
}

// Changes that exist only in the working tree are lost too. Untracked .atl/ is Gentle AI's skill registry cache.
const uncommitted = async (git: RunGit, path: string): Promise<string | undefined> => {
  try {
    const status = await git(['git', '-C', path, 'status', '--porcelain'])
    if (status.exitCode !== 0) {
      return unresolvedReason(`git status de ${path} falló`)
    }
    const dirty = status.stdout.split(/\r?\n/).filter(line => line.trim() !== '' && !/^\?\? \.atl\//.test(line))

    return dirty.length === 0
      ? undefined
      : `El worktree ${path} tiene cambios sin commitear (${dirty.slice(0, 5).join(' | ')}). Removerlo los borra. ${PERMISSION} Commiteá o descartá antes, o pedile el OK al humano.`
  } catch {
    return unresolvedReason('no pude correr git')
  }
}

// undefined: every removal in the command is safe. Anything that cannot be resolved is denied (fail closed).
export const checkRemovals = async (command: string, git: RunGit): Promise<string | undefined> => {
  const removals = worktreeRemovals(command)
  if (removals.length === 0) {
    return undefined
  }
  // Each repo's worktrees, listed once. A string is the reason they cannot be listed.
  const lists = new Map<string, Worktree[] | string>()
  const worktreesOf = async (repo: string | undefined): Promise<Worktree[] | string> => {
    const known = lists.get(repo ?? '')
    if (known !== undefined) {
      return known
    }
    let listed: Worktree[] | string
    try {
      const out = await git(repo === undefined ? ['git', 'worktree', 'list', '--porcelain'] : ['git', '-C', repo, 'worktree', 'list', '--porcelain'])
      listed = out.exitCode === 0 ? parseWorktrees(out.stdout) : repo === undefined ? 'git worktree list falló' : `git worktree list en ${repo} falló`
    } catch {
      listed = 'no pude correr git'
    }
    lists.set(repo ?? '', listed)

    return listed
  }
  for (const original of removals) {
    if (original.by === 'opaque') {
      return unresolvedReason(`un shell anidado (${original.value.slice(0, 80)}) esconde la remoción`)
    }
    if (original.by === 'none' && original.value !== '') {
      return unresolvedReason(`no puedo resolver el selector ${original.value}: es una variable o un patrón`)
    }
    const repo = original.repo
    if (repo !== undefined && UNKNOWABLE.test(repo)) {
      return unresolvedReason(`no puedo resolver el repo ${repo}: es una variable o un patrón`)
    }
    const list = await worktreesOf(repo)
    if (typeof list === 'string') {
      return unresolvedReason(list)
    }
    let removal = original
    if (original.by === 'issue') {
      // Orca resolves `issue:N` by the worktree's linked issue (checked with `orca worktree show`), not by its name.
      const linked = await linkedWorktrees(git, original.value, list)
      if (typeof linked === 'string') {
        return unresolvedReason(linked)
      }
      removal = { by: 'path', value: linked.path }
    }
    const matches = find(removal, list)
    const target = matches[0]
    if (target === undefined) {
      return unresolvedReason(`no encuentro el worktree ${removal.value === '' ? '(sin selector)' : removal.value}`)
    }
    if (matches.length > 1) {
      return unresolvedReason(`${removal.value} puede ser más de un worktree (${matches.map(one => one.path).join(' | ')})`)
    }
    const dirty = await uncommitted(git, target.path)
    if (dirty !== undefined) {
      return dirty
    }
    if (target.branch === undefined) {
      continue // detached: nothing to lose, no branch is deleted
    }
    try {
      const range = [`refs/heads/${target.branch}`, '--not', '--remotes', '--oneline']
      const log = await git(repo === undefined ? ['git', 'log', ...range] : ['git', '-C', repo, 'log', ...range])
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

type PrMerge = { number: string; repo?: string }
type PrView = { headRefName?: unknown; closingIssuesReferences?: unknown; body?: unknown }
type OrcaAgent = { state?: unknown; agentType?: unknown }
type OrcaWorktree = { path?: unknown; linkedIssue?: unknown; agents?: unknown }

const MERGE_VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit'])
const MERGE_REPO_FLAGS = new Set(['-R', '--repo'])

// Mirrors the gh pr merge forms recognized by puente-gentle's merges() without importing another mod.
const prMerges = (command: string): PrMerge[] => {
  const found: PrMerge[] = []
  for (const segment of splitSegments(command)) {
    const words = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(word => word.replace(/^['"]|['"]$/g, ''))
    if (words[0] !== 'gh' && words[0] !== 'gh.exe') {
      continue
    }
    let repo: string | undefined
    const rest: string[] = []
    for (let i = 1; i < words.length; i += 1) {
      const word = words[i] ?? ''
      if (MERGE_REPO_FLAGS.has(word)) {
        repo = words[i + 1]
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
      if (MERGE_VALUE_FLAGS.has(word)) {
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

const repoSlug = (url: string): string | undefined => {
  if (/^[^/\s]+\/[^/\s]+$/.test(url.trim())) return url.trim().replace(/\.git$/i, '').toLowerCase()
  const match = /(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?\s*$/i.exec(url.trim())

  return match?.[1]?.toLowerCase()
}

const prIssues = (pr: PrView): string[] => {
  const refs = Array.isArray(pr.closingIssuesReferences) ? pr.closingIssuesReferences : []
  const numbers = refs.flatMap(ref => {
    if (typeof ref !== 'object' || ref === null || !('number' in ref)) return []
    const number = String((ref as { number?: unknown }).number)

    return /^\d+$/.test(number) ? [number] : []
  })
  const body = typeof pr.body === 'string' ? pr.body : ''
  const matches = [...body.matchAll(/^\s*Closes\s+#(\d+)\b/gim)].map(match => match[1]).filter((number): number is string => number !== undefined)

  return [...new Set([...numbers, ...matches])]
}

const isLiveState = (state: unknown): state is string =>
  typeof state === 'string' && ['working', 'running', 'active', 'blocked', 'waiting'].includes(state.toLowerCase())

const liveAgent = (worktree: OrcaWorktree): OrcaAgent | undefined => {
  if (!Array.isArray(worktree.agents)) return undefined

  return (worktree.agents as OrcaAgent[]).find(agent => isLiveState(agent?.state))
}

const parsed = <T>(stdout: string): T | undefined => {
  try {
    return JSON.parse(stdout) as T
  } catch {
    return undefined
  }
}

// A failed GitHub/Orca read never blocks a merge. The hook only denies with a concrete live worker record.
export const checkLiveMerges = async (command: string, git: RunGit): Promise<string | undefined> => {
  const merges = prMerges(command)
  if (merges.length === 0) return undefined

  let localSlug: string | undefined
  const slug = async (): Promise<string | undefined> => {
    if (localSlug !== undefined) return localSlug
    try {
      const remote = await git(['git', 'remote', 'get-url', 'origin'])
      if (remote.exitCode === 0) localSlug = repoSlug(remote.stdout)
    } catch {
      // Without a known local GitHub repository, explicit -R targets are left alone.
    }

    return localSlug
  }

  let listed: Worktree[] | undefined
  const worktrees = async (): Promise<Worktree[] | undefined> => {
    if (listed !== undefined) return listed
    try {
      const result = await git(['git', 'worktree', 'list', '--porcelain'])
      if (result.exitCode === 0) listed = parseWorktrees(result.stdout)
    } catch {
      // Fail open on a worktree inventory failure.
    }

    return listed
  }

  let orcaRows: OrcaWorktree[] | undefined
  const rows = async (): Promise<OrcaWorktree[] | undefined> => {
    if (orcaRows !== undefined) return orcaRows
    try {
      const result = await git(['orca', 'worktree', 'ps', '--json'])
      const data = result.exitCode === 0 ? parsed<{ result?: { worktrees?: unknown } }>(result.stdout) : undefined
      if (Array.isArray(data?.result?.worktrees)) orcaRows = data.result.worktrees as OrcaWorktree[]
    } catch {
      // Fail open on an Orca inventory failure.
    }

    return orcaRows
  }

  for (const merge of merges) {
    if (merge.repo !== undefined) {
      const current = await slug()
      if (current === undefined || repoSlug(merge.repo) !== current) continue
    }
    let pr: PrView | undefined
    try {
      const result = await git(['gh', 'pr', 'view', merge.number, '--json', 'headRefName,closingIssuesReferences,body'])
      if (result.exitCode === 0) pr = parsed<PrView>(result.stdout)
    } catch {
      // Fail open on a GitHub read failure.
    }
    if (pr === undefined) continue

    const known = await worktrees()
    const all = await rows()
    if (known === undefined || all === undefined) continue
    const localPaths = new Set(known.map(worktree => norm(worktree.path)))
    const ours = all.filter(row => typeof row.path === 'string' && localPaths.has(norm(row.path)))
    const issues = prIssues(pr)
    let matches = ours.filter(row => issues.includes(String(row.linkedIssue)))
    let issue = matches.length === 1 ? String(matches[0]?.linkedIssue) : issues[0]
    if (matches.length === 0 && typeof pr.headRefName === 'string') {
      matches = known.flatMap(worktree => worktree.branch === pr?.headRefName
        ? ours.filter(row => norm(String(row.path)) === norm(worktree.path))
        : [])
    }
    if (matches.length !== 1) continue
    const agent = liveAgent(matches[0] ?? {})
    if (agent === undefined) continue
    const state = String(agent.state).toLowerCase()
    const name = typeof agent.agentType === 'string' ? agent.agentType : 'worker'
    const issueLabel = issue === undefined ? '' : `, #${issue}`

    return `El worker del PR #${merge.number} (${name}${issueLabel}) sigue trabajando (${state}): no mergees hasta que termine. vigilar emite ci-verde cuando deja de estar vivo.`
  }

  return undefined
}
