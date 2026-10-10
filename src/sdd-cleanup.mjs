import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'

// Exact paths observed in the supported Claude/Gentle AI home layouts. Never infer
// candidates from an sdd-* glob: unknown user files are deliberately out of scope.
const PHASE_NAMES = ['apply', 'archive', 'design', 'explore', 'init', 'onboard', 'propose', 'research', 'spec', 'tasks', 'verify']
const GENTLE_SDD_NAMES = ['apply', 'archive', 'continue', 'explore', 'ff', 'init', 'new', 'onboard', 'research', 'status', 'verify']

const knownPaths = [
  ...PHASE_NAMES.map(name => `.claude/agents/sdd-${name}.md`),
  ...PHASE_NAMES.map(name => `.claude/skills/sdd-${name}`),
  ...['sdd-orchestrator-sections.md', 'sdd-orchestrator-workflow.md', 'sdd-phase-common.md', 'sdd-status-contract.md']
    .map(name => `.claude/skills/_shared/${name}`),
  ...PHASE_NAMES.map(name => `.agents/skills/sdd-${name}`),
  ...GENTLE_SDD_NAMES.map(name => `.claude/commands/gentle-sdd-${name}.md`),
  ...GENTLE_SDD_NAMES.map(name => `.claude/skills/gentle-sdd-${name}`),
]

const absolutePaths = home => knownPaths.map(relative => ({ relative, absolute: path.join(home, ...relative.split('/')) }))

export const knownSddLeftovers = home => absolutePaths(home)
  .filter(({ absolute }) => existsSync(absolute))
  .map(({ relative, absolute }) => ({ relative, absolute }))

const timestamp = date => date.toISOString().slice(0, 16).replace(/[-:T]/g, '')

export const cleanupKnownSdd = (home, { dryRun = false, now = new Date(), say = console.log, move = renameSync } = {}) => {
  const found = knownSddLeftovers(home)
  if (found.length === 0) {
    say('No hay restos SDD conocidos; no hay nada para respaldar.')

    return { status: 0, moved: [], failures: [] }
  }
  if (dryRun) {
    say(`Se respaldar\u00EDan ${found.length} restos SDD conocidos; no se movi\u00F3 ning\u00FAn archivo.`)

    return { status: 0, moved: [], failures: [] }
  }

  const backupsDir = path.join(home, '.orca-stack', 'backups')
  const base = `sdd-${timestamp(now)}`
  let backupRoot = path.join(backupsDir, base)
  for (let suffix = 1; existsSync(backupRoot); suffix += 1) {
    backupRoot = path.join(backupsDir, `${base}-${suffix}`)
  }

  const moved = []
  const failures = []
  for (const { relative, absolute } of found) {
    const destination = path.join(backupRoot, ...relative.split('/'))
    try {
      mkdirSync(path.dirname(destination), { recursive: true })
      move(absolute, destination)
      moved.push(relative)
      say(`Respaldado ${relative} -> ${path.relative(home, destination)}`)
    } catch (error) {
      failures.push({ relative, message: error instanceof Error ? error.message : String(error) })
      say(`No se pudo respaldar ${relative}: ${failures.at(-1).message}`)
    }
  }

  if (failures.length > 0) {
    say(`Se respaldaron ${moved.length} restos SDD; ${failures.length} fallaron y siguen en su lugar. Volv\u00E9 a ejecutar orca-stack global --limpiar-sdd para reintentar.`)

    return { status: 1, moved, failures, backupRoot }
  }
  say(`Se respaldaron ${moved.length} restos SDD conocidos en ${path.relative(home, backupRoot)}.`)

  return { status: 0, moved, failures, backupRoot }
}
