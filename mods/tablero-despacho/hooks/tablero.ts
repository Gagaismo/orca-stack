// Pure helpers for the dispatch board: parse gh/git output and word it in Spanish.

import type { TableroChecks, TableroPr } from '../types'

export const FIELDS =
  'number,title,headRefName,author,isDraft,reviewDecision,statusCheckRollup,updatedAt'

export const GITHUB_REMOTE = /github\.com[:/]/i

type Check = {
  status?: string
  conclusion?: string
  state?: string
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

export const summarizeChecks = (rollup: readonly Check[]): TableroChecks => {
  let failed = 0
  let pending = 0
  for (const check of rollup) {
    const verdict = (check.conclusion || check.state || check.status || '').toUpperCase()
    if (FAILED.has(verdict)) {
      failed += 1
    } else if (PENDING.has(verdict) || (check.status !== undefined && check.status !== 'COMPLETED')) {
      pending += 1
    }
  }
  const total = rollup.length
  if (total === 0) {
    return { state: 'none', done: 0, total: 0 }
  }
  if (failed > 0) {
    return { state: 'fail', done: failed, total }
  }
  if (pending > 0) {
    return { state: 'pending', done: total - pending, total }
  }

  return { state: 'ok', done: total, total }
}

export const checksText = (checks: TableroChecks): string =>
  ({
    none: 'sin checks',
    ok: `✓ ${checks.done}/${checks.total}`,
    fail: `✗ ${checks.done} rojo${checks.done === 1 ? '' : 's'} de ${checks.total}`,
    pending: `… ${checks.done}/${checks.total}`,
  })[checks.state]

export const reviewText = (review: TableroPr['review']): string =>
  ({
    approved: 'review aprobada',
    changes: 'cambios pedidos',
    required: 'review pendiente',
    none: 'sin review',
  })[review]

const reviewOf = (decision: string | undefined): TableroPr['review'] =>
  decision === 'APPROVED'
    ? 'approved'
    : decision === 'CHANGES_REQUESTED'
      ? 'changes'
      : decision === 'REVIEW_REQUIRED'
        ? 'required'
        : 'none'

type RawPr = {
  number: number
  title: string
  headRefName: string
  author?: { login?: string }
  isDraft?: boolean
  reviewDecision?: string
  statusCheckRollup?: Check[] | null
  updatedAt?: string
}

// branch -> folder name of the worktree that has it checked out
export const parseWorktrees = (porcelain: string): Map<string, string> => {
  const byBranch = new Map<string, string>()
  let path = ''
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch refs/heads/')) {
      byBranch.set(line.slice('branch refs/heads/'.length).trim(), path.split(/[\\/]/).pop() ?? path)
    }
  }

  return byBranch
}

export const parsePrs = (json: string, worktrees: Map<string, string>): TableroPr[] => {
  const raw = JSON.parse(json) as RawPr[]

  return raw.map(pr => ({
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    author: pr.author?.login ?? '?',
    isDraft: pr.isDraft === true,
    review: reviewOf(pr.reviewDecision),
    checks: summarizeChecks(pr.statusCheckRollup ?? []),
    updatedAt: Date.parse(pr.updatedAt ?? '') || 0,
    worktree: worktrees.get(pr.headRefName),
  }))
}

export const relativeTime = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) {
    return 'recién'
  }
  if (minutes < 60) {
    return `hace ${minutes} min`
  }
  if (minutes < 60 * 24) {
    return `hace ${Math.round(minutes / 60)} h`
  }

  return `hace ${Math.round(minutes / (60 * 24))} d`
}

export const bandText = (prs: readonly TableroPr[]): string => {
  const ready = prs.filter(pr => pr.review === 'approved').length
  const red = prs.filter(pr => pr.checks.state === 'fail').length
  const parts = [`${prs.length} abierto${prs.length === 1 ? '' : 's'}`]
  if (ready > 0) {
    parts.push(`${ready} con review lista`)
  }
  if (red > 0) {
    parts.push(`${red} con checks rojos`)
  }

  return `PRs: ${parts.join(' · ')}`
}

export type GhFailure = { kind: 'norepo' } | { kind: 'error'; message: string }

// Short Spanish message for a failed gh call.
export const explainGhFailure = (stderr: string): GhFailure => {
  if (/not a git repository|no git remotes|none of the git remotes|could not determine base repo/i.test(stderr)) {
    return { kind: 'norepo' }
  }
  if (/gh auth login|not logged in|authentication|GH_TOKEN|HTTP 401/i.test(stderr)) {
    return { kind: 'error', message: 'gh no está autenticado: corré gh auth login.' }
  }
  const first = stderr.trim().split(/\r?\n/)[0] ?? ''

  return { kind: 'error', message: `No pude leer los PRs${first === '' ? '.' : `: ${first.slice(0, 120)}`}` }
}

export const prompts = {
  review: (n: number): string => `Lanzá el review del PR #${n} con agy`,
  status: (n: number): string => `Fijate el PR #${n} y decime cómo está`,
  merge: (n: number): string => `Si no hay bloqueos, mergeá el PR #${n}`,
  gentle: (n: number): string => `Consultá a Gentle Shell sobre el PR #${n}`,
}
