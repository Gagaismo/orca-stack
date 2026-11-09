import type { EngineInterface, Register } from 'claude-code'

import { homeOf, mainCheckout } from './orca-config'
import type { Host } from './orca-config'

// A session start, a resume and a compaction leave the model without what it read once; a turn does not.
const SOURCES = ['startup', 'resume', 'compact']

// The engine's `$` cannot cross an import: the config module gets these closures instead.
const hostOf = ($: EngineInterface): Host => ({
  home: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  git: argv => $.process.run(argv, { timeoutMs: 10_000 }),
  now: () => $.clock.now(),
})

// The file the contract pointer names: MAIN.md beside the policy, which `ORCA_STACK_POLICY_PATH` can move.
const mainDocPath = async ($: EngineInterface, host: Host): Promise<string> => {
  let policy: string | undefined
  try {
    policy = await $.env.get('ORCA_STACK_POLICY_PATH')
  } catch {
    policy = undefined
  }
  if (policy !== undefined && policy.trim() !== '') {
    const slashed = policy.trim().replace(/\\/g, '/')

    return `${slashed.slice(0, slashed.lastIndexOf('/') + 1)}MAIN.md`
  }
  const home = await homeOf(host)

  return home === undefined ? '~/orca/stack/MAIN.md' : `${home}/orca/stack/MAIN.md`
}

const readMainDoc = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  try {
    return (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
  } catch {
    return undefined
  }
}

const hasSetup = async ($: EngineInterface, root: string): Promise<boolean> => {
  try {
    return await $.fs.exists(`${root}/.orca-stack.json`)
  } catch {
    return false
  }
}

export const register: Register = on => {
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (!SOURCES.includes(e.source)) return result
    const host = hostOf($)
    const root = await mainCheckout(host)
    if (root === undefined || !(await hasSetup($, root))) return result
    const path = await mainDocPath($, host)
    const doc = await readMainDoc($, path)
    const text = doc === undefined
      ? `main-md: no se pudo leer \`${path}\`; seguí el puntero a MAIN.md del contrato.`
      : `Este es el contenido de \`${path}\`, el mismo MAIN.md al que apunta el contrato de AGENTS.md: ya lo tenés, no lo vuelvas a leer.\n\n${doc}`

    return {
      ...result,
      additionalContext: [...(result.additionalContext ?? []), text],
    }
  })
}
