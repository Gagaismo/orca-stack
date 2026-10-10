import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'

// Exact paths observed in the supported Claude/Gentle AI home layouts. Never infer
// candidates from an sdd-* glob: unknown user files are deliberately out of scope.
const knownPaths = [
  ...['apply', 'archive', 'design', 'explore', 'init', 'onboard', 'propose', 'research', 'spec', 'tasks', 'verify']
    .map(name => `.claude/agents/sdd-${name}.md`),
  ...['apply', 'archive', 'design', 'explore', 'init', 'onboard', 'propose', 'research', 'spec', 'tasks', 'verify']
    .map(name => `.claude/skills/sdd-${name}`),
  ...['sdd-orchestrator-sections.md', 'sdd-orchestrator-workflow.md', 'sdd-phase-common.md', 'sdd-status-contract.md']
    .map(name => `.claude/skills/_shared/${name}`),
  ...['apply', 'archive', 'design', 'explore', 'init', 'onboard', 'propose', 'research', 'spec', 'tasks', 'verify']
    .map(name => `.agents/skills/sdd-${name}`),
  ...['apply', 'archive', 'continue', 'explore', 'ff', 'init', 'new', 'onboard', 'research', 'status', 'verify']
    .map(name => `.claude/commands/gentle-sdd-${name}.md`),
]

const absolutePaths = home => knownPaths.map(relative => ({ relative, absolute: path.join(home, ...relative.split('/')) }))

export const knownSddLeftovers = home => absolutePaths(home)
  .filter(({ absolute }) => existsSync(absolute))
  .map(({ relative, absolute }) => ({ relative, absolute }))

const timestamp = date => date.toISOString().slice(0, 16).replace(/[-:T]/g, '')

export const cleanupKnownSdd = (home, { dryRun = false, now = new Date(), say = console.log, move = renameSync } = {}) => {
  const found = knownSddLeftovers(home)
  if (found.length === 0) {
    say('No known SDD leftovers found; nothing to back up.')

    return { status: 0, moved: [], failures: [] }
  }
  if (dryRun) {
    say(`Would back up ${found.length} known SDD leftover(s); no files were moved.`)

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
      say(`Backed up ${relative} -> ${path.relative(home, destination)}`)
    } catch (error) {
      failures.push({ relative, message: error instanceof Error ? error.message : String(error) })
      say(`Failed to back up ${relative}: ${failures.at(-1).message}`)
    }
  }

  if (failures.length > 0) {
    say(`${moved.length} known SDD leftover(s) backed up; ${failures.length} failed and remain in place. Run orca-stack global --limpiar-sdd again to retry.`)

    return { status: 1, moved, failures, backupRoot }
  }
  say(`Backed up ${moved.length} known SDD leftover(s) to ${path.relative(home, backupRoot)}.`)

  return { status: 0, moved, failures, backupRoot }
}
