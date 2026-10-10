import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { INSTALL_HINTS, MATT_MIN_VERSION, MATT_REQUIRED_SKILLS } from './constants.mjs'
import { hasLegacyOrchestratorMode, isLazyBlock, orchestratorMode, rddMode, readPersonalConfig, sddBlock, trimReviewSections } from './gentle.mjs'
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
// saved copy is gone: the coordinator would have nothing to read).
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
  const rdd = gentle ? rddMode(gentle) : { mode: 'off', source: null }
  const md = existsSync(L.claudeMd) ? readFileSync(L.claudeMd, 'utf8') : ''
  const config = readPersonalConfig(L)
  const mode = orchestratorMode(config)
  const hasNewMode = Object.hasOwn(config?.gentle ?? {}, 'orchestrator')
  if (hasLegacyOrchestratorMode(config)) {
    found.push({
      label: 'gentle.sddOrchestrator',
      detail: hasNewMode
        ? 'gentle.orchestrator gana sobre la clave antigua; borrá gentle.sddOrchestrator cuando puedas'
        : 'clave antigua: renombrá gentle.sddOrchestrator a gentle.orchestrator en ~/.orca-stack/config.json',
    })
  }
  const block = sddBlock(md)
  if (isLazyBlock(block)) {
    const hasCurrentCopy = existsSync(L.orchestratorCopy)
    const hasLegacyCopy = existsSync(L.legacyOrchestratorCopy)
    if (!hasCurrentCopy && hasLegacyCopy) {
      found.push({
        label: 'copia antigua del bloque de gentle-ai',
        detail: `existe ${L.legacyOrchestratorCopy}; corré \`orca-stack global\` para migrarla a ${L.orchestratorCopy}`,
      })
    } else if (!hasCurrentCopy) {
      found.push({
        level: 'fail',
        label: 'bloque de gentle-ai en modo lazy sin su copia',
        detail: `falta ${L.orchestratorCopy}: el puntero de ~/.claude/CLAUDE.md apunta a un archivo que no existe. Corré \`gentle-ai sync\` y después \`orca-stack global\``,
      })
    } else if (hasLegacyCopy) {
      found.push({
        label: 'copia antigua del bloque de gentle-ai',
        detail: `también existe ${L.legacyOrchestratorCopy}; corré \`orca-stack global\` para conservar la más nueva y respaldar la otra`,
      })
    }
  }
  if (mode === null) {
    found.push({ label: 'gentle.orchestrator', detail: 'en ~/.orca-stack/config.json tiene que ser "lazy" o "full"' })
  } else if (mode === 'lazy') {
    // With RDD on (or unreadable) `global` keeps the full block on purpose: it carries the review contract.
    const keepFull = Boolean(gentle) && rdd.mode !== 'off'
    if (isLazyBlock(block) && keepFull) {
      found.push({ label: 'bloque de gentle-ai en ~/.claude/CLAUDE.md', detail: 'está en modo lazy pero el RDD de gentle-ai no está apagado y necesita el contrato de review: corré `orca-stack global` para restaurarlo' })
    } else if (block.status === 'ok' && !isLazyBlock(block) && !keepFull) {
      found.push({ label: 'bloque de gentle-ai en ~/.claude/CLAUDE.md', detail: 'gentle-ai sync lo reescribió: corré `orca-stack global` (gentle.orchestrator es "lazy")' })
    }
  } else if (isLazyBlock(block)) {
    found.push({ label: 'bloque de gentle-ai en ~/.claude/CLAUDE.md', detail: 'sigue en modo lazy pero gentle.orchestrator es "full": corré `orca-stack global` para restaurarlo' })
  }
  const trim = gentle && mode === 'full' ? trimReviewSections(md) : null
  if (trim && (trim.removed > 0 || trim.skipped !== undefined) && rdd.mode === 'off') {
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
  if (rdd.mode === 'on' && rdd.source === 'default') {
    found.push({
      label: 'RDD de gentle-ai',
      detail: 'está prendido solo por defecto en gentle-ai v4: si no lo elegiste, corré `gentle-ai review mode disable` y después `orca-stack global`',
    })
  }

  return found
}
