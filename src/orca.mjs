import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { which } from './util.mjs'

// Where the Orca desktop app keeps its data. Read-only: this tool never writes there.
export const orcaDataDir = home => {
  if (process.env.ORCA_STACK_ORCA_DIR) {
    return process.env.ORCA_STACK_ORCA_DIR
  }
  const real = !process.env.ORCA_STACK_HOME
  if (process.platform === 'win32') {
    return path.join(real ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming') : path.join(home, 'AppData', 'Roaming'), 'orca')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'orca')
  }

  return path.join(real ? process.env.XDG_CONFIG_HOME || path.join(home, '.config') : path.join(home, '.config'), 'orca')
}

export const orcaInstalled = home => Boolean(which('orca')) || existsSync(orcaDataDir(home))

// The agent command overrides of every Orca profile: [{ profile, overrides: { claude, codex, antigravity } }].
export const readOrcaOverrides = home => {
  const profiles = path.join(orcaDataDir(home), 'profiles')
  if (!existsSync(profiles)) {
    return null
  }
  const found = []
  for (const name of readdirSync(profiles)) {
    const file = path.join(profiles, name, 'orca-data.json')
    if (!existsSync(file)) {
      continue
    }
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      found.push({ profile: name, overrides: data?.settings?.agentCmdOverrides ?? {} })
    } catch {
      found.push({ profile: name, overrides: null })
    }
  }

  return found
}
