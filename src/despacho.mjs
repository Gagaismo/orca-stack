import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PROJECT_CONFIG, PROJECT_LOCAL_CONFIG } from './constants.mjs'
import { analyzeChecks, isHigherRunId, isPending, latestChecks } from './checks.mjs'
import { codexTrustHint } from './codex-trust.mjs'
import { commitOf, markerLines, markerValue, namesCommit } from './marcas.mjs'
import { setCard, switchAccount } from './orca.mjs'
import { gentleAiBinaryCheck, resolveGentleSkills } from './pi.mjs'
import { readAsset, render, wrapperFile } from './templates.mjs'
import { SCRIPTS_REL, homeDir, isWindows, layout, run, samePath, which } from './util.mjs'

// Source of truth: shared/orca-config.ts (FAMILIES, familyOf, blockOf), which explains the rules. Duplicated because
// the mods cannot import src/ and Node 20 cannot import TypeScript; test/units.test.mjs compares the literal and runs
// shared/familias.json against it.
// BEGIN FAMILIES
export const FAMILIES = {
  "agents": ["claude", "agy", "codex", "pi"],
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
// ADR 0006 (#488): claude is no longer a worker agent; only agy, codex and pi run tickets and reviews.
export const WORKER_AGENTS = FAMILIES.agents.filter(agent => agent !== 'claude')
const CODEX_CC_REMOVED = 'codex-cc ya no existe en orca-stack (Command Code se elimin\u00F3 el 2026-10-24); us\u00E1 codex.'
const CLAUDE_WORKER_REMOVED = 'claude ya no es un agente worker (ADR 0006): despach\u00E1 a pi, agy o codex.'

// Stack markers cleared when launching pi: Orca's managed pi extension (orca-agent-status.ts) reports pi's card state
// through the Orca pane variables, so a worker keeps those while clearing ORCA_STACK_* (#277, #391).
const STACK_VARS_CLEARED = [
  'ORCA_STACK_AGENT', 'ORCA_STACK_MODE', 'ORCA_STACK_POLICY_PATH',
  'ORCA_STACK_CAVEMAN_LEVEL',
]
// gentle-pi tools that open a TUI dialog: nobody answers one in an unattended worker (under `pi -p` they failed).
const PI_DIALOG_TOOLS = 'ask_user_choice,ask_user_question'
// Only a review closes pi's tools (read-only). A ticket gets all of them: an allowlist would also drop gentle-pi's
// subagents, ODD and engram tools.
// The Engram read tools (gentle-engram) are in: a review reads the memory it shares with claude, and never writes it (#304).
export const PI_TOOLS = { review: 'read,bash,grep,find,ls,codemode,mem_current_project,mem_context,mem_search,mem_get_observation' }
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
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(date.trim())
  if (match === null) return undefined
  const [year, month, day, hour, minute] = match.slice(1).map(part => Number(part ?? 0))
  const at = new Date(year, month - 1, day, hour, minute)
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour || at.getMinutes() !== minute) return undefined

  return at.getTime()
}

export const blockOf = (config, agent, now) => {
  for (const rule of config.guardia?.bloquear ?? []) {
    if (typeof rule?.agente !== 'string' || rule.agente.toLowerCase() !== agent.toLowerCase()) continue
    const until = typeof rule.hasta === 'string' ? parseUntil(rule.hasta) : undefined
    if (until === undefined) return `La regla guardia.bloquear de ${agent} tiene una fecha "hasta" que no es AAAA-MM-DD ni AAAA-MM-DDTHH:MM (${String(rule.hasta)}): corregila antes de despacharlo.`
    if (now < until) return typeof rule.motivo === 'string' && rule.motivo.trim() !== '' ? rule.motivo : `${agent} está bloqueado hasta el ${rule.hasta}.`
  }

  return undefined
}

export const rosterOf = (config, now) => {
  const usa = Array.isArray(config.agentes?.usa) ? config.agentes.usa : []
  const seen = new Set()
  const roster = []
  for (const raw of usa) {
    const agent = String(raw).trim().toLowerCase()
    if (!WORKER_AGENTS.includes(agent) || seen.has(agent)) continue
    if (blockOf(config, agent, now) !== undefined) continue
    seen.add(agent)
    roster.push(agent)
  }

  return roster
}

export const crossFamilyReviewers = (config, implementer, roster) => {
  const own = familyOf(config, implementer, 'ticket').family
  const ask = Array.isArray(config.agentes?.preguntarAntes) ? config.agentes.preguntarAntes.map(a => String(a).toLowerCase()) : []
  const byFamily = new Map()
  for (const agent of WORKER_AGENTS) {
    if (!roster.includes(agent) || agent === implementer) continue
    const { family } = familyOf(config, agent, 'review')
    if (family === undefined || (own !== undefined && family === own)) continue
    const current = byFamily.get(family)
    if (current === undefined || (ask.includes(current) && !ask.includes(agent))) byFamily.set(family, agent)
  }
  const all = [...byFamily.values()]

  return [...all.filter(agent => !ask.includes(agent)), ...all.filter(agent => ask.includes(agent))]
}

export const rddFallbackFor = (config, agent, now) =>
  agent === 'pi' && Array.isArray(config.agentes?.usa) && crossFamilyReviewers(config, 'pi', rosterOf(config, now)).length === 0

const AGY_DEFAULT_MODEL = 'gemini-4-neon-high'
const psQuote = text => `'${text.replace(/'/g, "''")}'`
const shQuote = text => `'${text.replace(/'/g, "'\\''")}'`

// The command typed into the Orca terminal. `win` is the target shell, not the host: PowerShell on win32 (Orca's
// terminal there), POSIX elsewhere. Paths follow it.
export const launcherFor = ({ agent, mode, config, win, home, briefPath, session, skills, piModel, piThinking, interactive = false, supervised = false }) => {
  const { model: configured, effort } = modelFor(config, agent, mode)
  // #382: agy's default lives here, not in modelFor, so familyOf (the reviewer family) never sees it.
  // A blank or non-text agy model counts as unset, the same reading familyOf gives it.
  const model = agent === 'agy' ? (typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : AGY_DEFAULT_MODEL) : configured
  const P = win ? path.win32 : path.posix
  const wrapper = P.join(home, ...SCRIPTS_REL, wrapperFile(agent === 'claude' || agent === 'agy' ? agent : 'codex', win))
  const bin = (win ? '& ' : '') + `"${wrapper}"`
  if (agent === 'claude' || agent === 'agy') return `${bin} --dangerously-skip-permissions${model ? ` --model ${model}` : ''}`
  if (agent === 'codex') {
    // Fast mode spends codex credits faster and an unattended worker does not need the speed.
    const flags = `${model ? ` --model ${model}` : ''}${effort ? ` -c model_reasoning_effort="${effort}"` : ''} -c features.fast_mode=false -c approval_policy="never" -c sandbox_mode="danger-full-access"`
    return `${bin}${flags}`
  }
  // pi: an interactive TUI like the other workers, so Orca shows it on its card and a turn that waits on a background
  // verify resumes when it reports (`pi -p` ended with the turn, #277). The brief rides in the first message. Nothing
  // may wait on a person: the dialog tools are left out and --no-approve skips the project-trust prompt (untrusted, as
  // `pi -p` left it). The stack markers are cleared so they do not leak into Gentle Shell.
  const q = win ? psQuote : shQuote
  // #370: a planning session is interactive: the human drives it, so it keeps the dialog tools and no autonomy marker.
  const prompt = interactive ? `Read the brief in ${briefPath} and follow it; the human drives this session.` : `Read and carry out the brief in ${briefPath}. Unattended: never wait for user input.`
  const tools = PI_TOOLS[mode] ? ` --tools ${q(PI_TOOLS[mode])}` : ''
  // With a profile the orchestrator is the profile's own, not whatever the global settings.json says (a pin never moves it).
  const piFlags = piModel ? ` --model ${q(piModel)}${PI_THINKING.includes(piThinking) ? ` --thinking ${piThinking}` : ''}` : ''
  // #397: a supervised worker gets its brief once, from `orca orchestration worker-start`, not on its command line.
  const cmd = `pi --no-skills --skill ${q(skills)} --session-id ${session} --no-approve${interactive ? '' : ` --exclude-tools ${q(PI_DIALOG_TOOLS)}`}${piFlags}${tools}${supervised ? '' : ` ${q(prompt)}`}`
  // No ENGRAM_DATA_DIR: since gentle-pi 4.4.0 any explicit Engram selection turns memory off; the worker shares the
  // human's global Engram server instead (#304).
  // main-autonomo S3: Gentle Shell answers RDD consent from the policy file only when the pi process itself carries
  // GENTLE_PI_ORCA_RDD_POLICY=1. The agent's own bash calls cannot change its host's environment, so this is the trust
  // anchor the review asked for; it is always cleared first so a value inherited from the terminal never leaks in.
  const policy = rddConsentPolicy(config, 'pi') === 'politica'
  const set = [...(interactive ? [] : [['GENTLE_PI_AUTONOMOUS_MODE', '1']]), ...(policy && !interactive ? [['GENTLE_PI_ORCA_RDD_POLICY', '1']] : []), ...(config.piClaudeConfigDir ? [['CLAUDE_CONFIG_DIR', config.piClaudeConfigDir]] : [])]
  const cleared = [...STACK_VARS_CLEARED, 'GENTLE_PI_ORCA_RDD_POLICY', ...(interactive ? ['GENTLE_PI_AUTONOMOUS_MODE'] : [])]
  if (win) {
    return [`Remove-Item ${cleared.map(n => `Env:${n}`).join(', ')} -ErrorAction SilentlyContinue`, ...set.map(([k, v]) => `$env:${k} = ${psQuote(v)}`), cmd].join('; ')
  }

  return [`unset ${cleared.join(' ')}`, ...(set.length > 0 ? [`export ${set.map(([k, v]) => `${k}=${shQuote(v)}`).join(' ')}`] : []), cmd].join('; ')
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
// agy keeps reading it.
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

// pi's process ends with its turn and takes its background jobs along: a suite left in the background never reports (#295).
const piForeground = agent => agent === 'pi'
  ? '\n\nYour process ends when your turn ends, and background jobs die with it: run every verification (the configured suite and focused tests) in the foreground and wait for it to finish before you commit and push.'
  : ''

// The RDD review mode (#338): opt-in per repo with agentes.pi.review "rdd", and only for PRs pi implements.
export const rddMode = (config, agent) => agent === 'pi' && config?.agentes?.pi?.review === 'rdd'
const RDD_LENSES = ['risk', 'resilience', 'readability', 'reliability']

const rddAssessStep = (agent, piReview, base) => rddMode({ agentes: { pi: { review: piReview } } }, agent)
  ? '\n\nThis repo uses the RDD review mode for pi PRs (`agentes.pi.review: "rdd"`). After your last commit and before opening the PR, run `gentle_review` with operation `assess` and input `{"baseRef":"<git merge-base HEAD origin/' + (base ?? 'main') + ', the full 40-character sha>","committedOnly":true}` (a plain assess finds no pending changes once everything is committed) and write under `## Merge Danger` three lines: `Tier: <the tier assess returned>`, `reviewDue: <true|false, as assess returned it>` and your ODD `Risk:` line. Do not start an RDD review yourself: main reads those lines and decides whether the PR gets no review or an RDD review, and an RDD review you run on your own before the PR does not count as its review.'
  : ''

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
    ? `read issue #${vars.ISSUE ?? '<n>'} and its comments and the repo; comment on the issue; check off its \`## Tareas\` with \`gh issue edit ${vars.ISSUE ?? '<n>'} --body-file <file>\`; push only the ticket branch to \`origin\`; open the PR against ${vars.BASE ?? 'main'}.`
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
    DELTA_INSTRUCTIONS: vars.DELTA_INSTRUCTIONS ?? '',
    PROJECT_INSTRUCTIONS: projectInstructions(vars.AGENT),
    SUBAGENTS_INSTRUCTION: subagentsInstruction(vars.AGENT),
    BODY_PRECHECK_STEP: vars.BODY_PRECHECK_STEP ?? bodyPrecheckStep(vars.CUERPO_PR),
    RDD_ASSESS_STEP: rddAssessStep(vars.AGENT, vars.PI_REVIEW, vars.BASE),
    CODING_STANDARDS_INSTRUCTION: vars.HAS_CODING_STANDARDS ? 'Read CODING_STANDARDS.md and check the change against it before every commit.' : '',
    REVIEW_STANDARDS: vars.HAS_CODING_STANDARDS ? 'CODING_STANDARDS.md and AGENTS.md' : 'AGENTS.md',
    REVIEW_STANDARDS_ANY: vars.HAS_CODING_STANDARDS ? 'CODING_STANDARDS.md or AGENTS.md (a rule in either file alone is enough)' : 'AGENTS.md',
    COMMENT_REGLA_ESCRITA: vars.HAS_CODING_STANDARDS ? '`regla escrita`, citing `CODING_STANDARDS.md:<line>` of the rule it breaks, or as ' : '',
    REVIEW_STANDARDS_EITHER: vars.HAS_CODING_STANDARDS ? 'CODING_STANDARDS.md or AGENTS.md' : 'AGENTS.md',
    FANOUT_INSTRUCTIONS: fanoutInstructions(vars.AGENT, nota),
    PI_FOREGROUND: piForeground(vars.AGENT),
    NOTE_SECTION: nota ? `\n## Extra notes from main\n\n${nota.trim()}\n` : '',
    MIGRACION: vars.MIGRACION ? `\n- If this ticket adds a migration, number it ${vars.MIGRACION} (reserved by orca-stack); if it needs more than one, ask main with \`orca orchestration ask\`.` : '',
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
  gentleAiBinary: home => gentleAiBinaryCheck(layout(home)),
})

// #364: a pi whose local gentle-pi checkout lacks its package-local Gentle AI binary would only fail at push time, after
// the work. The same message as doctor, before any side effect; a binary doctor cannot locate does not stop the launch.
export const refuseMissingGentleAi = async io => {
  const binary = await io.gentleAiBinary(io.home)
  if (binary?.status === 'fail') throw new Error(`No lanzo a pi, binario Gentle AI de gentle-pi: ${binary.detail}.`)
}

const ok = (res, what) => {
  if (res.status !== 0) throw new Error(`${what} falló: ${(res.stderr || res.stdout || String(res.error)).trim()}`)

  return res
}

export const shellPrompt = text => /(?:^|\n)\s*PS\s+[A-Za-z]:\\[^\n>]*>\s*$/im.test(text)

// Any "<kind> limit reached" (session, 5-hour, weekly, Opus...) or a limit line naming its reset, not one wording per limit (#292).
// Codex keeps an informational banner on screen while it works, "⚠ 5h limit: 50% left · resets at 00:57" (main-autonomo
// S4): a line that says how much is left only stops a launch when nothing is left ("0% left") or it names a hard stop.
const QUOTA_HARD = /quota (reached|exceeded)|usage limit|hit your (?:session|usage) limit|\blimit reached\b|(?<![\d.])0% left\b/i
const QUOTA_SOFT = /rate[- ]limit|Resets? in \d|\blimit\b.*\bresets?\s+\S/i
const PERCENT_LEFT = /\b\d+% left\b/i
const isQuota = text => QUOTA_HARD.test(text) || (QUOTA_SOFT.test(text) && !PERCENT_LEFT.test(text))

export const quotaLine = lines => {
  if (!Array.isArray(lines)) return undefined
  return lines.slice(-15).find(line => isQuota(String(line)))
}

// The reset time a usage-limit line names, as read: "resets 02:20:00" -> "resets 02:20", "Resets in 10h45m" -> "resets in 10h45m";
// a weekly reset keeps its day: "resets Mon 9am", "resets Nov 12, 9am".
export const quotaReset = line => {
  const match = /\bresets?\s+(in\s+\d[\dhms]*|(?:at\s+)?(?:[A-Z][a-z]{2,8}\.?(?:\s+\d{1,2})?,?\s+(?:at\s+)?)?\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)/i.exec(String(line ?? ''))
  return match ? `resets ${match[1].trim()}` : undefined
}

// A usage-limit failure carries the line it read, so a caller can name the reset time without parsing the message.
const quotaError = (message, line) => Object.assign(new Error(message), { quota: line })

const checkPostLaunchScreen = async (io, handle, agent) => {
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) await io.sleep(5000)
    const res = ok(io.sh('orca', ['terminal', 'read', '--terminal', handle, '--screen', '--json']), 'orca terminal read')
    const tail = parseJson(res, 'orca terminal read').result?.terminal?.tail
    const lines = Array.isArray(tail) ? tail : typeof tail === 'string' ? tail.split(/\r?\n/) : []
    const quota = quotaLine(lines)
    if (quota) throw quotaError(`La terminal de ${agent} (${handle}) muestra un l\u00edmite de cuota; el turno no est\u00e1 ejecut\u00e1ndose: ${quota}`, quota)
    // shellPrompt intentionally recognizes PowerShell only; bash and cmd.exe prompts remain out of scope.
    const last = lines.map(line => String(line)).reverse().find(line => line.trim() !== '')
    if (last && shellPrompt(last)) throw new Error(`La terminal de ${agent} (${handle}) volvi\u00f3 al shell prompt; el turno no est\u00e1 ejecut\u00e1ndose: ${last}`)
  }
}

// agy's folder-trust screen never says "trust this folder?" (#330): "Antigravity CLI requires permission to read, edit,
// and execute files here." over the "Yes, I trust this folder" / "No, exit" menu.
const AGY_TRUST = /trust this folder\?|requires permission to read, edit, and execute files here|Yes, I trust this folder/i
const AGY_TRUST_ENTERS = 3

// agy 1.5.x draws a one-time banner ("Auto is now the default agent mode") or splash ("Introducing Gemini 4 Hydrogen")
// over its prompt, ending in "esc to dismiss" (#357): Orca reads it as a permission prompt and the brief never arrives.
const AGY_DISMISS = /esc to dismiss/i
const AGY_DISMISS_TRIES = 3
const AGY_EMPTY_PROMPT = /^[\s│┃|]*>[\s│┃|]*$/
const AGY_DIALOG = /trust this folder\?|Do you want to proceed\?/i
const SCREEN_LINES = 15
const screenLines = res => {
  if (res.status !== 0) return []
  let tail
  try { tail = JSON.parse(res.stdout)?.result?.terminal?.tail } catch { return [] }
  return Array.isArray(tail) ? tail.map(String) : typeof tail === 'string' ? tail.split(/\r?\n/) : []
}
const bottomOf = lines => lines.slice(-SCREEN_LINES).join('\n')
const showsSplash = lines => AGY_DISMISS.test(bottomOf(lines))
const showsDialog = lines => AGY_DIALOG.test(bottomOf(lines)) || AGY_TRUST.test(bottomOf(lines))
const readyForInput = lines => !showsSplash(lines) && !showsDialog(lines) && lines.slice(-SCREEN_LINES).some(line => AGY_EMPTY_PROMPT.test(line))

// What a human does when agy did not get its brief: the exact line, typed into the named terminal.
export const agyNotDelivered = (handle, briefPath) => `agy no recibió el brief. Pegá en la terminal ${handle} esta línea: Read and follow the brief in ${briefPath}`

// With the splash on screen: Esc (a raw ESC byte, no Enter) every 2 s while it stays, at most 3 times, until the empty
// `>` prompt shows with no dialog or trust screen; otherwise nothing is sent and the human gets the line to paste.
// Returns the screen lines to send over (unchanged when there was no splash).
export const dismissAgySplash = async (io, handle, lines, briefPath) => {
  if (!showsSplash(lines)) return lines
  let screen = lines
  for (let i = 0; i < AGY_DISMISS_TRIES; i += 1) {
    if (showsSplash(screen)) io.sh('orca', ['terminal', 'send', '--terminal', handle, '--text', '\u001b'])
    await io.sleep(2000)
    screen = screenLines(io.sh('orca', ['terminal', 'read', '--terminal', handle, '--screen', '--json']))
    if (readyForInput(screen)) return screen
    if (showsDialog(screen)) break
  }
  throw new Error(agyNotDelivered(handle, briefPath))
}

const waitForTui = async (io, handle, agent, root, issue, prompt, tries = 45) => {
  let last = null
  let stable = 0
  let enters = 0
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
    // Enter picks "Yes, I trust this folder", but agy can draw the menu before it takes input: confirm until it clears.
    if (agent === 'agy' && AGY_TRUST.test(text)) {
      // A review has no issue for reanudar to find its worktree by: the way back is pasting the brief line by hand.
      const next = issue === undefined ? `pegá en la terminal esta línea: ${prompt}` : `corré orca-stack reanudar ${issue} <url-del-comentario>.`
      if (enters >= AGY_TRUST_ENTERS) throw new Error(`agy sigue en la pantalla de confianza de la carpeta y no recibió el brief. Elegí "Yes, I trust this folder" en la terminal ${handle} y ${next}`)
      io.sh('orca', ['terminal', 'send', '--terminal', handle, '--enter'])
      enters += 1
      stable = 0
      last = null
      continue
    }
    if (shellPrompt(text)) throw new Error(`La terminal volvió al shell prompt antes de recibir el brief; el turno no arrancó. Pantalla: ${text}`)
    stable = text !== '' && text === last ? stable + 1 : 0
    last = text
    if (stable >= 2) {
      if (/trust this folder\?/i.test(text)) throw new Error(`La pantalla de confianza sigue abierta; no envío el brief sobre ese menú. Pantalla: ${text}`)
      // #476: agy's sign-in screen can stay stable before the TUI is ready; require its empty prompt or dismissible splash.
      const lines = text.split(/\r?\n/)
      if (agent !== 'agy' || readyForInput(lines) || showsSplash(lines)) return text
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
        if (typeof tools === 'string' && /<tools>\s*\(none\)/i.test(tools)) return { tools: 'none', file }
        return { tools: 'available', file }
      } catch {}
    }
  } catch {}
  return undefined
}

// #444: pi's editor shows a long paste as `[paste #1 +120 lines]`; a typed brief shows its own lines. Nothing was
// submitted yet (no session), so brief text on screen can only be in the input, unless pi is gone (a shell prompt).
const PI_PASTE_MARKER = /\[paste #\d+(?: \+\d+ lines| \d+ chars)?\]/
const PI_BRIEF_LINE_MIN = 20
// #454: Gentle Shell's frame line reads `─ ✿ waiting for input ─── INSERT ─` when pi waits with nothing submitted.
const PI_FRAME_LINE = /^\s*╭?─ [✿❀❁✾] /u
const PI_WAITING = /^\s*─ ✿ waiting for input ─/u
const piInputOf = (io, handle, brief) => {
  const lines = screenLines(io.sh('orca', ['terminal', 'read', '--terminal', handle, '--screen', '--json']))
  const last = [...lines].reverse().find(line => line.trim() !== '')
  if (last === undefined || shellPrompt(last)) return undefined
  const typed = lines.some(line => {
    const text = line.replace(/^[\s│┃|>]+|[\s│┃|]+$/g, '')
    return PI_PASTE_MARKER.test(text) || (text.length >= PI_BRIEF_LINE_MIN && String(brief ?? '').includes(text))
  })
  if (typed) return 'brief'
  return PI_WAITING.test(lines.findLast(line => PI_FRAME_LINE.test(line)) ?? '') ? 'empty' : undefined
}

// Up to 30 s: the TUI draws its screen before it takes the first message, so it can start slower than `pi -p` did.
const waitForPiSession = async (io, home, worktree, after = 0) => {
  for (let i = 0; i < 150; i += 1) {
    const session = piSessionTools(io, home, worktree, after)
    if (session !== undefined) return session
    await io.sleep(200)
  }
  return {}
}

// pi records an auth failure as its first reply: an error turn whose errorMessage is "Failed to authenticate: …" (#295).
// Only that first reply counts, so a later turn that quotes the words does not fail a launch. A relaunch with the same
// --session-id appends to the old file: replies written before this launch (`after`) belong to earlier turns.
const PI_AUTH = /Failed to authenticate/i
const piFirstReply = (io, file, after = 0) => {
  for (const line of io.readFile(file).split(/\r?\n/)) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (after > 0 && Date.parse(entry?.timestamp) < after) continue
    const message = entry?.type === 'message' ? entry.message : undefined
    if (message?.role !== 'assistant') continue
    const texts = [message.errorMessage, ...(Array.isArray(message.content) ? message.content.map(part => part?.text) : [message.content])]
    const lines = message.stopReason === 'error' ? texts.flatMap(t => (typeof t === 'string' ? t.split(/\r?\n/) : [])) : []
    const auth = lines.find(t => PI_AUTH.test(t))
    // A usage limit is also an error turn: "Claude rate limit (five_hour) — resets 02:20:00: You've hit your session limit" (#292).
    const quota = lines.find(t => isQuota(t))
    return auth ? { auth: auth.trim() } : quota ? { quota: quota.trim() } : { ok: true }
  }
  return undefined
}

// The same window as the screen check of #198: three reads, two five-second pauses; a first reply ends it early.
const checkPiAuth = async (io, file, configDir, after) => {
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) await io.sleep(5000)
    let reply
    try { reply = piFirstReply(io, file, after) } catch {}
    if (reply?.auth) {
      const dir = configDir ?? 'sin fijar (agentes.pi.claudeConfigDir no está en ~/.orca-stack/config.json; pi usa el que herede la terminal)'
      throw new Error(`Pi no pudo autenticarse; el turno no está ejecutándose: ${reply.auth}. CLAUDE_CONFIG_DIR: ${dir}. Volvé a iniciar sesión de Claude con esa carpeta antes de relanzar.`)
    }
    if (reply?.quota) throw quotaError(`Pi muestra un límite de cuota; el turno no está ejecutándose: ${reply.quota}`, reply.quota)
    if (reply?.ok) return
  }
}

// #397: Orca's orchestration commands. A failure carries Orca's own error and is marked, so despachar can release the
// issue instead of leaving it assigned with no worker.
const orchestrationError = message => Object.assign(new Error(message), { orchestration: true })
const orchestrationFailure = (res, what) => {
  let reason
  try {
    const body = JSON.parse(res.stdout)
    if (body?.ok === false) reason = body.error?.message ?? JSON.stringify(body.error ?? body)
  } catch {}
  if (res.status === 0 && reason === undefined) return undefined
  return `${what} falló: ${String(reason ?? (res.stderr || res.stdout || String(res.error ?? ''))).trim()}`
}
const shownArgs = argv => argv.map(a => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(' ')
const orchestrate = (io, say, argv) => {
  say(`orca orchestration ${shownArgs(argv)}`)
  const res = io.sh('orca', ['orchestration', ...argv])
  const failure = orchestrationFailure(res, `orca orchestration ${argv[0]}`)
  if (failure) throw orchestrationError(failure)
  let body
  try { body = JSON.parse(res.stdout) } catch { throw orchestrationError(`orca orchestration ${argv[0]} no devolvió JSON: ${(res.stderr || res.stdout).trim().split('\n')[0]}`) }
  return body?.result ?? body ?? {}
}
// The Run bound to main's session, or a new one bound to it when there is none.
const boundRun = (io, say, objective) => {
  const current = orchestrate(io, say, ['run-current', '--json'])
  const bound = current.runId ?? current.run?.id
  if (typeof bound === 'string' && bound !== '') return bound
  const created = orchestrate(io, say, ['run-create', '--objective', objective, '--json'])
  const id = created.runId ?? created.run?.id ?? created.id
  if (typeof id !== 'string' || id === '') throw orchestrationError('orca orchestration run-create no devolvió el id del Run.')
  return id
}
// #454: `rebind` ({ run, task, deliver }, reanudar only) starts a new dispatch for an existing Task whose dispatch closed;
// like a supervised start, Orca delivers the Task's stored spec, and `deliver(handle)` sends the answer line afterwards.
const startWorker = async (io, say, { agent, handle, briefPath, supervised, rebind }) => {
  const runId = rebind ? rebind.run : boundRun(io, say, supervised.objective)
  const argv = rebind
    ? ['worker-start', '--run', runId, '--task', rebind.task, '--terminal', handle, '--json']
    : ['worker-start', '--run', runId, '--terminal', handle, '--spec-file', briefPath, '--task-title', supervised.title, '--json']
  const start = () => {
    say(`orca orchestration ${shownArgs(argv)}`)
    return io.sh('orca', ['orchestration', ...argv])
  }
  let res = start()
  // #357: agy's trust screen the screen read missed makes Orca refuse with agent_prompt_blocked before the spec is
  // delivered; Enter confirms the preselected "Yes, I trust this folder", bounded like the trust screen. The retry
  // reissues the request Orca named (--retry-request), so Orca does not start a second "#<n> agy" Task.
  for (let i = 0; agent === 'agy' && i < AGY_TRUST_ENTERS && /agent_prompt_blocked/.test(`${res.stdout ?? ''}${res.stderr ?? ''}`); i += 1) {
    say(`agy muestra un pedido de confianza (agent_prompt_blocked): confirmo la carpeta con Enter (${i + 1}/${AGY_TRUST_ENTERS}).`)
    io.sh('orca', ['terminal', 'send', '--terminal', handle, '--enter'])
    await io.sleep(2000)
    const request = requestIdOf(res)
    if (request && !argv.includes('--retry-request')) argv.push('--retry-request', request)
    res = start()
  }
  const failure = orchestrationFailure(res, 'orca orchestration worker-start')
  if (!failure) {
    let receipt
    try { receipt = JSON.parse(res.stdout) } catch {}
    return { runId, taskId: rebind?.task ?? deepFind(receipt, ['taskId']), dispatchId: deepFind(receipt, ['dispatchId']) }
  }
  // Orca exits 1 for outcome_unknown too: the worker may have started, so the issue keeps its assignee.
  let body
  try { body = JSON.parse(res.stdout) } catch {}
  const unknown = hasValue(body, 'outcome_unknown')
  const dispatchId = deepFind(body, ['dispatchId'])
  if (rebind && !unknown) throw orchestrationError(`${failure}\nLa terminal nueva ${handle} quedó abierta sin dispatch en el Run ${runId}; no relanzo.`)
  if (rebind) throw orchestrationError(`${failure}\nEl resultado de worker-start es desconocido (outcome_unknown): el dispatch de la terminal nueva ${handle} puede haber arrancado; no relanzo. Comprobalo con \`${dispatchId ? `orca orchestration worker-show --dispatch ${dispatchId} --json` : `orca orchestration task-list --run ${runId} --json`}\`.`)
  if (!unknown) throw orchestrationError(failure)
  const request = requestIdOf(res)
  const check = request ? `orca orchestration request-show --request ${request} --json` : dispatchId ? `orca orchestration worker-show --dispatch ${dispatchId} --json` : `orca orchestration task-list --run ${runId} --json`
  throw new Error(`${failure}\nEl resultado de worker-start es desconocido (outcome_unknown): el worker de ${supervised.title} puede estar corriendo, así que el issue sigue asignado. Comprobalo con \`${check}\`.`)
}
const hasValue = (value, wanted) => value === wanted || ((isPlain(value) || Array.isArray(value)) && Object.values(value).some(v => hasValue(v, wanted)))
// The request id Orca names for a reissue: a requestId field, or the id in its "--retry-request <id>" advice.
const requestIdOf = res => {
  let body
  try { body = JSON.parse(res.stdout) } catch {}
  return deepFind(body, ['requestId', 'request_id']) ?? /--retry-request\s+([^\s.,;]+)/.exec(`${res.stdout ?? ''}${res.stderr ?? ''}`)?.[1]
}

// `supervised` ({ title, objective }: despachar, rebote and reanudar): the worker starts with `orca orchestration worker-start` in the
// Run bound to main instead of getting the brief line typed into its terminal (#397).
// The Run objective is the one despachar uses, so rebote and reanudar join or create the same Run (#462, #463).
export const supervisedTask = (repo, title) => ({ title, objective: `orca-stack ${repo}: tickets despachados por main` })

export const launchInWorktree = async ({ agent, mode, worktree, briefPath, brief, session, config, win, home, skills, piModel, piThinking, repositoryRoot, io, dryRun = false, piSessionAfter = 0, issue, interactive = false, supervised, rebind }) => {
  const say = io.out
  const launcher = launcherFor({ agent, mode, config, win, home, briefPath, session, skills, piModel, piThinking, interactive, supervised: Boolean(supervised || rebind) })
  const act = (cmd, argv, opts = {}) => {
    say(`${dryRun ? '[simulaci\u00f3n] ' : ''}${cmd} ${argv.map(a => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)

    return dryRun ? { status: 0, stdout: '', stderr: '' } : ok(io.sh(cmd, argv, opts), `${cmd} ${argv[0]}`)
  }

  say(`Lanzador (${agent}): ${launcher}`)
  const create = () => act('orca', ['terminal', 'create', '--worktree', `path:${worktree}`, '--title', agent, '--command', launcher, '--json'])
  let term = create()
  if (dryRun) {
    if (supervised) {
      if (agent !== 'pi') say(`[simulación] esperar la TUI de ${agent}${agent === 'agy' ? ' (confirmar la carpeta con Enter)' : ''}`)
      say(`[simulación] orca orchestration run-current --json (sin Run de main: orca orchestration run-create --objective ${JSON.stringify(supervised.objective)} --json)`)
      say(`[simulación] orca orchestration worker-start --run <run> --terminal <terminal> --spec-file ${briefPath} --task-title ${JSON.stringify(supervised.title)} --json`)
    } else if (rebind) {
      if (agent !== 'pi') say(`[simulación] esperar la TUI de ${agent}${agent === 'agy' ? ' (confirmar la carpeta con Enter)' : ''}`)
      say(`[simulación] orca orchestration worker-start --run ${rebind.run} --task ${rebind.task} --terminal <terminal> --json`)
    } else if (agent !== 'pi') say(`[simulaci\u00f3n] esperar la TUI de ${agent}${agent === 'agy' ? ' (confirmar la carpeta con Enter)' : ''} y enviar: Read and follow the brief in ${briefPath}`)
    say(`\n--- brief ---\n${brief}`)

    return 0
  }
  if (agent !== 'pi') {
    const handle = deepFind(parseJson(term, 'orca terminal create').result ?? {}, ['handle', 'terminalHandle'])
    if (!handle) throw new Error('orca terminal create no devolvi\u00f3 el handle de la terminal.')
    const prompt = `Read and follow the brief in ${briefPath}`
    let before = await waitForTui(io, handle, agent, repositoryRoot, issue, prompt)
    if (!before) throw new Error(`La TUI de ${agent} no apareci\u00f3 a tiempo. La terminal ${handle} sigue abierta: mandale a mano "Read and follow the brief in ${briefPath}".`)
    if (agent === 'agy') before = (await dismissAgySplash(io, handle, before.split('\n'), briefPath)).join('\n')
    if (supervised || rebind) {
      await startWorker(io, say, { agent, handle, briefPath, supervised, rebind })
      await checkPostLaunchScreen(io, handle, agent)
      if (rebind) await rebind.deliver(handle)
      say(`✔ ${agent} despachado en ${worktree}. Brief: ${briefPath}`)

      return 0
    }
    // agy's own failures after the send all mean one thing to the human: the brief did not arrive (#357). Orca's own
    // reason goes on a second line, so the cause is never hidden behind the line to paste.
    const fail = message => new Error(agent === 'agy' ? `${agyNotDelivered(handle, briefPath)}${message ? `\nCausa: ${message}` : ''}` : message)
    const sendBrief = () => io.sh('orca', ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter', '--wait-submit', '10', '--json'])
    let observed = sendBrief()
    // #357, seen live on agy 1.5.9: `orca terminal read --screen` can show the empty `>` prompt while agy is really on
    // its folder-trust screen, so the trust handling in waitForTui never fires; Orca's send does see it and refuses with
    // agent_prompt_blocked. Right after launch, in a worktree orca-stack created, Enter confirms the preselected
    // "Yes, I trust this folder" (as waitForTui does when the read shows it); bounded like the trust screen.
    for (let i = 0; agent === 'agy' && i < AGY_TRUST_ENTERS && /agent_prompt_blocked/.test(`${observed.stdout ?? ''}${observed.stderr ?? ''}`); i += 1) {
      say(`agy muestra un pedido de confianza (agent_prompt_blocked): confirmo la carpeta con Enter (${i + 1}/${AGY_TRUST_ENTERS}).`)
      io.sh('orca', ['terminal', 'send', '--terminal', handle, '--enter'])
      await io.sleep(2000)
      observed = sendBrief()
    }
    let sent = observed
    let oldHost = false
    if (observed.status !== 0 && /(?:unknown|unrecognized|unsupported)[^\n]*--wait-submit/i.test(observed.stderr || observed.stdout)) {
      oldHost = true
      sent = io.sh('orca', ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter'])
    }
    if (sent.status !== 0 && agent === 'agy') {
      let reason
      try { reason = JSON.parse(sent.stdout)?.error?.message } catch {}
      throw fail(String(reason ?? (sent.stderr || sent.stdout || 'orca terminal send falló')).trim().split(/\r?\n/)[0])
    }
    ok(sent, 'orca terminal send')
    let started = false
    if (!oldHost) {
      let receipt
      try {
        receipt = parseJson(sent, 'orca terminal send')
      } catch (error) {
        throw fail(error.message)
      }
      if (receipt.ok === false) throw fail(`orca terminal send no inici\u00f3 el turno: ${receipt.error?.message ?? JSON.stringify(receipt)}`)
      started = submittedTurn(receipt)
    }
    if (!started) started = worktreeAgentStarted(io, worktree)
    if (!started) {
      const screen = await screenAfterSend(io, handle, before)
      if (screen && !shellPrompt(screen) && !/trust this folder\?/i.test(screen)) started = true
    }
    if (!started) throw fail(`orca terminal send acept\u00f3 o envi\u00f3 el brief, pero no hay evidencia de que el turno haya arrancado. Terminal: ${handle}. Pantalla anterior: ${before}`)
    await checkPostLaunchScreen(io, handle, agent)
  } else {
    const handleOf = () => deepFind(parseJson(term, 'orca terminal create').result ?? {}, ['handle', 'terminalHandle'])
    let started
    if (supervised || rebind) {
      const handle = handleOf()
      if (!handle) throw new Error('orca terminal create no devolvió el handle de la terminal.')
      started = await startWorker(io, say, { agent, handle, briefPath, supervised, rebind })
    }
    let after = piSessionAfter
    let { tools, file } = await waitForPiSession(io, home, worktree, after)
    // #444: the brief can stay typed in pi's input without its Enter: one Enter, never a second, then one more wait.
    let handle
    if (piSessionAfter > 0 && tools === undefined) try { handle = handleOf() } catch {}
    let input = handle ? piInputOf(io, handle, brief) : undefined
    // #454: pi can come up waiting with an empty input: close that terminal and launch once more; a second empty input
    // fails, naming the second terminal, which stays open. #463: a supervised launch fences its dispatch with
    // worker-stop, which closes the terminal, and retries the same task on the new terminal with --retry-of.
    if (input === 'empty') {
      say(`Pi quedó esperando con la entrada vacía en ${handle}: cierro esa terminal y lo lanzo una vez más.`)
      const closing = started ? `detener el dispatch ${started.dispatchId ?? '(sin id)'} de la terminal ${handle}` : `cerrar la terminal ${handle}`
      try {
        if (started) {
          if (!started.dispatchId || !started.taskId) throw new Error('worker-start no devolvió el dispatch o la tarea')
          say(`orca orchestration worker-stop --dispatch ${started.dispatchId} --json`)
          const stopped = io.sh('orca', ['orchestration', 'worker-stop', '--dispatch', started.dispatchId, '--json'])
          const failure = orchestrationFailure(stopped, 'orca orchestration worker-stop')
          if (failure) throw new Error(failure)
        } else act('orca', ['terminal', 'close', '--terminal', handle, '--json'])
      } catch (error) {
        throw new Error(`No pude ${closing} de Pi con la entrada vacía, así que no lo lanzo de nuevo: ${error.message}`)
      }
      // #457: a session of the closed terminal that shows up late never counts as the second launch's.
      after = (io.now ?? Date.now)()
      term = create()
      handle = handleOf()
      if (started) {
        const argv = ['worker-start', '--run', started.runId, '--task', started.taskId, '--retry-of', started.dispatchId, '--terminal', handle, '--json']
        say(`orca orchestration ${shownArgs(argv)}`)
        const failure = orchestrationFailure(io.sh('orca', ['orchestration', ...argv]), 'orca orchestration worker-start')
        if (failure) throw new Error(`${failure}\nLa terminal nueva ${handle} de Pi quedó abierta sin dispatch; no la lanzo otra vez.`)
      }
      ;({ tools, file } = await waitForPiSession(io, home, worktree, after))
      input = tools === undefined && handle ? piInputOf(io, handle, brief) : undefined
      if (tools === undefined && input !== 'brief') throw new Error(`No observé una sesión nueva de Pi después del lanzamiento en ${worktree}; no doy el lanzamiento por iniciado. Terminal: ${handle}.`)
    }
    if (input === 'brief') {
      say(`El brief quedó escrito en la entrada de pi sin enviar: mando un Enter a ${handle}.`)
      io.sh('orca', ['terminal', 'send', '--terminal', handle, '--enter'])
      ;({ tools, file } = await waitForPiSession(io, home, worktree, after))
      if (tools === undefined) throw new Error(`No observé una sesión nueva de Pi después del lanzamiento en ${worktree}; no doy el lanzamiento por iniciado. Terminal: ${handle}.`)
    }
    if (tools === 'none') throw new Error(`La nueva sesi\u00f3n de Pi no tiene herramientas (<tools>\\n(none)); no despacho el brief. Revis\u00e1 la configuraci\u00f3n de herramientas de Pi para el worktree ${worktree}.`)
    if (piSessionAfter > 0 && tools === undefined) throw new Error(`No observ\u00E9 una sesi\u00F3n nueva de Pi despu\u00E9s del lanzamiento en ${worktree}; no doy el lanzamiento por iniciado.${rebind ? ` Terminal: ${handleOf()}.` : ''}`)
    if (file) await checkPiAuth(io, file, config.piClaudeConfigDir, after)
    if (rebind) await rebind.deliver(handleOf())
  }
  say(`\u2714 ${agent} despachado en ${worktree}. Brief: ${briefPath}`)

  return 0
}

// The only model providers a pi launch may use: Claude through the bridge or pi's Anthropic login, and OpenAI.
// Same JSON literal as shared/orca-config.ts (the mod side), compared by test/units.test.mjs.
// BEGIN PI_PROVIDERS
export const PI_PROVIDERS = ["claude-bridge/", "anthropic/", "openai/"]
// END PI_PROVIDERS
// The agents of a gentle-pi profile (orchestrator included) whose model is outside PI_PROVIDERS, as "agent (model)".
export const disallowedModels = profile => Object.entries(isPlain(profile) ? profile : {})
  .filter(([, agent]) => isPlain(agent) && typeof agent.model === 'string' && !PI_PROVIDERS.some(provider => agent.model.trim().startsWith(provider)))
  .map(([name, agent]) => `${name} (${agent.model.trim()})`)
// Why piProfileFor refuses the store profile `name`, or undefined when it launches it. The mod answers the same with
// shared/orca-config.ts: both sides run the cases of shared/perfiles-pi.json.
export const piProfileProblem = (name, profile) => {
  if (name.toLowerCase() === 'global') return '"global" es ambiguo'
  if (!PROFILE_NAME.test(name)) return 'nombre no válido'
  if (!isPlain(profile)) return 'no es un perfil'
  const bad = disallowedModels(profile)
  if (bad.length > 0) return `usa proveedores no permitidos: ${bad.join(', ')}`
  const orchestrator = profile.orchestrator
  if (!isPlain(orchestrator) || typeof orchestrator.model !== 'string' || orchestrator.model.trim() === '') return 'no define orchestrator.model'

  return undefined
}
// The profile the clone-local pin (<git-common-dir>/gentle-ai/profile-pin.json) declares, if any. gentle-pi gives it
// precedence over the worktree pin, so no other profile can be launched while it is there.
const clonePinFile = commonDir => path.join(commonDir, 'gentle-ai', 'profile-pin.json')
const clonePinOf = (commonDir, io) => {
  const local = commonDir ? readJson(clonePinFile(commonDir), io) : undefined

  return isPlain(local) && local.kind === PIN_KIND && typeof local.profile === 'string' ? local.profile : undefined
}
// What the "Falta el perfil" error offers: the launchable profiles, or why none is. A clone pin leaves only its own.
const launchableList = (profiles, clonePin) => {
  const entries = Object.entries(profiles ?? {})
  const problem = (name, profile) => piProfileProblem(name, profile) ?? (clonePin !== undefined && name !== clonePin ? `el clon fija el perfil "${clonePin}"` : undefined)
  const launchable = entries.filter(([name, profile]) => problem(name, profile) === undefined).map(([name]) => name)
  if (launchable.length > 0 || entries.length === 0) return `hay: ${launchable.join(', ') || 'ninguno'}`

  return `ninguno se puede lanzar: ${entries.map(([name, profile]) => `${name}: ${problem(name, profile)}`).join('; ')}`
}
const checkProviders = (name, profile) => {
  const bad = disallowedModels(profile)
  if (bad.length > 0) throw new Error(`El perfil de Pi "${name}" usa modelos de proveedores no permitidos (solo ${PI_PROVIDERS.join(', ')}): ${bad.join(', ')}.`)
}

// The gentle-pi profile a pi launch uses and where that came from: --perfil-pi, then the worktree pin, then
// agentes.pi.perfil. "global" is the globally active profile, on purpose. Nothing (or "preguntar") fails closed, before
// any side effect, so a launch never falls back to the global profile by accident.
export const piProfileFor = ({ flag, pin, config, home, commonDir, io }) => {
  const configured = config.agentes?.pi?.perfil
  const nonBlank = value => typeof value === 'string' && value.trim() !== ''
  const [wanted, source] = nonBlank(flag) ? [flag.trim(), 'flag']
    : nonBlank(pin) ? [pin.trim(), 'pin']
      : nonBlank(configured) && configured.trim().toLowerCase() !== 'preguntar' ? [configured.trim(), 'config'] : ['', undefined]
  const store = path.join(home, '.pi', 'gentle-ai', 'profiles.json')
  const data = readJson(store, io)
  const profiles = isPlain(data?.profiles) ? data.profiles : undefined
  const names = profiles ? Object.keys(profiles).join(', ') || 'ninguno' : 'ninguno'
  if (wanted === '') throw new Error(`Falta el perfil de Pi: pasá --perfil-pi <nombre> (${launchableList(profiles, clonePinOf(commonDir, io))}) o poné agentes.pi.perfil en la config ("global" usa el perfil activo global a propósito).`)
  if (wanted.toLowerCase() === 'global') {
    if (profiles && Object.keys(profiles).some(name => name.toLowerCase() === 'global')) {
      throw new Error(`"global" es ambiguo: ${store} tiene un perfil llamado así. Renombralo o pasá --perfil-pi con otro nombre.`)
    }
    // No active profile (or one missing from the store) leaves nothing to check the providers against: fail closed.
    const active = nonBlank(data?.active) ? data.active.trim() : undefined
    if (!active || !profiles || !isPlain(profiles[active])) {
      throw new Error(`"global" pide el perfil activo global, pero ${store} no tiene uno${active ? ` (activo: "${active}", que no existe)` : ''}. Activá uno con /gentle:profiles en Pi o pasá --perfil-pi <nombre>.`)
    }
    checkProviders(active, profiles[active])

    return { name: 'global', global: true, active, source: 'global' }
  }
  if (!PROFILE_NAME.test(wanted)) throw new Error(`El perfil de Pi "${wanted}" no es un nombre válido (letras, números, . _ -; hasta 64 caracteres).`)
  if (!profiles || !isPlain(profiles[wanted])) {
    throw new Error(`No existe el perfil de Pi "${wanted}" en ${store}${profiles ? ` (hay: ${names})` : ''}. Crealo con /gentle:profiles en Pi.`)
  }
  checkProviders(wanted, profiles[wanted])
  const orchestrator = profiles[wanted].orchestrator
  if (!isPlain(orchestrator) || typeof orchestrator.model !== 'string' || orchestrator.model.trim() === '') {
    throw new Error(`El perfil de Pi "${wanted}" no define orchestrator.model: sin él, el orquestador dependería del settings.json global.`)
  }
  // gentle-pi gives the clone-local pin precedence over the worktree one, so it would win silently.
  const local = clonePinOf(commonDir, io)
  if (local !== undefined && local !== wanted) {
    throw new Error(`El clon ya fija el perfil de Pi "${local}" (${clonePinFile(commonDir)}) y ese pin gana sobre el del worktree. Sacalo (/gentle:profiles, tecla p) o despachá con --perfil-pi ${local}.`)
  }

  let thinking
  if (orchestrator.thinking !== undefined) {
    if (PI_THINKING.includes(orchestrator.thinking)) thinking = orchestrator.thinking
    else io.out(`⚠ El perfil de Pi "${wanted}" tiene thinking ${JSON.stringify(orchestrator.thinking)}, que no es válido (${PI_THINKING.join(', ')}): se ignora y Pi arranca sin --thinking.`)
  }

  return { name: wanted, model: orchestrator.model.trim(), thinking, source }
}

// What every pi launch prints and its brief records, so an unexplained profile can be traced.
export const piProfileLines = profile => [
  ...(profile.global ? [`perfil de Pi: global (activo: ${profile.active})`] : []),
  `perfil de Pi: ${profile.global ? profile.active : profile.name} (fuente: ${profile.source})`,
]
// A worktree pin naming a profile the store no longer has can only be replaced by a named profile: "global" is no pin,
// and dropping the stale one would be a side effect nobody asked for. rebote and reanudar refuse it before any side effect.
export const refuseGlobalOverStalePin = (io, pin, flag) => {
  if (pin === undefined || typeof flag !== 'string' || flag.trim().toLowerCase() !== 'global' || piProfileStored(io, pin)) return
  throw new Error(`El worktree fija el perfil de Pi "${pin}", que ya no existe, y --perfil-pi global no lo reemplaza: pasá --perfil-pi <nombre> para fijar otro perfil en el worktree.`)
}
// A bounce or a resume that chose a named profile without the worktree pin writes the pin, so the subagents follow it too.
export const needsPin = profile => profile !== undefined && !profile.global && profile.source !== 'pin'
const withProfileLines = (brief, profile) => profile ? `${brief.replace(/\s*$/, '\n')}\n${piProfileLines(profile).join('\n')}\n` : brief

// Writes the worktree pin gentle-pi reads at every subagent launch, and keeps it out of git: info/exclude is per clone,
// so nothing tracked changes. gentle-pi also documents this file as a team-committable declaration, so first: a tracked pin
// is left alone when it declares the same profile and fails when it declares another one; and if git still does not ignore
// the file after the exclude entry (a .gitignore negation wins over info/exclude), it fails instead of writing.
const PIN_REL = '.pi/gentle-ai/profile.json'
// The profile name the worktree pin declares, if any.
export const readPin = (io, worktree) => {
  const profile = readJson(path.join(worktree, ...PIN_REL.split('/')), io)?.profile

  return typeof profile === 'string' ? profile : undefined
}
// Whether the gentle-pi store still has a profile called `name` (launchable or not).
export const piProfileStored = (io, name) => {
  const profiles = readJson(path.join(io.home, '.pi', 'gentle-ai', 'profiles.json'), io)?.profiles

  return isPlain(profiles) && Object.hasOwn(profiles, name) && isPlain(profiles[name])
}
export const writePin = (io, worktree, commonDir, name) => {
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
  const { n, agent, nota, perfilPi, rutas, dryRun = false, confirmado = false } = args
  const review = kind === 'review'
  const say = io.out
  if (!/^\d+$/.test(String(n ?? ''))) throw new Error(`Falta el número de ${review ? 'PR' : 'issue'}. Uso: orca-stack ${review ? 'revisar <pr>' : 'despachar <issue>'} <agente>.`)
  if (agent === 'codex-cc') throw new Error(CODEX_CC_REMOVED)
  if (agent === 'claude') throw new Error(CLAUDE_WORKER_REMOVED)
  if (!WORKER_AGENTS.includes(agent)) throw new Error(`Agente desconocido: ${agent ?? '(ninguno)'}. Los agentes son: ${WORKER_AGENTS.join(', ')}.`)
  const paths = reviewPaths(rutas, review)

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
  const consent = review ? undefined : rddConsentPolicy(config, agent)

  const remote = getRemoteOrigin(root, io)

  if (perfilPi !== undefined && agent !== 'pi') throw new Error('--perfil-pi solo vale para el agente pi.')
  const profile = agent === 'pi' ? piProfileFor({ flag: perfilPi, config, home: io.home, commonDir, io }) : undefined
  if (agent === 'pi' && !review) await refuseMissingGentleAi(io)

  let implementer = agent
  let branchOfPr
  let sha
  if (review) {
    const pr = parseJson(ok(io.sh('gh', ['pr', 'view', String(n), '--json', 'headRefName,headRefOid,body,number,comments,reviews'], { cwd: root }), 'gh pr view'), 'gh pr view')
    implementer = /^\s*Implementador:\s*(\S+)/mi.exec(pr.body ?? '')?.[1]?.trim().toLowerCase()
    if (!implementer) throw new Error(`El PR #${n} no tiene la línea "Implementador: <agente>" (la llevan los PRs de ticket y los de orquestación): sin ella no puedo comprobar que el revisor sea otro.`)
    if (implementer === agent.trim().toLowerCase()) throw new Error(`${agent} implementó el PR #${n}: nadie revisa su propio PR.`)
    // Same model family, same blind spots. pi is the exception: next to a Claude agent it brings another methodology.
    // A model with no known family proves nothing, so it does not stop the review.
    const mine = familyOf(config, agent, 'review').family
    if (agent !== 'pi' && implementer !== 'pi' && mine !== undefined && mine === familyOf(config, implementer, 'ticket').family) {
      throw new Error(`${agent} no revisa PRs de ${implementer}: los dos corren modelos de la familia ${mine}, comparten modelo y puntos ciegos.`)
    }
    branchOfPr = pr.headRefName
    sha = pr.headRefOid
    if (!paths && hasPublishedReview(pr, agent, sha)) throw new Error(`Ya revisaste ${sha} con ${agent}.`)
  } else {
    const issue = parseJson(ok(io.sh('gh', ['issue', 'view', String(n), '--json', 'state,assignees,title'], { cwd: root }), 'gh issue view'), 'gh issue view')
    if (String(issue.state).toUpperCase() !== 'OPEN') throw new Error(`El issue #${n} está cerrado.`)
    if ((issue.assignees ?? []).length > 0) throw new Error(`El issue #${n} ya tiene assignee (${issue.assignees.map(a => a.login).join(', ')}): está tomado.`)
  }

  // A review is named after its reviewer too: risk paths ask for more than one review of the same PR.
  const name = review ? `revision-${n}-${agent}` : `${repo}-${n}`
  const session = review ? `${repo}-${name}` : name
  const briefPath = path.join(io.home, 'orca', 'briefs', `${session}.md`)
  const reviewPath = path.join(io.home, 'orca', 'briefs', `${session}.review.md`)
  const startRef = `origin/${review ? branchOfPr : base}`

  // Idempotence lock: an existing worktree for this branch/name, or a live agent in it. A prunable entry is a worktree
  // whose folder is gone (`orca worktree rm` leaves one until `git worktree prune`): it does not count.
  const listed = ok(io.sh('git', ['worktree', 'list', '--porcelain'], { cwd: root }), 'git worktree list').stdout
  const entries = listed.split(/\r?\n\s*\r?\n/).filter(entry => !/^prunable\b/m.test(entry))
  const worktreeName = value => String(value).replace(/\\/g, '/').split('/').pop()
  const pathMatchesName = value => worktreeName(value) === name
  const existing = entries.find(entry => [...entry.matchAll(/^worktree (.+)$/gm)].some(([, value]) => pathMatchesName(value)))
  const conflict = entries.find(entry => [...entry.matchAll(/^(?:worktree |branch refs\/heads\/)(.+)$/gm)].some(([, value]) => pathMatchesName(value)))
  if (conflict && !review) throw new Error(`Ya hay un worktree para ${name}. No despacho dos veces: revisalo con \`orca worktree ps\`.`)
  if (conflict && review && !existing) throw new Error(`Ya hay un worktree o rama para ${name}, pero no pude identificar su ruta para reutilizarlo.`)
  const existingPath = existing ? [...existing.matchAll(/^worktree (.+)$/gm)].map(([, value]) => value).find(pathMatchesName) : undefined
  const previousHead = existing ? /^HEAD (.+)$/m.exec(existing)?.[1] : undefined
  if (existing && !previousHead) throw new Error(`No pude leer HEAD del worktree ${existingPath}; no voy a reutilizarlo.`)
  const ps = io.sh('orca', ['worktree', 'ps', '--json'])
  if (ps.status === 0) {
    const live = (parseJson(ps, 'orca worktree ps').result?.worktrees ?? []).find(
      w => worktreeName(w.path ?? '') === name || (!review && w.repo === repo && w.linkedIssue === Number(n)),
    )
    if (live && (!review || !existing)) throw new Error(`Orca ya tiene un worktree para ${name}${(live.agents ?? []).length > 0 ? ' con un agente vivo' : ''}: ${live.path}.`)
    // A done terminal or an empty shell in the review worktree is closed right before the reuse (main-autonomo S8).
    if (existing && live && (live.agents ?? []).some(item => LIVE_AGENT.test(item.state ?? item.status ?? ''))) {
      throw new Error(`Orca ya tiene un worktree para ${name} con un agente vivo: ${live.path}.`)
    }
    if (existing && !live) throw new Error(`Orca no muestra ${existingPath}; no puedo comprobar que no haya una terminal abierta antes de reutilizarlo.`)
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

  let fetchedOrigin = false
  let hasCodingStandards = false
  let migration
  const briefFor = branch => renderBrief(kind, {
    REPO: repo,
    REMOTE_HOST: remote.host,
    REMOTE_REPO: remote.ownerRepo,
    AGENT: agent,
    BASE: base,
    BRANCH: branch,
    VERIFICATION: verificationBlock(config),
    CUERPO_PR: config.verificacion?.cuerpoPR,
    PI_REVIEW: config.agentes?.pi?.review,
    HAS_CODING_STANDARDS: hasCodingStandards,
    PERKS: config.perks,
    ...(review ? { PR: String(n), SHA: sha, IMPLEMENTER: implementer } : { ISSUE: String(n), MIGRACION: migration?.texto }),
    ...(review ? {
      DELTA_INSTRUCTIONS: !previousHead || (previousHead === sha && !paths) ? 'This is the first review round; review the full PR.'
        : previousHead === sha ? `You already reviewed commit \`${sha}\`; this round reviews only the paths under \`## Partial review by design\`.`
          : `This is a second review round. Previous review commit is \`${previousHead}\`. Read only the delta with \`git diff ${previousHead}..${sha}\`.`,
      PUBLISH_INSTRUCTIONS: `Write the review in a UTF-8 file at ${reviewPath}. Publish it with the command below, never through a pipe:`,
      PUBLISH_COMMAND: `gh pr review ${n} --comment --body-file ${reviewPath}`,
    } : {}),
  }, nota) + partialReviewSection(paths)
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
  if (existing) {
    const status = io.sh('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: existingPath })
    if (status.status !== 0) throw new Error(`No pude comprobar el worktree ${existingPath}: ${(status.stderr || status.stdout).trim()}`)
    if (status.stdout.trim() !== '') throw new Error(`El worktree ${existingPath} est\u00E1 sucio; guard\u00E1 o descart\u00E1 sus cambios antes de revisar de nuevo.`)
    if (agent === 'pi') {
      const pinned = readPin(io, existingPath)
      // "global" writes no pin, so it matches a worktree without one.
      if (profile && pinned !== (profile.global ? undefined : profile.name)) throw new Error(`El worktree fija el perfil de Pi "${pinned ?? '(ninguno)'}"; no se puede cambiar a "${profile.name}" en una segunda revisión.`)
    }
    if (!dryRun) {
      const fetched = io.sh('git', ['fetch', 'origin'], { cwd: root })
      if (fetched.status !== 0) throw new Error(`git fetch origin fall\u00F3, no cambi\u00E9 el worktree: ${(fetched.stderr || fetched.stdout || String(fetched.error)).trim()}`)
      fetchedOrigin = true
    }
    const reachable = io.sh('git', ['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes/origin'], { cwd: existingPath })
    if (reachable.status !== 0 || reachable.stdout.trim() === '') throw new Error(`El HEAD del worktree ${existingPath} (${previousHead}) no est\u00E1 alcanzable desde origin; no cambi\u00E9 nada.`)
  }
  if (!dryRun && !fetchedOrigin) {
    const fetched = io.sh('git', ['fetch', 'origin'], { cwd: root })
    if (fetched.status !== 0) throw new Error(`git fetch origin falló, no asigné ni creé nada: ${(fetched.stderr || fetched.stdout || String(fetched.error)).trim()}`)
  }
  // main-autonomo-2 S2: the migration number is reserved after the fetch and before the issue is assigned; a second
  // dispatch of the same issue gets the number it already holds. Loaded here only: migraciones.mjs reaches estado.mjs,
  // which imports this module.
  if (!review && config.migraciones !== undefined) {
    const { reserve } = await import('./migraciones.mjs')
    migration = reserve({ issue: n, config, base, commonDir, root, io, dryRun })
    if (migration) say(dryRun ? `[simulación] Migración que reservaría para #${n}: ${migration.texto}` : `Migración ${migration.reused ? 'ya reservada' : 'reservada'} para #${n}: ${migration.texto}`)
  }
  const left = { assigned: false, worktree: null, brief: null }
  if (!review) {
    act('gh', ['issue', 'edit', String(n), '--add-assignee', '@me'], { cwd: root })
    left.assigned = !dryRun
  }
  const createArgs = ['worktree', 'create', '--name', name, '--base-branch', startRef, '--no-parent', ...(review ? [] : ['--issue', String(n)]), '--json']
  let worktree = existingPath ?? '<worktree>'
  let branch = name
  try {
    if (existing) {
      if (ps.status === 0) closeIdleTerminals(io, worktree, { dryRun, refusal: `Orca ya tiene un worktree para ${name} con un agente vivo: ${worktree}.` })
      say(`${dryRun ? '[simulación] ' : ''}Reutilizo ${worktree} desde ${previousHead} para revisar ${sha}.`)
      act('git', ['checkout', '--detach', sha], { cwd: worktree })
      branch = undefined
    } else {
      const created = act('orca', createArgs)
      if (!dryRun) {
        const json = parseJson(created, 'orca worktree create')
        worktree = deepFind(json.result ?? json, ['path', 'worktreePath'])
        branch = (deepFind(json.result ?? json, ['branch']) ?? name).replace(/^refs\/heads\//, '')
        if (!worktree) throw new Error('orca worktree create no devolvió la ruta del worktree.')
        left.worktree = worktree
      }
      // #430: main owns the worker's card; the issue link stays on `worktree create`.
      if (!review) {
        const card = ['--comment', `#${n} dispatched to ${agent}`, '--workspace-status', 'in-progress']
        if (dryRun) say(`[simulación] orca worktree set --worktree path:${worktree} ${card.map(a => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(' ')} --json`)
        else setCard(io, `path:${worktree}`, card)
      }
    }

    if (!review) say(`${dryRun ? '[simulaci\u00f3n] ' : ''}Rama: ${dryRun ? `la define Orca al crear el worktree (se pidi\u00f3 --name ${name})` : branch}`)

    if (profile) for (const line of piProfileLines(profile)) say(`${dryRun ? '[simulación] ' : ''}${line}`)
    if (profile && !profile.global) {
      say(`${dryRun ? '[simulación] ' : ''}perfil de Pi "${profile.name}": pin en ${path.join(worktree, ...PIN_REL.split('/'))} (si git no lo ignora, se agrega /${PIN_REL} a ${path.join(commonDir, 'info', 'exclude')}); orquestador ${profile.model}${profile.thinking ? ` (${profile.thinking})` : ''}`)
      if (!dryRun) writePin(io, worktree, commonDir, profile.name)
    }
    const brief = withProfileLines(briefFor(branch), profile)
    if (existing && io.exists(reviewPath)) {
      const archiveFor = round => path.join(io.home, 'orca', 'briefs', `${session}.review.${previousHead}${round > 1 ? `.${round}` : ''}.md`)
      let round = 1
      while (io.exists(archiveFor(round))) round += 1
      const archivedReviewPath = archiveFor(round)
      say(`${dryRun ? '[simulación] ' : ''}review anterior -> ${archivedReviewPath}`)
      if (!dryRun) io.rename(reviewPath, archivedReviewPath)
    }
    say(`${dryRun ? '[simulación] ' : ''}brief -> ${briefPath}`)
    if (paths) say(`${dryRun ? '[simulación] ' : ''}Review parcial por diseño: ${paths.join(', ')}`)
    if (!dryRun) {
      io.mkdirp(path.dirname(briefPath))
      io.writeFile(briefPath, brief)
      left.brief = briefPath
      if (consent === 'politica') writeRddConsent(io, worktree, [])
    }
    const launch = () => launchInWorktree({
      agent, mode, worktree, briefPath, brief, session, config, win, home: io.home, skills,
      piModel: profile?.model, piThinking: profile?.thinking, repositoryRoot: root, io, dryRun,
      piSessionAfter: agent === 'pi' ? (io.now ?? Date.now)() : 0, issue: review ? undefined : n,
      supervised: review ? undefined : supervisedTask(repo, `#${n} ${agent}`),
    })
    try {
      await launch()
    } catch (error) {
      // #431: out of quota right after the launch: switch to another Orca account of the agent and relaunch once. A
      // second quota stop, no account left or a failed list or select fail as before.
      if (review || dryRun || error.quota === undefined) throw error
      const switched = switchAccount(io, commonDir, agent, n, { launchedNow: true })
      if (switched.error) say(`cuenta no cambiada: ${agent} — ${switched.error}`)
      if (!switched.line) throw error
      say(switched.line)
      await launch()
    }

    return 0
  } catch (error) {
    // #397: Orca refused the supervised start, so no worker runs: the issue is released, not left assigned.
    if (!dryRun && error.orchestration && left.assigned) {
      say(`gh issue edit ${n} --remove-assignee @me`)
      if (io.sh('gh', ['issue', 'edit', String(n), '--remove-assignee', '@me'], { cwd: root }).status === 0) left.assigned = false
    }
    if (!dryRun) say(leftover(left, n, base))
    throw error
  }
}

const command = kind => async (flags, n, agent, io) =>
  dispatch(kind, { n, agent, nota: flags.nota, dryRun: flags.dryRun, confirmado: flags.confirmado, perfilPi: flags.perfilPi, rutas: flags.rutas }, io)
export const despacharCommand = command('ticket')
export const revisarCommand = command('review')

const reviewBody = review => typeof review?.body === 'string' ? review.body : ''
// #502: block revisar only when this reviewer already published a review/comment for this commit.
const hasPublishedReview = (pr, agent, sha) => {
  const targetAgent = agent.trim().toLowerCase()
  const targetSha = String(sha ?? '').toLowerCase()
  return [...(pr.reviews ?? []), ...(pr.comments ?? [])].some(item => {
    const body = reviewBody(item)
    const reviewer = markerLines(body).slice(0, 5).map(line => /^Revisor:\s*(\S+)$/i.exec(line)?.[1]?.toLowerCase()).find(Boolean)
    if (reviewer !== targetAgent) return false
    const rawCommit = /^(`?)([^\s`]+)\1$/.exec(markerValue(body, 'Commit', { within: 5 }) ?? '')?.[2]?.toLowerCase()
    return rawCommit === targetSha || namesCommit(commitOf(body, { within: 5 }), sha)
  })
}
const blockingSection = body => /(?:^|\r?\n)##\s+BLOQUEA\s*(?:\r?\n|$)([\s\S]*?)(?=\r?\n##\s|$)/i.exec(body)?.[1]?.trim() ?? ''
const blockingBody = body => {
  const section = blockingSection(body)
  return section !== '' && !/^nada\s*$/i.test(section)
}
// A blocker is an interpretation finding only when the last element of the tag right after its optional `file:line` says so, never from words in its text.
// Only a location shaped like path:line or path:line-line, backticked or bare, can precede the tag; other inline code is description.
// A backticked path may hold spaces only when it ends in a file extension, so prose such as `ratio is 1:3` stays description.
const interpretationLines = section => section.split(/\r?\n/).filter(line => {
  const tag = /^\s*\d+[.)]\s+(?:`(?:[^`\s]+|[^`\n]*\.[A-Za-z]\w*):\d+(?:-\d+)?`|[^\s(`]+:\d+(?:-\d+)?)?\s*\(([^()\n]*)\)/.exec(line)?.[1]
  return tag !== undefined && /^interpretaci[o\u00F3]n$/i.test(tag.split(',').at(-1).trim().normalize('NFC'))
})
// An issue that cannot be read adds no answers, so its interpretation findings stay with the human.
const humanAnswers = (io, root, pr) => {
  const isAnswer = item => /^Respuesta del humano:/m.test(reviewBody(item))
  const issues = [...new Set([...String(pr.body ?? '').matchAll(/\bCloses #(\d+)\b/gi)].map(match => match[1]))]
  const fromIssues = issues.flatMap(issue => {
    const res = io.sh('gh', ['issue', 'view', issue, '--json', 'comments'], { cwd: root })
    if (res.status !== 0) return []
    try {
      const comments = JSON.parse(res.stdout).comments
      return Array.isArray(comments) ? comments : []
    } catch {
      return []
    }
  })
  return [...(pr.comments ?? []), ...fromIssues].filter(isAnswer)
}

export const CI_BOUNCE_CAP = 4

// #396: the newest comment or review that starts with `Diagnóstico: main`, names the head on its `Commit:` line and
// was posted after the newest `Rebote CI:` marker, by date; an item without a date is never after a marker.
// hypothesis is its `Siguiente hipótesis:`, or undefined when it is empty or `ninguna`.
const mainDiagnosis = (items, namesHead) => {
  const timeOf = item => Date.parse(String(item?.createdAt ?? item?.submittedAt ?? ''))
  const lastMark = Math.max(-Infinity, ...items.filter(item => /^Rebote CI:\s*\S+\s*$/im.test(reviewBody(item))).map(item => {
    const at = timeOf(item)
    return Number.isNaN(at) ? Infinity : at
  }))
  const found = items
    .map(item => ({ body: reviewBody(item), at: timeOf(item) }))
    .filter(({ body, at }) => /^Diagnóstico:[ \t]*main(?:[ \t]|$)/im.test(body.trimStart().split(/\r?\n/)[0]) && !Number.isNaN(at) && at > lastMark &&
      namesHead(/^\s*Commit:\s*(\S+)\s*$/mi.exec(body)?.[1]))
    .sort((a, b) => a.at - b.at)
    .at(-1)
  if (!found) return undefined
  const hypothesis = /^\s*Siguiente hipótesis:[ \t]*(.*)$/mi.exec(found.body)?.[1]?.trim() ?? ''
  // `ninguna` copied with markdown (`ninguna`, **ninguna**, ninguna.) is still no hypothesis.
  const plain = hypothesis.replace(/[`*_]/g, '').trim().replace(/\.$/, '').trim()
  return { hypothesis: plain === '' || plain.toLowerCase() === 'ninguna' ? undefined : hypothesis }
}

const MARKER_ATTEMPTS = 3
const MARKER_RETRY_WAIT_MS = 3000

// The sha of the newest `Rebote:`, `Rebote CI:` or `Rebote conflicto:` mark among a PR's reviews and comments, by date.
const BOUNCE_MARK = /^Rebote(?: CI| conflicto)?:\s*(\S+)\s*$/gim
export const lastBounceMark = items => (items ?? [])
  .map((item, index) => ({ index, at: Date.parse(item?.submittedAt ?? item?.createdAt ?? ''), shas: [...reviewBody(item).matchAll(BOUNCE_MARK)].map(match => match[1]) }))
  .filter(item => item.shas.length > 0)
  .sort((a, b) => ((Number.isNaN(a.at) ? -Infinity : a.at) - (Number.isNaN(b.at) ? -Infinity : b.at)) || a.index - b.index)
  .at(-1)?.shas.at(-1)

const prWorktree = (io, root, pr, n) => {
  const listed = ok(io.sh('git', ['worktree', 'list', '--porcelain'], { cwd: root }), 'git worktree list').stdout
  const worktree = listed.split(/\r?\n\s*\r?\n/).map(entry => {
    const branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1]
    const location = /^worktree (.+)$/m.exec(entry)?.[1]
    return branch === pr.headRefName && location ? location : undefined
  }).find(Boolean)
  if (!worktree) throw new Error(`No hay un worktree para la rama ${pr.headRefName} del PR #${n}.`)
  return worktree
}

// Before the worktree moves: a pi bounce with no profile fails closed. The pin wins; with none, the flag or the config.
// A pin naming a profile the store no longer has can only be replaced: --perfil-pi does it, and the launch rewrites it.
const bounceProfile = (io, { agent, worktree, perfilPi, config, commonDir }) => {
  if (agent !== 'pi') return undefined
  const profilePin = readPin(io, worktree)
  const stalePin = profilePin !== undefined && !piProfileStored(io, profilePin)
  refuseGlobalOverStalePin(io, profilePin, perfilPi)
  if (perfilPi !== undefined && profilePin !== undefined && perfilPi !== profilePin && !stalePin) throw new Error(`El worktree fija el perfil de Pi "${profilePin}"; no se puede cambiar a "${perfilPi}" en un rebote.`)
  try {
    return piProfileFor({ flag: profilePin === undefined || stalePin ? perfilPi : undefined, pin: profilePin, config, home: io.home, commonDir, io })
  } catch (error) {
    if (perfilPi === undefined && stalePin) error.message += ` Repetí con --perfil-pi <nombre> para fijar otro perfil en el worktree.`
    throw error
  }
}

// Orca's live agent states: working (older Orca: running/active), or blocked/waiting on a dialog; only done is not live.
const LIVE_AGENT = /^(working|running|active|blocked|waiting)$/i

// main-autonomo S8: revisar and rebote refuse only a live agent; a done terminal or an empty shell (no agent record, a
// shell prompt on screen) of that worktree they close themselves, and say which. A terminal Orca places in another
// worktree, one whose screen cannot be read and any other terminal without a record are left alone.
export const closeIdleTerminals = (io, worktree, { dryRun = false, refusal }) => {
  const ps = io.sh('orca', ['worktree', 'ps', '--json'])
  if (ps.status !== 0) throw new Error(`Orca no contesta (orca worktree ps): ${(ps.stderr || ps.stdout).trim()}`)
  const row = (parseJson(ps, 'orca worktree ps').result?.worktrees ?? []).find(item => samePath(item.path ?? '', worktree))
  const agents = row?.agents ?? []
  const stateOf = item => String(item?.state ?? item?.status ?? '')
  if (agents.some(item => LIVE_AGENT.test(stateOf(item)))) throw new Error(refusal)
  if (!row) return []
  const listed = io.sh('orca', ['terminal', 'list', '--worktree', `path:${worktree}`, '--json'])
  let terminals
  try { terminals = JSON.parse(listed.stdout)?.result?.terminals } catch {}
  if (listed.status !== 0 || !Array.isArray(terminals)) throw new Error(`orca terminal list falló para ${worktree}: ${(listed.stderr || listed.stdout).trim().split(/\r?\n/)[0]}. No cerré nada.`)
  const records = new Map(agents.map(item => [item.paneKey, item]))
  const idle = terminals.flatMap(terminal => {
    if (!terminal?.handle || !terminal.worktreePath || !samePath(terminal.worktreePath, worktree)) return []
    const record = records.get(`${terminal.tabId}:${terminal.leafId}`)
    if (record) return /^done$/i.test(stateOf(record)) ? [[terminal.handle, 'done']] : []
    const res = io.sh('orca', ['terminal', 'read', '--terminal', terminal.handle, '--screen', '--json'])
    let tail
    try { tail = res.status === 0 ? JSON.parse(res.stdout)?.result?.terminal?.tail : undefined } catch {}
    const lines = Array.isArray(tail) ? tail.map(String) : typeof tail === 'string' ? tail.split(/\r?\n/) : []
    const last = lines.filter(line => line.trim() !== '').at(-1)
    return last && shellPrompt(last) ? [[terminal.handle, 'shell vacía']] : []
  })
  for (const [handle, reason] of idle) {
    if (dryRun) {
      io.out(`[simulación] Cerraría la terminal ${handle} (${reason}) de ${worktree}.`)
      continue
    }
    ok(io.sh('orca', ['terminal', 'close', '--terminal', handle, '--json']), `orca terminal close ${handle}`)
    io.out(`Cerré la terminal ${handle} (${reason}) de ${worktree}.`)
  }

  return idle.map(([handle]) => handle)
}

const refuseLiveAgent = (io, worktree, dryRun) =>
  closeIdleTerminals(io, worktree, { dryRun, refusal: `Hay un agente vivo en ${worktree}; cerralo antes de rebotar.` })

// main-autonomo S3: how a worker answers RDD's consent. "politica" (the default) leaves the answer in a file Gentle Shell
// reads; "humano" keeps the old behaviour, where the worker asks.
export const rddConsentPolicy = (config, agent) => {
  const value = config.agentes?.[agent]?.rddConsentimiento
  if (value === undefined || value === 'politica') return 'politica'
  if (value === 'humano') return 'humano'
  throw new Error(`agentes.${agent}.rddConsentimiento tiene que ser "politica" o "humano", no ${JSON.stringify(value)}.`)
}

export const RDD_CONSENT_REL = ['orca-stack', 'rdd-consentimiento.json']

// Written in the worktree's own git dir (a linked worktree has one per worktree), so it never shows in git status.
// keepExisting (reanudar): a resumed worker keeps the file it has, so a head main granted for an RDD review that
// paused on a Consulta: is still granted when it resumes.
export const writeRddConsent = (io, worktree, granted, { keepExisting = false } = {}) => {
  const res = io.sh('git', ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: worktree })
  const gitDir = res.status === 0 ? res.stdout.split(/\r?\n/)[0].trim() : ''
  if (gitDir === '') throw new Error(`No pude leer el git dir de ${worktree} (git rev-parse --git-dir): ${(res.stderr || res.stdout || String(res.error ?? '')).trim()}`)
  const file = path.join(path.resolve(worktree, gitDir), ...RDD_CONSENT_REL)
  if (keepExisting && io.exists(file)) {
    io.out(`Consentimiento RDD (política): dejo ${file} como está.`)
    return file
  }
  const text = JSON.stringify({ version: 1, granted })
  io.mkdirp(path.dirname(file))
  io.writeFile(file, `${text}\n`)
  io.out(`Consentimiento RDD (política): ${file} = ${text}`)

  return file
}

// main-autonomo S12: `revisar --rutas a,b` asks for a review of those paths only.
const reviewPaths = (rutas, review) => {
  if (rutas === undefined) return undefined
  if (!review) throw new Error('--rutas solo vale para revisar.')
  const paths = [...new Set(String(rutas).split(',').map(item => item.trim()).filter(Boolean))]
  if (paths.length === 0) throw new Error('--rutas necesita al menos una ruta: --rutas <ruta,ruta>.')

  return paths
}
const partialReviewSection = paths => paths
  ? `\n## Partial review by design\n\nmain asked for a review of these paths only (\`revisar --rutas\`): read each of them in full against the PR diff; you do not have to read the rest of the diff. Under \`## Cobertura\`, list them on \`Leído:\` and every other path the PR changes on \`Sin leer:\`.\n\n${paths.map(item => `- \`${item}\``).join('\n')}\n`
  : ''

export const CONTINUE_LINE = 'You were stopped before finishing this bounce (for example by a usage limit). The worktree keeps your work in progress (a merge in progress stays in progress): continue it, do not abort or reset it.'

// #462: a branch suffix after the issue number (`orca-stack-419-alcance`) still names issue #419.
const bounceIssue = (pr, n) => /^\s*Closes\s+#(\d+)/mi.exec(pr.body ?? '')?.[1] ?? /^.*-(\d+)(?:-[^\d/][^/]*)?$/.exec(pr.headRefName ?? '')?.[1] ?? String(n)
const bounceTask = (repo, issue, agent, n) => supervisedTask(repo, `#${issue} ${agent} rebote #${n}`)

// `rebote <pr> --continuar` (#292): relaunch the author of the bounce on the current head, in its worktree as it is,
// with the bounce brief and the session id the bounce used. It posts no marker, so it counts toward no bounce limit.
// Only pi is launched with a session id (`--session-id`); claude, codex and agy start a fresh session with the same brief.
const continueBounce = async ({ n, pr, agent, root, repo, config, commonDir, perfilPi, dryRun }, io) => {
  const say = io.out
  const sim = dryRun ? '[simulación] ' : ''
  const sha = pr.headRefOid
  const mark = lastBounceMark([...(pr.reviews ?? []), ...(pr.comments ?? [])])
  if (!mark) throw new Error(`El PR #${n} no tiene un marcador Rebote: ni Rebote CI: ni Rebote conflicto:; no hay rebote que continuar.`)
  if (mark !== sha) throw new Error(`El autor ya pusheó ${sha}; esto es un rebote nuevo, no una continuación.`)
  const name = `${repo}-pr-${n}-rebote`
  const bounceBrief = path.join(io.home, 'orca', 'briefs', `${name}.md`)
  if (!io.exists(bounceBrief)) throw new Error(`No encuentro el brief del rebote ${bounceBrief}; no hay rebote que continuar.`)
  const worktree = prWorktree(io, root, pr, n)
  const profile = bounceProfile(io, { agent, worktree, perfilPi, config, commonDir })
  const consent = rddConsentPolicy(config, agent)
  refuseLiveAgent(io, worktree, dryRun)
  const sessionPath = path.join(io.home, 'orca', 'briefs', `${name}.session`)
  let session = agent === 'pi' && io.exists(sessionPath) ? io.readFile(sessionPath).trim() : ''
  if (!session) {
    session = `${name}-${(io.now ?? Date.now)()}`
    say(agent === 'pi'
      ? `${sim}No encuentro la sesión del rebote (${sessionPath}): relanzo a pi con una sesión nueva y el mismo brief.`
      : `${sim}${agent} no continúa una sesión: lo relanzo con una sesión nueva y el mismo brief.`)
    if (agent === 'pi' && !dryRun) io.writeFile(sessionPath, `${session}\n`)
  }
  const skills = agent === 'pi' ? io.gentleSkills(io.home) : null
  if (agent === 'pi' && !skills) throw new Error('No encuentro las skills de gentle-pi (Pi ni npm global): corré `orca-stack global`.')
  if (profile) for (const line of piProfileLines(profile)) say(`${sim}${line}`)
  if (needsPin(profile) && !dryRun) writePin(io, worktree, commonDir, profile.name)
  // Rebuilt from the bounce brief on every run, so a second --continuar does not stack the line twice.
  const briefPath = path.join(io.home, 'orca', 'briefs', `${name}-continuar.md`)
  const brief = `${CONTINUE_LINE}\n\n${io.readFile(bounceBrief)}`
  if (!dryRun) io.writeFile(briefPath, brief)
  say(`${sim}brief -> ${briefPath}`)
  if (consent === 'politica' && !dryRun) writeRddConsent(io, worktree, [])
  const issue = bounceIssue(pr, n)
  try {
    await launchInWorktree({ agent, mode: 'ticket', worktree, briefPath, brief, session, config, win: io.win, home: io.home, skills, piModel: profile?.model, piThinking: profile?.thinking, repositoryRoot: root, io, dryRun, piSessionAfter: agent === 'pi' ? (io.now ?? Date.now)() : 0, issue, supervised: bounceTask(repo, issue, agent, n) })
  } catch (error) {
    if (error.quota === undefined) throw error
    // One launch per run: still out of quota means wait for the reset, never loop.
    const reset = quotaReset(error.quota)
    throw new Error(`${agent} sigue sin cuota${reset ? ` (${reset})` : ''}: reintentá \`orca-stack rebote ${n} --continuar\` ${reset ? 'después de esa hora' : 'cuando se renueve la cuota'}. ${error.message}`)
  }
  say(`${sim}Continúo el rebote de ${sha} de ${agent}.`)
  return 0
}

export const reboteCommand = async (flags, n, io = defaultIo()) => {
  const { nota, confirmado = false, perfilPi, dryRun = false, continuar = false } = flags
  // An RDD bounce asks pi for an RDD review of its own PR: it carries lenses, never findings.
  const rdd = flags.rdd !== undefined
  const lenses = rdd ? String(flags.rdd).split(',').map(lens => lens.trim().toLowerCase()) : []
  if (rdd && (lenses.length > 4 || new Set(lenses).size !== lenses.length || lenses.some(lens => !RDD_LENSES.includes(lens)))) {
    throw new Error(`--rdd necesita de 1 a 4 lentes distintas entre ${RDD_LENSES.join(', ')}.`)
  }
  if (rdd && continuar) throw new Error('--rdd no vale con --continuar: el autor sigue con el brief del rebote.')
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
  if (agent === 'codex-cc') throw new Error(CODEX_CC_REMOVED)
  if (!AGENTS.includes(agent)) throw new Error(`Agente desconocido en Implementador: ${agent}.`)
  if (!(config.agentes?.usa ?? []).includes(agent)) throw new Error(`${agent} no est\u00E1 en agentes.usa de este repo (${(config.agentes?.usa ?? []).join(', ') || 'vac\u00EDo'}).`)
  const blocked = blockOf(config, agent, (io.now ?? Date.now)())
  if (blocked) throw new Error(`No relanzo a ${agent}: ${blocked}`)
  if ((config.agentes?.preguntarAntes ?? []).includes(agent) && !confirmado) {
    throw new Error(`${agent} figura en agentes.preguntarAntes: main tiene que preguntarle al humano antes de relanzarlo. Si dijo que s\u00ED, repet\u00ED el comando con --confirmado.`)
  }
  if (perfilPi !== undefined && agent !== 'pi') throw new Error('--perfil-pi solo vale para el agente pi.')
  if (rdd && agent !== 'pi') throw new Error(`--rdd solo vale para un PR de pi (Implementador: ${agent}).`)
  if (rdd && !rddMode(config, agent) && !rddFallbackFor(config, agent, (io.now ?? Date.now)())) throw new Error('--rdd necesita agentes.pi.review: "rdd" en la config del repo.')
  if (agent === 'pi') await refuseMissingGentleAi(io)
  const consent = rddConsentPolicy(config, agent)

  const sha = pr.headRefOid
  if (typeof sha !== 'string' || sha.trim() === '') throw new Error(`No pude obtener headRefOid del PR #${n}.`)
  // The brief of a continuation is the bounce brief: a new note would need a new bounce.
  if (continuar && nota !== undefined) throw new Error('--nota no vale con --continuar: el autor sigue con el brief del rebote.')
  if (continuar) return await continueBounce({ n, pr, agent, root, repo, config, commonDir, perfilPi, dryRun }, io)
  const allReviews = [...(pr.reviews ?? []), ...(pr.comments ?? [])]
  // Same rules as src/estado.mjs (the source of truth, #391): comments and reviews in the order they were posted, the
  // first five lines, a sha abbreviated to 7+ characters still names the head, and an RDD review counts only after
  // main's request with the same lenses: a comment of its own whose first non-empty line is `RDD: <sha> (<lentes>)`
  // and that is not a review (no `Revisor:` line, no `## BLOQUEA`).
  const namesHead = commit => commit !== undefined && (commit.toLowerCase() === sha.toLowerCase() || (commit.length >= 7 && sha.toLowerCase().startsWith(commit.toLowerCase())))
  const lensKey = text => text.split(',').map(lens => lens.trim().toLowerCase()).filter(Boolean).sort().join(',')
  const timeOf = item => Date.parse(String(item?.createdAt ?? item?.submittedAt ?? ''))
  const posted = [...(pr.comments ?? []), ...(pr.reviews ?? [])]
  const timeline = posted.every(item => !Number.isNaN(timeOf(item))) ? [...posted].sort((a, b) => timeOf(a) - timeOf(b)) : posted
  const requestOf = body => {
    const lines = body.split(/\r?\n/).map(line => line.trim())
    if (lines.some(line => /^Revisor:/i.test(line) || /^##\s*BLOQUEA\b/i.test(line))) return undefined
    const match = /^RDD:\s*(\S+)\s*\(([^()]*)\)$/i.exec(lines.find(line => line !== '') ?? '')
    return match !== null && namesHead(match[1]) ? lensKey(match[2]) : undefined
  }
  if (rdd && timeline.some((item, at) => {
    const head = reviewBody(item).trimStart().split(/\r?\n/).slice(0, 5).join('\n')
    const lensesOf = /^\s*Revisor:\s*pi \(RDD:([^()]*)\)\s*$/mi.exec(head)?.[1]
    return lensesOf !== undefined && namesHead(/^\s*Commit:\s*(\S+)\s*$/mi.exec(head)?.[1]) &&
      timeline.slice(0, at).some(earlier => requestOf(reviewBody(earlier)) === lensKey(lensesOf))
  })) throw new Error(`Ya hay un review RDD de pi sobre ${sha}.`)
  const ciMarkers = allReviews.flatMap(item => [...reviewBody(item).matchAll(/^Rebote CI:\s*(\S+)\s*$/gim)].map(match => match[1]))
  const conflictMarkers = allReviews.flatMap(item => [...reviewBody(item).matchAll(/^Rebote conflicto:\s*(\S+)\s*$/gim)].map(match => match[1]))
  // A review round is one reviewed head: a marker posted twice by a retry, or a relaunch on the same head, is not a new round.
  const reviewMarkers = allReviews.flatMap(item => [...reviewBody(item).matchAll(/^Rebote:\s*(\S+)\s*$/gim)].map(match => match[1]))
  const round = new Set(reviewMarkers.filter(marker => marker !== sha)).size + 1
  // An RDD bounce skips the CI, conflict and blocker analysis: there are no findings to send.
  const mergeable = rdd ? '' : String(pr.mergeable ?? '').toUpperCase()
  if (mergeable === 'UNKNOWN') throw new Error(`GitHub todavía está calculando si el PR #${n} se puede mergear; repetí el comando en unos segundos.`)
  // GitHub does not run pull_request workflows while a PR conflicts, so its CI gate (pending, cancelled) is skipped.
  const conflict = mergeable === 'CONFLICTING'
  const base = pr.baseRefName || config.ramaBase || 'main'
  if (conflict && conflictMarkers.includes(sha)) throw new Error(`El PR #${n} ya rebotó por conflicto en ${sha} y el autor no pusheó nada desde entonces; mirá su worktree antes de repetir.`)
  // Only checks from the latest run of each workflow count; a cancelled run with an unlisted replacement is pending.
  // statusCheckRollup is the head commit's rollup, so every check in it belongs to headRefOid.
  const latest = rdd ? [] : latestChecks(Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [])
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
  // #396: k is the CI bounce being attempted, the distinct heads already CI-bounced (the current one aside) plus one.
  // Bounces 3 and 4 need a `Diagnóstico: main` on the head, posted after the latest `Rebote CI:`; never a fifth.
  let ciHypothesis
  if (failedChecks.length > 0) {
    const k = new Set(ciMarkers.filter(marker => marker !== sha)).size + 1
    if (k > CI_BOUNCE_CAP) throw new Error(`rebote: tope de ${CI_BOUNCE_CAP} rebotes de CI alcanzado en el PR #${n}`)
    if (k > 2) {
      const diagnosis = mainDiagnosis(allReviews, namesHead)
      if (!diagnosis) throw new Error(`rebote: falta un Diagnóstico de main sobre ${sha} para el rebote de CI ${k}`)
      if (!diagnosis.hypothesis) throw new Error(`rebote: el Diagnóstico de main sobre ${sha} no trae una Siguiente hipótesis`)
      ciHypothesis = diagnosis.hypothesis
    }
  }
  const blockers = rdd ? [] : allReviews.filter(item => {
    const body = reviewBody(item)
    return blockingBody(body) && /^\s*Commit:\s*(\S+)/mi.exec(body)?.[1] === sha
  })
  const flagged = blockers.filter(item => interpretationLines(blockingSection(reviewBody(item))).length > 0)
  // A Respuesta del humano posted after the review, on the PR or on an issue it closes, settles its interpretation findings.
  const answers = flagged.length > 0 ? humanAnswers(io, root, pr) : []
  const settledBy = new Map(flagged.map(item => {
    const at = Date.parse(item.submittedAt ?? item.createdAt ?? '')
    return [item, Number.isNaN(at) ? undefined : answers.find(answer => Date.parse(answer.createdAt ?? '') > at)]
  }).filter(([, answer]) => answer))
  const interpretations = flagged.filter(item => !settledBy.has(item))
  const reviewBlockers = blockers.filter(item => !interpretations.includes(item))
  // The review bounce is counted by each review's Commit: sha: only blockers on the current head count above,
  // so a Rebote: marker of an older head refuses nothing, and a head that moved bounces on a review of its own.
  if (interpretations.length > 0 && failedChecks.length === 0 && !conflict) {
    const lines = interpretations.map(item => `${item.url ?? item.html_url ?? 'review'}: ${interpretationLines(blockingSection(reviewBody(item))).join(' ')}`)
    throw new Error(`Los bloqueos de interpretaci\u00F3n van al humano, no al autor:\n${lines.join('\n')}`)
  }
  const findings = reviewBlockers.map(item => {
    const answer = settledBy.get(item)
    return `${item.url ?? item.html_url ?? 'Review'}\n${blockingSection(reviewBody(item))}${answer ? `\nInterpretation settled by the human: ${answer.url ?? '(no link available)'}` : ''}`
  }).join('\n\n')
  if (!rdd && reviewBlockers.length === 0 && failedChecks.length === 0 && !conflict) {
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
    }).join('\n') + (ciHypothesis ? `\n\nmain's diagnosis of this head (\`Diagnóstico: main\`), the hypothesis to test in this bounce: ${ciHypothesis}` : '')
    : 'None.'

  const worktree = prWorktree(io, root, pr, n)
  const profile = bounceProfile(io, { agent, worktree, perfilPi, config, commonDir })
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
  refuseLiveAgent(io, worktree, dryRun)
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
  // An RDD bounce keeps its brief and session apart, so `--continuar` never resumes it in place of a findings bounce.
  const stem = rdd ? `${name}-rdd` : name
  const session = `${stem}-${(io.now ?? Date.now)()}`
  const briefPath = path.join(io.home, 'orca', 'briefs', `${stem}.md`)
  const skills = agent === 'pi' ? io.gentleSkills(io.home) : null
  if (agent === 'pi' && !skills) throw new Error('No encuentro las skills de gentle-pi (Pi ni npm global): corr\u00E9 `orca-stack global`.')
  if (profile) for (const line of piProfileLines(profile)) say(`${dryRun ? '[simulaci\u00F3n] ' : ''}${line}`)
  if (needsPin(profile) && !dryRun) writePin(io, worktree, commonDir, profile.name)
  // `--continuar` reads it back to relaunch pi with the same --session-id; written before the launch, which may fail.
  if (!dryRun) {
    io.mkdirp(path.dirname(briefPath))
    io.writeFile(path.join(io.home, 'orca', 'briefs', `${stem}.session`), `${session}\n`)
  }
  const issue = bounceIssue(pr, n)
  const brief = rdd ? withProfileLines(render(readAsset('stack', 'brief-rdd.md'), {
    PR: String(n), SHA: sha,
    AGENT: agent,
    ISSUE: issue,
    LENSES: lenses.join(', '),
    REMOTE_HOST: remote.host,
    REMOTE_REPO: remote.ownerRepo,
    REMOTE_OPERATIONS: `read the PR, its diff and checks; push only the PR branch to \`origin\` for the bounded correction; comment on the PR; \`gh pr edit ${n} --body-file <file>\` for the PR body only.`,
    VERIFICATION: verificationBlock(config),
    PI_FOREGROUND: piForeground(agent),
    FANOUT_INSTRUCTIONS: fanoutInstructions(agent, nota, true),
    NOTE_SECTION: nota ? `\n## Extra notes from main\n\n${nota.trim()}\n` : '',
  }), profile) : withProfileLines(render(readAsset('stack', 'brief-rebote.md'), {
    PR: String(n), SHA: sha,
    AGENT: agent,
    ISSUE: issue,
    REMOTE_HOST: remote.host,
    REMOTE_REPO: remote.ownerRepo,
    REMOTE_OPERATIONS: `read the PR, its reviews and checks (including \`gh run view ... --log-failed\`); ${conflict ? `\`git fetch origin\` (the base branch \`${base}\`); ` : ''}push only the PR branch to \`origin\`; comment on the PR; \`gh pr edit ${n} --body-file <file>\` for the PR body only.`,
    FINDINGS: findings || (conflict ? 'No current blocking review findings.' : 'No current blocking review findings; this is a CI-only bounce.'),
    FAILED_CHECKS: failedChecksText,
    CONFLICT_SECTION: conflictSection,
    VERIFICATION: verificationBlock(config),
    PI_FOREGROUND: piForeground(agent),
    BODY_PRECHECK_STEP: reboteBodyPrecheckStep(config.verificacion?.cuerpoPR),
    // A bounce fixes the class of each finding, not only the line the reviewer named.
    DEFECT_CLASS_STEP: reviewBlockers.length > 0 ? '\n- For each review finding, name its defect class, fix every instance of that class in the diff, not only the reported line, and say in your PR comment which other instances of that class you checked.' : '',
    FANOUT_INSTRUCTIONS: fanoutInstructions(agent, nota, true),
    NOTE_SECTION: nota ? `\n## Extra notes from main\n\n${nota.trim()}\n` : '',
  }), profile)
  if (!dryRun) {
    io.mkdirp(path.dirname(briefPath))
    io.writeFile(briefPath, brief)
    // "declined lo propio, granted si pide main": only main's RDD request on this head grants it.
    if (consent === 'politica') writeRddConsent(io, worktree, rdd ? [sha] : [])
  }
  say(`${dryRun ? '[simulaci\u00F3n] ' : ''}brief -> ${briefPath}`)
  await launchInWorktree({ agent, mode: 'ticket', worktree, briefPath, brief, session, config, win: io.win, home: io.home, skills, piModel: profile?.model, piThinking: profile?.thinking, repositoryRoot: root, io, dryRun, piSessionAfter: agent === 'pi' ? (io.now ?? Date.now)() : 0, issue, supervised: bounceTask(repo, issue, agent, n) })
  if (rdd) say(`${dryRun ? '[simulación] ' : ''}RDD: ${sha} (${lenses.join(', ')})`)
  if (!dryRun) {
    const markerPath = path.join(io.home, 'orca', 'briefs', `${stem}-comment.md`)
    // The RDD marker is main's request, the only one estado accepts an RDD review of pi's own PR for (#338, #391).
    const markersToPost = rdd ? [`RDD: ${sha} (${lenses.join(', ')})`] : [reviewBlockers.length > 0 ? `Rebote: ${sha}` : null, reviewBlockers.length > 0 ? `Ronda: ${round}` : null, failedChecks.length > 0 ? `Rebote CI: ${sha}` : null, conflict ? `Rebote conflicto: ${sha}` : null].filter(Boolean)
    io.writeFile(markerPath, `${markersToPost.join('\n')}\n`)
    // The author is already running: a lost marker would let the next rebote bounce again, so retry and then fail loud.
    // A retry after a comment that did post only duplicates the marker, which every counter reads as a set.
    let posted = false
    for (let attempt = 1; attempt <= MARKER_ATTEMPTS && !posted; attempt++) {
      if (attempt > 1) await io.sleep(MARKER_RETRY_WAIT_MS)
      const res = io.sh('gh', ['pr', 'comment', String(n), '--body-file', markerPath], { cwd: root })
      posted = res.status === 0
      if (!posted) say(`gh pr comment falló (intento ${attempt} de ${MARKER_ATTEMPTS}): ${(res.stderr || res.stdout || String(res.error)).trim().split(/\r?\n/)[0]}`)
    }
    if (!posted) {
      throw new Error([
        `El autor ya está relanzado en ${worktree}, pero no pude publicar el marcador del rebote en el PR #${n} tras ${MARKER_ATTEMPTS} intentos.`,
        'Marcador:',
        ...markersToPost,
        `Archivo del marcador: ${markerPath}`,
        'Publicalo con:',
        // Quoted for main's shell (PowerShell on Windows): a home with spaces or `$` must stay one argument.
        `gh pr comment ${n} --body-file ${(io.win ? psQuote : shQuote)(markerPath)}`,
        `main tiene que publicarlo antes de cualquier otro rebote o merge del PR #${n}.`,
      ].join('\n'))
    }
  }
  if (reviewBlockers.length > 0) {
    say(`${dryRun ? '[simulaci\u00F3n] ' : ''}Rebote: ${sha}`)
    say(`${dryRun ? '[simulaci\u00F3n] ' : ''}Ronda: ${round}`)
    // Only printed, never posted: the contract's signal is for main, and it does not stop this bounce.
    if (round >= 2) say(`${dryRun ? '[simulaci\u00F3n] ' : ''}Ronda ${round} de review con bloqueos: el contrato pide un swarm de diagn\u00F3stico desde la segunda ronda o el segundo bounce del mismo hallazgo (MAIN.md, Arena y swarm, Se\u00F1ales); este rebote sigue igual.`)
  }
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
