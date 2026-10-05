import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { copyToBackup } from './backup.mjs'
import { PROJECT_CONFIG, PROJECT_LOCAL_CONFIG } from './constants.mjs'
import { removeBlock, upsertBlock } from './marker.mjs'
import { policyBlock } from './templates.mjs'
import { homeDir, readTextIfExists, run, timestamp, tilde, which } from './util.mjs'

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
  const home = homeDir()
  const prefix = dryRun ? '[simulación] ' : ''
  const stamp = timestamp()
  console.log(`orca-stack init${dryRun ? ' (simulación: no se escribe nada)' : ''}\nProyecto: ${root}\n`)

  // Plan first: every file is computed (and every marker validated) before the first write,
  // so a broken AGENTS.md or CLAUDE.md can never leave the project half-wired.
  const plan = []
  const block = (name, body, fallbackWhenMissing) => {
    const file = path.join(root, name)
    const original = readTextIfExists(file)
    const next = fallbackWhenMissing && original === null ? fallbackWhenMissing(body) : upsertBlock(original ?? '', body)
    if (next === original) {
      console.log(`${name}: el bloque orca-stack ya está al día`)
    } else {
      plan.push({ file, name, content: next, verb: original === null ? 'creo' : 'actualizo' })
    }
  }
  const missing = (name, content, text) => {
    if (existsSync(path.join(root, name))) {
      console.log(`${name}: ya existe, no se toca`)
    } else {
      plan.push({ file: path.join(root, name), name, content: text(content), verb: 'creo' })
    }
  }

  try {
    block('AGENTS.md', policyBlock({ policyPath: POLICY, briefsPath: BRIEFS, agentsPointer: true }))

    const claudeText = readTextIfExists(path.join(root, 'CLAUDE.md'))
    const short = policyBlock({ policyPath: POLICY, briefsPath: BRIEFS, short: true })
    if (claudeText === null) {
      block('CLAUDE.md', short, body => `Leé \`AGENTS.md\`: es el contrato de trabajo de este repo.\n\n${upsertBlock('', body)}`)
    } else if (isPointerOnly(claudeText)) {
      block('CLAUDE.md', short)
    } else {
      block('CLAUDE.md', policyBlock({ policyPath: POLICY, briefsPath: BRIEFS, agentsPointer: true }))
    }
  } catch (error) {
    console.error(`✖ ${error.message}\nNo escribí nada.`)

    return 1
  }

  missing(PROJECT_CONFIG, null, () => JSON.stringify({ version: 1 }, null, 2) + '\n')
  // Empty on purpose: a list here would replace the committed and personal ones (lists are not merged).
  missing(PROJECT_LOCAL_CONFIG, null, () => '{}\n')

  const ignore = path.join(root, '.gitignore')
  const ignoreText = readTextIfExists(ignore)
  if ((ignoreText ?? '').split(/\r?\n/).some(line => line.trim() === PROJECT_LOCAL_CONFIG)) {
    console.log(`.gitignore: ya ignora ${PROJECT_LOCAL_CONFIG}`)
  } else {
    const text = ignoreText ?? ''
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const base = text === '' || text.endsWith('\n') ? text : text + eol
    plan.push({ file: ignore, name: '.gitignore', content: `${base}${PROJECT_LOCAL_CONFIG}${eol}`, verb: ignoreText === null ? 'creo' : 'actualizo' })
  }

  for (const { file, name, content, verb } of plan) {
    console.log(`${prefix}${verb} ${name}`)
    if (dryRun) {
      continue
    }
    if (existsSync(file)) {
      const saved = copyToBackup(home, stamp, file)
      console.log(`  respaldo -> ${tilde(saved, home)}`)
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }

  console.log(
    `\nListo. Editá ${PROJECT_CONFIG} (reglas del proyecto, se commitea) y ${PROJECT_LOCAL_CONFIG} (local, ignorado).\n` +
      'Las claves están explicadas en el README: https://github.com/Gagaismo/orca-stack#configuración-en-tres-capas',
  )

  return 0
}
