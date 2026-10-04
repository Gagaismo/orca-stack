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
  guardia?: {
    bloquear?: { agente: string; hasta: string; motivo?: string }[]
    modeloClaude?: string
  }
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
  const home = await host.home()

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

// Never throws: a missing or broken layer is skipped.
export const loadConfig = async (host: Host): Promise<StackConfig> => {
  const home = await homeOf(host)
  const root = await repoRoot(host)

  return mergeConfig(
    home === undefined ? undefined : await readLayer(host, `${home}/.orca-stack/config.json`),
    root === undefined ? undefined : await readLayer(host, `${root}/.orca-stack.json`),
    root === undefined ? undefined : await readLayer(host, `${root}/.orca-stack.local.json`),
  )
}

// loadConfig with a short memory, for hooks that run on every tool call.
let remembered: { at: number; config: StackConfig } | undefined

export const currentConfig = async (host: Host, maxAgeMs = 30_000): Promise<StackConfig> => {
  const now = await host.now()
  if (remembered !== undefined && now - remembered.at < maxAgeMs) {
    return remembered.config
  }
  const config = await loadConfig(host)
  remembered = { at: now, config }

  return config
}

export const forgetConfig = (): void => {
  remembered = undefined
}
