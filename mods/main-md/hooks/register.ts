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

// Claude Code caps each additionalContext string at 10,000 characters and past it hands the model a 2,000-character
// preview and a path (https://code.claude.com/docs/en/hooks, "JSON output"). MAIN.md is about 23,000: the ticket's
// fallback sends the steps of `### Ciclo de main` instead, cut at line ends into entries that stay under the cap.
const CHUNK = 9_500
const CYCLE = '### Ciclo de `main`'

const cycleOf = (doc: string): string | undefined => {
  const lines = doc.replace(/\r\n/g, '\n').split('\n')
  const first = lines.findIndex(line => line.trim() === CYCLE)
  if (first === -1) return undefined
  const after = lines.slice(first + 1).findIndex(line => /^#{1,3} /.test(line))
  const end = after === -1 ? lines.length : first + 1 + after

  return lines.slice(first, end).join('\n').trimEnd()
}

const chunks = (text: string): string[] => {
  const out: string[] = []
  let rest = text
  while (rest.length > CHUNK) {
    const cut = rest.lastIndexOf('\n', CHUNK)
    if (cut <= 0) {
      out.push(rest.slice(0, CHUNK))
      rest = rest.slice(CHUNK)
    } else {
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut + 1)
    }
  }

  return [...out, rest]
}

const textsFor = (path: string, doc: string | undefined): string[] => {
  if (doc === undefined) return [`main-md: no se pudo leer \`${path}\`; seguí el puntero a MAIN.md del contrato.`]
  const cycle = cycleOf(doc)
  if (cycle === undefined) {
    return [`main-md: \`${path}\` no tiene la sección \`${CYCLE}\`; seguí el puntero a MAIN.md del contrato.`]
  }
  const parts = chunks(cycle)

  return parts.map((part, i) => i === 0
    ? `Estos son los pasos de \`${CYCLE}\` de \`${path}\`, el mismo MAIN.md al que apunta el contrato de AGENTS.md; el resto de sus secciones está en ese archivo.\n\n${part}`
    : `main-md: sigue \`${CYCLE}\` de \`${path}\` (parte ${i + 1} de ${parts.length}).\n\n${part}`)
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
    const texts = textsFor(path, await readMainDoc($, path))

    return {
      ...result,
      additionalContext: [...(result.additionalContext ?? []), ...texts],
    }
  })
}
