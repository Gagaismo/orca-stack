import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LEGACY_BEGIN, PINNED, PI_PACKAGES, PROJECT_CONFIG, PROJECT_LOCAL_CONFIG, WRAPPERS } from './constants.mjs'
import { loadState } from './ctx.mjs'
import { stackVars } from './global.mjs'
import { orcaDataDir, orcaInstalled, readOrcaOverrides } from './orca.mjs'
import { installedPackageVersion, piBinary, piModulesDir, piVersion, resolveGentleSkills } from './pi.mjs'
import { parseSettings } from './settings.mjs'
import { assetPath, listDirs, wrapperFile } from './templates.mjs'
import { PACKAGE_ROOT, homeDir, isWindows, layout, run, samePath, tilde, which } from './util.mjs'

const ICON = { ok: '✔', warn: '⚠', fail: '✖' }
const AUTH_ERROR = /\/login|no api key|not logged|unauthori[sz]ed|\b401\b|invalid api key|authentication|credential|no models? available|no provider/i

export const doctorCommand = async flags => {
  const home = homeDir()
  const L = layout(home)
  const results = []
  const add = (level, label, detail = '') => {
    results.push({ level, label, detail })
    console.log(`  ${ICON[level]} ${label}${detail ? ` - ${detail}` : ''}`)
  }
  const section = title => console.log(`\n${title}`)

  console.log(`orca-stack doctor\nHome: ${home}${flags.offline ? '  (modo --offline: sin sondeos de red)' : ''}`)

  // Install state
  section('Instalación')
  const state = loadState(home)
  if (state) {
    add('ok', 'estado de instalación', `${tilde(L.state, home)} (orca-stack ${state.version})`)
  } else {
    add('fail', 'estado de instalación', 'no hay state.json: corré `orca-stack global`')
  }

  // Policy docs
  section('Política del stack')
  for (const name of ['ORCA-STACK.md', 'ROLE-BRIEFS.md']) {
    const file = path.join(L.stackDir, name)
    if (!existsSync(file)) {
      add('fail', name, `falta ${tilde(file, home)}`)
    } else if (/\{\{[A-Z_]+\}\}/.test(readFileSync(file, 'utf8'))) {
      add('fail', name, 'tiene marcadores {{...}} sin reemplazar: volvé a correr `global`')
    } else {
      add('ok', name)
    }
  }

  // Wrappers: run their self-test for real.
  section('Wrappers de proveedores')
  const win = isWindows()
  const vars = stackVars(L)
  for (const agent of Object.keys(WRAPPERS)) {
    const file = path.join(L.scriptsDir, wrapperFile(agent, win))
    if (!existsSync(file)) {
      add('fail', `${agent}-orca-stack`, `falta ${tilde(file, home)}`)
      continue
    }
    const probe = run(file, ['--orca-stack-self-test'], { timeout: 20_000 })
    const policy = /ORCA_STACK_POLICY_PATH=(.+)/.exec(probe.stdout)?.[1]?.trim()
    const healthy =
      probe.status === 0 &&
      /ORCA_STACK_MODE=auto/.test(probe.stdout) &&
      /ORCA_STACK_CAVEMAN_LEVEL=full/.test(probe.stdout) &&
      /ORCA_STACK_PONYTAIL_LEVEL=full/.test(probe.stdout) &&
      policy &&
      existsSync(policy)
    if (healthy) {
      add('ok', `${agent}-orca-stack --orca-stack-self-test`, 'marcadores y política OK')
    } else {
      add('fail', `${agent}-orca-stack --orca-stack-self-test`, probe.error ? probe.error.message : `salida ${probe.status}; ${probe.stderr.trim().split('\n')[0] ?? ''}`)
    }
    const real = WRAPPERS[agent][win ? 'windows' : 'posix'].some(name => which(name))
    if (!real) {
      add('warn', `binario real de ${agent}`, `${WRAPPERS[agent][win ? 'windows' : 'posix'].join(' / ')} no está en el PATH`)
    }
  }

  // Skills
  section('Skills')
  for (const root of [L.claudeSkills, L.agentsSkills]) {
    const missing = listDirs(assetPath('skills')).filter(name => !existsSync(path.join(root, name, 'SKILL.md')))
    if (missing.length === 0) {
      add('ok', tilde(root, home), `${listDirs(assetPath('skills')).length} skills`)
    } else {
      add('fail', tilde(root, home), `faltan: ${missing.join(', ')}`)
    }
  }

  // Mods + settings
  section('Mods de Claude Code')
  let pluginDirs = []
  let settingsOk = true
  if (existsSync(L.settings)) {
    try {
      const raw = parseSettings(readFileSync(L.settings, 'utf8'), L.settings).env?.CLAUDE_CODE_PLUGIN_DIRS
      pluginDirs = typeof raw === 'string' ? raw.split(path.delimiter).filter(Boolean) : []
    } catch (error) {
      settingsOk = false
      add('fail', 'settings.json', error.message)
    }
  } else {
    add('fail', 'settings.json', `falta ${tilde(L.settings, home)}`)
    settingsOk = false
  }
  for (const name of listDirs(path.join(PACKAGE_ROOT, 'mods'))) {
    const dir = path.join(L.modsDir, name)
    const files = existsSync(path.join(dir, '.claude-plugin', 'plugin.json')) && existsSync(path.join(dir, 'hooks', 'hooks.json'))
    if (!files) {
      add('fail', name, `carpeta incompleta o ausente (${tilde(dir, home)})`)
    } else if (settingsOk && !pluginDirs.some(entry => samePath(entry, dir))) {
      add('fail', name, 'no está en env.CLAUDE_CODE_PLUGIN_DIRS de settings.json')
    } else {
      add('ok', name)
    }
  }
  if (existsSync(L.claudeMd)) {
    const has = readFileSync(L.claudeMd, 'utf8').includes('<!-- orca-stack:begin -->')
    add(has ? 'ok' : 'fail', 'bloque orca-stack en ~/.claude/CLAUDE.md', has ? '' : 'falta: corré `global`')
  } else {
    add('fail', '~/.claude/CLAUDE.md', 'no existe')
  }

  // Pi
  section('Pi (Gentle Shell)')
  const bin = flags.skipPi ? null : piBinary(L)
  if (flags.skipPi) {
    add('warn', 'Pi', 'omitido por --skip-pi')
  } else if (!bin) {
    add('fail', 'pi', 'no está instalado (ver `orca-stack global` para el comando oficial)')
  } else {
    const version = piVersion(bin)
    add(version === PINNED.pi ? 'ok' : 'warn', `pi ${version ?? '(versión ilegible)'}`, version === PINNED.pi ? tilde(bin, home) : `el stack se probó con ${PINNED.pi}`)
    for (const pkg of PI_PACKAGES) {
      const have = installedPackageVersion(piModulesDir(L), pkg.name)
      if (have === null) {
        add('fail', `${pkg.name}`, `no está instalado en Pi (esperado ${pkg.version})`)
      } else {
        add(have === pkg.version ? 'ok' : 'warn', `${pkg.name} ${have}`, have === pkg.version ? '' : `esperado ${pkg.version}`)
      }
    }
    add(which('gentle-shell') ? 'ok' : 'warn', 'comando gentle-shell', which('gentle-shell') ? '' : 'falta `npm i -g gentle-pi@' + PINNED.gentlePi + '`')
    const skills = resolveGentleSkills(L)
    if (skills) {
      add('ok', 'skills de gentle-pi (como las resuelve puente-gentle)', `${tilde(skills.dir, home)} [${skills.source}]`)
    } else {
      add('fail', 'skills de gentle-pi', 'no se encuentran ni en Pi ni en `npm root -g`: puente-gentle consultaría sin skills')
    }
    if (flags.offline) {
      add('warn', 'login de Pi', 'no se sondeó (--offline)')
    } else {
      const probe = run(bin, ['-p', 'Respondé solo con la palabra: ok', '--no-session'], { cwd: os.tmpdir(), timeout: 90_000 })
      const text = `${probe.stdout}\n${probe.stderr}`
      if (probe.timedOut) {
        add('warn', 'login de Pi', 'el sondeo tardó más de 90 s; probá `pi` a mano')
      } else if (probe.status === 0 && probe.stdout.trim() !== '') {
        add('ok', 'login de Pi', 'pi -p respondió')
      } else if (AUTH_ERROR.test(text)) {
        add('fail', 'login de Pi', 'falta conectar una cuenta: abrí `pi` y corré /login')
      } else {
        add('warn', 'login de Pi', `sondeo sin respuesta clara (salida ${probe.status}): ${text.trim().split('\n')[0]?.slice(0, 120)}`)
      }
    }
  }

  // External tools
  section('Herramientas externas')
  for (const [name, hint] of [
    ['engram', 'memoria persistente'],
    ['gentle-ai', 'sincroniza los agentes'],
  ]) {
    add(which(name) ? 'ok' : 'warn', name, which(name) ? '' : `no se encontró (${hint})`)
  }
  if (which('gh')) {
    const auth = flags.offline ? null : run(which('gh'), ['auth', 'status'], { timeout: 20_000 })
    add(auth === null || auth.status === 0 ? 'ok' : 'warn', 'gh', auth === null ? '' : auth.status === 0 ? 'autenticado' : 'sin sesión: `gh auth login`')
  } else {
    add('warn', 'gh', 'no se encontró (el tablero de PRs lo usa)')
  }

  // Orca (read-only)
  section('Orca')
  if (!orcaInstalled(home)) {
    add('warn', 'Orca', `no se detectó (${tilde(orcaDataDir(home), home)})`)
  } else {
    const profiles = readOrcaOverrides(home)
    if (!profiles || profiles.length === 0) {
      add('warn', 'Orca', 'instalado, pero sin perfiles legibles')
    }
    for (const { profile, overrides } of profiles ?? []) {
      if (overrides === null) {
        add('warn', `perfil ${profile}`, 'orca-data.json ilegible')
        continue
      }
      for (const [agent, def] of Object.entries(WRAPPERS)) {
        const expected = vars[`WRAPPER_${agent.toUpperCase()}`]
        const actual = overrides[def.orcaKey]
        if (typeof actual === 'string' && samePath(actual, expected)) {
          add('ok', `Orca [${profile}] ${def.orcaKey}`, 'apunta al wrapper')
        } else {
          add('warn', `Orca [${profile}] ${def.orcaKey}`, `${actual ? `apunta a ${actual}` : 'sin override'}; esperado ${expected}`)
        }
      }
    }
  }

  // Config layers
  section('Config')
  const checkJson = (file, label) => {
    if (!existsSync(file)) {
      return null
    }
    try {
      const data = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
      add('ok', label)

      return data
    } catch (error) {
      add('fail', label, `JSON inválido: ${error.message}`)

      return null
    }
  }
  const personal = checkJson(L.config, '~/.orca-stack/config.json')
  if (personal === null && !existsSync(L.config)) {
    add('warn', '~/.orca-stack/config.json', 'no existe (corré `global`)')
  } else if (personal && !personal.humano) {
    add('warn', 'humano', 'vacío en config.json: puente-gentle dirá "el usuario"')
  }
  const root = projectRootOf(process.cwd())
  if (root) {
    const committed = checkJson(path.join(root, PROJECT_CONFIG), PROJECT_CONFIG)
    const local = checkJson(path.join(root, PROJECT_LOCAL_CONFIG), PROJECT_LOCAL_CONFIG)
    // Same layering as the mods' mergeConfig: objects merge key by key, anything else (null included) replaces.
    const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const despacho = [personal, committed, local].reduce((acc, layer) => {
      const value = layer?.despacho
      if (value === undefined) {
        return acc
      }

      return isPlain(acc) && isPlain(value) ? { ...acc, ...value } : value
    }, undefined)
    for (const key of ['script', 'revisar']) {
      const rel = isPlain(despacho) ? despacho[key] : undefined
      if (typeof rel === 'string' && !existsSync(path.join(root, rel))) {
        add('warn', `despacho.${key}`, `${rel} no existe en el proyecto`)
      }
    }
    for (const { label, detail } of projectWarnings(root, committed)) {
      add('warn', label, detail)
    }
  }

  const fails = results.filter(r => r.level === 'fail').length
  const warns = results.filter(r => r.level === 'warn').length
  console.log(`\n${results.length - fails - warns} bien, ${warns} avisos, ${fails} fallas`)

  return fails > 0 ? 1 : 0
}

// Project-level warnings: a legacy pointer block still in place, or a setup nobody has finished.
export const projectWarnings = (root, config) => {
  const found = []
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(root, name)
    if (existsSync(file) && readFileSync(file, 'utf8').includes(LEGACY_BEGIN)) {
      found.push({ label: `${name}: bloque orca-stack viejo`, detail: '`orca-stack init` lo migra y además agrega el contrato de trabajo completo a AGENTS.md; si no querés ese cambio, no lo corras' })
    }
  }
  if (config && typeof config === 'object' && config.setup !== 'completo') {
    found.push({
      label: `${PROJECT_CONFIG}: setup pendiente`,
      detail: 'abrí una sesión de Claude en el checkout principal: va a ofrecer el setup (`orca-setup`)',
    })
  }

  return found
}

const projectRootOf = cwd => {
  const git = which('git')
  if (!git) {
    return null
  }
  const result = run(git, ['rev-parse', '--git-common-dir', '--show-toplevel'], { cwd, timeout: 10_000, env: process.env })
  if (result.status !== 0) {
    return null
  }
  const [common, top] = result.stdout.trim().split(/\r?\n/)
  const dir = path.resolve(cwd, common)

  return path.basename(dir) === '.git' ? path.dirname(dir) : path.resolve(top)
}
