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
