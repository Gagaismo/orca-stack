import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { INSTALL_HINTS, MATT_MIN_VERSION, MATT_REQUIRED_SKILLS } from './constants.mjs'
import {
  blocksOf,
  carriesOddMandate,
  gentleTargets,
  isLazyBlock,
  planLazyFile,
  rddMode,
  readPersonalConfig,
  sddMode,
  trimReviewSections,
} from './gentle.mjs'
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
// saved copy is gone: SDD or ODD would have nothing to read).
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
  const mode = sddMode(readPersonalConfig(L))
  if (mode === null) {
    found.push({ label: 'gentle.sddOrchestrator', detail: 'en ~/.orca-stack/config.json tiene que ser "lazy" o "full"' })
  }
  for (const target of gentleTargets(L)) {
    const md = existsSync(target.file) ? readFileSync(target.file, 'utf8') : ''
    const lazy = blocksOf(target).filter(({ locate }) => isLazyBlock(locate(md)))
    for (const { copy } of lazy.filter(({ copy }) => !existsSync(copy))) {
      found.push({
        level: 'fail',
        label: 'bloque de gentle-ai en modo lazy sin su copia',
        detail: `falta ${copy}: el puntero de ${target.label} apunta a un archivo que no existe. Corré \`gentle-ai sync\` y después \`orca-stack global\``,
      })
    }
    // With RDD on (or unreadable) `global` keeps claude's and codex's blocks full on purpose: they carry the review contract.
    const keepFull = target.rdd && Boolean(gentle) && rdd.mode !== 'off'
    if (mode === 'lazy') {
      const plan = keepFull ? null : planLazyFile(md, target)
      if (lazy.length > 0 && keepFull) {
        found.push({ label: `bloque de gentle-ai en ${target.label}`, detail: 'está en modo lazy pero el RDD de gentle-ai no está apagado y necesita el contrato de review: corré `orca-stack global` para restaurarlo' })
      } else if (plan?.copies?.length > 0) {
        found.push({ label: `bloque de gentle-ai en ${target.label}`, detail: 'gentle-ai sync lo reescribió: corré `orca-stack global` (gentle.sddOrchestrator es "lazy")' })
      }
      // The ODD mandate left after global, and why global leaves it.
      const why = keepFull
        ? `sigue porque el RDD de gentle-ai está ${rdd.mode === 'on' ? 'prendido' : 'en un estado que no pude leer'}: el review necesita los commits de trabajo de ODD`
        : plan.skipped !== undefined
          ? `global no lo recorta: ${plan.skipped}`
          : plan.copies.length === 0
            ? 'está fuera de los bloques de gentle-ai que global recorta'
            : null
      if (carriesOddMandate(md) && why !== null) {
        found.push({ label: `mandato ODD de gentle-ai en ${target.label}`, detail: why })
      }
    } else if (mode === 'full' && lazy.length > 0) {
      found.push({ label: `bloque de gentle-ai en ${target.label}`, detail: 'sigue en modo lazy pero gentle.sddOrchestrator es "full": corré `orca-stack global` para restaurarlo' })
    }
  }
  const md = existsSync(L.claudeMd) ? readFileSync(L.claudeMd, 'utf8') : ''
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
