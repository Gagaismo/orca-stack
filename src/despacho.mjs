import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PROJECT_CONFIG, PROJECT_LOCAL_CONFIG } from './constants.mjs'
import { ensureCandidateWorktreesExclude } from './candidate-worktrees.mjs'
import { analyzeChecks, isHigherRunId, isPending, latestChecks } from './checks.mjs'
import { codexTrustHint } from './codex-trust.mjs'
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
// subagents, ODD and engram tools.
export const PI_TOOLS = { review: 'read,bash,grep,find,ls,codemode' }
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
    // Fast mode spends codex credits faster and an unattended worker does not need the speed; codex-cc bills through
    // Command Code, so it keeps its flags.
    const fast = agent === 'codex' ? ' -c features.fast_mode=false' : ''
    const flags = `${model ? ` --model ${model}` : ''}${effort ? ` -c model_reasoning_effort="${effort}"` : ''}${fast} -c approval_policy="never" -c sandbox_mode="danger-full-access"`
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
    if (/[\s<>{}*$=:@#]/.test(t) || /^(-|~|\/|origin\/|refs\/|odd(\/|$))/.test(t) || /^[a-z]:[\\/]/i.test(t)) continue
    if ((t.includes('/') || PATH_EXTENSIONS.test(t)) && !found.includes(t)) found.push(t)
  }

  return found
}

export const missingPaths = (brief, has) => citedPaths(brief).filter(p => !has(p.replace(/\/+$/, '')))

const verificationBlock = config => {
  const lines = [config.verificacion?.suite, config.verificacion?.typecheck]
    .filter(c => typeof c === 'string' && c.trim() !== '' && c.trim().toLowerCase() !== 'ninguno')

  return lines.length === 0 ? "(none configured: run the project's own checks)" : lines.join('\n')
}

export const parseRemoteUrl = url => {
  if (typeof url !== 'string') return undefined
  const raw = url.trim()
  if (!raw) return undefined

  const scpMatch = /^(?:[^@\s]+@)?([a-zA-Z0-9.-]+):([^/\s][^:\s]*)$/.exec(raw)
  if (scpMatch) {
    const host = scpMatch[1]
    const repoPath = scpMatch[2].replace(/\.git$/i, '').replace(/^\/+/, '')
    const parts = repoPath.split('/')
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { host, ownerRepo: `${parts[0]}/${parts[1]}` }
    }
    return undefined
  }

  try {
    const parsed = new URL(raw)
    const host = parsed.hostname
    if (!host) return undefined
    const repoPath = parsed.pathname.replace(/\.git$/i, '').replace(/^\/+/, '')
    const parts = repoPath.split('/')
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { host, ownerRepo: `${parts[0]}/${parts[1]}` }
    }
  } catch {
    return undefined
  }

  return undefined
}

export const getRemoteOrigin = (root, io) => {
  const res = io.sh('git', ['remote', 'get-url', 'origin'], { cwd: root })
  if (res.status !== 0 || !res.stdout || !res.stdout.trim()) {
    throw new Error('El repo no tiene un remote origin configurado: no puedo determinar el destino remoto para autorizar al worker.')
  }
  const url = res.stdout.trim().split(/\r?\n/)[0].trim()
  const parsed = parseRemoteUrl(url)
  if (!parsed) {
    throw new Error(`No pude interpretar el remote origin "${url}" como host y owner/repo: no puedo determinar el destino remoto para autorizar al worker.`)
  }
  return { ...parsed, url }
}

const hasFanoutAuthorization = nota => typeof nota === 'string' &&
  /\b(?:arena|swarm)\b/i.test(nota) &&
  /\bN\s*=\s*\d+\b/i.test(nota) &&
  /\b(?:rubric|r[u\u00FA]brica|question|pregunta)\b/i.test(nota) &&
  /Agent tool only/i.test(nota)

const fanoutInstructions = (agent, nota, bounce = false) => {
  const bounceApproval = bounce
    ? 'A new fan-out note on this bounce requires a new human OK; previous dispatch approval does not carry over. '
    : ''
  if (agent !== 'claude') return `${bounceApproval}Arena and swarm are not supported for ${agent}, even when the note includes authorization. Do not run an arena or swarm fan-out.`
  if (!hasFanoutAuthorization(nota)) return `${bounceApproval}No arena or swarm is authorized without an approved note. Do not use Workflow or run an unrequested arena or swarm fan-out.`
  return `${bounceApproval}The approved note authorizes fan-out for this ticket only. Use the Agent tool only, never Workflow. Run only the approved N, one round, no retry. Candidates run at your effort unless the approved note specifies otherwise. If every candidate drops out or you want another round, do not retry; continue the normal path and say so under ## Arena or ## Swarm. Put the results under the matching ## Arena or ## Swarm heading in the PR body.`
}

// claude imports AGENTS.md through CLAUDE.md (`orca-stack init`), and codex and pi load it on their own. Nobody checked
// agy and codex-cc, so they keep reading it.
const LOADS_AGENTS_MD = ['claude', 'codex', 'pi']
const projectInstructions = agent => LOADS_AGENTS_MD.includes(agent)
  ? 'AGENTS.md is already in your context: do not read it again. Read GLOSSARY.md or CONTEXT.md and docs/adr when they exist.'
  : 'Read the project instructions (AGENTS.md, and GLOSSARY.md or CONTEXT.md and docs/adr when they exist).'

const subagentsInstruction = agent => {
  const scope = 'for ODD\'s explorer and verifier and for the code-review rounds of ## Pull request, and for nothing else, except an arena or swarm fan-out that the Fan-out line under ## Rules allows. Dispatching Orca workers is not allowed.'
  if (agent === 'claude') return `Subagents: you may use your session's subagents (the Agent tool) ${scope}`
  // codex does not spawn agents unless it is asked explicitly.
  if (agent === 'codex') return `Subagents: you may use your session's subagents (\`spawn_agent\`) ${scope} This line is the explicit request to spawn agents that your default asks for.`
  return `Subagents: when your runtime has subagents, you may use your session's subagents ${scope} When it has none, do those steps inline and note it under ## Desvíos del ticket.`
}

const bodyPrecheckStep = cuerpoPr => {
  if (typeof cuerpoPr !== 'string' || cuerpoPr.trim() === '') return ''
  const cmd = cuerpoPr.trim().replace(/\{file\}/g, '<your body file>')
  return `\n6. Run \`${cmd}\` on your PR body file and fix the body until it passes.`
}

const reboteBodyPrecheckStep = cuerpoPr => {
  if (typeof cuerpoPr !== 'string' || cuerpoPr.trim() === '') return ''
  const cmd = cuerpoPr.trim().replace(/\{file\}/g, '<your body file>')
  return `\n- Run \`${cmd}\` on the new body file before \`gh pr edit\` and fix the body until it passes.`
}

export const renderBrief = (kind, vars, nota) => {
  const defaultOps = kind === 'ticket'
    ? `read issue #${vars.ISSUE ?? '<n>'} and its comments and the repo; comment on the issue; push only the ticket branch to \`origin\`; open the PR against ${vars.BASE ?? 'main'}.`
    : 'read the PR, its diff, its checks and the issue it closes; publish the review with the command the brief already gives. No push.'
  return render(readAsset('stack', kind === 'ticket' ? 'brief-ticket.md' : 'brief-revision.md'), {
    ...vars,
    REMOTE_HOST: vars.REMOTE_HOST ?? 'github.com',
    REMOTE_REPO: vars.REMOTE_REPO ?? (vars.REPO ? `owner/${vars.REPO}` : 'owner/repo'),
    REMOTE_OPERATIONS: vars.REMOTE_OPERATIONS ?? defaultOps,
    WORKTREE_INSTRUCTIONS: vars.WORKTREE_INSTRUCTIONS ?? `Repo: ${vars.REPO}. PR #${vars.PR} is written by ${vars.IMPLEMENTER}; its head commit is ${vars.SHA}. This worktree must be at that commit: run git rev-parse HEAD, and if it differs, git fetch origin and git checkout --detach ${vars.SHA}.`,
    PUBLISH_INSTRUCTIONS: vars.PUBLISH_INSTRUCTIONS ?? 'Write the review in a UTF-8 file and publish it with a body file, never through a pipe:',
    PUBLISH_COMMAND: vars.PUBLISH_COMMAND ?? `gh pr review ${vars.PR} --comment --body-file <file>`,
    REVIEWER_LINE: vars.REVIEWER_LINE ?? vars.AGENT,
    PROJECT_INSTRUCTIONS: projectInstructions(vars.AGENT),
    SUBAGENTS_INSTRUCTION: subagentsInstruction(vars.AGENT),
    BODY_PRECHECK_STEP: vars.BODY_PRECHECK_STEP ?? bodyPrecheckStep(vars.CUERPO_PR),
    CODING_STANDARDS_INSTRUCTION: vars.HAS_CODING_STANDARDS ? 'Read CODING_STANDARDS.md and check the change against it before every commit.' : '',
    REVIEW_STANDARDS: vars.HAS_CODING_STANDARDS ? 'CODING_STANDARDS.md and AGENTS.md' : 'AGENTS.md',
    FANOUT_INSTRUCTIONS: fanoutInstructions(vars.AGENT, nota),
    NOTE_SECTION: nota ? `\n## Extra notes from main\n\n${nota.trim()}\n` : '',
  })
}

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
  listFiles: dir => readdirSync(dir).map(name => path.join(dir, name)),
  writeFile: (file, text) => writeFileSync(file, text, 'utf8'),
  rename: (from, to) => renameSync(from, to),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  gentleSkills: home => resolveGentleSkills(layout(home))?.dir ?? null,
})

const ok = (res, what) => {
  if (res.status !== 0) throw new Error(`${what} falló: ${(res.stderr || res.stdout || String(res.error)).trim()}`)

  return res
}

export const shellPrompt = text => /(?:^|\n)\s*PS\s+[A-Za-z]:\\[^\n>]*>\s*$/im.test(text)

export const quotaLine = lines => {
  if (!Array.isArray(lines)) return undefined
  return lines.slice(-15).find(line => /quota (reached|exceeded)|usage limit|rate[- ]limit|Resets? in \d/i.test(String(line)))
}

const checkPostLaunchScreen = async (io, handle, agent) => {
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) await io.sleep(5000)
    const res = ok(io.sh('orca', ['terminal', 'read', '--terminal', handle, '--screen', '--json']), 'orca terminal read')
    const tail = parseJson(res, 'orca terminal read').result?.terminal?.tail
    const lines = Array.isArray(tail) ? tail : typeof tail === 'string' ? tail.split(/\r?\n/) : []
    const quota = quotaLine(lines)
    if (quota) throw new Error(`La terminal de ${agent} (${handle}) muestra un l\u00edmite de cuota; el turno no est\u00e1 ejecut\u00e1ndose: ${quota}`)
    // shellPrompt intentionally recognizes PowerShell only; bash and cmd.exe prompts remain out of scope.
    const last = lines.map(line => String(line)).reverse().find(line => line.trim() !== '')
    if (last && shellPrompt(last)) throw new Error(`La terminal de ${agent} (${handle}) volvi\u00f3 al shell prompt; el turno no est\u00e1 ejecut\u00e1ndose: ${last}`)
  }
}

const waitForTui = async (io, handle, agent, root, tries = 45) => {
  let last = null
  let stable = 0
  let trusted = false
  for (let i = 0; i < tries; i += 1) {
    await io.sleep(2000)
    const res = io.sh('orca', ['terminal', 'read', '--terminal', handle, '--screen', '--json'])
    // Only the screen: the rest of the reply (the request id, the cursors) changes on every read.
    const tail = res.status === 0 ? parseJson(res, 'orca terminal read').result?.terminal?.tail : undefined
    const text = Array.isArray(tail) ? tail.join('\n') : typeof tail === 'string' ? tail : ''
    if (/update available/i.test(text) && /update now/i.test(text) && /\bskip\b/i.test(text)) {
      throw new Error(`Codex muestra su men\u00FA de actualizaci\u00F3n y no recibi\u00F3 el brief. Eleg\u00ED una opci\u00F3n en la terminal ${handle} y relanzalo con orca-stack reanudar <issue> <url-del-comentario>. Pantalla: ${text}`)
    }
    if (/trust this folder\?/i.test(text)) {
      if (agent !== 'agy') {
        throw new Error(`Codex pide confiar en la carpeta y no recibió el brief. ${codexTrustHint(root)} Pantalla: ${text}`)
      }
    }
    if (agent === 'agy' && !trusted && /trust/i.test(text)) {
      io.sh('orca', ['terminal', 'send', '--terminal', handle, '--enter'])
      trusted = true
      stable = 0
      last = null
      continue
    }
    if (shellPrompt(text)) throw new Error(`La terminal volvió al shell prompt antes de recibir el brief; el turno no arrancó. Pantalla: ${text}`)
    stable = text !== '' && text === last ? stable + 1 : 0
    last = text
    if (stable >= 2) {
      if (/trust this folder\?/i.test(text)) throw new Error(`La pantalla de confianza sigue abierta; no envío el brief sobre ese menú. Pantalla: ${text}`)
      return text
    }
  }

  return undefined
}

const submittedTurn = value => {
  if (Array.isArray(value)) return value.some(submittedTurn)
  if (!isPlain(value)) return false
  if (value.turnStarted === true || value.turn_started === true || value.turnStartObserved === true || value.submitted === true || value.submissionObserved === true || value.promptSubmitted === true || value.started === true) return true
  if (typeof value.status === 'string' && /^(submitted|turn[_ -]?started)$/i.test(value.status)) return true
  return Object.values(value).some(submittedTurn)
}

const worktreeAgentStarted = (io, worktree) => {
  const ps = io.sh('orca', ['worktree', 'ps', '--json'])
  if (ps.status !== 0) return false
  try {
    const rows = parseJson(ps, 'orca worktree ps').result?.worktrees ?? []
    const row = rows.find(w => samePath(w.path ?? '', worktree))
    return (row?.agents ?? []).some(a => /^(working|running|active)$/i.test(a.state ?? a.status ?? ''))
  } catch {
    return false
  }
}

const screenAfterSend = async (io, handle, before) => {
  for (let i = 0; i < 5; i += 1) {
    await io.sleep(1000)
    const res = io.sh('orca', ['terminal', 'read', '--terminal', handle, '--screen', '--json'])
    if (res.status !== 0) continue
    try {
      const tail = parseJson(res, 'orca terminal read').result?.terminal?.tail
      const text = Array.isArray(tail) ? tail.join('\n') : typeof tail === 'string' ? tail : ''
      if (text !== '' && text !== before) return text
    } catch {}
  }
  return undefined
}

const piSessionTools = (io, home, worktree, after = 0) => {
  const root = path.join(home, '.pi', 'agent', 'sessions')
  const target = path.resolve(worktree)
  try {
    const dirs = io.listFiles(root)
    const matches = dirs.flatMap(dir => {
      try {
        return io.listFiles(dir).filter(file => file.endsWith('.jsonl')).map(file => ({ file, name: path.basename(file) }))
      } catch { return [] }
    }).sort((a, b) => b.name.localeCompare(a.name))
    for (const { file } of matches) {
      try {
        if (after > 0 && (io.modifiedAt ? io.modifiedAt(file) : statSync(file).mtimeMs) <= after) continue
        const lines = io.readFile(file).split(/\r?\n/)
        const session = JSON.parse(lines[0])
        if (!samePath(session.cwd ?? '', target)) continue
        const initial = JSON.parse(lines[4] ?? '{}')
        const tools = initial.message?.sections?.tools ?? initial.message?.content?.find?.(part => part.type === 'text')?.text ?? initial.message?.content
        if (typeof tools === 'string' && /<tools>\s*\(none\)/i.test(tools)) return 'none'
        return 'available'
      } catch {}
    }
  } catch {}
  return undefined
}

const waitForPiSession = async (io, home, worktree, after = 0) => {
  for (let i = 0; i < 25; i += 1) {
    const tools = piSessionTools(io, home, worktree, after)
    if (tools !== undefined) return tools
    await io.sleep(200)
  }
  return undefined
}

export const launchInWorktree = async ({ agent, mode, worktree, briefPath, brief, session, config, win, home, skills, piModel, piThinking, repositoryRoot, io, dryRun = false, piSessionAfter = 0 }) => {
  const say = io.out
  const launcher = launcherFor({ agent, mode, config, win, home, briefPath, session, skills, piModel, piThinking })
  const act = (cmd, argv, opts = {}) => {
    say(`${dryRun ? '[simulaci\u00f3n] ' : ''}${cmd} ${argv.map(a => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)

    return dryRun ? { status: 0, stdout: '', stderr: '' } : ok(io.sh(cmd, argv, opts), `${cmd} ${argv[0]}`)
  }

  say(`Lanzador (${agent}): ${launcher}`)
  const term = act('orca', ['terminal', 'create', '--worktree', `path:${worktree}`, '--title', agent, '--command', launcher, '--json'])
  if (dryRun) {
    if (agent !== 'pi') say(`[simulaci\u00f3n] esperar la TUI de ${agent}${agent === 'agy' ? ' (confirmar la carpeta con Enter)' : ''} y enviar: Read and follow the brief in ${briefPath}`)
    say(`\n--- brief ---\n${brief}`)

    return 0
  }
  if (agent !== 'pi') {
    const handle = deepFind(parseJson(term, 'orca terminal create').result ?? {}, ['handle', 'terminalHandle'])
    if (!handle) throw new Error('orca terminal create no devolvi\u00f3 el handle de la terminal.')
    const before = await waitForTui(io, handle, agent, repositoryRoot)
    if (!before) throw new Error(`La TUI de ${agent} no apareci\u00f3 a tiempo. La terminal ${handle} sigue abierta: mandale a mano "Read and follow the brief in ${briefPath}".`)
    const prompt = `Read and follow the brief in ${briefPath}`
    const observed = io.sh('orca', ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter', '--wait-submit', '10', '--json'])
    let sent = observed
    let oldHost = false
    if (observed.status !== 0 && /(?:unknown|unrecognized|unsupported)[^\n]*--wait-submit/i.test(observed.stderr || observed.stdout)) {
      oldHost = true
      sent = io.sh('orca', ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter'])
    }
    ok(sent, 'orca terminal send')
    let started = false
    if (!oldHost) {
      const receipt = parseJson(sent, 'orca terminal send')
      if (receipt.ok === false) throw new Error(`orca terminal send no inici\u00f3 el turno: ${receipt.error?.message ?? JSON.stringify(receipt)}`)
      started = submittedTurn(receipt)
    }
    if (!started) started = worktreeAgentStarted(io, worktree)
    if (!started) {
      const screen = await screenAfterSend(io, handle, before)
      if (screen && !shellPrompt(screen) && !/trust this folder\?/i.test(screen)) started = true
    }
    if (!started) throw new Error(`orca terminal send acept\u00f3 o envi\u00f3 el brief, pero no hay evidencia de que el turno haya arrancado. Terminal: ${handle}. Pantalla anterior: ${before}`)
    await checkPostLaunchScreen(io, handle, agent)
  } else {
    const tools = await waitForPiSession(io, home, worktree, piSessionAfter)
    if (tools === 'none') throw new Error(`La nueva sesi\u00f3n de Pi no tiene herramientas (<tools>\\n(none)); no despacho el brief. Revis\u00e1 la configuraci\u00f3n de herramientas de Pi para el worktree ${worktree}.`)
    if (piSessionAfter > 0 && tools === undefined) throw new Error(`No observ\u00E9 una sesi\u00F3n nueva de Pi despu\u00E9s del lanzamiento en ${worktree}; no doy el rebote por iniciado.`)
  }
  say(`\u2714 ${agent} despachado en ${worktree}. Brief: ${briefPath}`)

  return 0
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
  if (git.status !== 0) throw new Error('Corr\u00E9 este comando dentro del checkout principal de un repo git.')
  const [gitDir, commonDir, top] = git.stdout.split(/\r?\n/).map(l => l.trim())
  if (!samePath(gitDir, commonDir)) throw new Error('Esto es un worktree: corr\u00E9 el comando desde el checkout principal del repo (la sesi\u00F3n de main).')
  const root = path.resolve(top)
  const repo = path.basename(root)

  const config = loadConfig(io.home, root)
  if (config.setup !== 'completo') throw new Error(`El setup de orca-stack está pendiente en ${repo}: hacelo con la skill orca-setup antes de despachar.`)
  if (config.modo === 'un-agente') throw new Error('El modo del repo es "un-agente": no hay workers que despachar.')
  const base = config.ramaBase
  if (typeof base !== 'string' || base === '') throw new Error('Falta ramaBase en la configuración del repo.')
  if (!(config.agentes?.usa ?? []).includes(agent)) throw new Error(`${agent} no est\u00E1 en agentes.usa de este repo (${(config.agentes?.usa ?? []).join(', ') || 'vac\u00EDo'}).`)
  const blocked = blockOf(config, agent, (io.now ?? Date.now)())
  if (blocked) throw new Error(`No despacho a ${agent}: ${blocked}`)
  if ((config.agentes?.preguntarAntes ?? []).includes(agent) && !confirmado) {
    throw new Error(`${agent} figura en agentes.preguntarAntes: main tiene que preguntarle al humano antes de despacharlo. Si dijo que sí, repetí el comando con --confirmado.`)
  }

  const remote = getRemoteOrigin(root, io)

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
  if (agent === 'pi' && !skills) throw new Error('No encuentro las skills de gentle-pi (Pi ni npm global): corr\u00E9 `orca-stack global`.')

  const act = (cmd, argv, opts = {}) => {
    say(`${dryRun ? '[simulación] ' : ''}${cmd} ${argv.map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)

    return dryRun ? { status: 0, stdout: '', stderr: '' } : ok(io.sh(cmd, argv, opts), `${cmd} ${argv[0]}`)
  }

  if (!dryRun) {
    const fetched = io.sh('git', ['fetch', 'origin'], { cwd: root })
    if (fetched.status !== 0) throw new Error(`git fetch origin falló, no asigné ni creé nada: ${(fetched.stderr || fetched.stdout || String(fetched.error)).trim()}`)
  }
  let hasCodingStandards = false
  const briefFor = branch => renderBrief(kind, {
    REPO: repo,
    REMOTE_HOST: remote.host,
    REMOTE_REPO: remote.ownerRepo,
    AGENT: agent,
    BASE: base,
    BRANCH: branch,
    VERIFICATION: verificationBlock(config),
    CUERPO_PR: config.verificacion?.cuerpoPR,
    HAS_CODING_STANDARDS: hasCodingStandards,
    ...(review ? { PR: String(n), SHA: sha, IMPLEMENTER: implementer } : { ISSUE: String(n) }),
  }, nota)
  // Validate the cited paths against the tree the worktree will be created from, before any side effect.
  const tree = io.sh('git', ['ls-tree', '-r', '--name-only', startRef], { cwd: root })
  if (tree.status === 0) {
    const files = new Set(tree.stdout.split(/\r?\n/).filter(Boolean))
    hasCodingStandards = files.has('CODING_STANDARDS.md')
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
    if (agent === 'claude') {
      ensureCandidateWorktreesExclude({ root, commonDir, io, dryRun, say })
    }
    const created = act('orca', createArgs)
    if (!dryRun) {
      const json = parseJson(created, 'orca worktree create')
      worktree = deepFind(json.result ?? json, ['path', 'worktreePath'])
      branch = (deepFind(json.result ?? json, ['branch']) ?? name).replace(/^refs\/heads\//, '')
      if (!worktree) throw new Error('orca worktree create no devolvió la ruta del worktree.')
      left.worktree = worktree
    }

    if (!review) say(`${dryRun ? '[simulaci\u00f3n] ' : ''}Rama: ${dryRun ? `la define Orca al crear el worktree (se pidi\u00f3 --name ${name})` : branch}`)

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
    await launchInWorktree({
      agent, mode, worktree, briefPath, brief, session, config, win, home: io.home, skills,
      piModel: profile?.model, piThinking: profile?.thinking, repositoryRoot: root, io, dryRun,
    })

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

const reviewBody = review => typeof review?.body === 'string' ? review.body : ''
const blockingSection = body => /(?:^|\r?\n)##\s+BLOQUEA\s*(?:\r?\n|$)([\s\S]*?)(?=\r?\n##\s|$)/i.exec(body)?.[1]?.trim() ?? ''
const blockingBody = body => {
  const section = blockingSection(body)
  return section !== '' && !/^nada\s*$/i.test(section)
}

export const reboteCommand = async (flags, n, io = defaultIo()) => {
  const { nota, confirmado = false, perfilPi, dryRun = false } = flags
  const say = io.out
  if (!/^\d+$/.test(String(n ?? ''))) throw new Error('Falta el n\u00FAmero de PR. Uso: orca-stack rebote <pr>.')
  const git = io.sh('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], { cwd: io.cwd })
  if (git.status !== 0) throw new Error('Corr\u00E9 este comando dentro del checkout principal de un repo git.')
  const [gitDir, commonDir, top] = git.stdout.split(/\r?\n/).map(line => line.trim())
  if (!samePath(gitDir, commonDir)) throw new Error('Esto es un worktree: corr\u00E9 el comando desde el checkout principal del repo (la sesi\u00F3n de main).')
  const root = path.resolve(top)
  const repo = path.basename(root)
  const config = loadConfig(io.home, root)
  if (config.setup !== 'completo') throw new Error(`El setup de orca-stack est\u00E1 pendiente en ${repo}: hacelo con la skill orca-setup antes de relanzar.`)
  if (config.modo === 'un-agente') throw new Error('El modo del repo es "un-agente": no hay workers que relanzar.')

  const remote = getRemoteOrigin(root, io)

  const pr = parseJson(ok(io.sh('gh', ['pr', 'view', String(n), '--json', 'state,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,body,comments,reviews,statusCheckRollup'], { cwd: root }), 'gh pr view'), 'gh pr view')
  if (String(pr.state).toUpperCase() !== 'OPEN') throw new Error(`El PR #${n} est\u00E1 ${String(pr.state).toLowerCase()}; no se puede rebotar.`)
  const agent = /^\s*Implementador:\s*(\S+)/mi.exec(pr.body ?? '')?.[1]?.trim().toLowerCase()
  if (!agent) throw new Error(`El PR #${n} no tiene la l\u00EDnea "Implementador: <agente>".`)
  if (!AGENTS.includes(agent)) throw new Error(`Agente desconocido en Implementador: ${agent}.`)
  if (!(config.agentes?.usa ?? []).includes(agent)) throw new Error(`${agent} no est\u00E1 en agentes.usa de este repo (${(config.agentes?.usa ?? []).join(', ') || 'vac\u00EDo'}).`)
  const blocked = blockOf(config, agent, (io.now ?? Date.now)())
  if (blocked) throw new Error(`No relanzo a ${agent}: ${blocked}`)
  if ((config.agentes?.preguntarAntes ?? []).includes(agent) && !confirmado) {
    throw new Error(`${agent} figura en agentes.preguntarAntes: main tiene que preguntarle al humano antes de relanzarlo. Si dijo que s\u00ED, repet\u00ED el comando con --confirmado.`)
  }
  if (perfilPi !== undefined && agent !== 'pi') throw new Error('--perfil-pi solo vale para el agente pi.')

  const sha = pr.headRefOid
  if (typeof sha !== 'string' || sha.trim() === '') throw new Error(`No pude obtener headRefOid del PR #${n}.`)
  const allReviews = [...(pr.reviews ?? []), ...(pr.comments ?? [])]
  const markers = allReviews.flatMap(item => [...reviewBody(item).matchAll(/^Rebote:\s*(\S+)\s*$/gim)].map(match => match[1]))
  const ciMarkers = allReviews.flatMap(item => [...reviewBody(item).matchAll(/^Rebote CI:\s*(\S+)\s*$/gim)].map(match => match[1]))
  const conflictMarkers = allReviews.flatMap(item => [...reviewBody(item).matchAll(/^Rebote conflicto:\s*(\S+)\s*$/gim)].map(match => match[1]))
  const mergeable = String(pr.mergeable ?? '').toUpperCase()
  if (mergeable === 'UNKNOWN') throw new Error(`GitHub todavía está calculando si el PR #${n} se puede mergear; repetí el comando en unos segundos.`)
  // GitHub does not run pull_request workflows while a PR conflicts, so its CI gate (pending, cancelled) is skipped.
  const conflict = mergeable === 'CONFLICTING'
  const base = pr.baseRefName || config.ramaBase || 'main'
  if (conflict && conflictMarkers.includes(sha)) throw new Error(`El PR #${n} ya rebotó por conflicto en ${sha} y el autor no pusheó nada desde entonces; mirá su worktree antes de repetir.`)
  // Only checks from the latest run of each workflow count; a cancelled run with an unlisted replacement is pending.
  // statusCheckRollup is the head commit's rollup, so every check in it belongs to headRefOid.
  const latest = latestChecks(Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [])
  const analysis = analyzeChecks(latest)
  const checks = latest.map(({ check }) => check)
  const checkName = check => check.name ?? check.context ?? 'Unnamed check'
  const checkUrl = check => check.detailsUrl ?? check.targetUrl ?? ''
  const cancelledChecks = conflict ? [] : latest.filter(({ check }) => check.__typename === 'CheckRun' && check.conclusion === 'CANCELLED')
  const successors = []
  const checkedWorkflows = new Set()
  for (const { check, runId } of cancelledChecks) {
    const workflow = check.workflowName ?? ''
    if (!runId || !workflow) continue
    if (checkedWorkflows.has(workflow)) continue
    checkedWorkflows.add(workflow)
    const res = io.sh('gh', ['run', 'list', '--commit', sha, '--workflow', workflow, '--json', 'databaseId,status,conclusion'], { cwd: root })
    if (res.status !== 0) throw new Error(`No pude comprobar las corridas de CI de ${workflow}: gh run list falló (${(res.stderr || res.stdout || '').trim().split(/\r?\n/)[0]}).`)
    let runs
    try {
      runs = JSON.parse(res.stdout)
    } catch {
      throw new Error(`No pude comprobar las corridas de CI de ${workflow}: gh run list no devolvió JSON.`)
    }
    if (!Array.isArray(runs)) throw new Error(`No pude comprobar las corridas de CI de ${workflow}: gh run list no devolvió una lista.`)
    const higher = runs.filter(run => isHigherRunId(run.databaseId, runId)).sort((a, b) => BigInt(a.databaseId) > BigInt(b.databaseId) ? -1 : 1)[0]
    if (higher) successors.push(higher.databaseId)
  }
  if (successors.length > 0) {
    throw new Error(`El PR #${n} tiene una corrida nueva de CI en curso (${successors.join(', ')}) que reemplaza a la cancelada; esperá a que termine antes de rebotar.`)
  }
  // A legacy row without a run id keeps the existing refusal and rerun guidance.
  const unexplainedCancelled = conflict ? [] : analysis.unexplainedCancellations.flatMap(c => c.checks)
  if (unexplainedCancelled.length > 0) {
    const reruns = unexplainedCancelled.map(check => {
      const runId = /\/actions\/runs\/(\d+)(?:\/|$)/i.exec(checkUrl(check))?.[1]
      return `${checkName(check)}${runId ? `: gh run rerun ${runId} --failed` : `: ${checkUrl(check) || 'run URL unavailable'} (rerun the failed jobs)`}`
    })
    throw new Error(`El PR #${n} tiene checks CANCELLED en ${sha}; no lo rebotes hasta volver a ejecutar CI:\n${reruns.join('\n')}`)
  }
  const pendingChecks = conflict ? [] : checks.filter(isPending)
  if (pendingChecks.length > 0) {
    throw new Error(`El PR #${n} todavía tiene checks pendientes en ${sha}: ${pendingChecks.map(checkName).join(', ')}. Esperá a que termine la CI antes de rebotar.`)
  }
  const failedChecks = analysis.realFailures.map(({ check }) => check)
  if (failedChecks.length > 0) {
    const previousCiShas = new Set(ciMarkers.filter(marker => marker !== sha))
    if (previousCiShas.size >= 2) {
      throw new Error(`Ya hubo dos rebotes de CI distintos para el PR #${n}; la CI sigue roja en ${sha}. Pasalo al humano para resolverlo.`)
    }
  }
  const blockers = allReviews.filter(item => {
    const body = reviewBody(item)
    return blockingBody(body) && /^\s*Commit:\s*(\S+)/mi.exec(body)?.[1] === sha
  })
  const interpretations = blockers.filter(item => /interpretaci[o\u00F3]n/i.test(blockingSection(reviewBody(item))))
  const reviewBlockers = blockers.filter(item => !interpretations.includes(item))
  // A conflict-only bounce does not spend the review bounce, so an older Rebote: marker does not refuse it.
  if (markers.some(marker => marker !== sha) && !(conflict && reviewBlockers.length === 0)) throw new Error(`El head del PR avanz\u00F3 desde el rebote (${markers.at(-1)} -> ${sha}); lo que siga en pie lo decide main con Decidido por main.`)
  if (interpretations.length > 0 && failedChecks.length === 0 && !conflict) {
    const lines = interpretations.map(item => `${item.url ?? item.html_url ?? 'review'}: ${blockingSection(reviewBody(item)).split(/\r?\n/).filter(line => /interpretaci[o\u00F3]n/i.test(line)).join(' ')}`)
    throw new Error(`Los bloqueos de interpretaci\u00F3n van al humano, no al autor:\n${lines.join('\n')}`)
  }
  const findings = reviewBlockers.map(item => {
    return `${item.url ?? item.html_url ?? 'Review'}\n${blockingSection(reviewBody(item))}`
  }).join('\n\n')
  if (reviewBlockers.length === 0 && failedChecks.length === 0 && !conflict) {
    const behind = String(pr.mergeStateStatus ?? '').toUpperCase() === 'BEHIND'
    throw new Error(`El PR #${n} no tiene un review bloqueante vigente en ${sha}.${behind ? ` Est\u00E1 atr\u00E1s de ${base} sin conflicto: main lo pone al d\u00EDa con \`gh pr update-branch ${n}\`.` : ''}`)
  }
  const failedChecksText = failedChecks.length > 0
    ? failedChecks.map(check => {
      const url = checkUrl(check)
      const jobId = /\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/i.exec(url)?.[1]
      const siblings = analysis.cancelledSiblingsByFailure.get(check) ?? []
      const siblingText = siblings.length > 0
        ? `\n  Cancelled siblings (following from this failure): ${siblings.map(checkName).join(', ')}`
        : ''
      return `- **${checkName(check)}**\n  Link: ${url || '(no link available)'}${jobId ? `\n  Inspect: \`gh run view --job ${jobId} --log-failed\`` : ''}${siblingText}`
    }).join('\n')
    : 'None.'

  const listed = ok(io.sh('git', ['worktree', 'list', '--porcelain'], { cwd: root }), 'git worktree list').stdout
  const worktree = listed.split(/\r?\n\s*\r?\n/).map(entry => {
    const branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1]
    const location = /^worktree (.+)$/m.exec(entry)?.[1]
    return branch === pr.headRefName && location ? location : undefined
  }).find(Boolean)
  if (!worktree) throw new Error(`No hay un worktree para la rama ${pr.headRefName} del PR #${n}.`)
  const status = io.sh('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worktree })
  if (status.status !== 0) throw new Error(`No pude comprobar el worktree ${worktree}: ${(status.stderr || status.stdout).trim()}`)
  if (status.stdout.trim() !== '') throw new Error(`El worktree ${worktree} est\u00E1 sucio; guard\u00E1 o descart\u00E1 sus cambios antes de relanzar.`)
  const head = ok(io.sh('git', ['rev-parse', 'HEAD'], { cwd: worktree }), 'git rev-parse HEAD').stdout.trim()
  // A clean worktree that is only behind the PR head (e.g. after `gh pr update-branch`) is fast-forwarded, not refused.
  // The fetch runs under --dry-run too: it only updates remote refs, and the head commit may not be local yet.
  if (head !== sha) {
    ok(io.sh('git', ['fetch', 'origin', pr.headRefName], { cwd: worktree }), 'git fetch')
    // --is-ancestor exits 0 when HEAD is an ancestor, 1 when it is not, and anything else on a git error.
    const ancestry = io.sh('git', ['merge-base', '--is-ancestor', 'HEAD', sha], { cwd: worktree })
    if (ancestry.status === 1) throw new Error(`El worktree ${worktree} est\u00E1 en ${head}, no en el head del PR ${sha}.`)
    if (ancestry.status !== 0) throw new Error(`No pude comprobar si el worktree ${worktree} (${head}) est\u00E1 atr\u00E1s del head del PR ${sha}: ${(ancestry.stderr || ancestry.stdout || '').trim()}`)
  }
  const ps = io.sh('orca', ['worktree', 'ps', '--json'])
  if (ps.status !== 0) throw new Error(`Orca no contesta (orca worktree ps): ${(ps.stderr || ps.stdout).trim()}`)
  const rows = parseJson(ps, 'orca worktree ps').result?.worktrees ?? []
  const row = rows.find(item => samePath(item.path ?? '', worktree))
  if ((row?.agents ?? []).some(item => /^(working|running|active)$/i.test(item.state ?? item.status ?? ''))) {
    throw new Error(`Hay un agente vivo en ${worktree}; cerralo antes de rebotar.`)
  }
  if (head !== sha) {
    if (!dryRun) ok(io.sh('git', ['merge', '--ff-only', sha], { cwd: worktree }), 'git merge --ff-only')
    say(`${dryRun ? '[simulaci\u00F3n] ' : ''}Adelant\u00E9 el worktree de ${head.slice(0, 7)} a ${sha.slice(0, 7)} (el head del PR).`)
  }
  let conflictSection = ''
  if (conflict) {
    // Like the head fetch, this runs under --dry-run too: it only updates remote refs.
    const fetched = io.sh('git', ['fetch', 'origin', base], { cwd: worktree })
    say(`${dryRun ? '[simulaci\u00F3n] ' : ''}git fetch origin ${base} (para listar los archivos en conflicto)`)
    // merge-tree exits 1 on conflicts and prints the tree, then one conflicting file each, NUL-separated (-z keeps paths unquoted).
    const tree = fetched.status === 0 ? io.sh('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', sha, `origin/${base}`], { cwd: worktree }) : undefined
    const files = tree?.status === 1 ? tree.stdout.split('\0').slice(1).filter(Boolean) : []
    const log = files.length > 0 ? io.sh('git', ['log', '--oneline', `${sha}..origin/${base}`, '--', ...files], { cwd: worktree }) : undefined
    const commits = log?.status === 0
      ? `\`\`\`text\n${log.stdout.trim() || '(none listed)'}\n\`\`\``
      : 'rebote could not compute the base commits.'
    const conflictFiles = files.length > 0
      ? `Conflicting files:\n\n${files.map(file => `- \`${file}\``).join('\n')}\n\nBase commits that touched them (\`git log --oneline HEAD..origin/${base} -- <files>\`):\n\n${commits}`
      : `rebote could not compute the conflicting files; \`git merge origin/${base}\` lists them.`
    conflictSection = `\n## Merge conflict\n\nPR #${n} conflicts with its base branch \`${base}\`. Resolve it with a merge:\n\n1. \`git fetch origin\`\n2. \`git merge origin/${base}\` (never rebase, never force push).\n3. Resolve every conflict and commit the merge.\n4. Run the configured verification (below).\n5. Push to the same branch.\n6. Comment on PR #${n} with how each conflicting file was resolved.\n\n${conflictFiles}\n`
  }

  const name = `${repo}-pr-${n}-rebote`
  const session = `${name}-${(io.now ?? Date.now)()}`
  const briefPath = path.join(io.home, 'orca', 'briefs', `${name}.md`)
  const profilePin = agent === 'pi' ? readJson(path.join(worktree, '.pi', 'gentle-ai', 'profile.json'), io)?.profile : undefined
  if (perfilPi !== undefined && perfilPi !== profilePin) throw new Error(`El worktree fija el perfil de Pi "${profilePin ?? '(ninguno)'}"; no se puede cambiar a "${perfilPi}" en un rebote.`)
  const profile = agent === 'pi' ? piProfileFor({ flag: profilePin ?? perfilPi, config, home: io.home, commonDir, io }) : undefined
  const skills = agent === 'pi' ? io.gentleSkills(io.home) : null
  if (agent === 'pi' && !skills) throw new Error('No encuentro las skills de gentle-pi (Pi ni npm global): corr\u00E9 `orca-stack global`.')
  const issue = /^\s*Closes\s+#(\d+)/mi.exec(pr.body ?? '')?.[1] ?? /-(\d+)$/.exec(pr.headRefName ?? '')?.[1] ?? String(n)
  const brief = render(readAsset('stack', 'brief-rebote.md'), {
    PR: String(n), SHA: sha,
    ISSUE: issue,
    REMOTE_HOST: remote.host,
    REMOTE_REPO: remote.ownerRepo,
    REMOTE_OPERATIONS: `read the PR, its reviews and checks (including \`gh run view ... --log-failed\`); ${conflict ? `\`git fetch origin\` (the base branch \`${base}\`); ` : ''}push only the PR branch to \`origin\`; comment on the PR; \`gh pr edit ${n} --body-file <file>\` for the PR body only.`,
    FINDINGS: findings || (conflict ? 'No current blocking review findings.' : 'No current blocking review findings; this is a CI-only bounce.'),
    FAILED_CHECKS: failedChecksText,
    CONFLICT_SECTION: conflictSection,
    VERIFICATION: verificationBlock(config),
    BODY_PRECHECK_STEP: reboteBodyPrecheckStep(config.verificacion?.cuerpoPR),
    FANOUT_INSTRUCTIONS: fanoutInstructions(agent, nota, true),
    NOTE_SECTION: nota ? `\n## Extra notes from main\n\n${nota.trim()}\n` : '',
  })
  if (!dryRun) {
    io.mkdirp(path.dirname(briefPath))
    io.writeFile(briefPath, brief)
  }
  say(`${dryRun ? '[simulaci\u00F3n] ' : ''}brief -> ${briefPath}`)
  await launchInWorktree({ agent, mode: 'ticket', worktree, briefPath, brief, session, config, win: io.win, home: io.home, skills, piModel: profile?.model, piThinking: profile?.thinking, repositoryRoot: root, io, dryRun, piSessionAfter: agent === 'pi' ? (io.now ?? Date.now)() : 0 })
  if (!dryRun) {
    const markerPath = path.join(io.home, 'orca', 'briefs', `${name}-comment.md`)
    const markersToPost = [reviewBlockers.length > 0 ? `Rebote: ${sha}` : null, failedChecks.length > 0 ? `Rebote CI: ${sha}` : null, conflict ? `Rebote conflicto: ${sha}` : null].filter(Boolean)
    io.writeFile(markerPath, `${markersToPost.join('\n')}\n`)
    ok(io.sh('gh', ['pr', 'comment', String(n), '--body-file', markerPath], { cwd: root }), 'gh pr comment')
  }
  if (reviewBlockers.length > 0) say(`${dryRun ? '[simulaci\u00F3n] ' : ''}Rebote: ${sha}`)
  if (failedChecks.length > 0) say(`${dryRun ? '[simulaci\u00F3n] ' : ''}Rebote CI: ${sha}`)
  if (conflict) say(`${dryRun ? '[simulaci\u00F3n] ' : ''}Rebote conflicto: ${sha}`)
  return 0
}

export const briefRevisionCommand = async ({ n, modelo, dryRun = false }, io = defaultIo()) => {
  const say = io.out
  if (!/^\d+$/.test(String(n ?? ''))) throw new Error('Falta el número de PR. Uso: orca-stack brief-revision <pr> --modelo <modelo>.')
  if (typeof modelo !== 'string' || modelo.trim() === '') throw new Error('brief-revision necesita --modelo <modelo>.')

  const git = io.sh('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], { cwd: io.cwd })
  if (git.status !== 0) throw new Error('Corr\u00E9 este comando dentro del checkout principal de un repo git.')
  const [gitDir, commonDir, top] = git.stdout.split(/\r?\n/).map(line => line.trim())
  if (!samePath(gitDir, commonDir)) throw new Error('Esto es un worktree: corr\u00E9 el comando desde el checkout principal del repo (la sesi\u00F3n de main).')
  const root = path.resolve(top)
  const repo = path.basename(root)
  const config = loadConfig(io.home, root)
  if (config.setup !== 'completo') throw new Error(`El setup de orca-stack está pendiente en ${repo}: hacelo con la skill orca-setup antes de despachar.`)
  if (config.modo !== 'un-agente') throw new Error('El modo del repo no es "un-agente": usá `orca-stack revisar <pr> <agente>` en modo multiagente.')

  const remote = getRemoteOrigin(root, io)

  const pr = parseJson(ok(io.sh('gh', ['pr', 'view', String(n), '--json', 'headRefOid,body,number'], { cwd: root }), 'gh pr view'), 'gh pr view')
  const implementer = /^\s*Implementador:\s*(\S+)/mi.exec(pr.body ?? '')?.[1]?.trim()
  if (!implementer) throw new Error(`El PR #${n} no tiene la línea "Implementador: <agente>".`)
  const sha = pr.headRefOid
  if (typeof sha !== 'string' || sha.trim() === '') throw new Error(`No pude obtener headRefOid del PR #${n}.`)

  const name = `revision-${n}-subagente`
  const worktree = path.join(path.dirname(root), `${repo}-${name}`)
  const briefPath = path.join(io.home, 'orca', 'briefs', `${repo}-${name}.md`)
  const reviewPath = path.join(io.home, 'orca', 'briefs', `${repo}-${name}.review.md`)
  const listed = ok(io.sh('git', ['worktree', 'list', '--porcelain'], { cwd: root }), 'git worktree list').stdout
  const registered = listed.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
  if (registered.some(entry => samePath(entry, worktree)) || io.exists(worktree)) {
    throw new Error(`Ya hay un worktree para el PR #${n}: ${worktree}.`)
  }

  const act = (cmd, args, cwd = root) => {
    say(`${dryRun ? '[simulación] ' : ''}${cmd} ${args.join(' ')}`)
    return dryRun ? { status: 0, stdout: '', stderr: '' } : ok(io.sh(cmd, args, { cwd }), `${cmd} ${args[0]}`)
  }
  act('git', ['fetch', 'origin', `refs/pull/${n}/head`])
  if (!dryRun) {
    const fetched = ok(io.sh('git', ['rev-parse', 'FETCH_HEAD'], { cwd: root }), 'git rev-parse FETCH_HEAD').stdout.trim()
    if (fetched !== sha) throw new Error(`El head del PR #${n} cambió durante la preparación: esperaba ${sha}, recibí ${fetched}.`)
  }
  const hasCodingStandards = !dryRun && io.sh('git', ['cat-file', '-e', `${sha}:CODING_STANDARDS.md`], { cwd: root }).status === 0
  const brief = renderBrief('review', {
    REPO: repo,
    REMOTE_HOST: remote.host,
    REMOTE_REPO: remote.ownerRepo,
    REMOTE_OPERATIONS: 'read-only (PR, diff, checks, issue). main publishes the review. No push.',
    PR: String(n),
    IMPLEMENTER: implementer,
    SHA: sha,
    BASE: config.ramaBase ?? 'main',
    VERIFICATION: verificationBlock(config),
    HAS_CODING_STANDARDS: hasCodingStandards,
    AGENT: `subagente (${modelo.trim()})`,
    REVIEWER_LINE: `subagente (${modelo.trim()})`,
    WORKTREE_INSTRUCTIONS: `Repo: ${repo}. This review is isolated in ${worktree}; work only inside that worktree. It is checked out detached at PR #${n}'s head commit ${sha}. Do not checkout or modify the main checkout. PR #${n} is written by ${implementer}.`,
    PUBLISH_INSTRUCTIONS: `Write the review body to the UTF-8 file ${reviewPath}. Do not publish the review; main will publish your file with gh pr review --comment --body-file.`,
    PUBLISH_COMMAND: `Do not publish; report the path to ${reviewPath} to main.`,
  })
  act('git', ['worktree', 'add', '--detach', worktree, sha])
  say(`${dryRun ? '[simulaci\u00F3n] ' : ''}brief -> ${briefPath}`)
  if (!dryRun) {
    io.mkdirp(path.dirname(briefPath))
    io.writeFile(briefPath, brief)
  }
  say(`worktree: ${worktree}`)
  say(`brief: ${briefPath}`)
  say(`review body: ${reviewPath}`)

  return 0
}

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
