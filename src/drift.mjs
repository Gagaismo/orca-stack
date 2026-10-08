import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { INSTALL_HINTS, MATT_MIN_VERSION, MATT_REQUIRED_SKILLS } from './constants.mjs'
import { isLazyBlock, rddMode, readPersonalConfig, sddBlock, sddMode, trimReviewSections } from './gentle.mjs'
import { which } from './util.mjs'

const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

const parseVersion = text => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text))

  return match ? match.slice(1).map(Number) : null
}

// > 0 when a is newer than b.
export const compareVersions = (a, b) => {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) {
      return x[i] - y[i]
    }
  }

  return 0
}

// The newest installed entry of the Matt Pocock plugin, whatever marketplace it came from: { version, installPath }.
const installedMatt = L => {
  const plugins = readJson(path.join(L.claudeDir, 'plugins', 'installed_plugins.json'))?.plugins ?? {}
  const entries = Object.entries(plugins)
    .filter(([key]) => key.startsWith('mattpocock-skills@'))
    .flatMap(([, list]) => (Array.isArray(list) ? list : []))
    .filter(entry => parseVersion(entry?.version) !== null)

  return entries.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
}

// Skill names the plugin ships (basenames of the `skills` paths in its plugin.json).
const pluginSkills = installPath => {
  const manifest = typeof installPath === 'string' ? readJson(path.join(installPath, '.claude-plugin', 'plugin.json')) : null

  return Array.isArray(manifest?.skills) ? manifest.skills.map(entry => path.basename(String(entry))) : []
}

// Things that drifted from what the work contract expects. Each one is a warning, except `level: 'fail'` (a lazy block whose
// saved copy is gone: SDD would have nothing to read).
export const driftWarnings = L => {
  const found = []
  const matt = installedMatt(L)
  if (matt && compareVersions(matt.version, MATT_MIN_VERSION) < 0) {
    found.push({
      label: `mattpocock-skills ${matt.version}`,
      detail: `es anterior a ${MATT_MIN_VERSION} (le faltan \`pr\`, \`retro\`, \`implement-spec\`). ${INSTALL_HINTS.mattpocock.join('; ')}`,
    })
  }
  const shipped = matt ? pluginSkills(matt.installPath) : []
  const duplicated = shipped.filter(name => existsSync(path.join(L.claudeSkills, name)))
  if (duplicated.length > 0) {
    found.push({
      label: 'skills duplicadas en ~/.claude/skills',
      detail: `${duplicated.join(', ')} también las trae el plugin y quedan dos veces en el contexto: \`npx skills remove ${duplicated.join(' ')} -g -a claude-code -y\``,
    })
  }
  const missing = MATT_REQUIRED_SKILLS.filter(name => !existsSync(path.join(L.agentsSkills, name, 'SKILL.md')))
  if (missing.length > 0) {
    found.push({
      label: '~/.agents/skills',
      detail: `faltan ${missing.join(', ')} (agy y codex no las ven): ${INSTALL_HINTS.mattpocockAgents[0]}`,
    })
  }
  const gentle = which('gentle-ai')
  const md = existsSync(L.claudeMd) ? readFileSync(L.claudeMd, 'utf8') : ''
  const mode = sddMode(readPersonalConfig(L))
  const block = sddBlock(md)
  if (mode === null) {
    found.push({ label: 'gentle.sddOrchestrator', detail: 'en ~/.orca-stack/config.json tiene que ser "lazy" o "full"' })
  } else if (mode === 'lazy') {
    if (isLazyBlock(block) && !existsSync(L.sddCopy)) {
      found.push({
        level: 'fail',
        label: 'bloque de gentle-ai en modo lazy sin su copia',
        detail: `falta ${L.sddCopy}: el puntero de ~/.claude/CLAUDE.md apunta a un archivo que no existe. Corré \`gentle-ai sync\` y después \`orca-stack global\``,
      })
    } else if (block.status === 'ok' && !isLazyBlock(block)) {
      found.push({ label: 'bloque de gentle-ai en ~/.claude/CLAUDE.md', detail: 'gentle-ai sync lo reescribió: corré `orca-stack global` (gentle.sddOrchestrator es "lazy")' })
    }
  } else if (isLazyBlock(block)) {
    found.push({ label: 'bloque de gentle-ai en ~/.claude/CLAUDE.md', detail: 'sigue en modo lazy pero gentle.sddOrchestrator es "full": corré `orca-stack global` para restaurarlo' })
  }
  const trim = gentle && mode === 'full' ? trimReviewSections(md) : null
  if (trim && (trim.removed > 0 || trim.skipped !== undefined) && rddMode(gentle) === 'off') {
    found.push(
      trim.skipped === undefined
        ? {
            label: 'secciones de review de gentle-ai en ~/.claude/CLAUDE.md',
            detail: 'siguen presentes con RDD apagado y se cargan en cada sesión: corré `orca-stack global` de nuevo (gentle-ai sync las restaura)',
          }
        : {
            label: 'texto de gentle-ai en ~/.claude/CLAUDE.md',
            detail: `cambió de forma y el recorte de sus secciones de review está en pausa (no se toca nada): ${trim.skipped}`,
          },
    )
  }

  return found
}
