import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { dispatch } from '../src/despacho.mjs'
import { candidateWorktreesStatus, CANDIDATE_WORKTREES_EXCLUDE, CANDIDATE_WORKTREES_PROBE } from '../src/candidate-worktrees.mjs'
import { cleanup, cli, git, read, tempDir, write } from './helpers.mjs'

const PROJECT = {
  setup: 'completo',
  modo: 'multiagente',
  ramaBase: 'main',
  agentes: { usa: ['claude', 'agy', 'codex', 'codex-cc', 'pi'], preguntarAntes: [] },
  verificacion: { suite: 'npm test', typecheck: 'ninguno' },
}

let home
let root
let worktreeDir

beforeEach(() => {
  home = tempDir('cw-home')
  root = path.join(tempDir('cw-root'), 'repo')
  worktreeDir = path.join(tempDir('cw-wt'), 'repo-42')
  write(path.join(root, 'README.md'), '# repo\n')
  write(path.join(root, '.orca-stack.json'), JSON.stringify(PROJECT))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'remote', 'add', 'origin', 'https://github.com/Gagaismo/orca-stack.git')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'initial')
  if (existsSync(excludePath(root))) {
    cleanup(excludePath(root))
  }
})

afterEach(() => {
  for (const dir of [home, path.dirname(root), path.dirname(worktreeDir)]) {
    cleanup(dir)
  }
})

const excludePath = repoRoot => path.join(repoRoot, '.git', 'info', 'exclude')
const hasExclude = repoRoot => existsSync(excludePath(repoRoot)) && read(excludePath(repoRoot)).includes(CANDIDATE_WORKTREES_EXCLUDE)

const makeFakeIo = (repoRoot, wtDir, over = {}) => {
  const calls = []
  const out = []
  const written = []
  const io = {
    home,
    cwd: repoRoot,
    win: process.platform === 'win32',
    out: line => out.push(line),
    sleep: async () => {},
    exists: existsSync,
    readFile: file => readFileSync(file, 'utf8'),
    listFiles: () => [],
    mkdirp: dir => mkdirSync(dir, { recursive: true }),
    writeFile: (file, text) => {
      written.push([file, text])
      write(file, text)
    },
    gentleSkills: () => null,
    sh: (cmd, args, opts = {}) => {
      calls.push([cmd, ...args])
      const key = `${cmd} ${args[0]} ${args[1] ?? ''}`.trim()
      const found = over[key] ?? over[`${cmd} ${args[0]}`]
      const custom = typeof found === 'function' ? found(args, opts) : found
      if (custom) return custom
      if (cmd === 'git') {
        if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' }
        if (args[0] === 'ls-tree') return { status: 0, stdout: 'README.md\n.orca-stack.json\n', stderr: '' }
        const res = git(opts.cwd ?? repoRoot, ...args)
        return { status: res.status ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
      }
      if (cmd === 'gh' && args[0] === 'issue') {
        return { status: 0, stdout: JSON.stringify({ state: 'OPEN', assignees: [], title: 't' }), stderr: '' }
      }
      if (args.join(' ') === 'worktree ps --json') {
        return { status: 0, stdout: JSON.stringify({ result: { worktrees: [] } }), stderr: '' }
      }
      if (args.join(' ').startsWith('worktree create')) {
        git(repoRoot, 'worktree', 'add', '-q', '-b', 'repo-42', wtDir)
        return { status: 0, stdout: JSON.stringify({ result: { worktree: { path: wtDir, branch: 'refs/heads/repo-42' } } }), stderr: '' }
      }
      if (args[0] === 'terminal' && args[1] === 'create') {
        return { status: 0, stdout: JSON.stringify({ result: { terminal: { handle: 'term_1' } } }), stderr: '' }
      }
      if (args[0] === 'terminal' && args[1] === 'send' && args.includes('--wait-submit')) {
        return { status: 0, stdout: JSON.stringify({ result: { submission: 'submitted', turnStarted: true } }), stderr: '' }
      }
      if (args[0] === 'terminal' && args[1] === 'read') {
        return { status: 0, stdout: JSON.stringify({ id: `req-${calls.length}`, ok: true, result: { terminal: { tail: ['ready'] } } }), stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  }
  return { io, calls, out, written }
}

describe('candidate worktrees: issue #161', () => {
  test('Rule 1: despachar writes /.claude/worktrees/ once to info/exclude; check-ignore succeeds from main and worktree of #42', async () => {
    assert.equal(existsSync(excludePath(root)), false)

    const env = makeFakeIo(root, worktreeDir)
    const status = await dispatch('ticket', { n: '42', agent: 'claude' }, env.io)
    assert.equal(status, 0)

    assert.equal(existsSync(excludePath(root)), true)
    const content = read(excludePath(root))
    assert.ok(content.includes(CANDIDATE_WORKTREES_EXCLUDE))

    // git check-ignore succeeds from main checkout
    const checkMain = git(root, 'check-ignore', CANDIDATE_WORKTREES_PROBE)
    assert.equal(checkMain.status, 0, checkMain.stdout + checkMain.stderr)

    // git check-ignore succeeds from worktree of #42
    const checkWt = git(worktreeDir, 'check-ignore', CANDIDATE_WORKTREES_PROBE)
    assert.equal(checkWt.status, 0, checkWt.stdout + checkWt.stderr)
  })

  test('Rule 2: a second dispatch writes no second line', async () => {
    const env1 = makeFakeIo(root, worktreeDir)
    await dispatch('ticket', { n: '42', agent: 'claude' }, env1.io)
    const content1 = read(excludePath(root))
    const occurrences1 = content1.split(/\r?\n/).filter(line => line.trim() === CANDIDATE_WORKTREES_EXCLUDE).length
    assert.equal(occurrences1, 1)

    const wt2 = path.join(tempDir('cw-wt2'), 'repo-43')
    const env2 = makeFakeIo(root, wt2)
    await dispatch('ticket', { n: '43', agent: 'claude' }, env2.io)
    const content2 = read(excludePath(root))
    const occurrences2 = content2.split(/\r?\n/).filter(line => line.trim() === CANDIDATE_WORKTREES_EXCLUDE).length
    assert.equal(occurrences2, 1)
    cleanup(path.dirname(wt2))
  })

  test('Rule 3: with !.claude/worktrees/ in tracked .gitignore, despachar warns and dispatches anyway (exit 0)', async () => {
    write(path.join(root, '.gitignore'), '!.claude/worktrees/\n')
    git(root, 'add', '.gitignore')
    git(root, 'commit', '-q', '-m', 'add negation')

    const env = makeFakeIo(root, worktreeDir)
    const status = await dispatch('ticket', { n: '42', agent: 'claude' }, env.io)
    assert.equal(status, 0)

    const warnLine = env.out.find(l => l.includes('git no ignora /.claude/worktrees/'))
    assert.ok(warnLine, `Expected warning line about negation in out:\n${env.out.join('\n')}`)
    assert.match(warnLine, /!\.claude\/worktrees\//)
    assert.match(warnLine, /gana sobre info\/exclude/)
  })

  test('Rule 4: init writes the same entry to info/exclude', () => {
    assert.equal(existsSync(excludePath(root)), false)

    const res = cli(home, ['init'], { cwd: root })
    assert.equal(res.status, 0, res.out)

    assert.equal(existsSync(excludePath(root)), true)
    const content = read(excludePath(root))
    assert.ok(content.includes(CANDIDATE_WORKTREES_EXCLUDE))

    const check = git(root, 'check-ignore', CANDIDATE_WORKTREES_PROBE)
    assert.equal(check.status, 0, check.stdout + check.stderr)

    // Second init is idempotent
    const res2 = cli(home, ['init'], { cwd: root })
    assert.equal(res2.status, 0, res2.out)
    const content2 = read(excludePath(root))
    const occurrences = content2.split(/\r?\n/).filter(line => line.trim() === CANDIDATE_WORKTREES_EXCLUDE).length
    assert.equal(occurrences, 1)
  })

  test('Rule 5: doctor says entry is missing, overridden by .gitignore, and passes when git ignores path', () => {
    // 1. Missing entry
    assert.equal(existsSync(excludePath(root)), false)
    const doctorMissing = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: root })
    assert.match(doctorMissing.out, /candidate worktrees|worktrees/)
    assert.match(doctorMissing.out, /missing|falta/)

    // 2. Passes when git ignores path
    write(excludePath(root), `${CANDIDATE_WORKTREES_EXCLUDE}\n`)
    const doctorOk = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: root })
    assert.match(doctorOk.out, /✔.*(?:candidate worktrees|worktrees)/)
    assert.match(doctorOk.out, /ignorado/)

    // 3. Overridden by .gitignore
    write(path.join(root, '.gitignore'), '!.claude/worktrees/\n')
    git(root, 'add', '.gitignore')
    git(root, 'commit', '-q', '-m', 'add negation')
    const doctorOverridden = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: root })
    assert.match(doctorOverridden.out, /⚠.*(?:candidate worktrees|worktrees)/)
    assert.match(doctorOverridden.out, /overridden|anulado/)
  })

  test('Rule 6: --dry-run on despachar and init prints action and writes nothing', async () => {
    // despachar --dry-run
    const env = makeFakeIo(root, worktreeDir)
    const status = await dispatch('ticket', { n: '42', agent: 'claude', dryRun: true }, env.io)
    assert.equal(status, 0)
    assert.equal(existsSync(excludePath(root)), false)
    const dryDispatchOut = env.out.join('\n')
    assert.match(dryDispatchOut, /\[simulación\].*agrega \/\.claude\/worktrees\//)

    // init --dry-run
    const initRes = cli(home, ['init', '--dry-run'], { cwd: root })
    assert.equal(initRes.status, 0, initRes.out)
    assert.equal(existsSync(excludePath(root)), false)
    assert.match(initRes.out, /\[simulación\].*agrego \/\.claude\/worktrees\//)
  })

  test('Rule 7 (preserve): doctor candidateWorktreesStatus helper unit tests', () => {
    // Direct unit test of status helper
    assert.equal(existsSync(excludePath(root)), false)
    const missing = candidateWorktreesStatus(root)
    assert.equal(missing.level, 'warn')
    assert.match(missing.detail, /missing|falta/)

    write(excludePath(root), `${CANDIDATE_WORKTREES_EXCLUDE}\n`)
    const ok = candidateWorktreesStatus(root)
    assert.equal(ok.level, 'ok')

    write(path.join(root, '.gitignore'), '!.claude/worktrees/\n')
    const overridden = candidateWorktreesStatus(root)
    assert.equal(overridden.level, 'warn')
    assert.match(overridden.detail, /overridden|anulado/)
  })
})
