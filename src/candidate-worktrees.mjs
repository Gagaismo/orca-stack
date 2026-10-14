import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { run, which } from './util.mjs'

export const CANDIDATE_WORKTREES_EXCLUDE = '/.claude/worktrees/'
export const CANDIDATE_WORKTREES_PROBE = '.claude/worktrees/agent-x'

export const findGitignoreNegation = (root, io) => {
  const file = path.join(root, '.gitignore')
  const exists = io?.exists ?? existsSync
  const read = io?.readFile ?? (f => readFileSync(f, 'utf8'))
  if (!exists(file)) return null
  try {
    const content = read(file)
    const line = content.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('!') && l.includes('.claude/worktrees'))
    return line ?? null
  } catch {
    return null
  }
}

export const ensureCandidateWorktreesExclude = ({ root, commonDir, io, dryRun = false, say = io?.out ?? console.log }) => {
  const isCandidateIgnored = () => {
    if (io?.sh) {
      return io.sh('git', ['check-ignore', '-q', CANDIDATE_WORKTREES_PROBE], { cwd: root }).status === 0
    }
    const git = which('git')
    return git ? run(git, ['check-ignore', '-q', CANDIDATE_WORKTREES_PROBE], { cwd: root, timeout: 5_000, env: process.env }).status === 0 : false
  }

  const exists = io?.exists ?? existsSync
  const read = io?.readFile ?? (f => readFileSync(f, 'utf8'))
  const write = io?.writeFile ?? writeFileSync
  const mkdirp = io?.mkdirp ?? (dir => mkdirSync(dir, { recursive: true }))

  if (!isCandidateIgnored()) {
    const exclude = path.join(commonDir, 'info', 'exclude')
    const text = exists(exclude) ? read(exclude) : ''
    if (!text.split(/\r?\n/).some(l => l.trim() === CANDIDATE_WORKTREES_EXCLUDE)) {
      say(`${dryRun ? '[simulación] ' : ''}agrega ${CANDIDATE_WORKTREES_EXCLUDE} a ${exclude}`)
      if (!dryRun) {
        mkdirp(path.dirname(exclude))
        write(exclude, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${CANDIDATE_WORKTREES_EXCLUDE}\n`)
      }
    }
    const negation = findGitignoreNegation(root, io)
    if (negation || (!dryRun && !isCandidateIgnored())) {
      say(`⚠ git no ignora ${CANDIDATE_WORKTREES_EXCLUDE} (un .gitignore con \`${negation ?? '!.claude/worktrees/'}\` gana sobre info/exclude)`)
    }
  }
}

export const candidateWorktreesStatus = (root, { io, git = which('git') } = {}) => {
  const exists = io?.exists ?? existsSync
  const read = io?.readFile ?? (f => readFileSync(f, 'utf8'))

  let commonDir
  if (io?.sh) {
    const res = io.sh('git', ['rev-parse', '--git-common-dir'], { cwd: root })
    if (res.status !== 0) return null
    commonDir = path.resolve(root, res.stdout.trim())
  } else {
    if (!git) return null
    const res = run(git, ['rev-parse', '--git-common-dir'], { cwd: root, timeout: 5_000, env: process.env })
    if (res.status !== 0) return null
    commonDir = path.resolve(root, res.stdout.trim())
  }

  const exclude = path.join(commonDir, 'info', 'exclude')
  const excludeText = exists(exclude) ? read(exclude) : ''
  const hasEntry = excludeText.split(/\r?\n/).some(line => line.trim() === CANDIDATE_WORKTREES_EXCLUDE)

  let ignored = false
  if (io?.sh) {
    ignored = io.sh('git', ['check-ignore', '-q', CANDIDATE_WORKTREES_PROBE], { cwd: root }).status === 0
  } else {
    ignored = run(git, ['check-ignore', '-q', CANDIDATE_WORKTREES_PROBE], { cwd: root, timeout: 5_000, env: process.env }).status === 0
  }

  if (ignored) {
    return { level: 'ok', detail: 'ignorado por git' }
  }

  const negation = findGitignoreNegation(root, io)
  if (hasEntry || negation) {
    return {
      level: 'warn',
      detail: `anulado por .gitignore (overridden by .gitignore: un .gitignore con \`${negation ?? '!.claude/worktrees/'}\` gana sobre info/exclude)`,
    }
  }

  return {
    level: 'warn',
    detail: 'falta la entrada en info/exclude (entry is missing; corré `orca-stack init`)',
  }
}
