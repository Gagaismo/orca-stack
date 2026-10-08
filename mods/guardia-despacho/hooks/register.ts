import type { EngineInterface, Register } from 'claude-code'

import { currentConfig, homeOf, parseJson } from './orca-config'
import type { Host, StackConfig } from './orca-config'
import { buildRules, checkRemovals, inspect } from './inspect'
import type { Shell } from './inspect'
import { chosenProfile, configuredProfile, piDispatchSlots, profileNames, profileOptions, withProfile } from './perfil-pi'

// The engine's `$` cannot cross an import: the config module gets these closures instead.
const hostOf = ($: EngineInterface): Host => ({
  home: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  git: argv => $.process.run(argv, { timeoutMs: 10_000 }),
  now: () => $.clock.now(),
})

// Ignored-rule notes are shown once per load, not on every command.
let noted = false

type Judgement = { deny: string } | { command: string } | undefined

// A pi dispatch made with the orca-stack CLI and no --perfil-pi: ask which gentle-pi profile the worktree gets and put
// the flag in the command, right after the agent. Anything that goes wrong (no store, dismissed, `-p`) leaves the command as is.
// With agentes.pi.perfil set to a name nobody is asked, and nothing is rewritten: the CLI reads that config itself.
const askProfile = async ($: EngineInterface, command: string, config: StackConfig): Promise<string> => {
  const slots = piDispatchSlots(command)
  if (slots.length === 0 || configuredProfile(config.agentes?.pi?.perfil)) {
    return command
  }
  try {
    const host = hostOf($)
    const home = await homeOf(host)
    const store = home === undefined ? undefined : `${home}/.pi/gentle-ai/profiles.json`
    if (store === undefined || !(await $.fs.exists(store))) {
      return command
    }
    const names = profileNames(parseJson(await $.fs.read(store)))
    const options = profileOptions(names)
    if (options.length < 2) {
      return command
    }
    const answer = await $.ui.ask('¿Qué perfil de modelos de gentle-pi uso para este despacho a Pi?', {
      options: options.map(option => option.label),
      header: 'Perfil Pi',
    })
    const name = chosenProfile(answer, options, names)

    return name === undefined ? command : withProfile(command, slots, name)
  } catch {
    return command
  }
}

const judge = async ($: EngineInterface, command: string, shell: Shell): Promise<Judgement> => {
  // Always on, with or without despacho: removing a worktree can destroy unpublished commits.
  const unsafe = await checkRemovals(command, argv => $.process.run(argv, { timeoutMs: 10_000 }))
  if (unsafe !== undefined) {
    return { deny: unsafe }
  }
  const config = await currentConfig(hostOf($))
  let current = command
  // OFF unless the project config declares `despacho`.
  const rules = buildRules(config)
  if (rules !== undefined) {
    if (rules.notes.length > 0 && !noted) {
      noted = true
      $.ui.toast(`guardia-despacho: ${rules.notes.join(' ')}`)
    }
    const verdict = inspect(command, await $.clock.now(), rules, shell)
    if (verdict.kind === 'deny') {
      return { deny: verdict.reason }
    }
    if (verdict.kind === 'rewrite') {
      $.ui.toast(`Agregué CLAUDE_MODELO=${rules.model ?? ''}`)
      current = verdict.command
    }
  }
  // Last, so a denied dispatch never asks anything.
  current = await askProfile($, current, config)

  return current === command ? undefined : { command: current }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const judgement = await judge($, e.command, 'bash')
    if (judgement === undefined) {
      return next(e)
    }

    return 'deny' in judgement ? judgement : next({ ...e, command: judgement.command })
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const judgement = await judge($, e.command, 'powershell')
    if (judgement === undefined) {
      return next(e)
    }

    return 'deny' in judgement ? judgement : next({ ...e, command: judgement.command })
  })
}
