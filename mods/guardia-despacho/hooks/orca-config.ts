// Config resolution shared by the orca-stack mods. A plugin can only import files of its own folder,
// so this file is copied verbatim into each mod that needs it (hooks/orca-config.ts); the repo's
// tests fail if a copy drifts from this one (edit shared/orca-config.ts, then run `npm run sync-shared`).
//
// Three layers, later ones override earlier ones:
//   1. ~/.orca-stack/config.json        (personal)
//   2. <repo>/.orca-stack.json          (committed project rules)
//   3. <repo>/.orca-stack.local.json    (gitignored, local/sensitive)
// <repo> is the main checkout, even when the session runs inside a git worktree.

export type BlockRule = { agente: string; hasta: string; motivo?: string }

export type StackConfig = {
  humano?: string
  mensajes?: { destinatarios?: string[] }
  despacho?: { script?: string; revisar?: string }
  riesgo?: string[] // path globs whose change needs a second review before merging (pi, or two other model families when pi wrote it)
  agentes?: { usa?: string[]; preguntarAntes?: string[]; modelos?: Record<string, unknown> }
  guardia?: {
    bloquear?: BlockRule[]
    modeloClaude?: string
  }
}

// Model families. Two agents whose models share a family share blind spots: one does not review the other, and
// they do not count as two independent reviews. The family comes from the model in `agentes.modelos` (the one the
// launcher passes with --model): its name, without the provider prefix, against `patterns`, in order. An agent
// with no model takes `defaults`; pi is `fixed`, because its launcher never passes a model. A model that matches
// no pattern has no family: nothing is proved about it.
// The literal between the markers is JSON: src/despacho.mjs keeps the same one, and test/units.test.mjs compares them.
// BEGIN FAMILIES
export const FAMILIES = {
  "agents": ["claude", "agy", "codex", "codex-cc", "pi"],
  "fixed": { "pi": "claude" },
  "defaults": { "claude": "claude", "codex": "gpt", "agy": "gemini" },
  "patterns": [
    ["claude", "^(claude|opus|sonnet|haiku|fable)\\b"],
    ["gpt", "^(gpt|codex|o\\d)"],
    ["gemini", "^gemini"],
    ["glm", "^glm"]
  ]
} as const
// END FAMILIES

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const familyOfModel = (model: string): string | undefined => {
  const name = model.trim().toLowerCase().split('/').pop() ?? ''

  return FAMILIES.patterns.find(([, pattern]) => new RegExp(pattern).test(name))?.[0]
}

// agentes.modelos.<agent>: "model", { modelo, esfuerzo } or { implementar: {...}, revisar: {...} } (as src/despacho.mjs).
export const modelFor = (config: StackConfig, agent: string, mode: 'ticket' | 'review'): string | undefined => {
  let entry = config.agentes?.modelos?.[agent]
  if (isPlain(entry) && (entry['implementar'] !== undefined || entry['revisar'] !== undefined)) {
    entry = entry[mode === 'review' ? 'revisar' : 'implementar']
  }
  const model = typeof entry === 'string' ? entry : isPlain(entry) ? entry['modelo'] : undefined

  return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined
}

// The family `agent` runs on to implement ('ticket') or to review; `model` is the configured one, for messages.
export const familyOf = (
  config: StackConfig,
  agent: string,
  mode: 'ticket' | 'review',
): { family: string | undefined; model: string | undefined } => {
  const fixed = (FAMILIES.fixed as Record<string, string>)[agent]
  if (fixed !== undefined) {
    return { family: fixed, model: undefined }
  }
  const model = modelFor(config, agent, mode)

  return { family: model === undefined ? (FAMILIES.defaults as Record<string, string>)[agent] : familyOfModel(model), model }
}

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

// Why `agent` cannot be dispatched now, or undefined. A rule with a bad date stops it too: a block must not
// vanish because of a typo.
export const blockOf = (config: StackConfig, agent: string, now: number): string | undefined => {
  for (const rule of config.guardia?.bloquear ?? []) {
    if (typeof rule?.agente !== 'string' || rule.agente.toLowerCase() !== agent.toLowerCase()) {
      continue
    }
    const until = typeof rule.hasta === 'string' ? parseUntil(rule.hasta) : undefined
    if (until === undefined) {
      return `La regla guardia.bloquear de ${agent} tiene una fecha "hasta" que no es AAAA-MM-DD (${String(rule.hasta)}): corregila antes de despacharlo.`
    }
    if (now < until) {
      return typeof rule.motivo === 'string' && rule.motivo.trim() !== '' ? rule.motivo : `${agent} está bloqueado hasta el ${rule.hasta}.`
    }
  }

  return undefined
}

// Plain objects merge key by key; anything else (arrays included) is replaced by the later layer.
const mergePlain = (...layers: unknown[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!isPlain(layer)) {
      continue
    }
    for (const [key, value] of Object.entries(layer)) {
      const before = out[key]
      out[key] = isPlain(value) && isPlain(before) ? mergePlain(before, value) : value
    }
  }

  return out
}

// One exception: `guardia.bloquear` adds up across the layers, so a block in one layer cannot be dropped by another.
export const mergeConfig = (...layers: unknown[]): StackConfig => {
  const out = mergePlain(...layers) as StackConfig
  const rules = layers.flatMap(layer => {
    const guardia = isPlain(layer) ? layer['guardia'] : undefined
    const list = isPlain(guardia) ? guardia['bloquear'] : undefined

    return Array.isArray(list) ? (list as BlockRule[]) : []
  })
  if (rules.length > 0) {
    out.guardia = { ...out.guardia, bloquear: rules }
  }

  return out
}

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

const slashed = (path: string): string => {
  let out = path.split('\\').join('/')
  while (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1)
  }

  return out
}

// Output of `git rev-parse --path-format=absolute --git-common-dir --show-toplevel`:
// the main checkout is the parent of the common `.git` dir; a bare repo falls back to the toplevel.
export const repoRootFrom = (stdout: string): string | undefined => {
  const [common, top] = stdout.split(/\r?\n/).map(line => line.trim())
  if (common !== undefined && common !== '') {
    const dir = slashed(common)
    if (dir.endsWith('/.git')) {
      return dir.slice(0, -'/.git'.length)
    }
  }

  return top === undefined || top === '' ? undefined : slashed(top)
}

// The engine's `$` cannot cross an import, so the host passes the few operations this module needs
// as closures: { home: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')), exists: p => $.fs.exists(p), read: p => $.fs.read(p),
// git: argv => $.process.run(argv, { timeoutMs: 10_000 }), now: () => $.clock.now() }.
export type Host = {
  home: () => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  git: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>
  now: () => Promise<number>
}

export const homeOf = async (host: Host): Promise<string | undefined> => {
  let home: string | undefined
  try {
    home = await host.home()
  } catch {
    home = undefined
  }

  return home === undefined || home === '' ? undefined : slashed(home)
}

const readLayer = async (host: Host, path: string): Promise<unknown> => {
  try {
    if (!(await host.exists(path))) {
      return undefined
    }

    return parseJson(await host.read(path))
  } catch {
    return undefined
  }
}

export const repoRoot = async (host: Host): Promise<string | undefined> => {
  try {
    const git = await host.git(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])

    return git.exitCode === 0 ? repoRootFrom(git.stdout) : undefined
  } catch {
    return undefined
  }
}

const loadFor = async (host: Host, home: string | undefined, root: string | undefined): Promise<StackConfig> =>
  mergeConfig(
    home === undefined ? undefined : await readLayer(host, `${home}/.orca-stack/config.json`),
    root === undefined ? undefined : await readLayer(host, `${root}/.orca-stack.json`),
    root === undefined ? undefined : await readLayer(host, `${root}/.orca-stack.local.json`),
  )

// Never throws: a missing or broken layer is skipped.
export const loadConfig = async (host: Host): Promise<StackConfig> =>
  loadFor(host, await homeOf(host), await repoRoot(host))

// loadConfig with a short memory, for hooks that run on every tool call. The memory is keyed by the
// resolved home and repo root, so switching to another checkout never serves the previous one's rules.
let remembered: { key: string; at: number; config: StackConfig } | undefined

export const currentConfig = async (host: Host, maxAgeMs = 30_000): Promise<StackConfig> => {
  const home = await homeOf(host)
  const root = await repoRoot(host)
  const key = `${home ?? ''}|${root ?? ''}`
  const now = await host.now()
  if (remembered !== undefined && remembered.key === key && now - remembered.at < maxAgeMs) {
    return remembered.config
  }
  const config = await loadFor(host, home, root)
  remembered = { key, at: now, config }

  return config
}

export const forgetConfig = (): void => {
  remembered = undefined
}
