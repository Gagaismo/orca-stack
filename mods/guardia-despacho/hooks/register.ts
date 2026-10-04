import type { EngineInterface, Register } from 'claude-code'

import { currentConfig } from './orca-config'
import type { Host } from './orca-config'
import { buildRules, inspect } from './inspect'
import type { Shell } from './inspect'

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

const judge = async ($: EngineInterface, command: string, shell: Shell): Promise<Judgement> => {
  // OFF unless the project config declares `despacho`.
  const rules = buildRules(await currentConfig(hostOf($)))
  if (rules === undefined) {
    return undefined
  }
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

    return { command: verdict.command }
  }

  return undefined
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
