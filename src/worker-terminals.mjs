import { WRAPPERS } from './constants.mjs'
import { AGENTS } from './despacho.mjs'
import { samePath } from './util.mjs'

const parse = res => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    return undefined
  }
}
const detail = res => (res.stderr || res.stdout || String(res.error ?? '')).trim().split(/\r?\n/)[0]

export const worktreeRows = io => {
  const res = io.sh('orca', ['worktree', 'ps', '--json'])
  const rows = res.status === 0 ? parse(res)?.result?.worktrees : undefined
  if (!Array.isArray(rows)) throw new Error(`Orca no contesta (orca worktree ps): ${detail(res)}`)

  return rows
}

export const paneAgents = row => new Map((row?.agents ?? []).map(agent => [agent.paneKey, agent]))

// #191: Orca's issue:<n> and branch:<head> selectors span every repo Orca manages, so a worker's worktree is picked among this repo's own worktrees (`git worktree list`).
export const repoWorktrees = (root, io) => {
  const listed = io.sh('git', ['worktree', 'list', '--porcelain'], { cwd: root })
  if (listed.status !== 0) throw new Error(`git worktree list falló: ${detail(listed)}`)
  const mine = listed.stdout.split(/\r?\n\s*\r?\n/).map(entry => ({ path: /^worktree (.+)$/m.exec(entry)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] })).filter(entry => entry.path)

  return worktreeRows(io).flatMap(row => {
    const git = row.path ? mine.find(entry => samePath(entry.path, row.path)) : undefined
    return git ? [{ row, branch: git.branch }] : []
  })
}

export const workerTerminals = (worktree, n, io) => {
  const res = io.sh('orca', ['terminal', 'list', '--worktree', `path:${worktree}`, '--json'])
  const terminals = res.status === 0 ? parse(res)?.result?.terminals : undefined
  if (!Array.isArray(terminals)) throw new Error(`orca terminal list falló para #${n}: ${detail(res)}`)
  const stray = terminals.find(terminal => !terminal.worktreePath || !samePath(terminal.worktreePath, worktree))
  if (stray) throw new Error(`Orca devolvió la terminal ${stray.handle} con worktreePath ${stray.worktreePath ?? '(ninguno)'}, no ${worktree}.`)

  return terminals
}

// #330: Orca names some agents differently from the stack (WRAPPERS[agent].orcaKey): Orca's antigravity is agy.
export const stackAgent = raw => Object.keys(WRAPPERS).find(agent => WRAPPERS[agent].orcaKey === raw) ?? raw

export const identityOf = (terminal, record) => stackAgent((AGENTS.includes(terminal.title) ? terminal.title : undefined) ?? record?.agentType ?? terminal.agentIdentity)

export const readScreen = (io, handle) => {
  const res = io.sh('orca', ['terminal', 'read', '--terminal', handle, '--screen', '--json'])
  const tail = res.status === 0 ? parse(res)?.result?.terminal?.tail : undefined
  if (tail === undefined) throw new Error(`No pude leer la pantalla de ${handle}: ${detail(res)}`)

  return (Array.isArray(tail) ? tail.join('\n') : String(tail)).split(/\r?\n/)
}
