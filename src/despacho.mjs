import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PROJECT_CONFIG, PROJECT_LOCAL_CONFIG } from './constants.mjs'
import { resolveGentleSkills } from './pi.mjs'
import { readAsset, render, wrapperFile } from './templates.mjs'
import { SCRIPTS_REL, homeDir, isWindows, layout, run, samePath, which } from './util.mjs'

// Source of truth: shared/orca-config.ts (FAMILIES, familyOf, blockOf), which explains the rules. Duplicated because
// the mods cannot import src/ and Node 20 cannot import TypeScript; test/units.test.mjs compares the literal and runs
// shared/familias.json against both sides.
// BEGIN FAMILIES
export const FAMILIES = {
  "agents": ["claude", "agy", "codex", "codex-cc", "pi"],
  "fixed": { "pi": "claude" },
  "defaults": { "claude": "claude", "codex": "gpt", "agy": "gemini" },
  "patterns": [
    ["claude", "^(claude|opus|sonnet|haiku|fable)"],
    ["gpt", "^(gpt|codex|o\\d)"],
    ["gemini", "^gemini"],
    ["glm", "^glm"]
  ]
}
// END FAMILIES
export const AGENTS = FAMILIES.agents

// Source of truth: mods/puente-gentle/hooks/puente.ts (ORCA_VARS_CLEARED, engramDir). Duplicated because the mod is TypeScript
// that can only import its own folder; the pi consult and this launcher must clear and set the same things.
const ORCA_VARS_CLEARED = [
  'ORCA_AGENT_HOOK_ENDPOINT', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN', 'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION', 'ORCA_AGENT_HOOK_TRANSPORT', 'ORCA_AGENT_LAUNCH', 'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_PANE', 'ORCA_PANE_KEY', 'ORCA_TAB_ID', 'ORCA_WORKTREE_ID', 'ORCA_TERMINAL_HANDLE',
  'ORCA_STACK_AGENT', 'ORCA_STACK_MODE', 'ORCA_STACK_POLICY_PATH', 'ORCA_STACK_PONYTAIL_LEVEL',
  'ORCA_STACK_CAVEMAN_LEVEL',
]
// Only a review closes pi's tools (read-only). A ticket gets all of them: an allowlist would also drop gentle-pi's
// subagents, SDD and engram tools.
const PI_TOOLS = { review: 'read,bash,grep,find,ls' }
const PI_THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// gentle-pi profile names: 1-64 ASCII slug characters. Also keeps the name harmless inside a path or a command.
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
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
const PIN_KIND = 'gentle-pi.agent_model_profile_pin'
const readJson = (file, io) => {
  try {
    return (io?.exists ?? existsSync)(file) ? JSON.parse((io?.readFile ?? (f => readFileSync(f, 'utf8')))(file).replace(/^﻿/, '')) : undefined
  } catch {
    return undefined
  }
}

export const loadConfig = (home, root) => {
  const personal = readJson(layout(home).config)
  const layers = [personal, readJson(path.join(root, PROJECT_CONFIG)), readJson(path.join(root, PROJECT_LOCAL_CONFIG))]
  const config = merge(...layers)
  // As shared/orca-config.ts: guardia.bloquear adds up across the layers, so no layer can drop a block.
  const rules = layers.flatMap(l => (isPlain(l) && isPlain(l.guardia) && Array.isArray(l.guardia.bloquear) ? l.guardia.bloquear : []))
  if (rules.length > 0) config.guardia = { ...config.guardia, bloquear: rules }
  // The Claude account pi uses comes from the personal layer only: a committed file must not redirect credentials.
  const dir = personal?.agentes?.pi?.claudeConfigDir
  config.piClaudeConfigDir = typeof dir === 'string' && dir.trim() !== '' ? path.normalize(dir.trim().replace(/^~(?=$|[\\/])/, home)) : undefined

  return config
}

// agentes.modelos.<agent>: "model", { modelo, esfuerzo } or { implementar: {...}, revisar: {...} }.
export const modelFor = (config, agent, mode) => {
  let entry = config.agentes?.modelos?.[agent]
  if (isPlain(entry) && (entry.implementar !== undefined || entry.revisar !== undefined)) entry = entry[mode === 'review' ? 'revisar' : 'implementar']
  if (typeof entry === 'string') return { model: entry, effort: undefined }

  return { model: isPlain(entry) ? entry.modelo : undefined, effort: isPlain(entry) ? entry.esfuerzo : undefined }
}

export const familyOfModel = model => {
  const name = model.trim().toLowerCase().split('/').pop() ?? ''

  return FAMILIES.patterns.find(([, pattern]) => new RegExp(pattern).test(name))?.[0]
}

export const familyOf = (config, agent, mode) => {
  if (FAMILIES.fixed[agent] !== undefined) return { family: FAMILIES.fixed[agent], model: undefined }
  const raw = modelFor(config, agent, mode).model
  const model = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined

  return { family: model === undefined ? FAMILIES.defaults[agent] : familyOfModel(model), model }
}

export const parseUntil = date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (match === null) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const at = new Date(year, month - 1, day)
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) return undefined

  return at.getTime()
}

export const blockOf = (config, agent, now) => {
  for (const rule of config.guardia?.bloquear ?? []) {
    if (typeof rule?.agente !== 'string' || rule.agente.toLowerCase() !== agent.toLowerCase()) continue
    const until = typeof rule.hasta === 'string' ? parseUntil(rule.hasta) : undefined
    if (until === undefined) return `La regla guardia.bloquear de ${agent} tiene una fecha "hasta" que no es AAAA-MM-DD (${String(rule.hasta)}): corregila antes de despacharlo.`
    if (now < until) return typeof rule.motivo === 'string' && rule.motivo.trim() !== '' ? rule.motivo : `${agent} está bloqueado hasta el ${rule.hasta}.`
  }

  return undefined
}

const psQuote = text => `'${text.replace(/'/g, "''")}'`
const shQuote = text => `'${text.replace(/'/g, "'\\''")}'`

// The command typed into the Orca terminal. `win` is the target shell, not the host: PowerShell on win32 (Orca's
// terminal there), POSIX elsewhere. Paths follow it.
export const launcherFor = ({ agent, mode, config, win, home, briefPath, session, skills, piModel, piThinking }) => {
  const { model, effort } = modelFor(config, agent, mode)
  const P = win ? path.win32 : path.posix
  const wrapper = P.join(home, ...SCRIPTS_REL, wrapperFile(agent === 'claude' || agent === 'agy' ? agent : 'codex', win))
  const bin = (win ? '& ' : '') + `"${wrapper}"`
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
  const tools = PI_TOOLS[mode] ? ` --tools ${q(PI_TOOLS[mode])}` : ''
  // With a profile the orchestrator is the profile's own, not whatever the global settings.json says (a pin never moves it).
  const piFlags = piModel ? ` --model ${q(piModel)}${PI_THINKING.includes(piThinking) ? ` --thinking ${piThinking}` : ''}` : ''
  const cmd = `pi -p --no-skills --skill ${q(skills)} --session-id ${session}${piFlags}${tools} ${q(prompt)}`
  const set = [['ENGRAM_DATA_DIR', P.join(home, '.gentle-shell', 'engram')], ['GENTLE_PI_AUTONOMOUS_MODE', '1'], ...(config.piClaudeConfigDir ? [['CLAUDE_CONFIG_DIR', config.piClaudeConfigDir]] : [])]
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
  readFile: file => readFileSync(file, 'utf8'),
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
    // Only the screen: the rest of the reply (the request id, the cursors) changes on every read.
    const tail = res.status === 0 ? parseJson(res, 'orca terminal read').result?.terminal?.tail : undefined
    const text = Array.isArray(tail) ? tail.join('\n') : typeof tail === 'string' ? tail : ''
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

// The gentle-pi profile a pi dispatch is pinned to: --perfil-pi wins over agentes.pi.perfil; absent or "preguntar" means
// the globally active profile (today's behavior). Fails before any side effect when it cannot be honored.
export const piProfileFor = ({ flag, config, home, commonDir, io }) => {
  const configured = config.agentes?.pi?.perfil
  const wanted = typeof flag === 'string' ? flag.trim() : typeof configured === 'string' && configured.trim().toLowerCase() !== 'preguntar' ? configured.trim() : ''
  if (wanted === '') return undefined
  if (!PROFILE_NAME.test(wanted)) throw new Error(`El perfil de Pi "${wanted}" no es un nombre válido (letras, números, . _ -; hasta 64 caracteres).`)
  const store = path.join(home, '.pi', 'gentle-ai', 'profiles.json')
  const profiles = readJson(store, io)?.profiles
  if (!isPlain(profiles) || !isPlain(profiles[wanted])) {
    throw new Error(`No existe el perfil de Pi "${wanted}" en ${store}${isPlain(profiles) ? ` (hay: ${Object.keys(profiles).join(', ') || 'ninguno'})` : ''}. Crealo con /gentle:profiles en Pi.`)
  }
  const orchestrator = profiles[wanted].orchestrator
  if (!isPlain(orchestrator) || typeof orchestrator.model !== 'string' || orchestrator.model.trim() === '') {
    throw new Error(`El perfil de Pi "${wanted}" no define orchestrator.model: sin él, el orquestador dependería del settings.json global.`)
  }
  // gentle-pi gives the clone-local pin precedence over the worktree one, so it would win silently.
  const localPin = path.join(commonDir, 'gentle-ai', 'profile-pin.json')
  const local = readJson(localPin, io)
  if (isPlain(local) && local.kind === PIN_KIND && typeof local.profile === 'string' && local.profile !== wanted) {
    throw new Error(`El clon ya fija el perfil de Pi "${local.profile}" (${localPin}) y ese pin gana sobre el del worktree. Sacalo (/gentle:profiles, tecla p) o despachá con --perfil-pi ${local.profile}.`)
  }

  let thinking
  if (orchestrator.thinking !== undefined) {
    if (PI_THINKING.includes(orchestrator.thinking)) thinking = orchestrator.thinking
    else io.out(`⚠ El perfil de Pi "${wanted}" tiene thinking ${JSON.stringify(orchestrator.thinking)}, que no es válido (${PI_THINKING.join(', ')}): se ignora y Pi arranca sin --thinking.`)
  }

  return { name: wanted, model: orchestrator.model.trim(), thinking }
}

// Writes the worktree pin gentle-pi reads at every subagent launch, and keeps it out of git: info/exclude is per clone,
// so nothing tracked changes. gentle-pi also documents this file as a team-committable declaration, so first: a tracked pin
// is left alone when it declares the same profile and fails when it declares another one; and if git still does not ignore
// the file after the exclude entry (a .gitignore negation wins over info/exclude), it fails instead of writing.
const PIN_REL = '.pi/gentle-ai/profile.json'
const writePin = (io, worktree, commonDir, name) => {
  const file = path.join(worktree, ...PIN_REL.split('/'))
  if (io.sh('git', ['ls-files', '--error-unmatch', PIN_REL], { cwd: worktree }).status === 0) {
    let declared
    try {
      declared = JSON.parse(io.readFile(file))
    } catch {}
    const other = isPlain(declared) && typeof declared.profile === 'string' ? declared.profile : undefined
    if (other === name) return
    throw new Error(`${PIN_REL} está versionado en el repo y ${other === undefined ? 'no se puede leer' : `declara el perfil "${other}"`}, no "${name}". No lo piso: ${other === undefined ? 'arreglalo en el repo' : `despachá con --perfil-pi ${other} o cambiá el perfil en el repo`}.`)
  }
  const ignored = () => io.sh('git', ['check-ignore', '-q', file], { cwd: worktree }).status === 0
  if (!ignored()) {
    const exclude = path.join(commonDir, 'info', 'exclude')
    const text = io.exists(exclude) ? io.readFile(exclude) : ''
    if (!text.split(/\r?\n/).some(l => l.trim() === `/${PIN_REL}`)) {
      io.mkdirp(path.dirname(exclude))
      io.writeFile(exclude, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}/${PIN_REL}\n`)
    }
    if (!ignored()) throw new Error(`git no ignora ${PIN_REL} ni con la entrada en ${exclude} (un .gitignore con \`!${PIN_REL}\` gana sobre info/exclude): no escribo el pin para no ensuciar el repo.`)
  }
  io.mkdirp(path.dirname(file))
  io.writeFile(file, `${JSON.stringify({ kind: PIN_KIND, version: 1, profile: name }, null, 2)}\n`)
}
// The whole dispatch: despachar (kind 'ticket', n = issue) and revisar (kind 'review', n = PR).
export const dispatch = async (kind, args, io = defaultIo()) => {
  const { n, agent, nota, perfilPi, dryRun = false, confirmado = false } = args
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
  const blocked = blockOf(config, agent, (io.now ?? Date.now)())
  if (blocked) throw new Error(`No despacho a ${agent}: ${blocked}`)
  if ((config.agentes?.preguntarAntes ?? []).includes(agent) && !confirmado) {
    throw new Error(`${agent} figura en agentes.preguntarAntes: main tiene que preguntarle al humano antes de despacharlo. Si dijo que sí, repetí el comando con --confirmado.`)
  }

  if (perfilPi !== undefined && agent !== 'pi') throw new Error('--perfil-pi solo vale para el agente pi.')
  const profile = agent === 'pi' ? piProfileFor({ flag: perfilPi, config, home: io.home, commonDir, io }) : undefined

  let implementer = agent
  let branchOfPr
  let sha
  if (review) {
    const pr = parseJson(ok(io.sh('gh', ['pr', 'view', String(n), '--json', 'headRefName,headRefOid,body,number'], { cwd: root }), 'gh pr view'), 'gh pr view')
    implementer = /^\s*Implementador:\s*(\S+)/mi.exec(pr.body ?? '')?.[1]?.trim().toLowerCase()
    if (!implementer) throw new Error(`El PR #${n} no tiene la línea "Implementador: <agente>": sin ella no puedo comprobar que el revisor sea otro.`)
    if (implementer === agent.trim().toLowerCase()) throw new Error(`${agent} implementó el PR #${n}: nadie revisa su propio PR.`)
    // Same model family, same blind spots. pi is the exception: next to a Claude agent it brings another methodology.
    // A model with no known family proves nothing, so it does not stop the review.
    const mine = familyOf(config, agent, 'review').family
    if (agent !== 'pi' && implementer !== 'pi' && mine !== undefined && mine === familyOf(config, implementer, 'ticket').family) {
      throw new Error(`${agent} no revisa PRs de ${implementer}: los dos corren modelos de la familia ${mine}, comparten modelo y puntos ciegos.`)
    }
    branchOfPr = pr.headRefName
    sha = pr.headRefOid
  } else {
    const issue = parseJson(ok(io.sh('gh', ['issue', 'view', String(n), '--json', 'state,assignees,title'], { cwd: root }), 'gh issue view'), 'gh issue view')
    if (String(issue.state).toUpperCase() !== 'OPEN') throw new Error(`El issue #${n} está cerrado.`)
    if ((issue.assignees ?? []).length > 0) throw new Error(`El issue #${n} ya tiene assignee (${issue.assignees.map(a => a.login).join(', ')}): está tomado.`)
  }

  // A review is named after its reviewer too: risk paths ask for more than one review of the same PR.
  const name = review ? `revision-${n}-${agent}` : `${repo}-${n}`
  const session = review ? `${repo}-${name}` : name
  const briefPath = path.join(io.home, 'orca', 'briefs', `${session}.md`)
  const startRef = `origin/${review ? branchOfPr : base}`

  // Idempotence lock: an existing worktree for this branch/name, or a live agent in it. A prunable entry is a worktree
  // whose folder is gone (`orca worktree rm` leaves one until `git worktree prune`): it does not count.
  const listed = ok(io.sh('git', ['worktree', 'list', '--porcelain'], { cwd: root }), 'git worktree list').stdout
  const taken = listed.split(/\r?\n\s*\r?\n/).filter(entry => !/^prunable\b/m.test(entry)).join('\n').split(/\r?\n/).filter(l => l.startsWith('worktree ') || l.startsWith('branch ')).map(l => l.replace(/^(worktree|branch) /, ''))
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
  const mode = review ? 'review' : 'ticket'
  const skills = agent === 'pi' ? io.gentleSkills(io.home) : null
  if (agent === 'pi' && !skills) throw new Error('No encuentro las skills de gentle-pi (Pi ni npm global): corré `orca-stack global`.')
  const launcher = launcherFor({ agent, mode, config, win, home: io.home, briefPath, session, skills, piModel: profile?.model, piThinking: profile?.thinking })
  const act = (cmd, argv, opts = {}) => {
    say(`${dryRun ? '[simulación] ' : ''}${cmd} ${argv.map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)

    return dryRun ? { status: 0, stdout: '', stderr: '' } : ok(io.sh(cmd, argv, opts), `${cmd} ${argv[0]}`)
  }

  if (!dryRun) {
    const fetched = io.sh('git', ['fetch', 'origin'], { cwd: root })
    if (fetched.status !== 0) throw new Error(`git fetch origin falló, no asigné ni creé nada: ${(fetched.stderr || fetched.stdout || String(fetched.error)).trim()}`)
  }
  const briefFor = branch => renderBrief(kind, {
    REPO: repo, AGENT: agent, BASE: base, BRANCH: branch, VERIFICATION: verificationBlock(config),
    ...(review ? { PR: String(n), SHA: sha, IMPLEMENTER: implementer } : { ISSUE: String(n) }),
  }, nota)
  // Validate the cited paths against the tree the worktree will be created from, before any side effect.
  const tree = io.sh('git', ['ls-tree', '-r', '--name-only', startRef], { cwd: root })
  if (tree.status === 0) {
    const files = new Set(tree.stdout.split(/\r?\n/).filter(Boolean))
    const missing = missingPaths(briefFor(name), p => files.has(p) || [...files].some(f => f.startsWith(`${p}/`)))
    if (missing.length > 0) {
      throw new Error(`El brief cita rutas que no existen en ${startRef}; no asigné ni creé nada:\n${missing.map(p => `  - ${p}`).join('\n')}\nUna ruta ignorada por git no llega a un worktree: citá algo que esté versionado.`)
    }
  } else if (dryRun) say(`⚠ No pude listar ${startRef}: la validación de rutas del brief se hace al despachar.`)
  else throw new Error(`No pude listar ${startRef} para validar las rutas del brief: ${(tree.stderr || tree.stdout).trim()}`)
  const left = { assigned: false, worktree: null, brief: null }
  if (!review) {
    act('gh', ['issue', 'edit', String(n), '--add-assignee', '@me'], { cwd: root })
    left.assigned = !dryRun
  }
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
      left.worktree = worktree
    }

    if (profile) {
      say(`${dryRun ? '[simulación] ' : ''}perfil de Pi "${profile.name}": pin en ${path.join(worktree, ...PIN_REL.split('/'))} (si git no lo ignora, se agrega /${PIN_REL} a ${path.join(commonDir, 'info', 'exclude')}); orquestador ${profile.model}${profile.thinking ? ` (${profile.thinking})` : ''}`)
      if (!dryRun) writePin(io, worktree, commonDir, profile.name)
    }
    const brief = briefFor(branch)
    say(`${dryRun ? '[simulación] ' : ''}brief -> ${briefPath}`)
    if (!dryRun) {
      io.mkdirp(path.dirname(briefPath))
      io.writeFile(briefPath, brief)
      left.brief = briefPath
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
    if (!dryRun) say(leftover(left, n, base))
    throw error
  }
}

const command = kind => async (flags, n, agent) =>
  dispatch(kind, { n, agent, nota: flags.nota, dryRun: flags.dryRun, confirmado: flags.confirmado, perfilPi: flags.perfilPi })
export const despacharCommand = command('ticket')
export const revisarCommand = command('review')

// What a failed dispatch left behind and how to recover: the idempotence lock refuses a retry while the worktree exists.
export const leftover = ({ assigned, worktree, brief }, n, base) => {
  if (!assigned && !worktree && !brief) return 'No quedó nada a medias.'
  const lines = ['El despacho quedó a medias. Quedó:']
  if (assigned) lines.push(`  - el issue #${n} asignado`)
  if (worktree) lines.push(`  - el worktree ${worktree}`)
  if (brief) lines.push(`  - el brief ${brief}`)
  lines.push(worktree ? 'Un reintento va a rechazar el despacho mientras el worktree exista. Para recuperar:' : 'Para recuperar:')
  if (worktree) {
    lines.push('  - seguí a mano: lanzá el agente en ese worktree y mandale el brief; o')
    lines.push(`  - con el OK del humano, \`orca worktree rm --worktree path:${worktree}\` (borra también la rama local: antes mirá que \`git branch --no-merged origin/${base}\` no la liste)`)
  }
  if (assigned) lines.push(`  - soltá el issue con \`gh issue edit ${n} --remove-assignee @me\``)

  return lines.join('\n')
}
