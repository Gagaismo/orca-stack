// Replays the counterexamples of formal/rebote/Rebote.tla against the real reboteCommand (src/despacho.mjs).
// The scaffolding (PROJECT, fakeIo) is copied from test/despacho.test.mjs lines 13-150; only the `replay:` tests are new.
// Run: node --test formal/rebote/replay.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { reboteCommand } from '../../src/despacho.mjs'
import { cleanup, tempDir, write } from '../../test/helpers.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = (stdout = '') => ({ status: 0, stdout, stderr: '' })

const PROJECT = {
  setup: 'completo',
  modo: 'multiagente',
  ramaBase: 'main',
  agentes: { usa: ['claude', 'agy', 'codex', 'pi'], preguntarAntes: [], pi: { perfil: 'global' } },
  verificacion: { suite: 'npm test -- --run', typecheck: 'npm run typecheck' },
}

let home
let root
let worktree
beforeEach(() => {
  home = tempDir('despacho-home')
  root = path.join(tempDir('despacho-root'), 'proj')
  worktree = path.join(tempDir('despacho-wt'), 'proj-7')
  write(path.join(root, 'x'), '')
  write(path.join(worktree, 'src', 'app.ts'), '')
  // PROJECT sends pi to the active global profile, which has to exist and pass the provider rule.
  write(path.join(home, '.pi', 'gentle-ai', 'profiles.json'), JSON.stringify({ active: 'default', profiles: { default: { orchestrator: { model: 'claude-bridge/claude-opus-5-5' } } } }))
})
afterEach(() => {
  for (const dir of [home, path.dirname(root), path.dirname(worktree)]) cleanup(dir)
})

// A scripted environment: every external call is recorded; `over` answers specific ones ("cmd arg0 [arg1]").
// piTools 'missing': the pi launch leaves no session, as when pi never started.
const fakeIo = (over = {}, { config = PROJECT, piTools = 'available' } = {}) => {
  write(path.join(root, '.orca-stack.json'), JSON.stringify(config))
  const calls = []
  const out = []
  const written = []
  const sleeps = []
  const sessionRoot = path.join(home, '.pi', 'agent', 'sessions')
  const sessionDir = path.join(sessionRoot, 'project')
  const sessionFile = path.join(sessionDir, '2026-10-09T00-00-00-000Z_session.jsonl')
  const files = new Map()
  const modified = new Map()
  const io = {
    home,
    cwd: root,
    win: true,
    modifiedAt: file => modified.get(file) ?? 0,
    out: line => out.push(line),
    sleep: async ms => { sleeps.push(ms) },
    exists: existsSync,
    readFile: file => files.get(file) ?? readFileSync(file, 'utf8'),
    listFiles: dir => dir === sessionRoot ? [sessionDir] : dir === sessionDir ? [...files.keys()].filter(file => path.dirname(file) === sessionDir) : [],
    mkdirp: () => {},
    writeFile: (file, text) => {
      written.push([file, text])
      write(file, text)
    },
    rename: renameSync,
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      const found = over[`${cmd} ${args[0]} ${args[1] ?? ''}`.trim()] ?? over[`${cmd} ${args[0]}`]
      const custom = typeof found === 'function' ? found(args) : found
      if (custom) return custom
      if (cmd === 'git' && args[0] === 'ls-files') return { status: 1, stdout: '', stderr: '' } // not tracked
      if (cmd === 'git' && args[0] === 'rev-parse') return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nbranch refs/heads/main\n`)
      if (cmd === 'git' && args[0] === 'remote') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'git') return okRes('src/app.ts\n')
      if (cmd === 'gh' && args[0] === 'issue') return json({ state: 'OPEN', assignees: [], title: 't' })
      if (args.join(' ') === 'worktree ps --json') return json({ result: { worktrees: [] } })
      if (args.join(' ').startsWith('worktree create')) return json({ result: { worktree: { path: worktree, branch: 'refs/heads/proj-7' } } })
      if (args[0] === 'terminal' && args[1] === 'create') {
        if (/(^|; )pi /.test(String(args[args.indexOf('--command') + 1] ?? '')) && piTools !== 'missing') {
          const text = piTools === 'none' ? '<tools>\n(none)' : '<tools>\n- read: Read file contents\n- bash: Execute commands'
          files.set(sessionFile, [
            JSON.stringify({ type: 'session', cwd: worktree }),
            '{}', '{}', '{}', JSON.stringify({ type: 'message', message: { role: 'system', content: '', sections: { tools: text } } }),
          ].join('\n'))
          modified.set(sessionFile, Date.now() + 1)
        }
        return json({ result: { terminal: { handle: 'term_1' } } })
      }
      if (args[0] === 'terminal' && args[1] === 'send' && args.includes('--wait-submit')) return json({ result: { submission: 'submitted', turnStarted: true } })
      if (args[0] === 'terminal' && args[1] === 'read') return json({ id: `req-${calls.length}`, ok: true, result: { terminal: { tail: ['ready'], latestCursor: calls.length } } })
      return okRes()
    },
  }
  // Calls that change something: every gh issue edit, orca worktree create, terminal create/send, git fetch.
  const writes = () =>
    calls.filter(c => (c[0] === 'gh' && c[2] === 'edit') || (c[0] === 'orca' && (c[2] === 'create' || c[2] === 'send')) || (c[0] === 'git' && c[1] === 'fetch'))

  return { io, calls, out, written, writes, sleeps }
}

const pr = (overrides = {}) => ({
  state: 'OPEN', headRefName: 'feat/fix', headRefOid: 'abc123', body: 'Implementador: agy',
  statusCheckRollup: [], mergeable: 'MERGEABLE',
  reviews: [{ body: 'Revisor: codex\nCommit: abc123\n\n## BLOQUEA\n1. `src/app.mjs:1` (introducido, concreta, implementaci\u00F3n): fix it.\n\n## SUGERENCIAS\n(none)', url: 'https://example.test/review/1' }],
  comments: [], ...overrides,
})
const bounceEnv = (pull = pr(), extra = {}) => {
  const env = fakeIo({ 'gh pr view': json(pull), 'git worktree': okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD abc123\nbranch refs/heads/feat/fix\n`), 'git status': okRes(''), ...extra }, { config: PROJECT })
  const original = env.io.sh
  env.io.sh = (cmd, args, opts) => {
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return okRes(`${pull.headRefOid}\n`)
    return original(cmd, args, opts)
  }
  return env
}
const launches = env => env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'create').length
const commentFails = { 'gh pr comment': { status: 1, stdout: '', stderr: 'HTTP 502' } }

describe('replay: counterexamples of formal/rebote/Rebote.tla', () => {
  // Model: Push, ReboteCommentFails, AuthorExits, Rebote (rebote-commentfail.cfg, ConflictBounceOncePerHead).
  test('replay: a conflict bounce whose marker comment failed is repeated on the same head', async () => {
    const conflicted = pr({ mergeable: 'CONFLICTING', reviews: [] })
    const first = bounceEnv(conflicted, commentFails)
    await assert.rejects(reboteCommand({}, '12', first.io), /gh pr comment/)
    assert.equal(launches(first), 1, 'the author was launched although the marker was never posted')
    // The author exits without pushing; nothing in the PR says a conflict bounce happened.
    const second = bounceEnv(conflicted)
    await reboteCommand({}, '12', second.io)
    assert.equal(launches(second), 1, 'a second conflict bounce on the same head was launched')
  })

  // Model: ReboteCommentFails, Push, AuthorExits, ReviewPosts, Rebote (rebote-commentfail.cfg, ReviewBounceOnce).
  test('replay: a review bounce whose marker comment failed leaves room for a second review bounce on a later head', async () => {
    const first = bounceEnv(pr(), commentFails)
    await assert.rejects(reboteCommand({}, '12', first.io), /gh pr comment/)
    assert.equal(launches(first), 1)
    const advanced = bounceEnv(pr({ headRefOid: 'def456', reviews: [{ body: 'Commit: def456\n## BLOQUEA\n1. still broken', url: 'https://example.test/review/2' }] }))
    await reboteCommand({}, '12', advanced.io)
    assert.equal(launches(advanced), 1, 'a second review bounce on a different head was launched')
  })

  // Control: with the marker posted, the same head advance is refused (the guard at L974 works).
  test('control: with the marker posted, the second review bounce on a later head is refused', async () => {
    const advanced = bounceEnv(pr({ headRefOid: 'def456', comments: [{ body: 'Rebote: abc123' }], reviews: [{ body: 'Commit: def456\n## BLOQUEA\n1. still broken' }] }))
    await assert.rejects(reboteCommand({}, '12', advanced.io), /avanz\u00F3 desde el rebote/)
    assert.equal(launches(advanced), 0)
  })
})
