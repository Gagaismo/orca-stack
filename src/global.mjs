import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import { INSTALL_HINTS, PROJECT_CONFIG, WRAPPERS } from './constants.mjs'
import { createCtx } from './ctx.mjs'
import { NO_BLOCK, isLazyBlock, lazyifyBlock, migrateOrchestratorCopy, orchestratorMode, rddMode, readPersonalConfig, refreshLazyPointer, restoreBlock, sddBlock, trimReviewSections } from './gentle.mjs'
import { CODEX_ASCII_MARKERS, CODEX_ASCII_RULE, codexAgentsMd } from './codex-windows.mjs'
import { removeAnyBlock, removeBlock, upsertBlock } from './marker.mjs'
import { installPathCommand } from './path-command.mjs'
import { orcaInstalled } from './orca.mjs'
import { setupPi } from './pi.mjs'
import { mergePluginDirs, parseSettings, stringifySettings } from './settings.mjs'
import {
  assetPath,
  listDirs,
  listFiles,
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
  const unchanged = original !== null && deepEqual(data, next)
  let created = false
  if (unchanged) {
    ctx.say(`  CLAUDE_CODE_PLUGIN_DIRS ya incluye los ${names.length} mods`)
  } else {
    created = ctx.writeShared(file, stringifySettings(next, original), `${ctx.show(file)} (CLAUDE_CODE_PLUGIN_DIRS +${merged.added.length})`).created
  }
  if (!ctx.dryRun) {
    // Claim every mod dir this install owns, also the ones that were already listed (orphans of an aborted run).
    const prev = ctx.state.settings
    ctx.state.settings = {
      file,
      pluginDirsAdded: [...new Set([...(prev?.pluginDirsAdded ?? []), ...dirs])],
      createdFile: prev ? prev.createdFile : created,
      createdEnv: prev ? prev.createdEnv : !unchanged && createdEnv,
      createdKey: prev ? prev.createdKey : !unchanged && createdKey,
    }
  }
}

// `global` no longer writes methodology into ~/.claude/CLAUDE.md (it reaches a project through `init`).
// Installs from before that left a block there: take it out, with a backup.
const removeClaudeMdBlock = ctx => {
  ctx.say('\nCLAUDE.md global')
  const file = ctx.L.claudeMd
  const original = readTextIfExists(file)
  const { text, found } = removeAnyBlock(original ?? '')
  if (!found) {
    ctx.say('  sin bloque orca-stack: no hay nada que sacar (la política llega por el proyecto, con `orca-stack init`)')

    return
  }
  if (text.trim() === '' && ctx.state.claudeMd?.createdFile) {
    ctx.backup(file)
    ctx.act(`borro ${ctx.show(file)} (lo había creado este instalador)`)
    if (!ctx.dryRun) {
      rmSync(file)
    }
  } else {
    ctx.writeShared(file, text, `${ctx.show(file)} (sin el bloque orca-stack)`)
  }
  ctx.say('  saqué el bloque orca-stack: la política ahora llega por el proyecto (`orca-stack init`), no por el CLAUDE.md global')
  if (!ctx.dryRun) {
    ctx.state.claudeMd = null
  }
}

// Lazy mode keeps the full coordinator text in ~/.orca-stack/gentle/orchestrator.md and leaves a short pointer between the markers.
// `gentle-ai sync` rewrites the block, so this step has to run again after each sync (it also refreshes the copy).
const lazyGentleBlock = (ctx, original) => {
  const block = sddBlock(original)
  if (block.status !== 'ok') {
    ctx.say(`  se omite y no toco nada: ${block.status === 'none' ? `${NO_BLOCK} (lo escribe \`gentle-ai sync\`)` : 'los marcadores del bloque de gentle-ai están incompletos, repetidos o desordenados'}`)

    return
  }
  // The block carries gentle-ai's Review Execution Contract: a pointer would silently turn receipt-driven development off.
  // Without the gentle-ai binary there is no review to protect.
  const bin = which('gentle-ai')
  const rdd = bin ? rddMode(bin) : { mode: 'off', source: null }
  if (rdd.mode !== 'off') {
    ctx.say(`  RDD de gentle-ai ${rdd.mode === 'on' ? 'prendido' : 'en un estado que no pude leer'}: el bloque queda completo (lazy le sacaría el contrato de review)`)
    if (rdd.mode === 'on' && rdd.source === 'default') {
      ctx.say('  está prendido solo por defecto en gentle-ai v4: si no lo elegiste, corré `gentle-ai review mode disable` y después `orca-stack global`')
    }
    restoreGentleBlock(ctx, original)

    return
  }
  const migration = migrateOrchestratorCopy(ctx)
  if (migration.skipped) {
    ctx.say('  se omite y no toco nada: no pude migrar la copia completa del bloque de gentle-ai')

    return
  }
  const copy = ctx.L.orchestratorCopy
  if (isLazyBlock(block)) {
    const hasCopy = existsSync(copy) || existsSync(ctx.L.legacyOrchestratorCopy)
    if (hasCopy) {
      const refreshed = refreshLazyPointer(original, copy)
      if (refreshed !== original) {
        ctx.writeShared(ctx.L.claudeMd, refreshed, `${ctx.show(ctx.L.claudeMd)} (puntero gentle-ai actualizado)`)
        ctx.say(`  actualicé el puntero gentle-ai; la copia completa queda en ${ctx.show(copy)}`)
      } else {
        ctx.say(`  ya está en modo lazy${existsSync(copy) ? '' : `; la copia migrada queda en ${ctx.show(copy)}`}`)
      }
    } else {
      ctx.say(`  ya está en modo lazy; pero falta ${ctx.show(copy)}: corré \`gentle-ai sync\` y después \`orca-stack global\``)
    }

    return
  }
  const { text, saved } = lazyifyBlock(original, copy)
  // The copy goes first: if it cannot be written, the block stays as it is.
  if (ctx.writeOwned(copy, saved, { label: `${ctx.show(copy)} (copia completa del bloque de gentle-ai)` }) === 'skipped') {
    ctx.say('  se omite y no toco nada: no pude guardar la copia completa del bloque')

    return
  }
  const kb = ((Buffer.byteLength(original) - Buffer.byteLength(text)) / 1024).toFixed(1)
  ctx.writeShared(ctx.L.claudeMd, text, `${ctx.show(ctx.L.claudeMd)} (bloque de gentle-ai en modo lazy: -${kb} KB)`)
  ctx.say(`  ${kb} KB menos en cada sesión. El texto completo queda en ${ctx.show(copy)}. \`gentle-ai sync\` lo reescribe: volvé a correr \`orca-stack global\` después de cada sync.`)
}

// Full mode over a lazy block: put the saved body back (with a backup). Returns the resulting text.
const restoreGentleBlock = (ctx, original) => {
  if (!isLazyBlock(sddBlock(original))) {
    return original
  }
  const migration = migrateOrchestratorCopy(ctx)
  if (migration.skipped) {
    ctx.say('  el bloque está en modo lazy pero no pude migrar la copia completa del bloque de gentle-ai')

    return original
  }
  const copy = existsSync(ctx.L.orchestratorCopy) ? ctx.L.orchestratorCopy : ctx.L.legacyOrchestratorCopy
  const saved = readTextIfExists(copy)
  if (saved === null) {
    ctx.say(`  el bloque está en modo lazy pero falta ${ctx.show(ctx.L.orchestratorCopy)}: corré \`gentle-ai sync\` para que gentle-ai lo escriba de nuevo`)

    return original
  }
  const text = restoreBlock(original, saved)
  ctx.writeShared(ctx.L.claudeMd, text, `${ctx.show(ctx.L.claudeMd)} (bloque completo de gentle-ai, restaurado desde la copia)`)
  const bin = which('gentle-ai')
  if (bin && !saved.includes('#### Review Execution Contract') && rddMode(bin).mode !== 'off') {
    ctx.say('  la copia no tiene el contrato de review: corré `gentle-ai sync`')
  }

  return text
}

const gentleBlockStep = ctx => {
  ctx.say('\nBloque de gentle-ai en CLAUDE.md')
  const mode = orchestratorMode(readPersonalConfig(ctx.L))
  const original = readTextIfExists(ctx.L.claudeMd)
  if (mode === null) {
    ctx.say(`  se omite y no toco nada: gentle.orchestrator en ${ctx.show(ctx.L.config)} tiene que ser "lazy" o "full"`)
  } else if (original === null) {
    ctx.say('  se omite: no hay ~/.claude/CLAUDE.md')
  } else if (mode === 'lazy') {
    lazyGentleBlock(ctx, original)
  } else {
    // Full: the block stays as gentle-ai writes it, minus the review sections while RDD is off.
    migrateOrchestratorCopy(ctx)
    trimGentleReview(ctx, restoreGentleBlock(ctx, original))
  }
}

// With RDD off, gentle-ai's review sections are dead weight in every session: cut them (with a backup).
// `gentle-ai sync` writes them back, so this step has to run again after each sync.
const trimGentleReview = (ctx, original) => {
  const file = ctx.L.claudeMd
  const bin = which('gentle-ai')
  if (original === null || !bin) {
    ctx.say(`  se omite: ${original === null ? 'no hay ~/.claude/CLAUDE.md' : 'gentle-ai no está instalado'}`)

    return
  }
  const rdd = rddMode(bin)
  if (rdd.mode !== 'off') {
    ctx.say(`  se omite: el desarrollo guiado por recibos (RDD) está ${rdd.mode === 'on' ? 'prendido' : 'en un estado que no pude leer'}`)
    if (rdd.mode === 'on' && rdd.source === 'default') {
      ctx.say('  está prendido solo por defecto en gentle-ai v4: si no lo elegiste, corré `gentle-ai review mode disable` y después `orca-stack global`')
    }

    return
  }
  const { text, removed, skipped } = trimReviewSections(original)
  if (skipped !== undefined) {
    ctx.say(`  se omite y no toco nada: el texto de gentle-ai cambió de forma (${skipped})`)

    return
  }
  if (removed === 0) {
    ctx.say('  ya están recortadas (o gentle-ai no las escribió)')

    return
  }
  const kb = (removed / 1024).toFixed(1)
  ctx.writeShared(file, text, `${ctx.show(file)} (sin las secciones de review de gentle-ai: -${kb} KB)`)
  ctx.say(`  ${kb} KB menos en cada sesión. \`gentle-ai sync\` las restaura: volvé a correr \`orca-stack global\` después de cada sync.`)
}

// Windows only: codex reads files through PowerShell, and 5.1 garbles UTF-8 (#58). A managed block in
// codex's AGENTS.md keeps its source code ASCII. Text outside the markers is never touched.
const installCodexAsciiRule = ctx => {
  if (!isWindows()) {
    return
  }
  ctx.say('\nRegla ASCII de codex (Windows)')
  if (!existsSync(ctx.L.codexDir)) {
    const why = process.env.CODEX_HOME ? 'CODEX_HOME apunta a una carpeta que no existe' : 'codex no está instalado'
    ctx.say(`  se omite: no hay ${ctx.show(ctx.L.codexDir)} (${why})`)

    return
  }
  const file = codexAgentsMd(ctx.L.codexDir)
  const original = readTextIfExists(file)
  const text = upsertBlock(original ?? '', CODEX_ASCII_RULE, CODEX_ASCII_MARKERS)
  if (text === original) {
    ctx.say(`  ${ctx.show(file)} ya tiene la regla`)

    return
  }
  const { created } = ctx.writeShared(file, text, `${ctx.show(file)} (regla ASCII de codex)`)
  if (!ctx.dryRun) {
    ctx.state.codexAgentsMd = { file, createdFile: ctx.state.codexAgentsMd ? ctx.state.codexAgentsMd.createdFile : created }
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
  step('Después de cada `gentle-ai sync`, volvé a correr `orca-stack global` (la sync reescribe el bloque de gentle-ai que `global` achicó)')
  for (const [bin, title] of [['engram', 'engram'], ['gentle-ai', 'gentle-ai']]) {
    if (!which(bin)) {
      step(`Instalar ${title}`, INSTALL_HINTS[bin])
    }
  }
  if (!orcaInstalled(L.home)) {
    step('Instalar Orca (si todavía no lo tenés)', INSTALL_HINTS.orca)
  }
  step('Skills de terceros (se instalan desde su origen, no vienen en este paquete)', [
    `Matt Pocock (Claude):  ${INSTALL_HINTS.mattpocock.join(' && ')}`,
    `Matt Pocock (agy, codex):  ${INSTALL_HINTS.mattpocockAgents[0]}`,
    `Caveman:      ${INSTALL_HINTS.caveman[0]}`,
  ])
  step('Reiniciá Claude Code: los mods se cargan en las sesiones nuevas')
  ctx.say(`\nPara verificar todo:  npx github:Gagaismo/orca-stack doctor`)
  ctx.say(`Config del proyecto:   npx github:Gagaismo/orca-stack init   (crea ${PROJECT_CONFIG})`)
}

// Everything that could abort the run half-way is checked here, before the first write.
export const preflight = ctx => {
  const settings = readTextIfExists(ctx.L.settings)
  const data = parseSettings(settings ?? '', ctx.L.settings)
  if (data.env !== undefined && (data.env === null || typeof data.env !== 'object' || Array.isArray(data.env))) {
    throw new Error(`${ctx.L.settings}: "env" no es un objeto. No lo toqué.`)
  }
  const md = readTextIfExists(ctx.L.claudeMd)
  if (md !== null) {
    removeAnyBlock(md) // throws on unbalanced, reordered or duplicated markers
  }
  const codexMd = isWindows() ? readTextIfExists(codexAgentsMd(ctx.L.codexDir)) : null
  if (codexMd !== null) {
    removeBlock(codexMd, CODEX_ASCII_MARKERS) // same
  }
}

export const globalCommand = async flags => {
  const ctx = createCtx({ dryRun: flags.dryRun, force: flags.force, home: homeDir() })
  ctx.say(
    `orca-stack global${flags.dryRun ? ' (simulación: no se escribe nada)' : ''}
` +
      `Destino: ${ctx.home}`,
  )
  preflight(ctx)
  try {
    installPolicyDocs(ctx)
    installWrappers(ctx)
    installSkills(ctx)
    installMods(ctx)
    removeClaudeMdBlock(ctx)
    gentleBlockStep(ctx)
    installCodexAsciiRule(ctx)
    setupPi(ctx, { skipPi: flags.skipPi })
    installPersonalConfig(ctx, { humano: flags.humano })
    installPathCommand(ctx)
  } finally {
    // Whatever was written is recorded, even when a step threw, so `remove` can always undo it.
    if (ctx.save()) {
      ctx.say(`
Estado guardado en ${ctx.show(ctx.L.state)}`)
    }
  }
  detectTools(ctx)
  printManualSteps(ctx, { skipPi: flags.skipPi })
  if (ctx.skipped.length > 0) {
    ctx.say(`
⚠ ${ctx.skipped.length} archivos existentes que no son de orca-stack quedaron como estaban. Para reemplazarlos (con respaldo): orca-stack global --force`)
  }
  if (ctx.failures > 0) {
    ctx.say(`
✖ ${ctx.failures} paso(s) fallaron; revisá los mensajes de arriba.`)

    return 1
  }

  return 0
}
