// Pure helpers for the "which gentle-pi profile?" question (no engine access): spot a pi dispatch made with the
// orca-stack CLI, list the profiles to offer, and put `--perfil-pi <name>` into the command.

import { piProfileProblem } from './orca-config'

const SEPARATOR = /(&&|\|\||;|\||\r?\n)/
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'npm', 'pnpm', 'yarn', 'exec', 'dlx', 'node', 'env', 'time', '&'])

const unquote = (token: string): string => token.replace(/^['"]|['"]$/g, '')

// AskUserQuestion takes 2-4 options.
export const MAX_OPTIONS = 4

export type ProfileOption = { label: string; name: string }

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const modelOf = (agent: unknown): string | undefined =>
  isPlain(agent) && typeof agent.model === 'string' && agent.model.trim() !== '' ? agent.model.trim() : undefined

// The profile the clone-local pin (`<git-common-dir>/gentle-ai/profile-pin.json`) declares, if any: gentle-pi gives it
// precedence over the worktree pin, so the CLI launches no other profile while it is there.
export const clonePinProfile = (pin: unknown): string | undefined =>
  isPlain(pin) && pin.kind === 'gentle-pi.agent_model_profile_pin' && typeof pin.profile === 'string' ? pin.profile : undefined

// Every profile of the store (`{ profiles: { <name>: { orchestrator: { model }, <agent>: { model } } } }`) the CLI would
// launch, in store order: the ones piProfileProblem (shared with the CLI) finds nothing wrong with and, with a clone
// pin, only the one it declares. Only those names are ever offered or put into a command.
export const launchableProfiles = (store: unknown, clonePin?: string): ProfileOption[] => {
  const profiles = isPlain(store) ? store.profiles : undefined
  if (!isPlain(profiles)) {
    return []
  }

  return Object.entries(profiles).flatMap(([name, profile]) => {
    const orchestrator = isPlain(profile) ? modelOf(profile.orchestrator) : undefined
    if (piProfileProblem(name, profile) !== undefined || orchestrator === undefined || (clonePin !== undefined && name !== clonePin)) {
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
