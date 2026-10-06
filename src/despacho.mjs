import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PROJECT_CONFIG, PROJECT_LOCAL_CONFIG } from './constants.mjs'
import { stackVars } from './global.mjs'
import { resolveGentleSkills } from './pi.mjs'
import { readAsset, render } from './templates.mjs'
import { homeDir, isWindows, layout, run, samePath, which } from './util.mjs'

export const AGENTS = ['claude', 'agy', 'codex', 'codex-cc', 'pi']
const CODEX_FAMILY = ['codex', 'codex-cc']

// Source of truth: mods/puente-gentle/hooks/puente.ts (ORCA_VARS_CLEARED, engramDir). Duplicated because the mod is TypeScript
// that can only import its own folder; the pi consult and this launcher must clear and set the same things.
const ORCA_VARS_CLEARED = [
  'ORCA_AGENT_HOOK_ENDPOINT', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN', 'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION', 'ORCA_AGENT_HOOK_TRANSPORT', 'ORCA_AGENT_LAUNCH', 'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_PANE', 'ORCA_PANE_KEY', 'ORCA_TAB_ID', 'ORCA_WORKTREE_ID', 'ORCA_TERMINAL_HANDLE',
  'ORCA_STACK_AGENT', 'ORCA_STACK_MODE', 'ORCA_STACK_POLICY_PATH', 'ORCA_STACK_PONYTAIL_LEVEL',
  'ORCA_STACK_CAVEMAN_LEVEL',
]
const engramDir = home => path.join(home, '.gentle-shell', 'engram')
const PI_TOOLS = { ticket: 'read,bash,edit,write,grep,find,ls', review: 'read,bash,grep,find,ls' }
const PATH_EXTENSIONS = /\.(md|json|mjs|cjs|js|ts|tsx|jsx|py|sh|ps1|ya?ml|toml|txt|html|css|sql|go|rs|cs|java|kt|rb)$/i

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Same merge as shared/orca-config.ts: objects merge key by key, anything else (lists included) is replaced.
const merge = (...layers) => {
  const out = {}
  for (const layer of layers) {
    if (!isPlain(layer)) continue
    for (const [key, value] of Object.entries(layer)) out[key] = isPlain(value) && isPlain(out[key]) ? merge(out[key], value) : value
  }

  return out
}
const readJson = file => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) : undefined
  } catch {
    return undefined
  }
}

export const loadConfig = (home, root) => {
  const personal = readJson(layout(home).config)
  const config = merge(personal, readJson(path.join(root, PROJECT_CONFIG)), readJson(path.join(root, PROJECT_LOCAL_CONFIG)))
  // The Claude account pi uses comes from the personal layer only: a committed file must not redirect credentials.
  const dir = personal?.agentes?.pi?.claudeConfigDir
  config.piClaudeConfigDir = typeof dir === 'string' && dir.trim() !== '' ? path.normalize(dir.trim().replace(/^~(?=$|[\\/])/, home)) : undefined

  return config
}

// agentes.modelos.<agent>: "model", { modelo, esfuerzo } or { implementar: {...}, revisar: {...} }.
export const modelFor = (config, agent, mode) => {
  let entry = config.agentes?.modelos?.[agent]
  if (isPlain(entry) && (entry.implementar || entry.revisar)) entry = entry[mode === 'review' ? 'revisar' : 'implementar']
  if (typeof entry === 'string') return { model: entry, effort: undefined }

  return { model: isPlain(entry) ? entry.modelo : undefined, effort: isPlain(entry) ? entry.esfuerzo : undefined }
}

const psQuote = text => `'${text.replace(/'/g, "''")}'`
const shQuote = text => `'${text.replace(/'/g, "'\\''")}'`

// The command typed into the Orca terminal. PowerShell on Windows (the Orca terminal there), POSIX sh elsewhere.
export const launcherFor = ({ agent, mode, vars, config, win, home, briefPath, session, skills }) => {
  const { model, effort } = modelFor(config, agent, mode)
  const bin = (win ? '& ' : '') + `"${{ claude: vars.WRAPPER_CLAUDE, agy: vars.WRAPPER_AGY }[agent] ?? vars.WRAPPER_CODEX}"`
  if (agent === 'claude' || agent === 'agy') return `${bin} --dangerously-skip-permissions${model ? ` --model ${model}` : ''}`
  if (agent === 'codex' || agent === 'codex-cc') {
    const flags = `${model ? ` --model ${model}` : ''}${effort ? ` -c model_reasoning_effort="${effort}"` : ''} -c approval_policy="never" -c sandbox_mode="danger-full-access"`
    if (agent === 'codex') return `${bin}${flags}`
    const provider = '-c model_provider=cc -c model_providers.cc.name=CommandCode -c model_providers.cc.base_url=https://api.commandcode.ai/provider/v1 -c model_providers.cc.env_key=CMD_API_KEY -c model_providers.cc.wire_api=responses'
    const key = win
      ? '$env:CMD_API_KEY = (Get-Content -Raw -Encoding UTF8 -LiteralPath "$HOME\\.pi\\agent\\auth.json" | ConvertFrom-Json).commandcode.key'
      : `export CMD_API_KEY="$(node -p "require(process.env.HOME + '/.pi/agent/auth.json').commandcode.key")"`

    return `${key}; ${bin} ${provider}${flags}`
  }
  // pi: headless, no TUI. The brief rides in the prompt; the Orca and stack variables are cleared so Orca does not
  // take this pane for a second agent and the stack markers do not leak into Gentle Shell.
  const q = win ? psQuote : shQuote
  const prompt = `Read and carry out the brief in ${briefPath}. Non-interactive: never wait for user input.`
  const cmd = `pi -p --no-skills --skill ${q(skills)} --session-id ${session} --tools ${PI_TOOLS[mode]} ${q(prompt)}`
  const set = [['ENGRAM_DATA_DIR', engramDir(home)], ['GENTLE_PI_AUTONOMOUS_MODE', '1'], ...(config.piClaudeConfigDir ? [['CLAUDE_CONFIG_DIR', config.piClaudeConfigDir]] : [])]
  if (win) {
    return [`Remove-Item ${ORCA_VARS_CLEARED.map(n => `Env:${n}`).join(', ')} -ErrorAction SilentlyContinue`, ...set.map(([k, v]) => `$env:${k} = ${psQuote(v)}`), cmd].join('; ')
  }

  return [`unset ${ORCA_VARS_CLEARED.join(' ')}`, `export ${set.map(([k, v]) => `${k}=${shQuote(v)}`).join(' ')}`, cmd].join('; ')
}

// Repo-relative paths a brief cites in inline backticks: contains a slash or ends in a known extension, no spaces, not a
// ref, URL, glob, placeholder or absolute path. Fenced blocks are commands and examples, not citations.
export const citedPaths = text => {
  const found = []
  for (const [, token] of text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)) {
    const t = token.replace(/:\d+(-\d+)?$/, '')
    if (/[\s<>{}*$=:@#]/.test(t) || /^(-|~|\/|origin\/|refs\/)/.test(t) || /^[a-z]:[\\/]/i.test(t)) continue
    if ((t.includes('/') || PATH_EXTENSIONS.test(t)) && !found.includes(t)) found.push(t)
  }

  return found
}

export const missingPaths = (brief, has) => citedPaths(brief).filter(p => !has(p.replace(/\/+$/, '')))

const verificationBlock = config => {
  const lines = [config.verificacion?.suite, config.verificacion?.typecheck].filter(c => typeof c === 'string' && c.trim() !== '')

  return lines.length === 0 ? "(none configured: run the project's own checks)" : lines.join('\n')
}

export const renderBrief = (kind, vars, nota) =>
  render(readAsset('stack', kind === 'ticket' ? 'brief-ticket.md' : 'brief-revision.md'), {
    ...vars,
    NOTE_SECTION: nota ? `\n## Extra notes from main\n\n${nota.trim()}\n` : '',
  })

const deepFind = (value, keys) => {
  if (!isPlain(value) && !Array.isArray(value)) return undefined
  for (const [k, v] of Object.entries(value)) if (keys.includes(k) && typeof v === 'string' && v !== '') return v
  for (const v of Object.values(value)) {
    const found = deepFind(v, keys)
    if (found !== undefined) return found
  }

  return undefined
}

const parseJson = (res, what) => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error(`${what} no devolvió JSON: ${(res.stderr || res.stdout).trim().split('\n')[0]}`)
  }
}

export const defaultIo = () => ({
  home: homeDir(),
  cwd: process.cwd(),
  win: isWindows(),
  out: console.log,
  sh: (cmd, args, { cwd } = {}) => run(which(cmd) ?? cmd, args, { cwd, env: process.env, timeout: 60_000 }),
  exists: existsSync,
  mkdirp: dir => mkdirSync(dir, { recursive: true }),
  writeFile: (file, text) => writeFileSync(file, text, 'utf8'),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  gentleSkills: home => resolveGentleSkills(layout(home))?.dir ?? null,
})

const ok = (res, what) => {
  if (res.status !== 0) throw new Error(`${what} falló: ${(res.stderr || res.stdout || String(res.error)).trim()}`)

  return res
}

const waitForTui = async (io, handle, agent, tries = 45) => {
  let last = null
  let stable = 0
  let trusted = false
  for (let i = 0; i < tries; i += 1) {
    await io.sleep(2000)
    const res = io.sh('orca', ['terminal', 'read', '--terminal', handle, '--screen', '--json'])
    const text = res.status === 0 ? JSON.stringify(parseJson(res, 'orca terminal read')) : ''
    if (agent === 'agy' && !trusted && /trust/i.test(text)) {
      io.sh('orca', ['terminal', 'send', '--terminal', handle, '--enter'])
      trusted = true
      stable = 0
      last = null
      continue
    }
    stable = text !== '' && text === last ? stable + 1 : 0
    last = text
    if (stable >= 2) return true
  }

  return false
}

// The whole dispatch: despachar (kind 'ticket', n = issue) and revisar (kind 'review', n = PR).
export const dispatch = async (kind, args, io = defaultIo()) => {
  const { n, agent, nota, dryRun = false, confirmado = false } = args
  const review = kind === 'review'
  const say = io.out
  if (!/^\d+$/.test(String(n ?? ''))) throw new Error(`Falta el número de ${review ? 'PR' : 'issue'}. Uso: orca-stack ${review ? 'revisar <pr>' : 'despachar <issue>'} <agente>.`)
  if (!AGENTS.includes(agent)) throw new Error(`Agente desconocido: ${agent ?? '(ninguno)'}. Los agentes son: ${AGENTS.join(', ')}.`)

  const git = io.sh('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], { cwd: io.cwd })
  if (git.status !== 0) throw new Error('Corré este comando dentro del checkout principal de un repo git.')
  const [gitDir, commonDir, top] = git.stdout.split(/\r?\n/).map(l => l.trim())
  if (!samePath(gitDir, commonDir)) throw new Error('Esto es un worktree: corré el comando desde el checkout principal del repo (la sesión de main).')
  const root = path.resolve(top)
  const repo = path.basename(root)

  const config = loadConfig(io.home, root)
  if (config.setup !== 'completo') throw new Error(`El setup de orca-stack está pendiente en ${repo}: hacelo con la skill orca-setup antes de despachar.`)
  if (config.modo === 'un-agente') throw new Error('El modo del repo es "un-agente": no hay workers que despachar.')
  const base = config.ramaBase
  if (typeof base !== 'string' || base === '') throw new Error('Falta ramaBase en la configuración del repo.')
  if (!(config.agentes?.usa ?? []).includes(agent)) throw new Error(`${agent} no está en agentes.usa de este repo (${(config.agentes?.usa ?? []).join(', ') || 'vacío'}).`)
  if ((config.agentes?.preguntarAntes ?? []).includes(agent) && !confirmado) {
    throw new Error(`${agent} figura en agentes.preguntarAntes: main tiene que preguntarle al humano antes de despacharlo. Si dijo que sí, repetí el comando con --confirmado.`)
  }

  let implementer = agent
  let branchOfPr
  let sha
  if (review) {
    const pr = parseJson(ok(io.sh('gh', ['pr', 'view', String(n), '--json', 'headRefName,headRefOid,body,number'], { cwd: root }), 'gh pr view'), 'gh pr view')
    implementer = /^\s*Implementador:\s*(\S+)/mi.exec(pr.body ?? '')?.[1]
    if (!implementer) throw new Error(`El PR #${n} no tiene la línea "Implementador: <agente>": sin ella no puedo comprobar que el revisor sea otro.`)
    if (implementer === agent) throw new Error(`${agent} implementó el PR #${n}: nadie revisa su propio PR.`)
    if (CODEX_FAMILY.includes(agent) && CODEX_FAMILY.includes(implementer)) throw new Error(`${agent} no revisa PRs de ${implementer}: comparten modelo y puntos ciegos.`)
    branchOfPr = pr.headRefName
    sha = pr.headRefOid
  } else {
    const issue = parseJson(ok(io.sh('gh', ['issue', 'view', String(n), '--json', 'state,assignees,title'], { cwd: root }), 'gh issue view'), 'gh issue view')
    if (String(issue.state).toUpperCase() !== 'OPEN') throw new Error(`El issue #${n} está cerrado.`)
    if ((issue.assignees ?? []).length > 0) throw new Error(`El issue #${n} ya tiene assignee (${issue.assignees.map(a => a.login).join(', ')}): está tomado.`)
  }

  const name = review ? `revision-${n}` : `${repo}-${n}`
  const briefPath = path.join(io.home, 'orca', 'briefs', `${repo}-${review ? `revision-${n}` : n}.md`)
  const startRef = `origin/${review ? branchOfPr : base}`

  // Idempotence lock: an existing worktree for this branch/name, or a live agent in it.
  const listed = ok(io.sh('git', ['worktree', 'list', '--porcelain'], { cwd: root }), 'git worktree list').stdout
  const taken = listed.split(/\r?\n/).filter(l => l.startsWith('worktree ') || l.startsWith('branch ')).map(l => l.replace(/^(worktree|branch) /, ''))
  if (taken.some(t => t.replace(/\\/g, '/').split('/').pop() === name)) throw new Error(`Ya hay un worktree para ${name}. No despacho dos veces: revisalo con \`orca worktree ps\`.`)
  const ps = io.sh('orca', ['worktree', 'ps', '--json'])
  if (ps.status === 0) {
    const live = (parseJson(ps, 'orca worktree ps').result?.worktrees ?? []).find(
      w => String(w.path ?? '').replace(/\\/g, '/').split('/').pop() === name || (!review && w.repo === repo && w.linkedIssue === Number(n)),
    )
    if (live) throw new Error(`Orca ya tiene un worktree para ${name}${(live.agents ?? []).length > 0 ? ' con un agente vivo' : ''}: ${live.path}.`)
  } else if (!dryRun) {
    throw new Error(`Orca no contesta (orca worktree ps): ${(ps.stderr || ps.stdout).trim()}`)
  } else say('⚠ Orca no contesta: no pude comprobar si ya hay un agente vivo.')

  const win = io.win
  const vars = stackVars(layout(io.home))
  const mode = review ? 'review' : 'ticket'
  const session = `${repo}-${review ? `revision-${n}` : n}`
  const skills = agent === 'pi' ? io.gentleSkills(io.home) : null
  if (agent === 'pi' && !skills) throw new Error('No encuentro las skills de gentle-pi (Pi ni npm global): corré `orca-stack global`.')
  const launcher = launcherFor({ agent, mode, vars, config, win, home: io.home, briefPath, session, skills })
  const act = (cmd, argv, opts = {}) => {
    say(`${dryRun ? '[simulación] ' : ''}${cmd} ${argv.map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)

    return dryRun ? { status: 0, stdout: '', stderr: '' } : ok(io.sh(cmd, argv, opts), `${cmd} ${argv[0]}`)
  }

  if (!dryRun) io.sh('git', ['fetch', 'origin'], { cwd: root })
  if (!review) act('gh', ['issue', 'edit', String(n), '--add-assignee', '@me'], { cwd: root })
  const createArgs = ['worktree', 'create', '--name', name, '--base-branch', startRef, '--no-parent', ...(review ? [] : ['--issue', String(n)]), '--json']
  let worktree = '<worktree>'
  let branch = name
  try {
    const created = act('orca', createArgs)
    if (!dryRun) {
      const json = parseJson(created, 'orca worktree create')
      worktree = deepFind(json.result ?? json, ['path', 'worktreePath'])
      branch = (deepFind(json.result ?? json, ['branch']) ?? name).replace(/^refs\/heads\//, '')
      if (!worktree) throw new Error('orca worktree create no devolvió la ruta del worktree.')
    }

    const brief = renderBrief(kind, {
      REPO: repo, AGENT: agent, BASE: base, BRANCH: branch, VERIFICATION: verificationBlock(config),
      ...(review ? { PR: String(n), SHA: sha, IMPLEMENTER: implementer } : { ISSUE: String(n) }),
    }, nota)
    let has
    if (dryRun) {
      const tree = io.sh('git', ['ls-tree', '-r', '--name-only', startRef], { cwd: root })
      const files = new Set(tree.stdout.split(/\r?\n/).filter(Boolean))
      has = tree.status === 0 ? p => files.has(p) || [...files].some(f => f.startsWith(`${p}/`)) : null
      if (!has) say(`⚠ No pude listar ${startRef}: la validación de rutas del brief se hace al despachar.`)
    } else has = p => io.exists(path.join(worktree, p))
    const missing = has ? missingPaths(brief, has) : []
    if (missing.length > 0) {
      throw new Error(`El brief cita rutas que no existen en el worktree${dryRun ? ` (${startRef})` : ''}; no lanzo nada y no borro nada:\n${missing.map(p => `  - ${p}`).join('\n')}\nUna ruta ignorada por git no llega a un worktree: citá algo que esté versionado.`)
    }

    say(`${dryRun ? '[simulación] ' : ''}brief -> ${briefPath}`)
    if (!dryRun) {
      io.mkdirp(path.dirname(briefPath))
      io.writeFile(briefPath, brief)
    }
    say(`Lanzador (${agent}): ${launcher}`)
    const term = act('orca', ['terminal', 'create', '--worktree', `path:${worktree}`, '--title', agent, '--command', launcher, '--json'])
    if (dryRun) {
      if (agent !== 'pi') say(`[simulación] esperar la TUI de ${agent}${agent === 'agy' ? ' (confirmar la carpeta con Enter)' : ''} y enviar: Read and follow the brief in ${briefPath}`)
      say(`\n--- brief ---\n${brief}`)

      return 0
    }
    if (agent !== 'pi') {
      const handle = deepFind(parseJson(term, 'orca terminal create').result ?? {}, ['handle', 'terminalHandle'])
      if (!handle) throw new Error('orca terminal create no devolvió el handle de la terminal.')
      if (!(await waitForTui(io, handle, agent))) throw new Error(`La TUI de ${agent} no apareció a tiempo. La terminal ${handle} sigue abierta: mandale a mano "Read and follow the brief in ${briefPath}".`)
      ok(io.sh('orca', ['terminal', 'send', '--terminal', handle, '--text', `Read and follow the brief in ${briefPath}`, '--enter']), 'orca terminal send')
    }
    say(`✔ ${agent} despachado en ${worktree}. Brief: ${briefPath}`)

    return 0
  } catch (error) {
    if (!dryRun && !review) say(`El issue #${n} quedó asignado; si no se despachó nada, soltalo con: gh issue edit ${n} --remove-assignee @me`)
    throw error
  }
}

const command = kind => async (flags, n, agent) =>
  dispatch(kind, { n, agent, nota: flags.nota, dryRun: flags.dryRun, confirmado: flags.confirmado })
export const despacharCommand = command('ticket')
export const revisarCommand = command('review')
