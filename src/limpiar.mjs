import { repoWorktrees, stackAgent } from './avisar.mjs'
import { getCommonDir } from './consultas.mjs'
import { defaultIo } from './despacho.mjs'
import { samePath } from './util.mjs'

// `orca-stack limpiar` (S13, MAIN.md step 9): closes the terminals of and removes every worktree of this repo whose PR
// merged or closed, through Orca. It never forces a removal, never deletes a branch (Orca keeps the local one; remote
// branches are never touched) and skips a dirty worktree or one with a live agent. A removed worktree is gone from
// `git worktree list`, so a second run removes nothing.
const LIVE = new Set(['working', 'running', 'active', 'blocked', 'waiting'])
const REVIEW_NAME = /^revision-(\d+)-[^/\\]+$/
const ENDED = { MERGED: 'mergeado', CLOSED: 'cerrado' }

const detail = res => (res.stderr || res.stdout || String(res.error ?? '')).trim().split(/\r?\n/)[0]
const parse = res => {
  try {
    return JSON.parse(res.stdout)
  } catch {
    return undefined
  }
}
const baseName = file => String(file).replace(/[\\/]+$/, '').split(/[\\/]/).pop()

// The PR of a worktree: the newest one on its branch (any open one keeps it alive), or for a review worktree the PR its
// name carries (`revision-<pr>-<agent>`), read on its own when the list does not have it.
const prOf = ({ row, branch }, prs, root, io) => {
  const onBranch = branch ? prs.filter(pr => pr.headRefName === branch) : []
  if (onBranch.length > 0) return onBranch.find(pr => pr.state === 'OPEN') ?? onBranch.sort((a, b) => b.number - a.number)[0]
  const named = REVIEW_NAME.exec(baseName(row.path))?.[1]
  if (!named) return undefined
  const listed = prs.find(pr => String(pr.number) === named)
  if (listed) return listed
  const res = io.sh('gh', ['pr', 'view', named, '--json', 'number,state,headRefName'], { cwd: root })

  return res.status === 0 ? parse(res) : undefined
}

export const limpiarCommand = async (flags = {}, io = defaultIo()) => {
  const warn = io.err ?? (message => console.error(message))
  const { root } = getCommonDir(io)
  const ours = repoWorktrees(root, io).filter(({ row }) => !samePath(row.path, root))
  const res = io.sh('gh', ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state,headRefName'], { cwd: root })
  const prs = res.status === 0 ? parse(res) : undefined
  if (!Array.isArray(prs)) throw new Error(`No pude listar los PRs con gh pr list: ${detail(res)}. No toqué nada.`)

  let touched = false
  let failed = false
  for (const worktree of ours) {
    const pr = prOf(worktree, prs, root, io)
    const ended = ENDED[pr?.state]
    if (!ended) continue
    touched = true
    const where = worktree.row.path
    const why = `PR #${pr.number} ${ended}`
    const live = (worktree.row.agents ?? []).find(agent => LIVE.has(String(agent.state ?? agent.status ?? '').toLowerCase()))
    if (live) {
      io.out(`Omito ${where} (${why}): ${stackAgent(live.agentType ?? 'un agente')} está ${String(live.state ?? live.status).toLowerCase()}.`)
      continue
    }
    const status = io.sh('git', ['status', '--porcelain'], { cwd: where })
    if (status.status !== 0) {
      io.out(`Omito ${where} (${why}): no pude leer su estado con git status (${detail(status)}).`)
      continue
    }
    if (status.stdout.trim() !== '') {
      io.out(`Omito ${where} (${why}): tiene cambios sin commitear.`)
      continue
    }
    if (flags.dryRun) {
      io.out(`[simulación] cerraría las terminales y sacaría ${where} (${why}).`)
      continue
    }
    const closed = io.sh('orca', ['terminal', 'close', '--worktree', `path:${where}`, '--all', '--json'])
    if (closed.status !== 0) {
      warn(`✖ No pude cerrar las terminales de ${where} (${detail(closed)}): no saqué el worktree.`)
      failed = true
      continue
    }
    const removed = io.sh('orca', ['worktree', 'rm', '--worktree', `path:${where}`, '--json'])
    if (removed.status !== 0) {
      warn(`✖ Cerré las terminales de ${where}, pero no pude sacar el worktree (${detail(removed)}).`)
      failed = true
      continue
    }
    io.out(`Cerré las terminales y saqué ${where} (${why}).`)
  }
  if (!touched) io.out('Nada para limpiar.')

  return failed ? 1 : 0
}
