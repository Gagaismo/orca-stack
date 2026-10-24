// Pure helpers for the "which gentle-pi profile?" question (no engine access): spot a pi dispatch made with the
// orca-stack CLI, list the profiles to offer, and put `--perfil-pi <name>` into the command.

const SEPARATOR = /(&&|\|\||;|\||\r?\n)/
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'npm', 'pnpm', 'yarn', 'exec', 'dlx', 'node', 'env', 'time', '&'])

// Same shape gentle-pi accepts for a profile name; nothing else is ever offered or put into a command.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const unquote = (token: string): string => token.replace(/^['"]|['"]$/g, '')

// The only model providers a pi launch may use (the CLI refuses any other): Claude through the bridge or pi's
// Anthropic login, and OpenAI.
const PROVIDERS = ['claude-bridge/', 'anthropic/', 'openai/']
// AskUserQuestion takes 2-4 options.
export const MAX_OPTIONS = 4

export type ProfileOption = { label: string; name: string }

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const modelOf = (agent: unknown): string | undefined =>
  isPlain(agent) && typeof agent.model === 'string' && agent.model.trim() !== '' ? agent.model.trim() : undefined

// Every profile of the store (`{ profiles: { <name>: { orchestrator: { model }, <agent>: { model } } } }`) the CLI would
// launch, in store order: a safe name, an orchestrator model, and every model on an allowed provider.
export const launchableProfiles = (store: unknown): ProfileOption[] => {
  const profiles = isPlain(store) ? store.profiles : undefined
  if (!isPlain(profiles)) {
    return []
  }

  return Object.entries(profiles).flatMap(([name, profile]) => {
    const orchestrator = isPlain(profile) ? modelOf(profile.orchestrator) : undefined
    const models = isPlain(profile) ? Object.values(profile).map(modelOf).filter(model => model !== undefined) : []
    if (!SAFE_NAME.test(name) || orchestrator === undefined || !models.every(model => PROVIDERS.some(provider => model.startsWith(provider)))) {
      return []
    }

    return [{ name, label: `${name}: orquesta ${orchestrator}` }]
  })
}

// The profile an answer picks: a label, or (typed under "Other") the name of a launchable profile as it is.
export const chosenProfile = (answer: string, profiles: readonly ProfileOption[]): string | undefined => {
  const trimmed = answer.trim()

  return profiles.find(profile => profile.label === trimmed || profile.name === trimmed)?.name
}

// The config says which profile to use (a name or "global", not "preguntar"): the CLI reads it, so nobody asks.
export const configuredProfile = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() !== '' && value.trim().toLowerCase() !== 'preguntar'

// Offsets in `command` just after the agent token of every `orca-stack despachar|revisar <n> pi` that has no
// --perfil-pi and is not a --dry-run. The command word has to be orca-stack (or a runner such as npx given it), so
// an echo or a grep that mentions the command is left alone.
export const piDispatchSlots = (command: string): number[] => {
  const slots: number[] = []
  const parts = command.split(SEPARATOR)
  let offset = 0
  for (let p = 0; p < parts.length; p += 1) {
    const segment = parts[p] ?? ''
    if (p % 2 === 0) {
      const slot = slotOf(segment)
      if (slot !== undefined) {
        slots.push(offset + slot)
      }
    }
    offset += segment.length
  }

  return slots
}

const slotOf = (segment: string): number | undefined => {
  const tokens = [...segment.matchAll(/\S+/g)].map(match => ({ text: unquote(match[0]), end: (match.index ?? 0) + match[0].length }))
  let i = 0
  while (i < tokens.length && (ENV_ASSIGN.test(tokens[i]?.text ?? '') || tokens[i]?.text === '&')) {
    i += 1
  }
  const word = (tokens[i]?.text ?? '').split(/[\\/]/).pop() ?? ''
  const isCli = /^orca-stack(\.mjs|\.cmd|\.ps1)?$/i.test(word)
  const viaRunner = RUNNERS.has(word.toLowerCase()) && tokens.slice(i + 1).some(token => /orca-stack/i.test(token.text))
  if (!isCli && !viaRunner) {
    return undefined
  }
  const at = tokens.findIndex(token => token.text === 'despachar' || token.text === 'revisar')
  const number = tokens[at + 1]
  const agent = tokens[at + 2]
  if (at === -1 || number === undefined || agent === undefined || !/^\d+$/.test(number.text) || agent.text.toLowerCase() !== 'pi') {
    return undefined
  }
  if (tokens.some(token => /^--(perfil-pi|dry-run)\b/.test(token.text))) {
    return undefined
  }

  return agent.end
}

export const withProfile = (command: string, slots: readonly number[], name: string): string => {
  let out = command
  for (const slot of [...slots].sort((a, b) => b - a)) {
    out = `${out.slice(0, slot)} --perfil-pi ${name}${out.slice(slot)}`
  }

  return out
}
