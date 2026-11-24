import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'

import { copyToBackup } from './backup.mjs'
import { CANDIDATE_WORKTREES_EXCLUDE, CANDIDATE_WORKTREES_PROBE, findGitignoreNegation } from './candidate-worktrees.mjs'
import { LEGACY_BEGIN, LEGACY_END, MARKER_BEGIN, MARKER_END, PROJECT_CONFIG, PROJECT_LOCAL_CONFIG } from './constants.mjs'
import { loadConfig } from './despacho.mjs'
import { BASELINE_FILE, seedBaseline } from './lint.mjs'
import { removeBlock, upsertBlock } from './marker.mjs'
import { perksOf } from './perks.mjs'
import { policyBlock, readAsset, render } from './templates.mjs'
import { homeDir, layout, packageVersion, readTextIfExists, run, timestamp, tilde, which } from './util.mjs'

// Portable pointers: never an absolute user path.
export const POLICY = '~/orca/stack/ORCA-STACK.md'
export const BRIEFS = '~/orca/stack/ROLE-BRIEFS.md'
export const MAIN_DOC = '~/orca/stack/MAIN.md'

// Orca's worktree files (#432): the setup step comes from the repo's lockfile, and the include list is the local config.
const ORCA_YAML_HEAD = '# Orca runs scripts.setup in each new worktree right after creating it.\n# No worktree.sharedDirectories: a worker that changes dependencies would change them for every worktree.\n'
export const orcaYaml = root =>
  existsSync(path.join(root, 'package-lock.json'))
    ? `${ORCA_YAML_HEAD}scripts:\n  setup: |\n    npm install\n`
    : `${ORCA_YAML_HEAD}# orca-stack init found no install step (no package-lock.json): add one under scripts.setup if worktrees need it.\n`
export const WORKTREE_INCLUDE =
  '# Gitignored local files Orca copies into each new worktree.\n# Literal paths only (Orca skips globs and negations); never list secrets such as .env files.\n' +
  `${PROJECT_LOCAL_CONFIG}\n`

const projectRoot = cwd => {
  const git = which('git')
  if (!git) {
    return null
  }
  const result = run(git, ['rev-parse', '--show-toplevel'], { cwd, timeout: 15_000, env: process.env })

  return result.status === 0 ? path.resolve(result.stdout.trim()) : null
}

// Length of the orca-stack block (current or legacy) inside text; 0 when there is none.
const blockSize = text => {
  for (const [open, close] of [[MARKER_BEGIN, MARKER_END], [LEGACY_BEGIN, LEGACY_END]]) {
    const begin = text.indexOf(open)
    const end = text.indexOf(close)
    if (begin !== -1 && end > begin) {
      return end + close.length - begin
    }
  }

  return 0
}

// Claude Code stops loading AGENTS.md on its own once a CLAUDE.md exists: the import is what loads the contract.
const importsAgents = text => removeBlock(text).text.split(/\r?\n/).some(line => line.trim() === '@AGENTS.md')

export const LINT_DEFAULTS = { enabled: true, comentarios: { alcance: 'repo' } }
const LINT_WORKFLOW = '.github/workflows/orca-stack-lint.yml'
const LINT_JOB = 'orca-stack-lint'
const HOOKS_DIR = '.githooks'
const LINT_HOOK = `${HOOKS_DIR}/pre-push`
const STANDARDS = 'CODING_STANDARDS.md'
const ENABLE_HOOK = `git config core.hooksPath ${HOOKS_DIR}`
const HOOK_QUESTION = `¿Activo el hook ${LINT_HOOK} con \`${ENABLE_HOOK}\`? [s/N] `
const lintRun = () => `npx --yes github:Gagaismo/orca-stack#v${packageVersion()} lint`

const commentTable = text => {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.indexOf('| Type | Action |')
  let end = start
  while (start !== -1 && lines[end + 1]?.startsWith('|')) end += 1
  return start === -1 ? null : lines.slice(start, end + 1).join('\n')
}

// #424: the key goes in before the closing brace, so every other byte of the repo's own file stays as it was.
const withLintKey = text => {
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    parsed = undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${PROJECT_CONFIG} no es un objeto JSON válido; no lo toco`)
  if ('lint' in parsed) return null
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  '
  const close = text.lastIndexOf('}')
  const head = text.slice(0, close).replace(/\s+$/, '')
  const value = JSON.stringify(LINT_DEFAULTS, null, indent).split('\n').join(`${eol}${indent}`)

  return `${head}${head.endsWith('{') ? '' : ','}${eol}${indent}"lint": ${value}${eol}${text.slice(close)}`
}

const workflowWithJob = root => {
  const dir = path.join(root, '.github', 'workflows')
  if (!existsSync(dir)) return null
  const job = new RegExp(`^\\s+["']?${LINT_JOB}["']?\\s*:`, 'm')
  const found = readdirSync(dir).sort().find(name => /\.ya?ml$/i.test(name) && job.test(readFileSync(path.join(dir, name), 'utf8')))

  return found ? `.github/workflows/${found}` : null
}

const ttyAsk = () =>
  process.stdin.isTTY && process.stdout.isTTY
    ? async question => {
        const prompt = createInterface({ input: process.stdin, output: process.stdout })
        try {
          return await prompt.question(question)
        } finally {
          prompt.close()
        }
      }
    : undefined

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// #424: each piece is written only when missing and fails on its own, so a re-run completes the rest without duplicating.
const installLint = async ({ root, home, stamp, dryRun, prefix, activarHook, ask, env, written }) => {
  const failed = []
  const attempt = (name, step) => {
    try {
      const outcome = step()
      if (outcome.skip) return console.log(outcome.skip)
      if (dryRun) return console.log(`${prefix}${outcome.line}`)
      const line = outcome.write() ?? outcome.line
      written.push(name)
      console.log(line)
    } catch (error) {
      failed.push(name)
      console.log(`✖ ${name}: no se pudo escribir (${error.message})`)
    }
  }
  const full = name => path.join(root, name)
  const create = (name, content, mode) => () => {
    mkdirSync(path.dirname(full(name)), { recursive: true })
    writeFileSync(full(name), content, mode ? { mode } : undefined)
    if (mode) chmodSync(full(name), mode)
  }
  const present = name => ({ skip: `${name}: ya existe, no se toca` })

  attempt(PROJECT_CONFIG, () => {
    const next = withLintKey(readTextIfExists(full(PROJECT_CONFIG)) ?? '{}\n')
    if (next === null) return { skip: `${PROJECT_CONFIG}: ya tiene una clave lint propia, no se toca` }

    return {
      line: `agrego la clave lint a ${PROJECT_CONFIG}`,
      write: () => {
        if (!written.includes(PROJECT_CONFIG)) copyToBackup(home, stamp, full(PROJECT_CONFIG))
        writeFileSync(full(PROJECT_CONFIG), next)
      },
    }
  })
  attempt(LINT_WORKFLOW, () => {
    if (existsSync(full(LINT_WORKFLOW))) return present(LINT_WORKFLOW)
    const own = workflowWithJob(root)
    if (own) return { skip: `${LINT_WORKFLOW}: no se crea, ${own} ya tiene un job ${LINT_JOB}` }

    return { line: `creo ${LINT_WORKFLOW}`, write: create(LINT_WORKFLOW, render(readAsset('lint', 'orca-stack-lint.yml'), { LINT_COMMAND: lintRun() })) }
  })
  attempt(LINT_HOOK, () => existsSync(full(LINT_HOOK)) ? present(LINT_HOOK) : { line: `creo ${LINT_HOOK}`, write: create(LINT_HOOK, render(readAsset('lint', 'pre-push'), { LINT_COMMAND: lintRun() }), 0o755) })
  attempt(STANDARDS, () => {
    const text = readTextIfExists(full(STANDARDS))
    if (text === null) return { line: `creo ${STANDARDS}`, write: create(STANDARDS, readAsset('lint', STANDARDS)) }
    const table = commentTable(readAsset('lint', STANDARDS))

    return { skip: text.replace(/\r\n/g, '\n').includes(table) ? `${STANDARDS}: ya existe, no se toca` : `⚠ ${STANDARDS}: ya existe, no se toca, y le falta la regla de los comentarios (la tabla | Type | Action |): agregala a mano` }
  })
  attempt(BASELINE_FILE, () => {
    if (existsSync(full(BASELINE_FILE))) return present(BASELINE_FILE)
    const off = { skip: `${BASELINE_FILE}: no se crea, el lint está apagado (lint.enabled es false)` }
    if (loadConfig(home, root).lint?.enabled === false) return off

    return {
      line: `creo ${BASELINE_FILE}`,
      write: () => {
        const seeded = seedBaseline(root, { home, extraFiles: [...written, BASELINE_FILE] })

        return `creo ${BASELINE_FILE} (${plural(seeded.entries.length, 'entrada', 'entradas')})`
      },
    }
  })

  const git = which('git')
  const current = git ? run(git, ['config', '--get', 'core.hooksPath'], { cwd: root, env, timeout: 10_000 }) : { status: 1, stdout: '' }
  const value = current.status === 0 ? current.stdout.trim() : ''
  if (value !== '') {
    console.log(value.replace(/^\.\//, '').replace(/[\\/]+$/, '') === HOOKS_DIR
      ? `core.hooksPath: ya apunta a ${HOOKS_DIR}`
      : `core.hooksPath: ya apunta a ${value}, no lo cambio; para usar el hook, llamá a ${LINT_HOOK} desde tus hooks`)
  } else if (!dryRun && !existsSync(full(LINT_HOOK))) {
    console.log(`core.hooksPath: no lo cambié, falta ${LINT_HOOK}`)
  } else if (dryRun && (activarHook || ask)) {
    console.log(`${prefix}core.hooksPath: ${activarHook ? 'lo apuntaría' : 'preguntaría antes de apuntarlo'} a ${HOOKS_DIR}`)
  } else if (activarHook || (ask && /^(s|si|sí|y|yes)$/i.test(String(await ask(HOOK_QUESTION)).trim()))) {
    const set = git ? run(git, ['config', 'core.hooksPath', HOOKS_DIR], { cwd: root, env, timeout: 10_000 }) : { status: 1, stderr: 'git no está en el PATH' }
    if (set.status === 0) {
      console.log(`core.hooksPath: lo apunté a ${HOOKS_DIR}`)
    } else {
      failed.push('core.hooksPath')
      console.log(`✖ core.hooksPath: no se pudo cambiar (${String(set.stderr).trim()})`)
    }
  } else {
    console.log(`core.hooksPath: no lo cambié; para activar el hook corré \`${ENABLE_HOOK}\``)
  }

  return failed
}

export const initCommand = async (flags, cwd = process.cwd(), io = {}) => {
  const dryRun = flags.dryRun
  const root = projectRoot(cwd)
  if (!root) {
    console.error('Esto no es un repo de git. Corré `orca-stack init` dentro del proyecto.')

    return 1
  }
  const home = io.home ?? homeDir()
  const prefix = dryRun ? '[simulación] ' : ''
  const stamp = timestamp()
  console.log(`orca-stack init${dryRun ? ' (simulación: no se escribe nada)' : ''}\nProyecto: ${root}\n`)

  // Plan first: every file is computed (and every marker validated) before the first write,
  // so a broken AGENTS.md or CLAUDE.md can never leave the project half-wired.
  const plan = []
  const block = (name, body) => {
    const file = path.join(root, name)
    const original = readTextIfExists(file)
    const next = upsertBlock(original ?? '', body)
    if (next === original) {
      console.log(`${name}: el bloque orca-stack ya está al día`)
    } else {
      plan.push({ file, name, content: next, verb: original === null ? 'creo' : 'actualizo', grew: blockSize(next) > blockSize(original ?? '') })
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
    // The contract carries the text of the perks the merged config turns on (#393).
    block('AGENTS.md', policyBlock({ policyPath: POLICY, briefsPath: BRIEFS, perks: perksOf(loadConfig(home, root)) }))

    const claudeText = readTextIfExists(path.join(root, 'CLAUDE.md')) ?? ''
    block('CLAUDE.md', policyBlock({ policyPath: POLICY, briefsPath: BRIEFS, short: true, importAgents: !importsAgents(claudeText) }))
  } catch (error) {
    console.error(`✖ ${error.message}\nNo escribí nada.`)

    return 1
  }

  missing(PROJECT_CONFIG, null, () => JSON.stringify({ version: 1 }, null, 2) + '\n')
  // Empty on purpose: a list here would replace the committed and personal ones (lists are not merged).
  missing(PROJECT_LOCAL_CONFIG, null, () => '{}\n')
  missing('orca.yaml', root, orcaYaml)
  missing('.worktreeinclude', null, () => WORKTREE_INCLUDE)

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

  // The block sends main to MAIN.md, which `global` installs: without it, main's rules are missing.
  const mainDoc = path.join(layout(home).stackDir, 'MAIN.md')
  const hasMainDoc = existsSync(mainDoc)
  const written = []
  for (const { file, name, content, verb, grew } of plan) {
    console.log(`${prefix}${verb} ${name}`)
    if (grew && name === 'AGENTS.md' && hasMainDoc) {
      console.log('  el bloque orca-stack ahora lleva el contrato de trabajo completo')
    }
    if (dryRun) {
      continue
    }
    if (existsSync(file)) {
      const saved = copyToBackup(home, stamp, file)
      console.log(`  respaldo -> ${tilde(saved, home)}`)
    }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
    written.push(name)
  }

  const failed = await installLint({
    root, home, stamp, dryRun, prefix, written,
    activarHook: flags.activarHook === true,
    ask: 'ask' in io ? io.ask : ttyAsk(),
    env: io.env ?? process.env,
  })

  const git = which('git')
  let commonDir = path.join(root, '.git')
  if (git) {
    const res = run(git, ['rev-parse', '--git-common-dir'], { cwd: root, timeout: 10_000, env: process.env })
    if (res.status === 0) commonDir = path.resolve(root, res.stdout.trim())
  }
  const exclude = path.join(commonDir, 'info', 'exclude')
  const excludeText = readTextIfExists(exclude)
  const hasExclude = (excludeText ?? '').split(/\r?\n/).some(line => line.trim() === CANDIDATE_WORKTREES_EXCLUDE)
  if (hasExclude) {
    console.log(`info/exclude: ya ignora ${CANDIDATE_WORKTREES_EXCLUDE}`)
  } else {
    console.log(`${prefix}agrego ${CANDIDATE_WORKTREES_EXCLUDE} a info/exclude`)
    if (!dryRun) {
      mkdirSync(path.dirname(exclude), { recursive: true })
      const text = excludeText ?? ''
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      const base = text === '' || text.endsWith('\n') ? text : text + eol
      writeFileSync(exclude, `${base}${CANDIDATE_WORKTREES_EXCLUDE}${eol}`)
    }
  }
  const negation = findGitignoreNegation(root)
  const ignored = git ? run(git, ['check-ignore', '-q', CANDIDATE_WORKTREES_PROBE], { cwd: root, timeout: 5_000, env: process.env }).status === 0 : true
  if (negation || (!dryRun && !ignored)) {
    console.log(`⚠ git no ignora ${CANDIDATE_WORKTREES_EXCLUDE} (un .gitignore con \`${negation ?? '!.claude/worktrees/'}\` gana sobre info/exclude)`)
  }
  if (!hasMainDoc) {
    console.log(`⚠ falta ${MAIN_DOC}, con las reglas de main a las que apunta el bloque: corré \`orca-stack global\``)
  }

  console.log(
    `\nListo. Editá ${PROJECT_CONFIG} (reglas del proyecto, se commitea) y ${PROJECT_LOCAL_CONFIG} (local, ignorado).\n` +
      'Las claves están explicadas en el README: https://github.com/Gagaismo/orca-stack#configuración-en-tres-capas',
  )
  if (failed.length > 0) {
    console.log(`✖ lint: no se escribió ${failed.join(', ')}; arreglá el problema y volvé a correr orca-stack init, que completa lo que falta sin duplicar nada`)

    return 1
  }

  return 0
}
