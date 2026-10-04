import { chmodSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { INSTALL_HINTS, PROJECT_CONFIG, WRAPPERS } from './constants.mjs'
import { createCtx } from './ctx.mjs'
import { upsertBlock } from './marker.mjs'
import { orcaInstalled } from './orca.mjs'
import { setupPi } from './pi.mjs'
import { mergePluginDirs, parseSettings, stringifySettings } from './settings.mjs'
import {
  assetPath,
  listDirs,
  listFiles,
  policyBlock,
  readAsset,
  render,
  skipForMod,
  wrapperContent,
  wrapperFile,
} from './templates.mjs'
import { deepEqual, homeDir, isWindows, readTextIfExists, run, sha256, which } from './util.mjs'

const PKG_ROOT = path.resolve(assetPath(), '..')

export const stackVars = L => {
  const win = isWindows()

  return {
    POLICY_PATH: path.join(L.stackDir, 'ORCA-STACK.md'),
    BRIEFS_PATH: path.join(L.stackDir, 'ROLE-BRIEFS.md'),
    WRAPPER_CLAUDE: path.join(L.scriptsDir, wrapperFile('claude', win)),
    WRAPPER_CODEX: path.join(L.scriptsDir, wrapperFile('codex', win)),
    WRAPPER_AGY: path.join(L.scriptsDir, wrapperFile('agy', win)),
  }
}

const installPolicyDocs = ctx => {
  ctx.say('\nPolítica del stack')
  const vars = stackVars(ctx.L)
  for (const name of ['ORCA-STACK.md', 'ROLE-BRIEFS.md']) {
    ctx.writeOwned(path.join(ctx.L.stackDir, name), render(readAsset('stack', name), vars))
  }
}

const installWrappers = ctx => {
  ctx.say('\nWrappers de proveedores')
  const win = isWindows()
  for (const agent of Object.keys(WRAPPERS)) {
    const file = path.join(ctx.L.scriptsDir, wrapperFile(agent, win))
    ctx.writeOwned(file, wrapperContent(agent, win), { mode: win ? undefined : 0o755 })
    if (!win && !ctx.dryRun && existsSync(file)) {
      chmodSync(file, 0o755)
    }
  }
}

const installSkills = ctx => {
  ctx.say('\nSkills')
  const vars = stackVars(ctx.L)
  const names = listDirs(assetPath('skills'))
  for (const root of [ctx.L.claudeSkills, ctx.L.agentsSkills]) {
    for (const name of names) {
      const dir = assetPath('skills', name)
      for (const rel of listFiles(dir)) {
        const text = readFileSync(path.join(dir, rel), 'utf8')
        ctx.writeOwned(path.join(root, name, ...rel.split('/')), rel.endsWith('.md') ? render(text, vars) : text)
      }
    }
  }
  ctx.state.skills = names
}

const installMods = ctx => {
  ctx.say('\nMods de Claude Code')
  const names = listDirs(path.join(PKG_ROOT, 'mods'))
  for (const name of names) {
    const dir = path.join(PKG_ROOT, 'mods', name)
    for (const rel of listFiles(dir, skipForMod)) {
      ctx.writeOwned(path.join(ctx.L.modsDir, name, ...rel.split('/')), readFileSync(path.join(dir, rel)))
    }
  }
  ctx.state.mods = names

  // Merge the mod folders into env.CLAUDE_CODE_PLUGIN_DIRS of ~/.claude/settings.json.
  const file = ctx.L.settings
  const original = readTextIfExists(file)
  const data = parseSettings(original ?? '', file)
  const next = structuredClone(data)
  const dirs = names.map(name => path.join(ctx.L.modsDir, name))
  const createdEnv = next.env === undefined
  if (next.env === undefined || next.env === null || typeof next.env !== 'object' || Array.isArray(next.env)) {
    if (next.env !== undefined) {
      throw new Error(`${file}: "env" no es un objeto. No lo toqué.`)
    }
    next.env = {}
  }
  const createdKey = next.env.CLAUDE_CODE_PLUGIN_DIRS === undefined
  const merged = mergePluginDirs(next.env.CLAUDE_CODE_PLUGIN_DIRS, dirs)
  next.env.CLAUDE_CODE_PLUGIN_DIRS = merged.value
  if (original !== null && deepEqual(data, next)) {
    ctx.say(`  CLAUDE_CODE_PLUGIN_DIRS ya incluye los ${names.length} mods`)

    return
  }
  const result = ctx.writeShared(file, stringifySettings(next, original), `${ctx.show(file)} (CLAUDE_CODE_PLUGIN_DIRS +${merged.added.length})`)
  if (!ctx.dryRun) {
    const prev = ctx.state.settings
    ctx.state.settings = {
      file,
      pluginDirsAdded: [...new Set([...(prev?.pluginDirsAdded ?? []), ...merged.added])],
      createdFile: prev ? prev.createdFile : result.created,
      createdEnv: prev ? prev.createdEnv : createdEnv,
      createdKey: prev ? prev.createdKey : createdKey,
    }
  }
}

const installClaudeMd = ctx => {
  ctx.say('\nCLAUDE.md global')
  const file = ctx.L.claudeMd
  const original = readTextIfExists(file)
  const vars = stackVars(ctx.L)
  const next = upsertBlock(original ?? '', policyBlock({ policyPath: vars.POLICY_PATH, briefsPath: vars.BRIEFS_PATH }))
  if (next === original) {
    ctx.say('  el bloque orca-stack ya está al día')

    return
  }
  const result = ctx.writeShared(file, next, `bloque orca-stack en ${ctx.show(file)}`)
  if (!ctx.dryRun) {
    ctx.state.claudeMd = {
      file,
      createdFile: ctx.state.claudeMd ? ctx.state.claudeMd.createdFile : result.created,
    }
  }
}

const gitUserName = () => {
  const git = which('git')
  if (!git) {
    return ''
  }
  const result = run(git, ['config', '--get', 'user.name'], { timeout: 10_000, env: process.env })

  return result.status === 0 ? result.stdout.trim() : ''
}

const installPersonalConfig = (ctx, { humano }) => {
  ctx.say('\nConfig personal')
  const file = ctx.L.config
  if (existsSync(file)) {
    ctx.say(`  ${ctx.show(file)} ya existe: no se toca`)

    return
  }
  const name = humano ?? gitUserName()
  const content = JSON.stringify({ humano: name }, null, 2) + '\n'
  ctx.writeOwned(file, content, { label: `${ctx.show(file)} (humano: ${name === '' ? 'vacío; los mods dicen "el usuario"' : name})` })
  if (!ctx.dryRun) {
    ctx.state.config = { file, sha256: sha256(content) }
  }
}

const detectTools = ctx => {
  ctx.say('\nHerramientas externas (solo se detectan, no se instalan)')
  const found = key => (which(key) ? '✔' : '✖')
  ctx.say(`  ${found('engram')} engram`)
  ctx.say(`  ${found('gentle-ai')} gentle-ai`)
  ctx.say(`  ${found('gh')} gh`)
  ctx.say(`  ${found('claude')} claude`)
}

const printManualSteps = (ctx, { skipPi }) => {
  const vars = stackVars(ctx.L)
  const L = ctx.L
  ctx.say('\nPasos manuales que quedan')
  let n = 1
  const step = (title, lines = []) => {
    ctx.say(`  ${n}. ${title}`)
    for (const line of lines) {
      ctx.say(`       ${line}`)
    }
    n += 1
  }
  step('Orca > Settings > Agents > command overrides: apuntá cada agente a su wrapper', [
    `Claude Code  -> ${vars.WRAPPER_CLAUDE}`,
    `Codex        -> ${vars.WRAPPER_CODEX}`,
    `Antigravity  -> ${vars.WRAPPER_AGY}`,
  ])
  if (!skipPi) {
    step('Pi: abrí `pi` y corré /login para conectar tu cuenta (sin eso Gentle Shell no responde)')
  }
  step('GitHub CLI: `gh auth login` (el tablero de PRs y el puente lo necesitan)')
  step('`gentle-ai sync` para que gentle-ai reconcilie sus bloques en tus agentes')
  for (const [bin, title] of [['engram', 'engram'], ['gentle-ai', 'gentle-ai']]) {
    if (!which(bin)) {
      step(`Instalar ${title}`, INSTALL_HINTS[bin])
    }
  }
  if (!orcaInstalled(L.home)) {
    step('Instalar Orca (si todavía no lo tenés)', INSTALL_HINTS.orca)
  }
  step('Skills de terceros (se instalan desde su origen, no vienen en este paquete)', [
    `Matt Pocock:  ${INSTALL_HINTS.mattpocock[0]}`,
    `Caveman:      ${INSTALL_HINTS.caveman[0]}`,
  ])
  step('Reiniciá Claude Code: los mods se cargan en las sesiones nuevas')
  ctx.say(`\nPara verificar todo:  npx github:Gagaismo/orca-stack doctor`)
  ctx.say(`Config del proyecto:   npx github:Gagaismo/orca-stack init   (crea ${PROJECT_CONFIG})`)
}

export const globalCommand = async flags => {
  const ctx = createCtx({ dryRun: flags.dryRun, home: homeDir() })
  ctx.say(
    `orca-stack global${flags.dryRun ? ' (simulación: no se escribe nada)' : ''}\n` +
      `Destino: ${ctx.home}`,
  )
  installPolicyDocs(ctx)
  installWrappers(ctx)
  installSkills(ctx)
  installMods(ctx)
  installClaudeMd(ctx)
  setupPi(ctx, { skipPi: flags.skipPi })
  installPersonalConfig(ctx, { humano: flags.humano })
  if (ctx.save()) {
    ctx.say(`\nEstado guardado en ${ctx.show(ctx.L.state)}`)
  }
  detectTools(ctx)
  printManualSteps(ctx, { skipPi: flags.skipPi })
  return 0
}
