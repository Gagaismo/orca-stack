import { existsSync } from 'node:fs'
import path from 'node:path'

import { piBinary } from './pi.mjs'
import { childEnv, readTextIfExists, run, which } from './util.mjs'

export const piCodemodeStatus = (L, { piBin } = {}) => {
  const bin = piBin !== undefined ? piBin : piBinary(L)
  if (!bin) {
    return { status: 'not_applicable', detail: 'no está instalado' }
  }
  const file = path.join(L.piAgent, 'settings.json')
  const text = readTextIfExists(file)
  if (text === null) {
    return { status: 'off', command: 'orca-stack global', file }
  }
  try {
    const data = JSON.parse(text)
    if (Array.isArray(data.defaultTools) && data.defaultTools.includes('+codemode')) {
      return { status: 'on', detail: '+codemode en defaultTools', file }
    }

    return { status: 'off', command: 'orca-stack global', file }
  } catch (error) {
    return { status: 'off', command: 'orca-stack global', file, error: error.message }
  }
}

export const ensurePiCodemode = (ctx, { piBin } = {}) => {
  const bin = piBin !== undefined ? piBin : piBinary(ctx.L)
  if (!bin) {
    ctx.say('  pi no está instalado: omito la configuración de codemode')

    return 'skipped_not_installed'
  }
  const file = path.join(ctx.L.piAgent, 'settings.json')
  const original = readTextIfExists(file)
  let data = {}
  if (original !== null && original.trim() !== '') {
    try {
      data = JSON.parse(original)
    } catch (error) {
      throw new Error(`${file}: JSON inválido (${error.message}). No lo toqué.`)
    }
  }

  if (Array.isArray(data.defaultTools) && data.defaultTools.includes('+codemode')) {
    ctx.say('  codemode en Pi ya está activado (+codemode en defaultTools)')

    return 'unchanged'
  }

  const next = structuredClone(data)
  if (Array.isArray(next.defaultTools)) {
    next.defaultTools = [...next.defaultTools.filter(item => item !== '-codemode' && item !== '+codemode'), '+codemode']
  } else {
    next.defaultTools = ['+codemode']
  }

  ctx.writeShared(file, JSON.stringify(next, null, 2) + '\n', `${ctx.show(file)} (+codemode en defaultTools)`)
  ctx.say('  activé codemode en Pi (+codemode en defaultTools)')

  return 'updated'
}

export const codexFeaturesList = (bin, { env } = {}) => {
  return run(bin, ['features', 'list'], { env: env ?? childEnv(), timeout: 15_000 })
}

export const codexCodemodeStatus = (L, { codexBin, env } = {}) => {
  const bin = codexBin !== undefined ? codexBin : which('codex')
  if (!bin) {
    return { status: 'not_applicable', detail: 'no está instalado' }
  }
  const res = codexFeaturesList(bin, { env })
  if (res.status !== 0) {
    return { status: 'not_applicable', detail: 'no pude consultar codex features list' }
  }
  const match = /(?:^|\r?\n)code_mode\s+([^\r\n]+)/.exec(res.stdout)
  if (!match) {
    return { status: 'not_applicable', detail: 'la versión instalada de codex no soporta code_mode' }
  }
  const row = match[1].trim()
  const enabled = row.endsWith('true') || /\btrue\b/.test(row)
  if (enabled) {
    return { status: 'on', detail: 'code_mode = true' }
  }

  return { status: 'off', command: 'codex features enable code_mode' }
}

export const ensureCodexCodemode = (ctx, { codexBin, env } = {}) => {
  const bin = codexBin !== undefined ? codexBin : which('codex')
  if (!bin) {
    ctx.say('  codex no está instalado: omito la configuración de codemode')

    return 'skipped_not_installed'
  }
  const res = codexFeaturesList(bin, { env: env ?? childEnv() })
  if (res.status !== 0) {
    ctx.say('  no pude consultar codex features list: omito la configuración de codemode')

    return 'skipped_failed'
  }
  const match = /(?:^|\r?\n)code_mode\s+([^\r\n]+)/.exec(res.stdout)
  if (!match) {
    ctx.say('  la versión instalada de codex no incluye la feature code_mode: se omite')

    return 'skipped_unsupported'
  }
  const row = match[1].trim()
  const enabled = row.endsWith('true') || /\btrue\b/.test(row)
  if (enabled) {
    ctx.say('  codemode en codex ya está activado (code_mode = true)')

    return 'unchanged'
  }

  const configFile = path.join(ctx.L.codexDir, 'config.toml')
  if (existsSync(configFile)) {
    ctx.backup(configFile)
  }
  ctx.act('ejecuto: codex features enable code_mode')
  if (!ctx.dryRun) {
    const enableRes = run(bin, ['features', 'enable', 'code_mode'], { env: env ?? childEnv(), timeout: 15_000 })
    if (enableRes.status !== 0) {
      ctx.fail(`falló codex features enable code_mode: ${enableRes.stderr || enableRes.stdout}`)

      return 'failed'
    }
  }
  ctx.say('  activé codemode en codex (codex features enable code_mode)')

  return 'updated'
}
