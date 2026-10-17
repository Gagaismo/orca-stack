import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { briefRevisionCommand, dispatch, reboteCommand, renderBrief, parseRemoteUrl, getRemoteOrigin } from '../src/despacho.mjs'
import { cleanup, tempDir, write } from './helpers.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = (stdout = '') => ({ status: 0, stdout, stderr: '' })

const PROJECT = {
  setup: 'completo',
  modo: 'multiagente',
  ramaBase: 'main',
  agentes: { usa: ['claude', 'agy', 'codex', 'codex-cc', 'pi'], preguntarAntes: ['codex-cc'] },
  verificacion: { suite: 'npm test -- --run', typecheck: 'npm run typecheck' },
}

let home
let root
let worktree

beforeEach(() => {
  home = tempDir('remote-auth-home')
  root = path.join(tempDir('remote-auth-root'), 'proj')
  worktree = path.join(tempDir('remote-auth-wt'), 'proj-feat-x')
  write(path.join(root, 'x'), '')
  write(path.join(worktree, 'src', 'app.ts'), '')
})

afterEach(() => {
  for (const dir of [home, path.dirname(root), path.dirname(worktree)]) cleanup(dir)
})

const fakeIo = (over = {}, { config = PROJECT } = {}) => {
  write(path.join(root, '.orca-stack.json'), JSON.stringify(config))
  const calls = []
  const out = []
  const written = []
  const files = new Map()
  const io = {
    home,
    cwd: root,
    win: true,
    out: line => out.push(line),
    sleep: async () => {},
    exists: existsSync,
    readFile: file => files.get(file) ?? readFileSync(file, 'utf8'),
    listFiles: () => [],
    mkdirp: () => {},
    writeFile: (file, text) => {
      written.push([file, text])
      write(file, text)
    },
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    sh: (cmd, args, opts = {}) => {
      calls.push([cmd, ...args])
      const found = over[`${cmd} ${args[0]} ${args[1] ?? ''}`.trim()] ?? over[`${cmd} ${args[0]}`]
      const custom = typeof found === 'function' ? found(args) : found
      if (custom) return custom
      if (cmd === 'git' && args[0] === 'ls-files') return { status: 1, stdout: '', stderr: '' }
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('--path-format=absolute')) {
        return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') return okRes('abc123\n')
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return okRes('abc123\n')
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD abc123\nbranch refs/heads/feat/x\n`)
      if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'git' && args[0] === 'status') return okRes('')
      if (cmd === 'git') return okRes('src/app.ts\n')
      if (cmd === 'gh' && args[0] === 'issue') return json({ state: 'OPEN', assignees: [], title: 't' })
      if (cmd === 'gh' && args[0] === 'pr') return json({
        state: 'OPEN',
        number: 7,
        headRefName: 'feat/x',
        headRefOid: 'abc123',
        body: 'Implementador: codex\nCloses #7',
        reviews: [{ body: 'Commit: abc123\n## BLOQUEA\n1. fix this', url: 'https://github.com/Gagaismo/orca-stack/pull/7#pullrequestreview-1' }],
        statusCheckRollup: [],
      })
      if (args.join(' ') === 'worktree ps --json') return json({ result: { worktrees: [] } })
      if (args.join(' ').startsWith('worktree create')) return json({ result: { worktree: { path: worktree, branch: 'refs/heads/proj-7' } } })
      return okRes()
    },
  }
  const writes = () =>
    calls.filter(c => (c[0] === 'gh' && c[2] === 'edit') || (c[0] === 'orca' && (c[2] === 'create' || c[2] === 'send')) || (c[0] === 'git' && (c[1] === 'fetch' || c[2] === 'add')))

  return { io, calls, out, written, writes }
}

describe('remote authorization: parseRemoteUrl', () => {
  test('parses https, ssh, git and scp URLs to host and owner/repo', () => {
    assert.deepEqual(parseRemoteUrl('https://github.com/Gagaismo/orca-stack.git'), {
      host: 'github.com',
      ownerRepo: 'Gagaismo/orca-stack',
    })
    assert.deepEqual(parseRemoteUrl('https://github.com/Gagaismo/orca-stack'), {
      host: 'github.com',
      ownerRepo: 'Gagaismo/orca-stack',
    })
    assert.deepEqual(parseRemoteUrl('git@github.com:Gagaismo/orca-stack.git'), {
      host: 'github.com',
      ownerRepo: 'Gagaismo/orca-stack',
    })
    assert.deepEqual(parseRemoteUrl('git@github.com:Gagaismo/orca-stack'), {
      host: 'github.com',
      ownerRepo: 'Gagaismo/orca-stack',
    })
    assert.deepEqual(parseRemoteUrl('ssh://git@github.com/Gagaismo/orca-stack.git'), {
      host: 'github.com',
      ownerRepo: 'Gagaismo/orca-stack',
    })
    assert.deepEqual(parseRemoteUrl('https://ghe.example.com/Gagaismo/orca-stack.git'), {
      host: 'ghe.example.com',
      ownerRepo: 'Gagaismo/orca-stack',
    })
  })

  test('returns undefined for invalid, non-remote or unparseable URLs', () => {
    assert.equal(parseRemoteUrl(''), undefined)
    assert.equal(parseRemoteUrl('/local/path'), undefined)
    assert.equal(parseRemoteUrl('file:///path/to/repo'), undefined)
    assert.equal(parseRemoteUrl('https://github.com/'), undefined)
    assert.equal(parseRemoteUrl('https://github.com/orca-stack'), undefined)
    assert.equal(parseRemoteUrl('https://github.com/a/b/c'), undefined)
  })
})

describe('Reglas 1-8', () => {
  test('Regla 1: despachar on HTTPS origin authorizes gh and git credentials on github.com, repo Gagaismo/orca-stack, with ticket operations', async () => {
    const env = fakeIo({ 'git remote get-url': okRes('https://github.com/Gagaismo/orca-stack.git\n') })
    await dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes('## Remote authorization'))
    assert.ok(out.includes('- Destination: github.com, repository Gagaismo/orca-stack'))
    assert.ok(out.includes('- Credential/session: the GitHub CLI (`gh`) session and the git credentials already configured on this machine.'))
    assert.ok(out.includes('- Operations: read issue #7 and its comments and the repo; comment on the issue; push only the ticket branch to `origin`; open the PR against main.'))
  })

  test('Regla 2: despachar on SSH origin resolves the same host and owner/repo', async () => {
    const env = fakeIo({ 'git remote get-url': okRes('git@github.com:Gagaismo/orca-stack.git\n') })
    await dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes('- Destination: github.com, repository Gagaismo/orca-stack'))
    assert.ok(out.includes('- Credential/session: the GitHub CLI (`gh`) session and the git credentials already configured on this machine.'))
  })

  test('Regla 3: rebote authorizes reading PR, reviews, checks, failed logs, pushing PR branch and commenting on PR', async () => {
    const env = fakeIo({ 'git remote get-url': okRes('https://github.com/Gagaismo/orca-stack.git\n') })
    await reboteCommand({ dryRun: true }, '7', env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes('## Remote authorization'))
    assert.ok(out.includes('- Destination: github.com, repository Gagaismo/orca-stack'))
    assert.ok(out.includes('- Operations: read the PR, its reviews and checks (including `gh run view ... --log-failed`); push only the PR branch to `origin`; comment on the PR; `gh pr edit 7 --body-file <file>` for the PR body only.'))
  })

  test('Regla 4: revisar authorizes reading and publishing review only, and says no push', async () => {
    const env = fakeIo({
      'git remote get-url': okRes('https://github.com/Gagaismo/orca-stack.git\n'),
      'gh pr': json({ headRefName: 'feat/x', headRefOid: 'abc123', body: 'Implementador: codex\nCloses #7', number: 7 }),
    })
    await dispatch('review', { n: '7', agent: 'agy', dryRun: true }, env.io)
    const out = env.out.join('\n')

    assert.ok(out.includes('## Remote authorization'))
    assert.ok(out.includes('- Destination: github.com, repository Gagaismo/orca-stack'))
    assert.ok(out.includes('- Operations: read the PR, its diff, its checks and the issue it closes; publish the review with the command the brief already gives. No push.'))
  })

  test('Regla 5: brief-revision authorizes read-only and says main publishes', async () => {
    const env = fakeIo(
      {
        'git remote get-url': okRes('https://github.com/Gagaismo/orca-stack.git\n'),
        'gh pr': json({ number: 7, headRefOid: 'abc123', body: 'Implementador: codex' }),
        'git worktree list': okRes(`worktree ${root}\n`),
      },
      { config: { ...PROJECT, modo: 'un-agente' } },
    )
    await briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io)
    const briefPath = path.join(home, 'orca', 'briefs', 'proj-revision-7-subagente.md')
    const brief = readFileSync(briefPath, 'utf8')

    assert.ok(brief.includes('## Remote authorization'))
    assert.ok(brief.includes('- Destination: github.com, repository Gagaismo/orca-stack'))
    assert.ok(brief.includes('- Operations: read-only (PR, diff, checks, issue). main publishes the review. No push.'))
  })

  test('Regla 6: every brief lists what is not authorized (merge, force push, deleting branches or issues, other repos, remotes or hosts)', async () => {
    const notAuth = '- Explicitly not authorized: merge, force push, deleting branches or issues, other repos, remotes or hosts.'

    // ticket
    const ticketEnv = fakeIo()
    await dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, ticketEnv.io)
    assert.ok(ticketEnv.out.join('\n').includes(notAuth))

    // review
    const reviewEnv = fakeIo({
      'gh pr': json({ headRefName: 'feat/x', headRefOid: 'abc123', body: 'Implementador: codex\nCloses #7', number: 7 }),
    })
    await dispatch('review', { n: '7', agent: 'agy', dryRun: true }, reviewEnv.io)
    assert.ok(reviewEnv.out.join('\n').includes(notAuth))

    // rebote
    const reboteEnv = fakeIo()
    await reboteCommand({ dryRun: true }, '7', reboteEnv.io)
    assert.ok(reboteEnv.out.join('\n').includes(notAuth))

    // brief-revision
    const brEnv = fakeIo(
      {
        'gh pr': json({ number: 7, headRefOid: 'abc123', body: 'Implementador: codex' }),
        'git worktree list': okRes(`worktree ${root}\n`),
      },
      { config: { ...PROJECT, modo: 'un-agente' } },
    )
    await briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, brEnv.io)
    const brief = readFileSync(path.join(home, 'orca', 'briefs', 'proj-revision-7-subagente.md'), 'utf8')
    assert.ok(brief.includes(notAuth))
  })

  test('Regla 7: refuses before creating worktree or assigning issue when origin is missing or unparseable', async () => {
    // Missing origin
    const noRemote = fakeIo({ 'git remote get-url': { status: 1, stdout: '', stderr: 'fatal: No such remote' } })
    await assert.rejects(
      dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, noRemote.io),
      /remote.*origin/i,
    )
    assert.deepEqual(noRemote.writes(), [], 'no worktree creation or issue assignment on missing origin')

    // Unparseable origin
    const badRemote = fakeIo({ 'git remote get-url': okRes('/home/user/local-repo\n') })
    await assert.rejects(
      dispatch('ticket', { n: '7', agent: 'agy', dryRun: true }, badRemote.io),
      /host.*owner\/repo/i,
    )
    assert.deepEqual(badRemote.writes(), [], 'no worktree creation or issue assignment on bad origin')
  })

  test('Regla 8: --nota still renders after the authorization section, unchanged', async () => {
    const env = fakeIo()
    await dispatch('ticket', { n: '7', agent: 'agy', nota: 'Do not touch production DB', dryRun: true }, env.io)
    const out = env.out.join('\n')

    const authPos = out.indexOf('## Remote authorization')
    const notePos = out.indexOf('## Extra notes from main')
    assert.ok(authPos !== -1, 'has remote authorization section')
    assert.ok(notePos !== -1, 'has extra notes section')
    assert.ok(authPos < notePos, 'remote authorization renders before extra notes')
    assert.ok(out.includes('Do not touch production DB'))
  })
})

describe('PRESERVE: public entries touched in src/despacho.mjs', () => {
  test('renderBrief retains existing variable substitutions and defaults', () => {
    const brief = renderBrief('ticket', {
      REPO: 'orca-stack',
      ISSUE: '96',
      AGENT: 'agy',
      BRANCH: 'Gagaismo/orca-stack-96',
      BASE: 'main',
      VERIFICATION: 'npm test',
    })
    assert.ok(brief.includes('# Ticket brief: issue #96 (orca-stack)'))
    assert.ok(brief.includes('Repo: orca-stack. Your branch is Gagaismo/orca-stack-96'))
    assert.ok(brief.includes('Pull requests target main.'))
    assert.ok(brief.includes('gh pr create --base main --head Gagaismo/orca-stack-96'))
    assert.ok(brief.includes('Implementador: agy'))
    assert.ok(brief.includes('Closes #96'))
  })

  test('rebote retains findings and failed checks rendering', async () => {
    const env = fakeIo()
    await reboteCommand({ dryRun: true }, '7', env.io)
    const out = env.out.join('\n')
    assert.ok(out.includes('## Review findings'))
    assert.ok(out.includes('fix this'))
  })
})
