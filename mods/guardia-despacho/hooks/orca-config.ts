// Config resolution shared by the orca-stack mods. A plugin can only import files of its own folder,
// so this file is copied verbatim into each mod that needs it (hooks/orca-config.ts); the repo's
// tests fail if a copy drifts from this one (edit shared/orca-config.ts, then run `npm run sync-shared`).
//
// Three layers, later ones override earlier ones:
//   1. ~/.orca-stack/config.json        (personal)
//   2. <repo>/.orca-stack.json          (committed project rules)
//   3. <repo>/.orca-stack.local.json    (gitignored, local/sensitive)
// <repo> is the main checkout, even when the session runs inside a git worktree.

export type StackConfig = {
  humano?: string
  mensajes?: { destinatarios?: string[] }
  despacho?: { script?: string; revisar?: string }
  riesgo?: string[] // path globs whose change needs a second review before merging (pi, or two other model families when pi wrote it)
  guardia?: {
    bloquear?: { agente: string; hasta: string; motivo?: string }[]
    modeloClaude?: string
  }
}

// The stack's agents and the model each one runs on. Two agents of one family share blind spots, so they do not
// count as two independent reviews. pi runs on a Claude account. src/despacho.mjs keeps its own AGENTS and codex
// family list; the repo's tests check that they agree with this table.
export const MODEL_FAMILY: Record<string, string> = {
  claude: 'claude',
  pi: 'claude',
  codex: 'codex',
  'codex-cc': 'codex',
  agy: 'agy',
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// Plain objects merge key by key; anything else (arrays included) is replaced by the later layer.
export const mergeConfig = (...layers: unknown[]): StackConfig => {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!isPlain(layer)) {
      continue
    }
    for (const [key, value] of Object.entries(layer)) {
      const before = out[key]
      out[key] = isPlain(value) && isPlain(before) ? mergeConfig(before, value) : value
    }
  }

  return out as StackConfig
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
