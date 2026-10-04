import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PROJECT_CONFIG, PROJECT_LOCAL_CONFIG } from './constants.mjs'
import { removeBlock, upsertBlock } from './marker.mjs'
import { policyBlock } from './templates.mjs'
import { readTextIfExists, run, timestamp, which } from './util.mjs'

// Portable pointers: never an absolute user path.
const POLICY = '~/orca/stack/ORCA-STACK.md'
const BRIEFS = '~/orca/stack/ROLE-BRIEFS.md'

const projectRoot = cwd => {
  const git = which('git')
  if (!git) {
    return null
  }
  const result = run(git, ['rev-parse', '--show-toplevel'], { cwd, timeout: 15_000, env: process.env })

  return result.status === 0 ? path.resolve(result.stdout.trim()) : null
}

// A CLAUDE.md that only says "read AGENTS.md" gets a short pointer instead of the full block.
export const isPointerOnly = text => {
  const outside = removeBlock(text).text
  const lines = outside.split(/\r?\n/).filter(line => line.trim() !== '')

  return lines.length <= 12 && /AGENTS\.md/.test(outside)
}

export const initCommand = async (flags, cwd = process.cwd()) => {
  const dryRun = flags.dryRun
  const root = projectRoot(cwd)
  if (!root) {
    console.error('Esto no es un repo de git. Corré `orca-stack init` dentro del proyecto.')

    return 1
  }
  const prefix = dryRun ? '[simulación] ' : ''
  const stamp = timestamp()
  console.log(`orca-stack init${dryRun ? ' (simulación: no se escribe nada)' : ''}\nProyecto: ${root}\n`)

  const writeText = (file, content, verb) => {
    console.log(`${prefix}${verb} ${path.relative(root, file) || file}`)
    if (dryRun) {
      return
    }
    if (existsSync(file)) {
      copyFileSync(file, `${file}.bak-orca-stack-${stamp}`)
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }

  const upsertFile = (name, body) => {
    const file = path.join(root, name)
    const original = readTextIfExists(file)
    const next = upsertBlock(original ?? '', body)
    if (next === original) {
      console.log(`${name}: el bloque orca-stack ya está al día`)

      return
    }
    writeText(file, next, original === null ? 'creo' : 'actualizo')
  }

  upsertFile('AGENTS.md', policyBlock({ policyPath: POLICY, briefsPath: BRIEFS, agentsPointer: true }))

  const claudeMd = path.join(root, 'CLAUDE.md')
  const claudeText = readTextIfExists(claudeMd)
  if (claudeText === null) {
    // New CLAUDE.md: point at AGENTS.md, which carries the contract.
    const file = claudeMd
    const body = policyBlock({ policyPath: POLICY, briefsPath: BRIEFS, short: true })
    writeText(file, `Leé \`AGENTS.md\`: es el contrato de trabajo de este repo.\n\n${upsertBlock('', body)}`, 'creo')
  } else if (isPointerOnly(claudeText)) {
    upsertFile('CLAUDE.md', policyBlock({ policyPath: POLICY, briefsPath: BRIEFS, short: true }))
  } else {
    upsertFile('CLAUDE.md', policyBlock({ policyPath: POLICY, briefsPath: BRIEFS, agentsPointer: true }))
  }

  const config = path.join(root, PROJECT_CONFIG)
  if (existsSync(config)) {
    console.log(`${PROJECT_CONFIG}: ya existe, no se toca`)
  } else {
    writeText(config, JSON.stringify({ version: 1 }, null, 2) + '\n', 'creo')
  }
  const local = path.join(root, PROJECT_LOCAL_CONFIG)
  if (existsSync(local)) {
    console.log(`${PROJECT_LOCAL_CONFIG}: ya existe, no se toca`)
  } else {
    writeText(local, JSON.stringify({ mensajes: { destinatarios: [] } }, null, 2) + '\n', 'creo')
  }

  const ignore = path.join(root, '.gitignore')
  const ignoreText = readTextIfExists(ignore) ?? ''
  if (ignoreText.split(/\r?\n/).some(line => line.trim() === PROJECT_LOCAL_CONFIG)) {
    console.log(`.gitignore: ya ignora ${PROJECT_LOCAL_CONFIG}`)
  } else {
    const eol = ignoreText.includes('\r\n') ? '\r\n' : '\n'
    const base = ignoreText === '' || ignoreText.endsWith('\n') ? ignoreText : ignoreText + eol
    writeText(ignore, `${base}${PROJECT_LOCAL_CONFIG}${eol}`, ignoreText === '' && !existsSync(ignore) ? 'creo' : 'actualizo')
  }

  console.log(
    `\nListo. Editá ${PROJECT_CONFIG} (reglas del proyecto, se commitea) y ${PROJECT_LOCAL_CONFIG} (local, ignorado).\n` +
      'Las claves están explicadas en el README: https://github.com/Gagaismo/orca-stack#configuración-en-tres-capas',
  )

  return 0
}
