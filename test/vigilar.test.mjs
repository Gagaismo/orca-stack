import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { isStatus, latestChecks } from '../src/checks.mjs'
import { main } from '../src/cli.mjs'
import { upsertBlock } from '../src/marker.mjs'
import { policyBlock } from '../src/templates.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'
import { pendingAfterSwitch } from '../src/orca.mjs'
import { vigilarCommand } from '../src/vigilar.mjs'

const COMMON = '/repo/.git'
const CURSOR = path.join(COMMON, 'orca-stack', 'vigilar.json')
const MERGES = path.join(COMMON, 'orca-stack', 'vigilar-merges.json')
const MINUTE = 60 * 1000
const REPORTED = path.join(COMMON, 'orca-stack', 'consultas-reportadas.json')
const CONSULTA = { id: 'IC_1', author: { login: 'stack-bot' }, body: 'Consulta: claude — ¿uso X o Y?' }
const T0 = Date.parse('2026-10-15T18:00:00Z')
const ABC = 'abc1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DEF = 'def5678bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = stdout => ({ status: 0, stdout, stderr: '' })
const fail = stderr => ({ status: 1, stdout: '', stderr })

const check = (name, conclusion, { status = 'COMPLETED', startedAt = '2026-10-15T17:00:00Z', workflowName = 'CI' } = {}) =>
  ({ __typename: 'CheckRun', name, workflowName, status, conclusion: status === 'COMPLETED' ? conclusion : '', startedAt })
const GREEN = [check('ubuntu-latest / Node 20', 'SUCCESS'), check('ci-ok', 'SUCCESS')]
const PENDING = [check('ubuntu-latest / Node 20', '', { status: 'IN_PROGRESS' })]

// A merged PR is merged a minute after T0 unless a test says when.
const pr = (number, { state = 'OPEN', head = ABC, branch = 'Gagaismo/orca-stack-7', closes = [7], body = '', checks = [], mergeable, mergedAt = state === 'MERGED' ? new Date(T0 + MINUTE).toISOString() : null } = {}) =>
  ({ number, state, headRefName: branch, headRefOid: head, mergedAt, body, closingIssuesReferences: closes.map(n => ({ number: n })), statusCheckRollup: checks, mergeable })

// A fake GitHub, git and Orca. Tests change `world` between runs; inside one run, each io.sleep applies the next
// scripted change, so a looping watcher sees the world move and ends on its own with tanda-cerrada.
const harness = (world = {}) => {
  const files = {}
  const out = []
  const err = []
  const calls = []
  const sleeps = []
  const renames = []
  const io = {
    cwd: '/repo',
    home: '/home',
    out: line => out.push(line),
    err: line => err.push(line),
    exists: file => file in files,
    readFile: file => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`)
      return files[file]
    },
    writeFile: (file, text) => {
      files[file] = text
    },
    rename: (from, to) => {
      renames.push(to)
      files[to] = files[from]
      delete files[from]
    },
    mkdirp: () => {},
    now: () => world.now ?? T0,
    sleep: async ms => {
      sleeps.push(ms)
      const next = world.script?.shift()
      if (!next) throw new Error('test: the watcher polled past the scripted world')
      next(world)
    },
    sh: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'git' && args.includes('--git-common-dir')) return okRes(`/repo/.git\n${COMMON}\n/repo\n`)
      if (cmd === 'git' && args[0] === 'worktree') {
        const entries = (world.worktrees ?? []).filter(wt => !wt.foreign).map(wt => `worktree ${wt.path}\nHEAD 1\nbranch refs/heads/${wt.branch}\n`)
        return okRes(['worktree /repo\nHEAD 0\nbranch refs/heads/main\n', ...entries].join('\n'))
      }
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') {
        if (world.orcaDown) return fail('orca: runtime not running')
        return json({ ok: true, result: { worktrees: (world.worktrees ?? []).map(wt => ({ path: wt.path, repo: wt.repo ?? 'orca-stack', linkedIssue: wt.linkedIssue, agents: wt.agents ?? [] })) } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') {
        if (world.orcaDown || world.terminalListDown) return fail(world.terminalListDown ?? 'orca: runtime not running')
        const selector = args[args.indexOf('--worktree') + 1] ?? ''
        const targetPath = selector.startsWith('path:') ? selector.slice(5) : selector
        if (world.strayTerminal) return json({ ok: true, result: { terminals: [world.strayTerminal] } })
        const wt = (world.worktrees ?? []).find(item => item.path === targetPath)
        const terms = (wt?.terminals ?? []).map(t => ({ worktreePath: wt.path, tabId: `tab-${t.handle}`, leafId: `leaf-${t.handle}`, ...t }))
        return json({ ok: true, result: { terminals: terms } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') {
        const handle = args[args.indexOf('--terminal') + 1]
        if (world.terminalReadDown === true || world.terminalReadDown?.[handle]) {
          return fail(typeof world.terminalReadDown === 'string' ? world.terminalReadDown : world.terminalReadDown?.[handle] ?? `orca terminal read failed for ${handle}`)
        }
        const wt = (world.worktrees ?? []).find(item => (item.terminals ?? []).some(t => t.handle === handle))
        const tail = world.screens?.[handle] ?? wt?.screens?.[handle] ?? wt?.screen ?? []
        return json({ ok: true, result: { terminal: { handle, tail, source: 'screen' } } })
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        if (world.ghDown) return fail(world.ghDown)
        world.onList?.()
        // Plain `gh pr list` lists open PRs only: without --state all, merged and closed PRs never show up.
        const all = args.includes('--state') && args[args.indexOf('--state') + 1] === 'all'
        return json((world.prs ?? []).filter(p => !(world.hidden ?? []).includes(p.number) && (all || p.state === 'OPEN')))
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const found = (world.prs ?? []).find(p => String(p.number) === args[2])
        if (world.ghDown || !found) return fail(world.ghDown ?? `no pull requests found for ${args[2]}`)
        world.onPrView?.(args)
        return json(found)
      }
      if (cmd === 'gh' && args[0] === 'run' && args[1] === 'list') {
        if (world.runListDown) return fail(world.runListDown)
        return json(world.runs ?? [])
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        if (world.ghDown) return fail(world.ghDown)
        if (args.includes('comments')) return world.issueCommentsDown ? fail('comments unavailable') : json({ comments: (world.comments ?? {})[args[2]] ?? [] })
        if ((world.issueDown ?? {})[args[2]]) return fail(world.issueDown[args[2]])
        return json({ state: (world.issues ?? {})[args[2]] ?? 'OPEN' })
      }
      // #431: Orca's managed accounts; select moves the active one.
      if (cmd === 'orca' && args[0] === 'account') {
        const agent = args[args.indexOf('--agent') + 1]
        if (world.accountDown?.[args[1]]) return fail(world.accountDown[args[1]])
        const listed = world.accounts?.[agent] ?? { accounts: [], activeAccountId: null }
        if (args[1] === 'select') listed.activeAccountId = args[args.indexOf('--account') + 1]
        return json({ ok: true, result: { [agent]: listed } })
      }
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return world.userDown ? fail(world.userDown) : json({ login: 'stack-bot' })
      // GitHub's sub-issues REST endpoint answers with the sub-issues as a list of issues.
      const sub = cmd === 'gh' && args[0] === 'api' ? /^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)\/sub_issues\?per_page=100$/.exec(args[1] ?? '') : null
      if (sub) return world.ghDown ? fail(world.ghDown) : json(((world.subIssues ?? {})[sub[1]] ?? []).map(number => ({ number, state: 'open', title: `t${number}` })))
      return fail(`unexpected call: ${cmd} ${args.join(' ')}`)
    },
  }
  const cursor = () => JSON.parse(files[CURSOR])

  return { io, world, files, out, err, calls, sleeps, renames, cursor }
}

const once = (h, items, flags = {}) => vigilarCommand({ unaVez: true, ...flags }, items, h.io)
const drain = h => h.out.splice(0)
const mergeDeMain = (h, n) => vigilarCommand({ mergeDeMain: n }, [], h.io)

describe('orca-stack vigilar (#195)', () => {
  test('issue #214 Rule 1: emits worker-detenido for the matching no-PR codex worker', async () => {
    const paused = { path: '/wt/orca-stack-212', repo: 'orca-stack', linkedIssue: 212, agents: [{ state: 'done', agentType: 'codex' }] }
    const h = harness({ worktrees: [paused], issues: { 212: 'OPEN', 213: 'OPEN' } })
    await once(h, ['212', '213'])
    assert.deepEqual(h.out, ['worker-detenido #212 codex: terminó sin abrir un PR'])
  })

  test('issue #214 Rule 2: stop cursor survives rearm and reports only a new done transition', async () => {
    const paused = { path: '/wt/orca-stack-212', repo: 'orca-stack', linkedIssue: 212, agents: [{ state: 'done', agentType: 'codex' }] }
    const h = harness({ worktrees: [paused], issues: { 212: 'OPEN', 213: 'OPEN' } })
    await once(h, ['212', '213'])
    assert.deepEqual(h.out, ['worker-detenido #212 codex: terminó sin abrir un PR'])
    const rearmed = harness({ worktrees: [paused], issues: { 212: 'OPEN', 213: 'OPEN' } })
    rearmed.files[CURSOR] = JSON.stringify(h.cursor())
    await once(rearmed, ['212', '213'])
    assert.deepEqual(rearmed.out, [])

    const restarted = harness({ worktrees: [paused], issues: { 212: 'OPEN' } })
    restarted.files[CURSOR] = JSON.stringify(h.cursor())
    restarted.world.worktrees[0].agents[0].state = 'working'
    await once(restarted, ['212'])
    restarted.world.worktrees[0].agents[0].state = 'done'
    await once(restarted, ['212'])
    assert.deepEqual(restarted.out, ['worker-detenido #212 codex: terminó sin abrir un PR'])
  })

  test('issue #214 Rule 3: excludes working workers and issues with an open PR, while #399 includes Pi', async () => {
    const paused = { path: '/wt/orca-stack-212', repo: 'orca-stack', linkedIssue: 212, agents: [{ state: 'done', agentType: 'codex' }] }
    const working = harness({ worktrees: [{ ...paused, agents: [{ state: 'working', agentType: 'codex' }] }], issues: { 212: 'OPEN' } })
    await once(working, ['212'])
    assert.deepEqual(working.out, [])
    const pi = harness({ worktrees: [{ ...paused, agents: [{ state: 'done', agentType: 'pi' }] }], issues: { 212: 'OPEN' } })
    await once(pi, ['212'])
    assert.deepEqual(pi.out, ['worker-detenido #212 pi: terminó sin abrir un PR'])
    const withPr = harness({ worktrees: [paused], prs: [pr(80, { closes: [212] })] })
    await once(withPr, ['212'])
    assert.ok(!withPr.out.some(line => line.startsWith('worker-detenido')))
  })

  test('issue #214 Rule 4: warns once when Orca worktree state is unavailable and keeps polling', async () => {
    const h = harness({ orcaDown: true, issues: { 212: 'OPEN' } })
    h.world.script = [world => { world.orcaDown = false; world.issues[212] = 'CLOSED' }]
    assert.equal(await vigilarCommand({ cada: '1' }, ['212'], h.io), 0)
    assert.equal(h.err.filter(line => /orca worktree ps/.test(line)).length, 1)
    assert.equal(h.sleeps.length, 1)
  })

  test('Rule 1: stdout carries only event lines, a poll with nothing new prints nothing, diagnostics go to stderr', async () => {
    const h = harness({ prs: [pr(70, { checks: GREEN })], orcaDown: true })
    h.world.script = [
      () => {},
      world => {
        world.prs = [pr(70, { state: 'MERGED', checks: GREEN })]
      },
    ]
    assert.equal(await vigilarCommand({ cada: '1' }, ['7'], h.io), 0)

    // Poll 1 emits the state, poll 2 sees the same state and prints nothing, poll 3 sees the merge and closes the batch.
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234', 'pr-mergeado #7 PR #70 abc1234', 'tanda-cerrada #7'])
    assert.deepEqual(h.sleeps, [1000, 1000])
    assert.ok(h.err.some(line => /orca: runtime not running/.test(line)), 'the Orca diagnostic goes to stderr')

    // A cursor that cannot be written is a diagnostic too, and the watcher still prints each line once.
    const locked = harness({ prs: [pr(70)] })
    locked.io.rename = () => {
      throw new Error('EPERM: operation not permitted, rename')
    }
    locked.world.script = [() => {}, world => {
      world.prs = [pr(70, { state: 'CLOSED' })]
    }]
    assert.equal(await vigilarCommand({}, ['7'], locked.io), 0)
    assert.deepEqual(locked.out, ['pr-abierto #7 PR #70 abc1234', 'pr-cerrado #7 PR #70', 'tanda-cerrada #7'])
    assert.ok(locked.err.some(line => /EPERM/.test(line)))
  })

  test('Rule 2: an open PR on Gagaismo/orca-stack-166 that closes #166 is the PR of the watched issue 166', async () => {
    const h = harness({ prs: [pr(191, { branch: 'Gagaismo/orca-stack-166', closes: [166] })] })
    await once(h, ['166'])
    assert.deepEqual(h.out, ['pr-abierto #166 PR #191 abc1234'])
  })

  test('Rule 3: a PR on the literal branch orca-stack-166 that closes #200 is not #166\'s; the worktree branch and a Closes line are links', async () => {
    const worktrees = [{ path: '/wt/orca-stack-166', branch: 'Gagaismo/orca-stack-166', linkedIssue: 166 }]
    const decoy = pr(200, { branch: 'orca-stack-166', closes: [200], body: 'Closes #200' })
    const h = harness({ worktrees, prs: [decoy] })
    await once(h, ['166'])
    assert.deepEqual(drain(h), [])

    // The worktree's branch links a PR with no closing reference (a base that is not the default branch); a body line links #167.
    h.world.prs = [decoy, pr(201, { branch: 'Gagaismo/orca-stack-166', closes: [] }), pr(202, { branch: 'feature/x', closes: [], body: 'Summary\n\nCloses #167' })]
    await once(h, ['166', '167'])
    assert.deepEqual(drain(h), ['pr-abierto #166 PR #201 abc1234', 'pr-abierto #167 PR #202 abc1234'])
  })

  test('Rule 4: resuming with an existing cursor, the same arguments and an unchanged world prints nothing', async () => {
    const h = harness({ prs: [pr(70, { checks: GREEN })] })
    await once(h, ['7'])
    assert.equal(drain(h).length, 2)
    await once(h, ['7'])
    assert.deepEqual(h.out, [])
  })

  test('Rule 5: checks that turned green while nothing watched give exactly one ci-verde on the next run', async () => {
    const h = harness({ prs: [pr(70, { checks: PENDING })] })
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['pr-abierto #7 PR #70 abc1234'])
    assert.equal(h.cursor()['7'].ci, undefined)

    h.world.prs = [pr(70, { checks: GREEN })]
    await once(h, ['7'])
    assert.deepEqual(h.out, ['ci-verde #7 PR #70 abc1234'])
  })

  test('Issue 225 Rule 1: an open PR resolves its worker by head branch and normalizes its one agent state', async () => {
    const workerBranch = { path: '/wt/issue-225', branch: 'feat/225', linkedIssue: null, agents: [{ agentType: 'CoDeX', state: 'WORKING' }] }
    const hBranch = harness({ worktrees: [workerBranch], prs: [pr(70, { branch: 'feat/225', checks: GREEN })] })
    await once(hBranch, ['7'])
    assert.deepEqual(hBranch.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde-retenido #7 PR #70 abc1234: codex working'])

    const workerLinked = { path: '/wt/issue-225-linked', branch: 'other-branch', linkedIssue: 7, agents: [{ agentType: 'codex', state: 'working' }] }
    const hLinked = harness({ worktrees: [workerLinked], prs: [pr(70, { branch: 'feat/225', checks: GREEN })] })
    await once(hLinked, ['7'])
    assert.deepEqual(hLinked.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde-retenido #7 PR #70 abc1234: codex working'])
  })

  test('Issue 225 Rule 2: green CI is held once per head while worker lives, then released when done', async () => {
    const worker = { path: '/wt/issue-225', branch: 'Gagaismo/orca-stack-7', linkedIssue: 7, agents: [{ agentType: 'codex', state: 'working' }] }
    const h = harness({ worktrees: [worker], prs: [pr(70, { checks: GREEN })] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde-retenido #7 PR #70 abc1234: codex working'])
    h.out.length = 0
    await once(h, ['7'])
    assert.deepEqual(h.out, [])
    worker.agents[0].state = 'done'
    await once(h, ['7'])
    assert.deepEqual(h.out, ['ci-verde #7 PR #70 abc1234'])

    const blockedWorker = { path: '/wt/blocked', branch: 'Gagaismo/orca-stack-7', linkedIssue: 7, agents: [{ agentType: 'codex', state: 'blocked' }] }
    const hBlocked = harness({ worktrees: [blockedWorker], prs: [pr(70, { checks: GREEN })] })
    await once(hBlocked, ['7'])
    assert.deepEqual(hBlocked.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde-retenido #7 PR #70 abc1234: codex blocked'])
    hBlocked.out.length = 0
    await once(hBlocked, ['7'])
    assert.deepEqual(hBlocked.out, [])

    const exitWorker = { path: '/wt/exit', branch: 'Gagaismo/orca-stack-7', linkedIssue: 7, agents: [{ agentType: 'codex', state: 'working' }] }
    const hExit = harness({ worktrees: [exitWorker], prs: [pr(70, { checks: GREEN })] })
    await once(hExit, ['7'])
    assert.deepEqual(hExit.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde-retenido #7 PR #70 abc1234: codex working'])
    hExit.out.length = 0
    exitWorker.agents = []
    await once(hExit, ['7'])
    assert.deepEqual(hExit.out, ['ci-verde #7 PR #70 abc1234'])

    const liveRed = harness({ worktrees: [worker], prs: [pr(70, { checks: [check('matrix', 'FAILURE')] })] })
    worker.agents = [{ agentType: 'codex', state: 'working' }]
    await once(liveRed, ['7'])
    assert.deepEqual(liveRed.out, ['pr-abierto #7 PR #70 abc1234', 'ci-roja #7 PR #70 abc1234: matrix=FAILURE'])
  })

  test('Issue 225 Rule 3: unreadable worktrees keep the ci-verde fallback, while #399 watches Pi workers too', async () => {
    const unreadable = harness({ orcaDown: true, prs: [pr(70, { checks: GREEN })] })
    await once(unreadable, ['7'])
    assert.deepEqual(unreadable.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234'])
    assert.ok(unreadable.err.some(line => line.includes('no enlaza PRs por worktree')))

    const pi = harness({ worktrees: [{ path: '/wt/pi', branch: 'Gagaismo/orca-stack-7', linkedIssue: 7, agents: [{ agentType: 'pi', state: 'working' }] }], prs: [pr(70, { checks: GREEN })] })
    await once(pi, ['7'])
    assert.deepEqual(pi.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde-retenido #7 PR #70 abc1234: pi working'])
  })

  test('Rule 6: a first run with no cursor emits the current state once', async () => {
    const h = harness({ prs: [pr(70, { checks: GREEN })] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234'])
  })

  test('Rule 7: CI events per head commit: failing checks named, pending and no checks silent, re-runs, latest run by startedAt', async () => {
    const red = [
      check('windows-latest / Node 20', 'FAILURE'),
      check('ci-ok', 'CANCELLED'),
      check('ubuntu-latest / Node 22', '', { status: 'IN_PROGRESS' }),
      check('ubuntu-latest / Node 20', 'SUCCESS'),
    ]
    const h = harness({ prs: [pr(70, { checks: red }), pr(80, { branch: 'Gagaismo/orca-stack-8', closes: [8] })] })
    await once(h, ['7', '8'])
    // #8's PR has no checks: no CI event.
    assert.deepEqual(drain(h), [
      'pr-abierto #7 PR #70 abc1234',
      'ci-roja #7 PR #70 abc1234: windows-latest / Node 20=FAILURE, ci-ok=CANCELLED',
      'pr-abierto #8 PR #80 abc1234',
    ])

    // A new head commit starts a new cycle: pending emits only the head event. Watching #7 alone is another batch, so
    // it is told once that PR #70 is open (S9).
    h.world.prs = [pr(70, { head: DEF, checks: PENDING })]
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['head-nuevo #70 def5678', 'pr-abierto #7 PR #70 def5678'])

    // Green, red after a re-run, then green again on the same head commit: each change is emitted once.
    for (const checks of [GREEN, GREEN, [check('ci-ok', 'FAILURE')], [check('ci-ok', 'SUCCESS')]]) {
      h.world.prs = [pr(70, { head: DEF, checks })]
      await once(h, ['7'])
    }
    assert.deepEqual(drain(h), ['ci-verde #7 PR #70 def5678', 'ci-roja #7 PR #70 def5678: ci-ok=FAILURE', 'ci-verde #7 PR #70 def5678'])

    // Two runs of one check on one head commit: an old red next to a newer green counts as green.
    const twoRuns = [check('ci-ok', 'FAILURE', { startedAt: '2026-10-15T17:00:00Z' }), check('ci-ok', 'SUCCESS', { startedAt: '2026-10-15T17:30:00Z' })]
    const fresh = harness({ prs: [pr(70, { checks: twoRuns })] })
    await once(fresh, ['7'])
    assert.deepEqual(fresh.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234'])
  })

  test('Rule 7: red, a gh run rerun --failed, then red again on one head commit gives two ci-roja; polling a finished run again prints nothing', async () => {
    // GitHub keeps the rows of every run on the head commit, and ci-ok (needs: the matrix) gets its row only once the
    // matrix finished, after the matrix's failure was already visible.
    const win1 = check('windows-latest / Node 20', 'FAILURE', { startedAt: '2026-10-15T17:00:00Z' })
    const ok1 = check('ci-ok', 'FAILURE', { startedAt: '2026-10-15T17:05:00Z' })
    const win2 = check('windows-latest / Node 20', 'FAILURE', { startedAt: '2026-10-15T17:10:00Z' })
    const ok2 = check('ci-ok', 'FAILURE', { startedAt: '2026-10-15T17:15:00Z' })
    const runs = [
      [win1],
      [win1, ok1],
      [win1, ok1],
      // The re-run is in progress: the old ci-ok row is still the latest ci-ok.
      [win1, ok1, { ...win2, status: 'IN_PROGRESS', conclusion: '' }],
      [win1, ok1, win2],
      [win1, ok1, win2, ok2],
      [win1, ok1, win2, ok2],
    ]
    const h = harness({ prs: [pr(70, { checks: runs[0] })] })
    for (const checks of runs) {
      h.world.prs = [pr(70, { checks })]
      await once(h, ['7'])
    }
    assert.deepEqual(drain(h), [
      'pr-abierto #7 PR #70 abc1234',
      'ci-roja #7 PR #70 abc1234: windows-latest / Node 20=FAILURE',
      'ci-roja #7 PR #70 abc1234: windows-latest / Node 20=FAILURE, ci-ok=FAILURE',
    ])

    // A third run that started and failed while nothing watched is still one ci-roja on the next run.
    const win3 = check('windows-latest / Node 20', 'TIMED_OUT', { startedAt: '2026-10-15T17:20:00Z' })
    h.world.prs = [pr(70, { checks: [win1, ok1, win2, ok2, win3, check('ci-ok', 'FAILURE', { startedAt: '2026-10-15T17:25:00Z' })] })]
    await once(h, ['7'])
    await once(h, ['7'])
    assert.deepEqual(h.out, ['ci-roja #7 PR #70 abc1234: windows-latest / Node 20=TIMED_OUT, ci-ok=FAILURE'])
  })

  test('Rule 8: a merge main registered with --merge-de-main gives no event, ends the item, and its record is not used again', async () => {
    const h = harness({ prs: [pr(70)] })
    await once(h, ['7', '8'])
    drain(h)
    assert.equal(await mergeDeMain(h, '70'), 0)
    h.world.prs = [pr(70, { state: 'MERGED' })]
    h.world.now = T0 + 5 * MINUTE
    await once(h, ['7', '8'])
    assert.deepEqual(drain(h), [])
    assert.deepEqual(h.cursor()['7'], { pr: 70, abiertoPara: ['7,8'], head: ABC, fin: 'main' })

    // The record has expired by now: the item stays ended by main and no late pr-mergeado appears.
    h.world.now = T0 + 45 * MINUTE
    await once(h, ['7', '8'])
    assert.deepEqual(h.out, [])
  })

  test('Rule 9: a merged PR with no record, a record for another head commit, or a record older than 30 minutes gives pr-mergeado', async () => {
    const none = harness({ prs: [pr(70, { state: 'MERGED' })] })
    await once(none, ['7', '8'])
    assert.deepEqual(none.out, ['pr-mergeado #7 PR #70 abc1234'])

    const otherHead = harness({ prs: [pr(70, { head: DEF })] })
    await mergeDeMain(otherHead, '70')
    otherHead.world.prs = [pr(70, { state: 'MERGED' })]
    await once(otherHead, ['7', '8'])
    assert.deepEqual(otherHead.out, ['pr-mergeado #7 PR #70 abc1234'])

    const stale = harness({ prs: [pr(70)] })
    await mergeDeMain(stale, '70')
    stale.world.prs = [pr(70, { state: 'MERGED', mergedAt: new Date(T0 + 31 * MINUTE).toISOString() })]
    await once(stale, ['7', '8'])
    assert.deepEqual(stale.out, ['pr-mergeado #7 PR #70 abc1234'])
  })

  test('Rule 10: a PR closed unmerged gives pr-cerrado and ends its item', async () => {
    const h = harness({ prs: [pr(70, { state: 'CLOSED' })] })
    assert.equal(await vigilarCommand({}, ['7'], h.io), 0)
    assert.deepEqual(h.out, ['pr-cerrado #7 PR #70', 'tanda-cerrada #7'])
    assert.equal(h.cursor()['7'].fin, 'cerrado')
  })

  test('Rule 11: tanda-cerrada once, when every item ended, then exit 0; never while an item has an open issue or an open PR', async () => {
    const h = harness({ prs: [pr(70, { state: 'MERGED' })] })
    await once(h, ['7', '8'])
    // #8 has no PR and its issue is open.
    assert.deepEqual(drain(h), ['pr-mergeado #7 PR #70 abc1234'])

    h.world.prs.push(pr(80, { branch: 'Gagaismo/orca-stack-8', closes: [8] }))
    h.world.script = [world => world.prs.splice(1, 1, pr(80, { state: 'MERGED', branch: 'Gagaismo/orca-stack-8', closes: [8] }))]
    assert.equal(await vigilarCommand({}, ['7', '8'], h.io), 0)
    assert.deepEqual(drain(h), ['pr-abierto #8 PR #80 abc1234', 'pr-mergeado #8 PR #80 abc1234', 'tanda-cerrada #7 #8'])

    // The batch already closed: rearming it emits nothing again.
    assert.equal(await vigilarCommand({}, ['7', '8'], h.io), 0)
    assert.deepEqual(h.out, [])
  })

  test('Rule 12: GitHub unreachable prints nothing and keeps the cursor; three failed polls in a row give one vigilar-ciego', async () => {
    const h = harness({ ghDown: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)\nretry later' })
    const noCursor = () => assert.equal(CURSOR in h.files, false)
    h.world.script = [noCursor, noCursor, noCursor, world => {
      noCursor()
      world.ghDown = undefined
      world.prs = [pr(70, { state: 'MERGED' })]
    }]
    assert.equal(await vigilarCommand({}, ['7'], h.io), 0)
    assert.deepEqual(h.out, ['vigilar-ciego: gh pr list falló (HTTP 502: Bad Gateway (https://api.github.com/graphql))', 'pr-mergeado #7 PR #70 abc1234', 'tanda-cerrada #7'])
    assert.equal(h.err.filter(line => /HTTP 502/.test(line)).length, 4)

    // One issue gh cannot read (a mistyped number) is not GitHub being unreachable: the other items are still watched.
    const typo = harness({ prs: [pr(70)], issueDown: { 9999: 'GraphQL: Could not resolve to an issue or pull request with the number of 9999.' } })
    await once(typo, ['7', '9999'])
    assert.deepEqual(typo.out, ['pr-abierto #7 PR #70 abc1234'])
    assert.ok(typo.err.some(line => line.includes('#9999') && line.includes('Could not resolve')))
  })

  test('Rule 13: --dry-run prints the first poll\'s events and writes no cursor', async () => {
    const h = harness({ prs: [pr(70, { checks: GREEN })] })
    assert.equal(await vigilarCommand({ dryRun: true }, ['7'], h.io), 0)
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234'])
    assert.deepEqual(Object.keys(h.files), [])
    assert.deepEqual(h.sleeps, [])

    // With --consultas, the consultas check runs in dry-run too: consultas-reportadas.json is not written either.
    const asking = harness({ prs: [pr(70)], comments: { 7: [CONSULTA] } })
    assert.equal(await vigilarCommand({ dryRun: true, consultas: true }, ['7'], asking.io), 0)
    assert.deepEqual(asking.out, ['pr-abierto #7 PR #70 abc1234', 'consulta nueva en #7'])
    assert.deepEqual(Object.keys(asking.files), [])
  })

  test('Rule 14: --merge-de-main writes the record, prints nothing on stdout and exits 0; a bad argument or an unknown PR writes nothing', async () => {
    const h = harness({ prs: [pr(70)] })
    h.files[MERGES] = JSON.stringify({ 60: { head: DEF, at: new Date(T0 - 40 * MINUTE).toISOString() } })
    assert.equal(await mergeDeMain(h, '70'), 0)
    assert.deepEqual(h.out, [])
    // A record older than 30 minutes is dropped when the file is rewritten.
    assert.deepEqual(JSON.parse(h.files[MERGES]), { 70: { head: ABC, at: '2026-10-15T18:00:00.000Z' } })

    const unknown = harness({ prs: [] })
    await assert.rejects(() => mergeDeMain(unknown, '99'), /PR #99/)
    assert.deepEqual(Object.keys(unknown.files), [])

    const oldError = console.error
    let output = ''
    console.error = value => { output += `${value}
` }
    try {
      assert.equal(await main(['vigilar', '--merge-de-main', 'abc']), 1)
    } finally {
      console.error = oldError
    }
    assert.match(output, /--merge-de-main <pr>/)
  })

  test('Rule 15: vigilar with no issue numbers and no --merge-de-main is a usage error', async () => {
    const oldError = console.error
    let output = ''
    console.error = value => { output += `${value}\n` }
    try {
      assert.equal(await main(['vigilar']), 1)
    } finally {
      console.error = oldError
    }
    assert.match(output, /Uso: orca-stack vigilar <n\.\.\.>/)
  })

  test('Rule 16: a record written while a watcher is mid-poll survives the cursor write of the watcher', async () => {
    const h = harness({ prs: [pr(70)] })
    // main records its merge from inside the watcher's first poll, between reading GitHub and writing the cursor.
    h.world.onList = () => {
      h.world.onList = undefined
      mergeDeMain(h, '70')
    }
    h.world.script = [world => {
      world.prs = [pr(70, { state: 'MERGED' })]
    }]
    assert.equal(await vigilarCommand({}, ['7'], h.io), 0)
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'tanda-cerrada #7'])
    assert.deepEqual(h.renames.filter(file => file === MERGES).length, 1, 'only --merge-de-main writes vigilar-merges.json')
  })

  test('Rule 17: merged PRs are seen through gh pr list --state all, and a cursor PR missing from the list is read with gh pr view', async () => {
    const h = harness({ prs: [pr(70, { state: 'MERGED' })] })
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['pr-mergeado #7 PR #70 abc1234', 'tanda-cerrada #7'])

    const past = harness({ prs: [pr(70)] })
    await once(past, ['7'])
    assert.deepEqual(drain(past), ['pr-abierto #7 PR #70 abc1234'])
    // PR 70 fell past the list's --limit: the watcher reads it by number and still sees it merged.
    past.world.prs = [pr(70, { state: 'MERGED' })]
    past.world.hidden = [70]
    await once(past, ['7'])
    assert.deepEqual(past.out, ['pr-mergeado #7 PR #70 abc1234', 'tanda-cerrada #7'])
    assert.ok(past.calls.some(call => call.startsWith('gh pr view 70 --json')))
  })

  test('Rule 18: after update-branch the record of the old head commit does not cover the merge; a second --merge-de-main does', async () => {
    const h = harness({ prs: [pr(70)] })
    await mergeDeMain(h, '70')
    h.world.prs = [pr(70, { state: 'MERGED', head: DEF })]
    await once(h, ['7', '8'])
    assert.deepEqual(h.out, ['pr-mergeado #7 PR #70 def5678'])

    const again = harness({ prs: [pr(70)] })
    await mergeDeMain(again, '70')
    again.world.prs = [pr(70, { head: DEF })]
    await mergeDeMain(again, '70')
    again.world.prs = [pr(70, { state: 'MERGED', head: DEF })]
    await once(again, ['7', '8'])
    assert.deepEqual(again.out, [])
  })

  test('Rule 19: with --consultas one watcher reports a new Consulta: once; without it no Consulta is reported', async () => {
    const h = harness({ prs: [pr(70)], comments: { 7: [CONSULTA] } })
    h.world.script = [() => {}, world => {
      world.prs = [pr(70, { state: 'MERGED' })]
    }]
    assert.equal(await vigilarCommand({ consultas: true }, ['7'], h.io), 0)
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'consulta nueva en #7', 'pr-mergeado #7 PR #70 abc1234', 'tanda-cerrada #7'])
    assert.deepEqual(JSON.parse(h.files[REPORTED]), ['IC_1'])

    const plain = harness({ prs: [pr(70)], comments: { 7: [CONSULTA] } })
    await once(plain, ['7'])
    assert.deepEqual(plain.out, ['pr-abierto #7 PR #70 abc1234'])
    assert.equal(plain.files[REPORTED], undefined)

    // A failing consultas check goes to stderr; the PR events of that poll are still printed.
    const broken = harness({ prs: [pr(70)], comments: { 7: [CONSULTA] }, userDown: 'HTTP 401: Bad credentials' })
    assert.equal(await once(broken, ['7'], { consultas: true }), 0)
    assert.deepEqual(broken.out, ['pr-abierto #7 PR #70 abc1234'])
    assert.ok(broken.err.some(line => /HTTP 401: Bad credentials/.test(line)))
  })

  test('Rule 20: an issue closed with no PR counts as ended', async () => {
    const h = harness({ prs: [pr(70, { state: 'MERGED' })], issues: { 8: 'CLOSED' } })
    assert.equal(await vigilarCommand({}, ['7', '8'], h.io), 0)
    assert.deepEqual(h.out, ['pr-mergeado #7 PR #70 abc1234', 'tanda-cerrada #7 #8'])
  })

  test('Rule 22: --help lists vigilar and its flags; MAIN.md steps 5 and 7 name it; the AGENTS.md block equals the asset', async () => {
    const oldLog = console.log
    let output = ''
    console.log = value => { output += `${value}\n` }
    try {
      assert.equal(await main(['--help']), 0)
      assert.match(output, /\n  vigilar\s+\S/)
      for (const flag of ['--cada <segundos>', '--una-vez', '--consultas', '--merge-de-main <pr>']) {
        assert.ok(output.split('\n').some(line => line.trimStart().startsWith(flag) && line.includes('(vigilar)')), flag)
      }
      assert.ok(output.includes('(global, init, remove, despachar, revisar, rebote, brief-revision, consultas, avisar, reanudar, vigilar, planificar, limpiar)'))
      output = ''
      assert.equal(await main(['vigilar', '--help']), 0)
      assert.ok(output.includes('review-publicado #<pr> <agente> <sha> bloquea=<n>'))
      assert.ok(output.includes('head-nuevo #<pr> <sha>'))
      assert.ok(output.includes('orca-stack vigilar <n...> [--cada <segundos>] [--una-vez] [--dry-run] [--consultas]'))
      assert.ok(output.includes('orca-stack vigilar --merge-de-main <pr>'))
    } finally {
      console.log = oldLog
    }

    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'MAIN.md'), 'utf8')
    const step = n => contract.split(/\r?\n/).find(line => line.startsWith(`${n}. `))
    assert.ok(step(5).includes('un solo Monitor de fondo armado con `orca-stack vigilar <n...>`'))
    assert.ok(step(5).includes('Armalo siempre con `--consultas`'))
    assert.ok(step(5).includes('Antes de rearmarlo, matá el anterior'))
    assert.ok(!step(5).includes('gh pr list --json'))
    assert.ok(step(7).includes('justo antes de cada intento de `gh pr merge <n>`, corré `orca-stack vigilar --merge-de-main <n>`'))
    assert.ok(step(7).includes('también después de `gh pr update-branch <n>`'))

    const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    assert.equal(upsertBlock(agents, block), agents, 'init would change nothing in AGENTS.md')
  })
})

describe('orca-stack vigilar (#206)', () => {
  const at = clock => Date.parse(`2026-10-15T${clock}:00Z`)

  test('Rule 1: a record at 10:00, a merge of that head at 10:05 and a poll at 11:00 end the item silently as main\'s merge', async () => {
    const h = harness({ prs: [pr(70)], now: at('10:00') })
    assert.equal(await mergeDeMain(h, '70'), 0)
    h.world.prs = [pr(70, { state: 'MERGED', mergedAt: '2026-10-15T10:05:00Z' })]
    h.world.now = at('11:00')
    await once(h, ['7', '8'])
    assert.deepEqual(h.out, [])
    assert.deepEqual(h.cursor()['7'], { pr: 70, head: ABC, fin: 'main' })
  })

  test('Rule 2: the human merged that head at 09:58 and main recorded it at 10:00: pr-mergeado', async () => {
    const h = harness({ prs: [pr(70, { state: 'MERGED', mergedAt: '2026-10-15T09:58:00Z' })], now: at('10:01') })
    h.files[MERGES] = JSON.stringify({ 70: { head: ABC, at: '2026-10-15T10:00:00.000Z' } })
    await once(h, ['7', '8'])
    assert.deepEqual(h.out, ['pr-mergeado #7 PR #70 abc1234'])
    assert.equal(h.cursor()['7'].fin, 'mergeado')
  })

  test('Rule 3: a record at 10:00 and a merge of that head at 10:31: pr-mergeado', async () => {
    const h = harness({ prs: [pr(70)], now: at('10:00') })
    await mergeDeMain(h, '70')
    h.world.prs = [pr(70, { state: 'MERGED', mergedAt: '2026-10-15T10:31:00Z' })]
    h.world.now = at('10:31')
    await once(h, ['7', '8'])
    assert.deepEqual(h.out, ['pr-mergeado #7 PR #70 abc1234'])
  })

  test('Rule 4: --merge-de-main on a MERGED or a CLOSED PR exits 1, leaves vigilar-merges.json untouched and says why on stderr', async () => {
    const before = JSON.stringify({ 60: { head: DEF, at: new Date(T0).toISOString() } })
    for (const [state, message] of [['MERGED', 'El PR #70 ya está mergeado: no registré nada.'], ['CLOSED', 'El PR #70 está cerrado: no registré nada.']]) {
      const h = harness({ prs: [pr(70, { state })] })
      h.files[MERGES] = before
      assert.equal(await mergeDeMain(h, '70'), 1, state)
      assert.equal(h.files[MERGES], before, state)
      assert.deepEqual(h.renames, [], state)
      assert.deepEqual(h.err, [message])
      assert.deepEqual(h.out, [])
    }
  })

  test('Rule 5: MAIN.md step 7 says main still tries gh pr merge when --merge-de-main fails; the AGENTS.md block equals the asset', () => {
    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'MAIN.md'), 'utf8')
    const step7 = contract.split(/\r?\n/).find(line => line.startsWith('7. '))
    assert.ok(step7.includes('corré `orca-stack vigilar --merge-de-main <n>`, también después de `gh pr update-branch <n>` (el registro lleva el head); si el registro falla, igual intentás el merge, y si sale, su `pr-mergeado` es tuyo.'))

    const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    assert.equal(upsertBlock(agents, block), agents, 'init would change nothing in AGENTS.md')
  })

  test('Rule 6: watcher A on 1 and 2 and watcher B on 3 share vigilar.json; after both poll it holds A\'s latest entries for 1 and 2 and B\'s for 3', async () => {
    const item = (n, options = {}) => pr(n * 10, { branch: `Gagaismo/orca-stack-${n}`, closes: [n], ...options })
    const h = harness({ prs: [item(1), item(2), item(3)] })
    h.world.script = [
      // B polls while A sleeps, then #1 turns green for A's next poll.
      world => {
        once(h, ['3'])
        world.prs = [item(1, { checks: GREEN }), item(2), item(3)]
      },
      world => {
        world.prs = [item(1, { state: 'MERGED', checks: GREEN }), item(2, { state: 'MERGED' }), item(3)]
      },
    ]
    assert.equal(await vigilarCommand({}, ['1', '2'], h.io), 0)
    assert.deepEqual(drain(h), [
      'pr-abierto #1 PR #10 abc1234',
      'pr-abierto #2 PR #20 abc1234',
      'pr-abierto #3 PR #30 abc1234',
      'ci-verde #1 PR #10 abc1234',
      'pr-mergeado #1 PR #10 abc1234',
      'pr-mergeado #2 PR #20 abc1234',
      'tanda-cerrada #1 #2',
    ])
    assert.deepEqual(h.cursor(), {
      1: { pr: 10, abiertoPara: ['1,2'], head: ABC, ci: 'verde', fin: 'mergeado' },
      2: { pr: 20, abiertoPara: ['1,2'], head: ABC, fin: 'mergeado' },
      3: { pr: 30, abiertoPara: ['3'], head: ABC },
    })

    // B re-armed on 3 resumes from its own entry and prints nothing again.
    await once(h, ['3'])
    assert.deepEqual(h.out, [])
  })

  test('Rule 8: an older finished CANCELLED row and a newer QUEUED row with no startedAt leave the check pending, with no ci-roja', async () => {
    const rows = [
      check('windows-latest / Node 20', 'CANCELLED', { startedAt: '2026-10-15T10:00:00Z' }),
      check('windows-latest / Node 20', '', { status: 'QUEUED', startedAt: null }),
    ]
    const h = harness({ prs: [pr(70, { checks: rows })] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234'])
    assert.equal(h.cursor()['7'].ci, undefined)
  })

  test('Issue 225 Rule 4: the highest run per workflow counts and missing checks stay pending', async () => {
    const row = (name, conclusion, run) => ({
      __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion,
      detailsUrl: `https://github.com/org/repo/actions/runs/${run}/job/1`,
    })
    const h = harness({ prs: [pr(70, { checks: [row('matrix', 'FAILURE', 10), row('matrix', 'SUCCESS', 11), row('context', 'SUCCESS', 12)] })] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234'])
    assert.equal(h.cursor()['7'].ci, undefined)

    const mixed = harness({
      prs: [pr(70, {
        checks: [
          row('matrix', 'SUCCESS', 12),
          row('context', 'SUCCESS', 12),
          { __typename: 'StatusContext', context: 'security/guard', state: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      })],
    })
    await once(mixed, ['7'])
    assert.deepEqual(mixed.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234'])
  })

  test('Issue 225 Rule 5: the #218 successor rows are exclusive and later green emits ci-verde', async () => {
    const row = (name, conclusion, run) => ({
      __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion,
      detailsUrl: `https://github.com/org/repo/actions/runs/${run}/job/1`,
    })
    const h = harness({ prs: [pr(70, { checks: [row('matrix', 'SUCCESS', 38843085964), row('ci-ok', 'SUCCESS', 38843085964), row('matrix', 'SUCCESS', 38843110472)] })] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234'])
    assert.equal(h.cursor()['7'].ci, undefined)
    h.world.prs[0].statusCheckRollup.push(row('ci-ok', 'SUCCESS', 38843110472))
    h.out.length = 0
    await once(h, ['7'])
    assert.deepEqual(h.out, ['ci-verde #7 PR #70 abc1234'])
  })

  test('Issue 225 Rule 6: a higher queued run replaces a cancelled one, queried only for cancelled checks', async () => {
    const cancelled = { __typename: 'CheckRun', name: 'matrix', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/org/repo/actions/runs/38843085964/job/1' }
    const h = harness({ prs: [pr(70, { checks: [cancelled] })], runs: [{ databaseId: 38843110472, status: 'queued', conclusion: null }] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234'])
    assert.deepEqual(h.calls.filter(line => line.startsWith('gh run list')), ['gh run list --commit abc1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --workflow CI --json databaseId,status,conclusion'])
    const green = harness({ prs: [pr(70, { checks: GREEN })] })
    await once(green, ['7'])
    assert.equal(green.calls.filter(line => line.startsWith('gh run list')).length, 0)
  })

  test('Issue 225 Rule 7: unreplaced cancellation emits ci-cancelada once and excludes ci-ok failure', async () => {
    const rows = [
      { __typename: 'CheckRun', name: 'matrix', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/org/repo/actions/runs/38843085964/job/1' },
      { __typename: 'CheckRun', name: 'ci-ok', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/org/repo/actions/runs/38843085964/job/2' },
    ]
    const h = harness({ prs: [pr(70, { checks: rows })], runs: [] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'ci-cancelada #7 PR #70 abc1234: matrix=CANCELLED'])
    h.out.length = 0
    await once(h, ['7'])
    assert.deepEqual(h.out, [])

    const failed = harness({ prs: [pr(70, { checks: rows })], runListDown: 'temporary failure' })
    await once(failed, ['7'])
    assert.deepEqual(failed.out, [])
    assert.ok(failed.err.some(line => line.includes('gh run list falló (temporary failure)')))
    assert.equal(failed.files[CURSOR], undefined)

    const blind = harness({ prs: [pr(70, { checks: rows })], runListDown: 'temporary failure' })
    blind.world.script = [() => {}, () => {}, world => {
      world.runListDown = undefined
      world.prs = [pr(70, { state: 'MERGED' })]
    }]
    assert.equal(await vigilarCommand({}, ['7'], blind.io), 0)
    assert.deepEqual(blind.out, ['vigilar-ciego: gh run list falló (temporary failure)', 'pr-mergeado #7 PR #70 abc1234', 'tanda-cerrada #7'])
  })

  test('Issue 225 Rule 9: a red rerun in the same workflow run still emits once per failed attempt', async () => {
    const row = (startedAt, run) => ({
      __typename: 'CheckRun', name: 'matrix', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt,
      detailsUrl: `https://github.com/org/repo/actions/runs/${run}/job/1`,
    })
    const h = harness({ prs: [pr(70, { checks: [row('2026-10-15T10:00:00Z', 38843110472)] })] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'ci-roja #7 PR #70 abc1234: matrix=FAILURE'])
    h.out.length = 0
    await once(h, ['7'])
    assert.deepEqual(h.out, [])
    h.world.prs[0].statusCheckRollup.push(row('2026-10-15T10:30:00Z', 38843110472))
    await once(h, ['7'])
    assert.deepEqual(h.out, ['ci-roja #7 PR #70 abc1234: matrix=FAILURE'])
  })

  test('Issue 225 Rule 9: rows of run 10 red, then rows of run 11 red on the same head gives two ci-roja events', async () => {
    const row = (name, run, startedAt = '2026-10-15T10:00:00Z') => ({
      __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt,
      detailsUrl: `https://github.com/org/repo/actions/runs/${run}/job/1`,
    })
    const h = harness({ prs: [pr(70, { checks: [row('test', 10)] })] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'ci-roja #7 PR #70 abc1234: test=FAILURE'])
    assert.equal(h.cursor()['7'].corridaRun, '10')
    h.out.length = 0
    await once(h, ['7'])
    assert.deepEqual(h.out, [])
    h.world.prs[0].statusCheckRollup.push(row('test', 11, '2026-10-15T11:00:00Z'))
    await once(h, ['7'])
    assert.deepEqual(h.out, ['ci-roja #7 PR #70 abc1234: test=FAILURE'])
    assert.equal(h.cursor()['7'].corridaRun, '11')
    h.out.length = 0
    await once(h, ['7'])
    assert.deepEqual(h.out, [])
  })

  test('Issue 225 PRESERVE: vigilarCommand preserves cursor file, worker-detenido, and merge-de-main', async () => {
    const wt = { path: '/wt/paused', repo: 'orca-stack', linkedIssue: 7, agents: [{ state: 'done', agentType: 'codex' }] }
    const h = harness({ worktrees: [wt], issues: { 7: 'OPEN' } })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['worker-detenido #7 codex: terminó sin abrir un PR'])
    assert.equal(h.cursor()['7'].worker?.state, 'done')

    const hMerge = harness({ prs: [pr(70)] })
    await once(hMerge, ['7'])
    drain(hMerge)
    assert.equal(await mergeDeMain(hMerge, '70'), 0)
    hMerge.world.prs = [pr(70, { state: 'MERGED' })]
    hMerge.world.now = T0 + 5 * MINUTE
    await once(hMerge, ['7'])
    assert.deepEqual(drain(hMerge), ['tanda-cerrada #7'])
    assert.equal(hMerge.cursor()['7'].fin, 'main')
  })

  test('Issue 225 PRESERVE: latestChecks preserves CheckRun without runId and StatusContext checks', () => {
    const rollup = [
      { __typename: 'StatusContext', context: 'security/guard', state: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/1' },
    ]
    const checks = latestChecks(rollup)
    assert.equal(checks.length, 3)
    assert.ok(checks.some(c => isStatus(c.check) && c.check.context === 'security/guard'))
    assert.ok(checks.some(c => c.check.name === 'lint' && !c.runId))
    assert.ok(checks.some(c => c.check.name === 'unit' && c.runId === '123'))
  })

  test('Issue 240 Rule 1: real failure earlier than cancelled siblings emits ci-roja and not ci-cancelada', async () => {
    const run = 999
    const row = (name, conclusion, startedAt, completedAt, job = 1) => ({
      __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion, startedAt, completedAt,
      detailsUrl: `https://github.com/org/repo/actions/runs/${run}/job/${job}`,
    })
    const checks = [
      row('ubuntu-latest / Node 20', 'FAILURE', '2026-10-15T10:00:05Z', '2026-10-15T10:00:40Z', 1),
      row('ubuntu-latest / Node 22', 'CANCELLED', '2026-10-15T10:00:05Z', '2026-10-15T10:00:41Z', 2),
      row('windows-latest / Node 20', 'CANCELLED', '2026-10-15T10:00:05Z', '2026-10-15T10:00:41Z', 3),
      row('windows-latest / Node 22', 'CANCELLED', '2026-10-15T10:00:05Z', '2026-10-15T10:00:41Z', 4),
    ]
    const h = harness({ prs: [pr(70, { checks })], runs: [] })
    await once(h, ['7'])
    assert.deepEqual(h.out, [
      'pr-abierto #7 PR #70 abc1234',
      'ci-roja #7 PR #70 abc1234: ubuntu-latest / Node 20=FAILURE',
    ])
    assert.equal(h.cursor()['7'].ci, 'roja')
  })

  test('Issue 240 Rule 2: red row started after first cancellation completed is not reported and emits ci-cancelada', async () => {
    const run = 38843085964
    const row = (name, conclusion, startedAt, completedAt, job = 1) => ({
      __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion, startedAt, completedAt,
      detailsUrl: `https://github.com/org/repo/actions/runs/${run}/job/${job}`,
    })
    const checks = [
      row('matrix-job', 'CANCELLED', '2026-10-15T02:57:40Z', '2026-10-15T02:58:16Z', 1),
      row('ci-ok', 'FAILURE', '2026-10-15T02:59:09Z', '2026-10-15T02:59:15Z', 2),
    ]
    const h = harness({ prs: [pr(70, { checks })], runs: [] })
    await once(h, ['7'])
    assert.deepEqual(h.out, [
      'pr-abierto #7 PR #70 abc1234',
      'ci-cancelada #7 PR #70 abc1234: matrix-job=CANCELLED',
    ])
    assert.equal(h.cursor()['7'].ci, undefined)

    const withNewer = harness({ prs: [pr(70, { checks })], runs: [{ databaseId: 38843110472, status: 'queued', conclusion: null }] })
    await once(withNewer, ['7'])
    assert.deepEqual(withNewer.out, ['pr-abierto #7 PR #70 abc1234'])
  })

  test('Issue 240 Rule 3: red row with no startedAt or cancelled rows with no completedAt keeps #225 behaviour', async () => {
    const run = 999
    const row = (name, conclusion, startedAt, completedAt, job = 1) => ({
      __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion, startedAt, completedAt,
      detailsUrl: `https://github.com/org/repo/actions/runs/${run}/job/${job}`,
    })
    const noStarted = [
      row('matrix-job', 'CANCELLED', '2026-10-15T10:00:00Z', '2026-10-15T10:00:40Z', 1),
      row('unit-test', 'FAILURE', null, '2026-10-15T10:00:40Z', 2),
    ]
    const h1 = harness({ prs: [pr(70, { checks: noStarted })], runs: [] })
    await once(h1, ['7'])
    assert.deepEqual(h1.out, [
      'pr-abierto #7 PR #70 abc1234',
      'ci-cancelada #7 PR #70 abc1234: matrix-job=CANCELLED',
    ])

    const noCompleted = [
      row('matrix-job', 'CANCELLED', '2026-10-15T10:00:00Z', null, 1),
      row('unit-test', 'FAILURE', '2026-10-15T10:00:05Z', '2026-10-15T10:00:40Z', 2),
    ]
    const h2 = harness({ prs: [pr(70, { checks: noCompleted })], runs: [] })
    await once(h2, ['7'])
    assert.deepEqual(h2.out, [
      'pr-abierto #7 PR #70 abc1234',
      'ci-cancelada #7 PR #70 abc1234: matrix-job=CANCELLED',
    ])
  })

  test('Issue 240 PRESERVE: vigilarCommand preserves existing green, pending and unhandled cancelled events', async () => {
    const green = harness({ prs: [pr(70, { checks: GREEN })] })
    await once(green, ['7'])
    assert.deepEqual(green.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234'])

    const pending = harness({ prs: [pr(70, { checks: PENDING })] })
    await once(pending, ['7'])
    assert.deepEqual(pending.out, ['pr-abierto #7 PR #70 abc1234'])
  })

  test('Issue 256 Rule 2: real fail-fast rows emit ci-roja with the failing row', async () => {
    // Real statusCheckRollup rows of https://github.com/encode/httpx/pull/3796 (run 37009481166, default fail-fast matrix).
    const row = (name, conclusion, startedAt, completedAt, job) => ({
      __typename: 'CheckRun', name, workflowName: 'Test Suite', status: 'COMPLETED', conclusion, startedAt, completedAt,
      detailsUrl: `https://github.com/encode/httpx/actions/runs/37009481166/job/${job}`,
    })
    const checks = [
      row('Python 3.10', 'CANCELLED', '2026-10-02T12:54:17Z', '2026-10-02T12:55:11Z', 110845502632),
      row('Python 3.11', 'CANCELLED', '2026-10-02T12:53:52Z', '2026-10-02T12:54:36Z', 110845502341),
      row('Python 3.12', 'FAILURE', '2026-10-02T12:53:52Z', '2026-10-02T12:54:34Z', 110845502631),
      row('Python 3.13', 'CANCELLED', '2026-10-02T12:53:54Z', '2026-10-02T12:54:56Z', 110845502533),
    ]
    const h = harness({ prs: [pr(70, { checks })], runs: [] })
    await once(h, ['7'])
    assert.deepEqual(h.out, [
      'pr-abierto #7 PR #70 abc1234',
      'ci-roja #7 PR #70 abc1234: Python 3.12=FAILURE',
    ])
    assert.equal(h.cursor()['7'].ci, 'roja')
  })
})

describe('orca-stack vigilar (#254)', () => {
  const DF9 = 'df9e86accccccccccccccccccccccccccccccccc'
  const pr251 = options => pr(251, { head: DF9, branch: 'Gagaismo/orca-stack-250', closes: [250], ...options })
  const readsMergeable = (h, prefix) => h.calls.some(call => call.startsWith(prefix) && call.split(' ').at(-1).split(',').includes('mergeable'))

  test('Issue 254 Rule 1: #250 / PR #251 conflicting on head df9e86a after PR #252 merged gives pr-en-conflicto #250 PR #251 df9e86a', async () => {
    const h = harness({ prs: [pr251({ mergeable: 'CONFLICTING' })] })
    await once(h, ['250'])
    assert.ok(readsMergeable(h, 'gh pr list'), 'mergeable is read with the PR fields')
    assert.deepEqual(h.out, ['pr-abierto #250 PR #251 df9e86a', 'pr-en-conflicto #250 PR #251 df9e86a'])

    // A cursor PR past the list's --limit is read with gh pr view and the same fields.
    const viewed = harness({ prs: [pr251({ mergeable: 'CONFLICTING' })], hidden: [251] })
    viewed.files[CURSOR] = JSON.stringify({ 250: { pr: 251, head: DF9, abiertoPara: ['250'] } })
    await once(viewed, ['250'])
    assert.ok(readsMergeable(viewed, 'gh pr view 251'))
    assert.deepEqual(viewed.out, ['pr-en-conflicto #250 PR #251 df9e86a'])
  })

  test('Issue 254 Rule 2: once per head; a new conflicting head emits again; a new mergeable head emits no conflict and CI follows', async () => {
    const h = harness({ prs: [pr251({ mergeable: 'CONFLICTING' })] })
    await once(h, ['250'])
    drain(h)
    await once(h, ['250'])
    assert.deepEqual(h.out, [])

    h.world.prs = [pr251({ head: ABC, mergeable: 'CONFLICTING' })]
    await once(h, ['250'])
    assert.deepEqual(drain(h), ['head-nuevo #251 abc1234', 'pr-en-conflicto #250 PR #251 abc1234'])

    h.world.prs = [pr251({ head: DEF, mergeable: 'MERGEABLE', checks: PENDING })]
    await once(h, ['250'])
    assert.deepEqual(drain(h), ['head-nuevo #251 def5678'])
    h.world.prs = [pr251({ head: DEF, mergeable: 'MERGEABLE', checks: GREEN })]
    await once(h, ['250'])
    assert.deepEqual(h.out, ['ci-verde #250 PR #251 def5678'])
  })

  test('Issue 254 Rule 3: UNKNOWN emits nothing, is evaluated again next poll, and does not clear a conflict emitted for that head', async () => {
    const h = harness({ prs: [pr251({ mergeable: 'UNKNOWN' })] })
    await once(h, ['250'])
    assert.deepEqual(drain(h), ['pr-abierto #250 PR #251 df9e86a'])
    h.world.prs = [pr251({ mergeable: 'CONFLICTING' })]
    await once(h, ['250'])
    assert.deepEqual(drain(h), ['pr-en-conflicto #250 PR #251 df9e86a'])

    h.world.prs = [pr251({ mergeable: 'UNKNOWN' })]
    await once(h, ['250'])
    h.world.prs = [pr251({ mergeable: 'CONFLICTING' })]
    await once(h, ['250'])
    assert.deepEqual(h.out, [])
  })

  test('Issue 254 Rule 4: the conflict event is emitted while the PR\'s worker is live', async () => {
    const worker = { path: '/wt/orca-stack-250', branch: 'Gagaismo/orca-stack-250', linkedIssue: 250, agents: [{ agentType: 'codex', state: 'working' }] }
    const h = harness({ worktrees: [worker], prs: [pr251({ mergeable: 'CONFLICTING' })] })
    await once(h, ['250'])
    assert.deepEqual(h.out, ['pr-abierto #250 PR #251 df9e86a', 'pr-en-conflicto #250 PR #251 df9e86a'])

    const manual = readFileSync(path.join(PACKAGE_ROOT, 'docs', 'manual.md'), 'utf8')
    const row = manual.split(/\r?\n/).find(line => line.startsWith('| `pr-en-conflicto #<n> PR #<pr> <sha>`'))
    assert.ok(row?.includes('con el agente vivo, `rebote` se niega'), row)
    assert.ok(row.includes('`orca-stack rebote <pr>` una vez que el worker se detuvo'), row)
  })

  test('Issue 254 Rule 5: re-arming vigilar resumes from the cursor and does not emit the conflict of the current head again', async () => {
    const h = harness({ prs: [pr251({ mergeable: 'CONFLICTING' })] })
    await once(h, ['250'])
    assert.ok(h.out.includes('pr-en-conflicto #250 PR #251 df9e86a'))
    const rearmed = harness({ prs: [pr251({ mergeable: 'CONFLICTING' })] })
    rearmed.files[CURSOR] = h.files[CURSOR]
    await once(rearmed, ['250'])
    assert.deepEqual(rearmed.out, [])
  })

  test('Issue 254 Rule 6: a conflicting PR is open and does not close the batch; tanda-cerrada keeps its condition', async () => {
    const h = harness({ prs: [pr(70, { state: 'MERGED' }), pr251({ mergeable: 'CONFLICTING' })] })
    await once(h, ['7', '250'])
    assert.deepEqual(drain(h), ['pr-mergeado #7 PR #70 abc1234', 'pr-abierto #250 PR #251 df9e86a', 'pr-en-conflicto #250 PR #251 df9e86a'])
    assert.equal(h.cursor()['250'].fin, undefined)

    h.world.prs = [pr(70, { state: 'MERGED' }), pr251({ state: 'MERGED' })]
    assert.equal(await vigilarCommand({}, ['7', '250'], h.io), 0)
    assert.deepEqual(h.out, ['pr-mergeado #250 PR #251 df9e86a', 'tanda-cerrada #7 #250'])
  })

  test('Issue 254 Rule 7: the manual events table has pr-en-conflicto with rebote; MAIN.md step 5 names it next to worker-detenido; AGENTS.md equals the asset; vigilar --help lists it', async () => {
    const manual = readFileSync(path.join(PACKAGE_ROOT, 'docs', 'manual.md'), 'utf8')
    const row = manual.split(/\r?\n/).find(line => line.startsWith('| `pr-en-conflicto #<n> PR #<pr> <sha>`'))
    assert.ok(row, 'manual events row')
    assert.ok(row.includes('Corré `orca-stack rebote <pr>` una vez que el worker se detuvo'), row)

    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'MAIN.md'), 'utf8')
    const step5 = contract.split(/\r?\n/).find(line => line.startsWith('5. '))
    assert.ok(step5.includes('`worker-detenido #<n> <agente>: terminó sin abrir un PR`'))
    assert.ok(step5.includes('`pr-en-conflicto #<n> PR #<pr> <sha>`'))
    assert.ok(step5.includes('`orca-stack rebote <pr>`'))

    const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })
    assert.equal(upsertBlock(agents, block), agents, 'init would change nothing in AGENTS.md')

    const oldLog = console.log
    let output = ''
    console.log = value => { output += `${value}\n` }
    try {
      assert.equal(await main(['vigilar', '--help']), 0)
    } finally {
      console.log = oldLog
    }
    assert.ok(output.split('\n').some(line => line.trim() === 'pr-en-conflicto #<n> PR #<pr> <sha>'), output)
  })

  test('Issue 254 Rule 8 and PRESERVE: vigilarCommand keeps every existing event and --merge-de-main on a non-conflicting PR', async () => {
    const worker = { path: '/wt/orca-stack-7', branch: 'Gagaismo/orca-stack-7', linkedIssue: 7, agents: [{ agentType: 'codex', state: 'working' }] }
    const h = harness({ worktrees: [worker], prs: [pr(70, { mergeable: 'MERGEABLE', checks: [check('ci-ok', 'FAILURE')] })] })
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['pr-abierto #7 PR #70 abc1234', 'ci-roja #7 PR #70 abc1234: ci-ok=FAILURE'])
    h.world.prs = [pr(70, { head: DEF, mergeable: 'MERGEABLE', checks: GREEN })]
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['head-nuevo #70 def5678', 'ci-verde-retenido #7 PR #70 def5678: codex working'])
    worker.agents[0].state = 'done'
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['ci-verde #7 PR #70 def5678'])
    assert.equal(await mergeDeMain(h, '70'), 0)
    h.world.prs = [pr(70, { state: 'MERGED', head: DEF, mergeable: 'UNKNOWN' })]
    assert.equal(await vigilarCommand({}, ['7'], h.io), 0)
    assert.deepEqual(drain(h), ['tanda-cerrada #7'])
    assert.equal(h.cursor()['7'].fin, 'main')

    const cancelled = [{ __typename: 'CheckRun', name: 'matrix', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/org/repo/actions/runs/38843085964/job/1' }]
    const c = harness({ prs: [pr(70, { mergeable: 'MERGEABLE', checks: cancelled }), pr(80, { mergeable: 'MERGEABLE', branch: 'Gagaismo/orca-stack-8', closes: [8] })], runs: [] })
    await once(c, ['7', '8'])
    assert.deepEqual(drain(c), ['pr-abierto #7 PR #70 abc1234', 'ci-cancelada #7 PR #70 abc1234: matrix=CANCELLED', 'pr-abierto #8 PR #80 abc1234'])
    c.world.prs = [pr(70, { state: 'MERGED' }), pr(80, { state: 'CLOSED', branch: 'Gagaismo/orca-stack-8', closes: [8] })]
    assert.equal(await vigilarCommand({}, ['7', '8'], c.io), 0)
    assert.deepEqual(c.out, ['pr-mergeado #7 PR #70 abc1234', 'pr-cerrado #8 PR #80', 'tanda-cerrada #7 #8'])

    const paused = harness({ worktrees: [{ path: '/wt/orca-stack-9', branch: 'b9', linkedIssue: 9, agents: [{ state: 'done', agentType: 'codex' }] }] })
    await once(paused, ['9'])
    assert.deepEqual(paused.out, ['worker-detenido #9 codex: terminó sin abrir un PR'])
  })
})

describe('orca-stack vigilar (#299)', () => {
  test('Rule 1: emits each marked review comment with its reviewer, commit and blocker count', async () => {
    const h = harness({ prs: [{ ...pr(70), comments: [{ id: 'c1', body: 'Revisor: agy\nCommit: abc1234aaaaaaaa\n\n## BLOQUEA\n1. First\n2. Second\n\n## SUGERENCIAS\nNone' }], reviews: [{ id: 'r1', body: 'Revisor: pi\nCommit: def5678bbbbbbbb\n\n## BLOQUEA\nnada' }, { id: 'r2', body: 'ordinary comment' }] }] })
    await once(h, ['7'])
    assert.deepEqual(h.out.filter(line => line.startsWith('review-publicado')), ['review-publicado #70 agy abc1234 bloquea=2', 'review-publicado #70 pi def5678 bloquea=0'])
  })

  test('Rule 2: emits a new head only after the watched PR head changes', async () => {
    const h = harness({ prs: [pr(70)] })
    await once(h, ['7'])
    assert.ok(!h.out.some(line => line.startsWith('head-nuevo')))
    h.world.prs[0].headRefOid = DEF
    await once(h, ['7'])
    assert.ok(h.out.includes('head-nuevo #70 def5678'))
    h.world.prs[0] = pr(70, { state: 'MERGED', head: ABC })
    await once(h, ['7'])
    assert.ok(h.out.includes('head-nuevo #70 abc1234'))
    h.world.prs[0].headRefOid = DEF
    await once(h, ['7'])
    drain(h)
    await once(h, ['7'])
    assert.ok(!h.out.some(line => line.startsWith('head-nuevo')))
  })

  test('Rule 3: review and head events survive a rearm without repetition', async () => {
    const world = { prs: [{ ...pr(70), comments: [{ id: 'c1', body: 'Revisor: agy\nCommit: abc1234aaaaaaaa\n## BLOQUEA\nnada' }] }] }
    const h = harness(world)
    await once(h, ['7'])
    world.prs[0].headRefOid = DEF
    await once(h, ['7'])
    assert.equal(h.out.filter(line => line === 'review-publicado #70 agy abc1234 bloquea=0').length, 1)
    assert.equal(h.out.filter(line => line === 'head-nuevo #70 def5678').length, 1)
    const rearmed = harness(world)
    rearmed.files[CURSOR] = JSON.stringify(h.cursor())
    await once(rearmed, ['7'])
    assert.deepEqual(rearmed.out, [])
    const shared = harness({ prs: [{ ...pr(70, { closes: [7, 8] }), comments: world.prs[0].comments }] })
    shared.world.prs[0].comments.push({ ...shared.world.prs[0].comments[0], id: 'c2' })
    await once(shared, ['7', '8'])
    assert.equal(shared.out.filter(line => line === 'review-publicado #70 agy abc1234 bloquea=0').length, 2)
    shared.world.prs[0].headRefOid = DEF
    await once(shared, ['7', '8'])
    assert.equal(shared.out.filter(line => line === 'head-nuevo #70 def5678').length, 1)
  })

  test('PRESERVE: vigilarCommand retains existing PR and CI events', async () => {
    const h = harness({ prs: [pr(70, { checks: GREEN })] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234'])
  })
})

describe('orca-stack vigilar (main-autonomo S9, #365)', () => {
  const BOM = String.fromCharCode(0xfeff)
  const reviews = h => h.out.filter(line => line.startsWith('review-publicado'))

  test('S9: a review body led by a BOM gives the same review-publicado as one without it', async () => {
    const h = harness({ prs: [{ ...pr(70), comments: [{ id: 'c1', body: `${BOM}Revisor: codex\nCommit: ${ABC}\n\n## BLOQUEA\nnada` }] }] })
    await once(h, ['7'])
    assert.deepEqual(reviews(h), ['review-publicado #70 codex abc1234 bloquea=0'])
  })

  test('S9: Commit: with the sha in backticks counts; a quoted `> Revisor:` body is not a review', async () => {
    const h = harness({ prs: [{ ...pr(70), comments: [
      { id: 'c1', body: `Revisor: agy\nCommit: \`${ABC}\`\n\n## BLOQUEA\n1. Falta un test` },
      { id: 'c2', body: `> Revisor: codex\n> Commit: ${ABC}\n\nCito el review de arriba.` },
    ] }] })
    await once(h, ['7'])
    assert.deepEqual(reviews(h), ['review-publicado #70 agy abc1234 bloquea=1'])
  })

  test('S9: Fixes #N, Closes: #N, lowercase and mid-line closing keywords link a PR; Refs #N and #NN do not', async () => {
    const bodies = { 71: 'Fixes #7', 72: 'Closes: #8', 73: 'closes #9', 74: 'This PR resolves #10 today.' }
    const linkedPrs = Object.entries(bodies).map(([n, body]) => pr(Number(n), { branch: `b${n}`, closes: [], body }))
    const decoys = [pr(80, { branch: 'b80', closes: [], body: 'Refs #11' }), pr(81, { branch: 'b81', closes: [], body: 'Closes #110' })]
    const h = harness({ prs: [...linkedPrs, ...decoys] })
    await once(h, ['7', '8', '9', '10', '11'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #71 abc1234', 'pr-abierto #8 PR #72 abc1234', 'pr-abierto #9 PR #73 abc1234', 'pr-abierto #10 PR #74 abc1234'])
  })

  test('S9: a PR an older monitor already knew gives pr-abierto once to a monitor of another batch, never again on rearm', async () => {
    const h = harness({ prs: [pr(70)], issues: { 8: 'OPEN' } })
    await once(h, ['7', '8'])
    assert.deepEqual(drain(h), ['pr-abierto #7 PR #70 abc1234'])

    const other = harness({ prs: [pr(70)] })
    other.files[CURSOR] = h.files[CURSOR]
    await once(other, ['7'])
    assert.deepEqual(drain(other), ['pr-abierto #7 PR #70 abc1234'])
    await once(other, ['7'])
    assert.deepEqual(drain(other), [])

    // The first batch, re-armed with its own arguments on the shared cursor, resumes without repeating.
    const rearmed = harness({ prs: [pr(70)], issues: { 8: 'OPEN' } })
    rearmed.files[CURSOR] = other.files[CURSOR]
    await once(rearmed, ['7', '8'])
    assert.deepEqual(rearmed.out, [])
  })

  test('S9: a cursor written before this fix (pr known, no record of who was told) gives pr-abierto once', async () => {
    const h = harness({ prs: [pr(70)] })
    h.files[CURSOR] = JSON.stringify({ 7: { pr: 70, head: ABC } })
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['pr-abierto #7 PR #70 abc1234'])
    await once(h, ['7'])
    assert.deepEqual(h.out, [])
  })

  test('PRESERVE S3: a batch watcher never reads sub-issues', async () => {
    const h = harness({ prs: [pr(70)] })
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['pr-abierto #7 PR #70 abc1234'])
    assert.equal(h.calls.some(call => call.includes('sub_issues')), false)
  })

  test('S9: --consultas reads the linked PR too, so a Consulta: on PR #70 is reported', async () => {
    const h = harness({ prs: [pr(70)], comments: { 70: [{ ...CONSULTA, id: 'IC_pr', body: `${BOM}Consulta: pi — ¿consentimiento RDD?` }] } })
    await once(h, ['7'], { consultas: true })
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'consulta nueva en #70'])
    assert.ok(h.calls.includes('gh issue view 7 --json comments'))
    assert.ok(h.calls.includes('gh issue view 70 --json comments'))
  })
})

describe('orca-stack vigilar --paraguas (S3, #370)', () => {
  const umbrella = (h, flags = {}) => vigilarCommand({ paraguas: '29', unaVez: true, ...flags }, [], h.io)
  const EVENT = 'planificacion-publicada #29 #63,#64,#65,#66'

  test('Rule 1: four sub-issues from one to-tickets run give one event, once the batch stops growing', async () => {
    const h = harness({ subIssues: { 29: [63, 64] } })
    await umbrella(h)
    assert.deepEqual(drain(h), [])
    h.world.subIssues[29] = [63, 64, 65, 66]
    await umbrella(h)
    assert.deepEqual(drain(h), [])
    await umbrella(h)
    assert.deepEqual(drain(h), [EVENT])
    await umbrella(h)
    assert.deepEqual(h.out, [])
    assert.ok(h.calls.includes('gh api repos/{owner}/{repo}/issues/29/sub_issues?per_page=100'))
  })

  test('Rule 1: a later batch gives its own event with only the new sub-issues', async () => {
    const h = harness({ subIssues: { 29: [63, 64, 65, 66] } })
    await umbrella(h)
    await umbrella(h)
    assert.deepEqual(drain(h), [EVENT])
    h.world.subIssues[29] = [63, 64, 65, 66, 80, 79]
    await umbrella(h)
    await umbrella(h)
    assert.deepEqual(h.out, ['planificacion-publicada #29 #79,#80'])
  })

  test('Rule 2 negative: grilling turns (comments, umbrella edits) with no sub-issues emit nothing', async () => {
    const h = harness({ subIssues: { 29: [] }, comments: { 29: [{ id: 'IC_9', author: { login: 'stack-bot' }, body: 'Edité GLOSSARY.md' }] } })
    for (let i = 0; i < 3; i += 1) await umbrella(h)
    assert.deepEqual(h.out, [])
    assert.equal(h.calls.some(call => call.includes('comments')), false)
  })

  test('Rule 3 negative: an issue that is not a sub-issue of the umbrella emits nothing', async () => {
    // #90 is a follow-up bug in the repo: it is on the umbrella's own sub-issue list only if someone links it.
    const h = harness({ subIssues: { 29: [], 90: [] }, issues: { 90: 'OPEN' } })
    for (let i = 0; i < 3; i += 1) await umbrella(h)
    assert.deepEqual(h.out, [])
  })

  test('a re-armed monitor resumes from the cursor and does not re-emit', async () => {
    const h = harness({ subIssues: { 29: [63, 64, 65, 66] } })
    await umbrella(h)
    await umbrella(h)
    assert.deepEqual(drain(h), [EVENT])
    const rearmed = harness({ subIssues: { 29: [63, 64, 65, 66] } })
    rearmed.files[CURSOR] = h.files[CURSOR]
    await umbrella(rearmed)
    await umbrella(rearmed)
    assert.deepEqual(rearmed.out, [])
    // The umbrella's entry shares vigilar.json with the batch items and does not touch them.
    h.files[CURSOR] = JSON.stringify({ ...h.cursor(), 7: { pr: 70, head: ABC } })
    await umbrella(h)
    assert.deepEqual(h.cursor()[7], { pr: 70, head: ABC })
  })

  test('--dry-run reads once and writes no cursor', async () => {
    const h = harness({ subIssues: { 29: [63] } })
    await umbrella(h, { unaVez: false, dryRun: true })
    await umbrella(h, { unaVez: false, dryRun: true })
    assert.equal(CURSOR in h.files, false)
    assert.deepEqual(h.out, [])
  })

  test('looping, it emits the batch and ends on its own when the umbrella is closed', async () => {
    const h = harness({
      subIssues: { 29: [63, 64, 65, 66] },
      script: [() => {}, world => { world.issues = { 29: 'CLOSED' } }],
    })
    assert.equal(await vigilarCommand({ paraguas: '29', cada: '5' }, [], h.io), 0)
    assert.deepEqual(h.out, [EVENT])
    assert.deepEqual(h.sleeps, [5000, 5000])
    assert.ok(h.err.includes('vigilar: el paraguas #29 está cerrado; no queda nada que vigilar.'))
  })

  test('three polls in a row that cannot read GitHub say vigilar-ciego once', async () => {
    const h = harness({ ghDown: 'HTTP 502' })
    for (let i = 0; i < 4; i += 1) await vigilarCommand({ paraguas: '29', unaVez: true }, [], h.io)
    // Each --una-vez run starts its own failure count: only a looping watcher reaches three.
    assert.deepEqual(h.out, [])
    const looping = harness({ ghDown: 'HTTP 502', script: [() => {}, () => {}, world => { delete world.ghDown; world.issues = { 29: 'CLOSED' } }] })
    await vigilarCommand({ paraguas: '29', cada: '1' }, [], looping.io)
    assert.deepEqual(looping.out, ['vigilar-ciego: gh issue view falló (HTTP 502)'])
  })

  test('negative: --paraguas takes one umbrella number and no batch items', async () => {
    const usage = 'Uso: orca-stack vigilar --paraguas <n> [--cada <segundos>] [--una-vez] [--dry-run], con el número de un solo issue paraguas y sin otros items.'
    for (const [flags, items] of [[{ paraguas: 'x' }, []], [{ paraguas: '' }, []], [{ paraguas: '29' }, ['7']], [{ paraguas: '29', consultas: true }, []]]) {
      const h = harness()
      await assert.rejects(vigilarCommand({ unaVez: true, ...flags }, items, h.io), error => error.message === usage, JSON.stringify([flags, items]))
      assert.deepEqual(h.calls, [])
    }
  })
})

describe('issue #395 diagnosis', () => {
  const read = name => readFileSync(path.join(PACKAGE_ROOT, name), 'utf8')
  test('Rule 1: contract defines the diagnosis marker and fields', () => {
    const text = read('assets/stack/CONTRATO.md')
    for (const s of ['Diagn\u00f3stico: <agente>', 'Causa:', 'Probado:', 'Siguiente hip\u00f3tesis:']) assert.ok(text.includes(s), s)
  })
  test('Rule 2: brief limits attempts by cause and stops without a PR', () => {
    const text = read('assets/stack/brief-ticket.md')
    for (const s of ['two attempts per cause', 'Fixing an unrelated failure does not use an attempt for this cause', 'After the second failed attempt', 'does not push or open a PR']) assert.ok(text.includes(s), s)
  })
  test('Rule 3: RED setup self-fix is separate and unreproduced rule is diagnosed', () => {
    const text = read('assets/stack/brief-ticket.md')
    for (const s of ['one setup self-fix', 'does not count', 'Causa: no se pudo reproducir']) assert.ok(text.includes(s), s)
  })
  test('Rule 4: brief places diagnosis on open PR or otherwise issue', () => {
    const text = read('assets/stack/brief-ticket.md')
    assert.ok(text.includes('on the open PR, otherwise on the issue'))
  })
  test('Rule 5: diagnosis events survive rearm and PR transition and ignore quotes and main', async () => {
    const comments = { 7: [{ id: 'i1', body: 'Diagn\u00f3stico: codex' }, { id: 'i2', body: 'quoted Diagn\u00f3stico: pi' }, { id: 'i3', body: 'Diagn\u00f3stico: main' }] }
    const h = harness({ comments })
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['diagnostico #7 codex'])
    h.world.prs = [{ ...pr(70), comments: [{ id: 'p1', body: 'Diagn\u00f3stico: agy' }, { id: 'p2', body: '> Diagn\u00f3stico: pi' }] }]
    await once(h, ['7'])
    assert.deepEqual(drain(h).filter(line => line.startsWith('diagnostico ')), ['diagnostico #7 agy'])
    const rearmed = harness(h.world)
    rearmed.files[CURSOR] = h.files[CURSOR]
    await once(rearmed, ['7'])
    assert.deepEqual(rearmed.out, [])
    const shared = harness({ prs: [{ ...pr(70, { closes: [7, 8] }), comments: [{ id: 'p1', body: 'Diagn\u00f3stico: agy' }] }] })
    await once(shared, ['7', '8'])
    assert.deepEqual(shared.out.filter(line => line.startsWith('diagnostico ')), ['diagnostico #7 agy'])
    const unavailable = harness({ issueCommentsDown: true, issues: { 7: 'CLOSED' }, comments: { 7: [{ id: 'i1', body: 'Diagn\u00f3stico: codex' }] } })
    await once(unavailable, ['7'])
    assert.deepEqual(drain(unavailable), [])
    unavailable.world.issueCommentsDown = false
    await once(unavailable, ['7'])
    assert.deepEqual(drain(unavailable), ['diagnostico #7 codex', 'tanda-cerrada #7'])
  })
  test('Rule 6: main acts on a new hypothesis or flags recurring causes without asking', () => {
    const text = read('assets/stack/MAIN.md')
    for (const s of ['diagnostico #<n> <agente>', 'sin preguntarle al humano', 'Probado:', 'nunca repitas lo probado', 'Siguiente hip\u00f3tesis: ninguna', 'needs-info', '--nota', 'producto, interpretaci\u00f3n y alcance']) assert.ok(text.includes(s), s)
  })
  test('Rule 7: manual and help document diagnosis marker and event', async () => {
    const manual = read('docs/manual.md')
    assert.ok(manual.includes('Diagn\u00f3stico:'))
    assert.ok(manual.includes('diagnostico #<n> <agente>'))
    const oldLog = console.log
    let output = ''
    console.log = value => { output += value }
    try { assert.equal(await main(['vigilar', '--help']), 0) } finally { console.log = oldLog }
    assert.ok(output.includes('diagnostico #<n> <agente>'))
  })
  test('PRESERVE: vigilarCommand emits existing PR and CI events', async () => {
    const h = harness({ prs: [pr(70, { checks: GREEN })] })
    await once(h, ['7'])
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234'])
  })
})

describe('orca-stack vigilar (#399)', () => {
  const wt = (issue, agentType, state, extra = {}) => ({
    path: `/wt/orca-stack-${issue}`,
    branch: `Gagaismo/orca-stack-${issue}`,
    linkedIssue: issue,
    terminals: [{ handle: `term_${issue}`, title: agentType === 'antigravity' ? 'agy' : agentType }],
    agents: [{ paneKey: `tab-term_${issue}:leaf-term_${issue}`, state, agentType }],
    ...extra,
  })

  test('Rule 1: a worker sitting on a quota message emits worker-detenido even when Orca still reports working', async () => {
    const quota = '\u26A0 Individual quota reached\u2026 Resets in 10h45m19s'
    const h = harness({
      worktrees: [wt(7, 'antigravity', 'working', { screen: ['Applying fix...', quota] })],
      issues: { 7: 'OPEN' },
      now: T0,
    })
    await once(h, ['7'])
    assert.deepEqual(drain(h), [`worker-detenido #7 agy: cuota \u2014 ${quota}`])

    // R3's 30m working threshold never preempts or double-fires after quota.
    h.world.now = T0 + 30 * MINUTE
    await once(h, ['7'])
    assert.deepEqual(h.out, [])

    // Negative: a genuinely working worker with an active spinner reading quota or rate-limit text emits nothing.
    const working = harness({
      worktrees: [wt(7, 'claude', 'working', { screen: ['Issue #199 says rate-limited and usage limit / quota reached', '\u2722 Churning\u2026 (1m 2s \u00B7 \u2193 3k tokens)'] })],
      issues: { 7: 'OPEN' },
    })
    await once(working, ['7'])
    assert.deepEqual(working.out, [])
  })

  test('Rule 2: emits worker-detenido for quota, shell prompt, and done without PR, and skips closed issues or foreign worktrees', async () => {
    const quota = "You've hit your usage limit. Try again at 00:57."
    const hQuota = harness({ worktrees: [wt(7, 'codex', 'done', { screen: ['step 1', quota] })], issues: { 7: 'OPEN' } })
    await once(hQuota, ['7'])
    assert.deepEqual(hQuota.out, [`worker-detenido #7 codex: cuota \u2014 ${quota}`])

    // Quota words older than the bottom 15 lines do not match quota; instead done applies.
    const oldQuota = harness({
      worktrees: [wt(7, 'claude', 'done', { screen: ['rate limit', ...Array(15).fill('ready'), 'last step'] })],
      issues: { 7: 'OPEN' },
    })
    await once(oldQuota, ['7'])
    assert.deepEqual(oldQuota.out, ['worker-detenido #7 claude: termin\u00F3 sin abrir un PR \u2014 last step'])

    // Idle PowerShell tabs without an agent identity do not mask or trigger a worker death; worker at shell emits volvió al shell.
    const hShell = harness({
      worktrees: [{
        path: '/wt/orca-stack-7',
        branch: 'Gagaismo/orca-stack-7',
        linkedIssue: 7,
        terminals: [{ handle: 'term_idle', title: 'Terminal 1' }, { handle: 'term_worker', title: 'claude' }],
        screens: { term_idle: ['PS C:\\idle>'], term_worker: ['fatal: error', 'PS C:\\work>'] },
        agents: [],
      }],
      issues: { 7: 'OPEN' },
    })
    await once(hShell, ['7'])
    assert.deepEqual(hShell.out, ['worker-detenido #7 claude: volvi\u00F3 al shell \u2014 PS C:\\work>'])

    // Two worker terminals: one done at shell and one live working -> emits nothing.
    const twoTerms = harness({
      worktrees: [{
        path: '/wt/orca-stack-7',
        branch: 'Gagaismo/orca-stack-7',
        linkedIssue: 7,
        terminals: [{ handle: 'term_old', title: 'claude' }, { handle: 'term_new', title: 'claude' }],
        screens: { term_old: ['PS C:\\work>'], term_new: ['\u2722 Churning\u2026 (1m 2s)'] },
        agents: [
          { paneKey: 'tab-term_old:leaf-term_old', state: 'done', agentType: 'claude', updatedAt: 100 },
          { paneKey: 'tab-term_new:leaf-term_new', state: 'working', agentType: 'claude', updatedAt: 200 },
        ],
      }],
      issues: { 7: 'OPEN' },
    })
    await once(twoTerms, ['7'])
    assert.deepEqual(twoTerms.out, [])

    // Closed issue, foreign-repo worktree, and done worker with an open PR are not reported; terminal read error skips worker only.
    const closed = harness({ worktrees: [wt(7, 'claude', 'done', { screen: ['PS C:\\work>'] })], issues: { 7: 'CLOSED' } })
    await once(closed, ['7'])
    assert.deepEqual(closed.out, ['tanda-cerrada #7'])
    assert.equal(closed.calls.some(c => c.startsWith('orca terminal')), false)

    const foreign = harness({
      worktrees: [{ ...wt(7, 'claude', 'done', { screen: ['PS C:\\work>'] }), repo: 'other-repo', foreign: true }],
      issues: { 7: 'OPEN' },
    })
    await once(foreign, ['7'])
    assert.deepEqual(foreign.out, [])
    assert.equal(foreign.calls.some(c => c.startsWith('orca terminal')), false)

    const withPr = harness({
      worktrees: [wt(7, 'claude', 'done', { screen: ['PS C:\\work>'] })],
      prs: [pr(70, { checks: GREEN })],
    })
    await once(withPr, ['7'])
    assert.deepEqual(withPr.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde #7 PR #70 abc1234'])
    assert.equal(withPr.calls.some(c => c.startsWith('orca terminal')), false)

    const readErr = harness({
      worktrees: [wt(7, 'claude', 'done')],
      prs: [pr(80, { branch: 'Gagaismo/orca-stack-8', closes: [8] })],
      issues: { 7: 'OPEN' },
      terminalReadDown: { term_7: 'terminal gone' },
    })
    await once(readErr, ['7', '8'])
    assert.deepEqual(readErr.out, ['pr-abierto #8 PR #80 abc1234'])
    assert.ok(readErr.err.some(line => line.includes('#7') && line.includes('terminal gone')))

    // Failed gh issue view (unknown issue state) never invents worker-detenido.
    const unknownIssue = harness({
      worktrees: [wt(7, 'claude', 'done', { screen: ['PS C:\\work>'] })],
      issueDown: { 7: 'Could not resolve issue' },
    })
    await once(unknownIssue, ['7'])
    assert.deepEqual(unknownIssue.out, [])
  })

  test('Rule 3: emits worker-trabado after 30 minutes while working and after 4 minutes while non-working without a PR', async () => {
    const h = harness({
      worktrees: [wt(7, 'antigravity', 'working', { screen: ['Running tests...'] })],
      issues: { 7: 'OPEN' },
      now: T0,
    })
    await once(h, ['7'])
    assert.deepEqual(drain(h), [])

    h.world.now = T0 + 29 * MINUTE
    await once(h, ['7'])
    assert.deepEqual(drain(h), [])

    h.world.now = T0 + 30 * MINUTE
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['worker-trabado #7 agy: sin cambios por 30m \u2014 Running tests...'])

    // Screen change resets the 30-minute timer.
    h.world.worktrees[0].screen = ['Step 2 running']
    h.world.now = T0 + 31 * MINUTE
    await once(h, ['7'])
    assert.deepEqual(drain(h), [])
    h.world.now = T0 + 60 * MINUTE
    await once(h, ['7'])
    assert.deepEqual(drain(h), [])
    h.world.now = T0 + 61 * MINUTE
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['worker-trabado #7 agy: sin cambios por 30m \u2014 Step 2 running'])

    // Recovery (screen changes) clears prior stall so a later stall on the same text still reports.
    h.world.worktrees[0].screen = ['Running tests...']
    h.world.now = T0 + 62 * MINUTE
    await once(h, ['7'])
    assert.deepEqual(drain(h), [])
    h.world.now = T0 + 92 * MINUTE
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['worker-trabado #7 agy: sin cambios por 30m \u2014 Running tests...'])

    // Non-working without PR stalls at 4 minutes.
    const blocked = harness({
      worktrees: [wt(7, 'claude', 'blocked', { screen: ['Do you want to proceed?'] })],
      issues: { 7: 'OPEN' },
      now: T0,
    })
    await once(blocked, ['7'])
    blocked.world.now = T0 + 3 * MINUTE
    await once(blocked, ['7'])
    assert.deepEqual(drain(blocked), [])
    blocked.world.now = T0 + 4 * MINUTE
    await once(blocked, ['7'])
    assert.deepEqual(drain(blocked), ['worker-trabado #7 claude: sin cambios por 4m \u2014 Do you want to proceed?'])

    // Open PR with working worker stalls at 30 minutes; open PR with non-working worker never triggers 4-minute stall.
    const openWorking = harness({
      worktrees: [wt(7, 'codex', 'working', { screen: ['Pushing fixes'] })],
      prs: [pr(70)],
      now: T0,
    })
    await once(openWorking, ['7'])
    drain(openWorking)
    openWorking.world.now = T0 + 30 * MINUTE
    await once(openWorking, ['7'])
    assert.deepEqual(drain(openWorking), ['worker-trabado #7 codex: sin cambios por 30m \u2014 Pushing fixes'])

    const openBlocked = harness({
      worktrees: [wt(7, 'codex', 'blocked', { screen: ['Waiting'] })],
      prs: [pr(70)],
      now: T0,
    })
    await once(openBlocked, ['7'])
    drain(openBlocked)
    openBlocked.world.now = T0 + 10 * MINUTE
    await once(openBlocked, ['7'])
    assert.deepEqual(openBlocked.out, [])

    // State transition working -> waiting resets the stall clock (does not fire 4m immediately after 5m working).
    const switched = harness({
      worktrees: [wt(7, 'claude', 'working', { screen: ['Thinking'] })],
      issues: { 7: 'OPEN' },
      now: T0,
    })
    await once(switched, ['7'])
    switched.world.worktrees[0].agents[0].state = 'waiting'
    switched.world.now = T0 + 5 * MINUTE
    await once(switched, ['7'])
    assert.deepEqual(drain(switched), [])
    switched.world.now = T0 + 9 * MINUTE
    await once(switched, ['7'])
    assert.deepEqual(drain(switched), ['worker-trabado #7 claude: sin cambios por 4m \u2014 Thinking'])

    // Transitioning back to working and waiting on the same screen does not repeat 4m, still reports 30m working, and decaying does not duplicate 4m.
    switched.world.worktrees[0].agents[0].state = 'working'
    switched.world.now = T0 + 10 * MINUTE
    await once(switched, ['7'])
    switched.world.worktrees[0].agents[0].state = 'waiting'
    switched.world.now = T0 + 11 * MINUTE
    await once(switched, ['7'])
    switched.world.now = T0 + 16 * MINUTE
    await once(switched, ['7'])
    assert.deepEqual(drain(switched), [])
    switched.world.worktrees[0].agents[0].state = 'working'
    switched.world.now = T0 + 17 * MINUTE
    await once(switched, ['7'])
    assert.deepEqual(drain(switched), [])
    switched.world.now = T0 + 47 * MINUTE
    await once(switched, ['7'])
    assert.deepEqual(drain(switched), ['worker-trabado #7 claude: sin cambios por 30m \u2014 Thinking'])
    switched.world.worktrees[0].agents[0].state = 'unverifiable'
    switched.world.now = T0 + 52 * MINUTE
    await once(switched, ['7'])
    assert.deepEqual(switched.out, [])
  })

  test('Rule 4: each watchdog event ends with the last non-empty screen line cut at 200 characters', async () => {
    const longLine = 'A'.repeat(250)
    const hStall = harness({
      worktrees: [wt(7, 'claude', 'waiting', { screen: ['short', `   ${longLine}   `, '', '   '] })],
      issues: { 7: 'OPEN' },
      now: T0,
    })
    await once(hStall, ['7'])
    hStall.world.now = T0 + 4 * MINUTE
    await once(hStall, ['7'])
    assert.equal(hStall.out.length, 1)
    assert.ok(hStall.out[0].endsWith('A'.repeat(200)), hStall.out[0])
    assert.ok(!hStall.out[0].endsWith('A'.repeat(201)), hStall.out[0])

    const quota = '\u26A0 Individual quota reached\u2026 Resets in 10h45m19s'
    const hQuotaTrailing = harness({
      worktrees: [wt(7, 'antigravity', 'working', { screen: [quota, longLine, ''] })],
      issues: { 7: 'OPEN' },
    })
    await once(hQuotaTrailing, ['7'])
    assert.equal(hQuotaTrailing.out.length, 1)
    assert.ok(hQuotaTrailing.out[0].includes(`cuota \u2014 ${quota}`))
    assert.ok(hQuotaTrailing.out[0].endsWith('A'.repeat(200)))
    assert.ok(!hQuotaTrailing.out[0].endsWith('A'.repeat(201)))
  })

  test('Rule 5: watches pi workers like every other agent (without PR and with open PR)', async () => {
    const piPr = harness({
      worktrees: [wt(7, 'pi', 'working', { screen: ['\u2500 \u2740 implementing\u2026 \u2500\u2500\u2500 INSERT \u2500'] })],
      prs: [pr(70, { checks: GREEN })],
    })
    await once(piPr, ['7'])
    assert.deepEqual(piPr.out, ['pr-abierto #7 PR #70 abc1234', 'ci-verde-retenido #7 PR #70 abc1234: pi working'])

    const piShell = harness({
      worktrees: [wt(7, 'pi', 'done', { screen: ['done output', 'PS C:\\work>'] })],
      issues: { 7: 'OPEN' },
    })
    await once(piShell, ['7'])
    assert.deepEqual(piShell.out, ['worker-detenido #7 pi: volvi\u00F3 al shell \u2014 PS C:\\work>'])

    const piDone = harness({
      worktrees: [wt(7, 'pi', 'done', { screen: ['\u2500 \u273F waiting for input \u2500\u2500\u2500 INSERT \u2500'] })],
      issues: { 7: 'OPEN' },
    })
    await once(piDone, ['7'])
    assert.deepEqual(piDone.out, ['worker-detenido #7 pi: termin\u00F3 sin abrir un PR \u2014 \u2500 \u273F waiting for input \u2500\u2500\u2500 INSERT \u2500'])

    const piStall = harness({
      worktrees: [wt(7, 'pi', 'working', { screen: ['Running tests'] })],
      issues: { 7: 'OPEN' },
      now: T0,
    })
    await once(piStall, ['7'])
    piStall.world.now = T0 + 30 * MINUTE
    await once(piStall, ['7'])
    assert.deepEqual(piStall.out, ['worker-trabado #7 pi: sin cambios por 30m \u2014 Running tests'])

    // pi without an Orca record stalls at 4 minutes when idle on screen without a PR, and reports quota when hit.
    const piIdleStall = harness({
      worktrees: [{
        path: '/wt/orca-stack-8',
        branch: 'Gagaismo/orca-stack-8',
        linkedIssue: 8,
        terminals: [{ handle: 'term_8', title: 'pi' }],
        agents: [],
        screen: ['Waiting on step'],
      }],
      issues: { 8: 'OPEN' },
      now: T0,
    })
    await once(piIdleStall, ['8'])
    piIdleStall.world.now = T0 + 4 * MINUTE
    await once(piIdleStall, ['8'])
    assert.deepEqual(piIdleStall.out, ['worker-trabado #8 pi: sin cambios por 4m \u2014 Waiting on step'])

    const piQuota = "Claude rate limit (five_hour) \u2014 resets 02:20:00: You've hit your session limit"
    const hPiQuota = harness({
      worktrees: [wt(9, 'pi', 'working', { screen: [piQuota] })],
      issues: { 9: 'OPEN' },
    })
    await once(hPiQuota, ['9'])
    assert.deepEqual(hPiQuota.out, [`worker-detenido #9 pi: cuota \u2014 ${piQuota}`])

    // Newer pi terminal without an Orca record wins over an older done terminal.
    const newerPi = harness({
      worktrees: [{
        path: '/wt/orca-stack-10',
        branch: 'Gagaismo/orca-stack-10',
        linkedIssue: 10,
        terminals: [
          { handle: 'term_old', title: 'claude', lastOutputAt: 100 },
          { handle: 'term_pi', title: 'pi', lastOutputAt: 200 },
        ],
        screens: { term_old: ['Done'], term_pi: ['PS C:\\work>'] },
        agents: [{ paneKey: 'tab-term_old:leaf-term_old', state: 'done', agentType: 'claude', updatedAt: 100 }],
      }],
      issues: { 10: 'OPEN' },
    })
    await once(newerPi, ['10'])
    assert.deepEqual(newerPi.out, ['worker-detenido #10 pi: volvi\u00F3 al shell \u2014 PS C:\\work>'])
  })

  test('Rule 6: each (worker, reason) is emitted once and resumes across restarts without repeating or losing elapsed stall time', async () => {
    const quota = '\u26A0 Individual quota reached\u2026 Resets in 10h45m19s'
    const h = harness({
      worktrees: [wt(7, 'antigravity', 'working', { screen: [quota] })],
      issues: { 7: 'OPEN' },
      now: T0,
    })
    await once(h, ['7'])
    assert.deepEqual(drain(h), [`worker-detenido #7 agy: cuota \u2014 ${quota}`])

    // Restart with persisted cursor: quota does not repeat.
    const rearmed = harness({
      worktrees: [wt(7, 'antigravity', 'working', { screen: [quota] })],
      issues: { 7: 'OPEN' },
      now: T0 + 2 * MINUTE,
    })
    rearmed.files[CURSOR] = h.files[CURSOR]
    await once(rearmed, ['7'])
    assert.deepEqual(rearmed.out, [])

    // Reason changes from quota to shell: emits once for the new reason.
    rearmed.world.worktrees[0].agents[0].state = 'done'
    rearmed.world.worktrees[0].screen = ['PS C:\\work>']
    await once(rearmed, ['7'])
    assert.deepEqual(drain(rearmed), ['worker-detenido #7 agy: volvi\u00F3 al shell \u2014 PS C:\\work>'])

    // Stall timer survives restart: started at T0, restarted at T0 + 15m, triggers at T0 + 30m, never repeats at T0 + 35m.
    const stall1 = harness({
      worktrees: [wt(8, 'claude', 'working', { screen: ['Still thinking'] })],
      issues: { 8: 'OPEN' },
      now: T0,
    })
    await once(stall1, ['8'])
    assert.deepEqual(stall1.out, [])

    const stall2 = harness({
      worktrees: [wt(8, 'claude', 'working', { screen: ['Still thinking'] })],
      issues: { 8: 'OPEN' },
      now: T0 + 15 * MINUTE,
    })
    stall2.files[CURSOR] = stall1.files[CURSOR]
    await once(stall2, ['8'])
    assert.deepEqual(stall2.out, [])

    stall2.world.now = T0 + 30 * MINUTE
    await once(stall2, ['8'])
    assert.deepEqual(drain(stall2), ['worker-trabado #8 claude: sin cambios por 30m \u2014 Still thinking'])

    const stall3 = harness({
      worktrees: [wt(8, 'claude', 'working', { screen: ['Still thinking'] })],
      issues: { 8: 'OPEN' },
      now: T0 + 35 * MINUTE,
    })
    stall3.files[CURSOR] = stall2.files[CURSOR]
    await once(stall3, ['8'])
    assert.deepEqual(stall3.out, [])

    // Closing the terminal while Orca keeps the done agent record (same paneKey) does not repeat worker-detenido.
    const closedTerm = harness({
      worktrees: [wt(10, 'claude', 'done', { screen: ['Finished'] })],
      issues: { 10: 'OPEN' },
    })
    await once(closedTerm, ['10'])
    assert.deepEqual(drain(closedTerm), ['worker-detenido #10 claude: termin\u00F3 sin abrir un PR \u2014 Finished'])
    closedTerm.world.worktrees[0].terminals = []
    await once(closedTerm, ['10'])
    assert.deepEqual(closedTerm.out, [])

    // --dry-run writes no cursor.
    const dry = harness({
      worktrees: [wt(9, 'claude', 'done', { screen: ['PS C:\\work>'] })],
      issues: { 9: 'OPEN' },
    })
    await vigilarCommand({ dryRun: true }, ['9'], dry.io)
    assert.deepEqual(dry.out, ['worker-detenido #9 claude: volvi\u00F3 al shell \u2014 PS C:\\work>'])
    assert.equal(CURSOR in dry.files, false)
  })

  test('Rule 7: vigilar --help and docs/manual.md list worker-detenido and worker-trabado', async () => {
    const oldLog = console.log
    let output = ''
    console.log = value => { output += `${value}\n` }
    try {
      assert.equal(await main(['vigilar', '--help']), 0)
    } finally {
      console.log = oldLog
    }
    assert.ok(output.includes('worker-detenido #<n> <agente>: <motivo>'), output)
    assert.ok(output.includes('worker-trabado #<n> <agente>: <motivo>'), output)

    const manual = readFileSync(path.join(PACKAGE_ROOT, 'docs', 'manual.md'), 'utf8')
    assert.ok(manual.includes('| `worker-detenido #<n> <agente>: <motivo>`'), 'manual lists worker-detenido')
    assert.ok(manual.includes('| `worker-trabado #<n> <agente>: <motivo>`'), 'manual lists worker-trabado')
    assert.ok(!manual.includes('worker-en-pausa'), 'manual no longer references worker-en-pausa')

    const mainDoc = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'MAIN.md'), 'utf8')
    assert.ok(!mainDoc.includes('worker-en-pausa'), 'MAIN.md no longer references worker-en-pausa')
    const step5 = mainDoc.split(/\r?\n/).find(line => line.startsWith('5. '))
    const diag = mainDoc.split(/\r?\n/).find(line => line.startsWith('Ante `diagnostico #<n> <agente>`'))
    assert.ok(step5.includes('`worker-detenido #<n> <agente>: terminó sin abrir un PR`'), 'MAIN.md step 5 names worker-detenido')
    assert.ok(diag.includes('`worker-detenido #<n> <agente>: terminó sin abrir un PR`'), 'MAIN.md diagnostico paragraph names worker-detenido')
  })

  test('PRESERVE: vigilarCommand keeps existing PR, CI, merge-de-main, and umbrella events', async () => {
    const worker = wt(7, 'codex', 'working', { screen: ['Running checks'] })
    const h = harness({ worktrees: [worker], prs: [pr(70, { checks: GREEN })], now: T0 })
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['pr-abierto #7 PR #70 abc1234', 'ci-verde-retenido #7 PR #70 abc1234: codex working'])
    worker.agents[0].state = 'done'
    await once(h, ['7'])
    assert.deepEqual(drain(h), ['ci-verde #7 PR #70 abc1234'])
    assert.equal(await mergeDeMain(h, '70'), 0)
    h.world.prs = [pr(70, { state: 'MERGED', checks: GREEN })]
    h.world.now = T0 + 2 * MINUTE
    assert.equal(await vigilarCommand({}, ['7'], h.io), 0)
    assert.deepEqual(drain(h), ['tanda-cerrada #7'])

    const umb = harness({ subIssues: { 29: [63, 64] } })
    await vigilarCommand({ paraguas: '29', unaVez: true }, [], umb.io)
    await vigilarCommand({ paraguas: '29', unaVez: true }, [], umb.io)
    assert.deepEqual(umb.out, ['planificacion-publicada #29 #63,#64'])
  })
})

describe('#431 vigilar: a quota stop switches the Orca account of the same agent', () => {
  const Q = "You've hit your usage limit. Try again at 00:57."
  const ACCOUNTS = path.join(COMMON, 'orca-stack', 'cuentas.json')
  const stop = (issue, agentType, handle = `term_${issue}`, screen = ['step', Q], state = 'done') => ({
    path: `/wt/orca-stack-${issue}`, branch: `Gagaismo/orca-stack-${issue}`, linkedIssue: issue, screen,
    terminals: [{ handle, title: agentType === 'antigravity' ? 'agy' : agentType }],
    agents: [{ paneKey: `tab-${handle}:leaf-${handle}`, state, agentType }],
  })
  const accounts = (...ids) => ({ accounts: ids.map(id => ({ id, email: `${id}@example.com` })), activeAccountId: ids[0] })
  const accountCalls = h => h.calls.filter(call => call.startsWith('orca account'))
  const quotaStop = (n, agent) => `worker-detenido #${n} ${agent}: cuota — ${Q}`

  test('S7: only a quota stop calls orca account; volvió al shell, terminó sin abrir un PR and a stall never do', async () => {
    for (const screen of [['fatal', 'PS C:\\work>'], ['last step']]) {
      const h = harness({ worktrees: [stop(7, 'claude', 'term_7', screen)], accounts: { claude: accounts('c1', 'c2') } })
      await once(h, ['7'])
      assert.match(h.out[0], /^worker-detenido #7 claude: (volvió al shell|terminó sin abrir un PR) — \S/)
      assert.deepEqual(accountCalls(h), [])
    }
    const stalled = harness({ worktrees: [stop(7, 'claude', 'term_7', ['thinking'], 'idle')], accounts: { claude: accounts('c1', 'c2') } })
    await once(stalled, ['7'])
    stalled.world.now = T0 + 5 * MINUTE
    await once(stalled, ['7'])
    assert.deepEqual(stalled.out, ['worker-trabado #7 claude: sin cambios por 4m — thinking'])
    assert.deepEqual(accountCalls(stalled), [])
  })

  test('S8: a quota stop selects another account of the same agent and reports cuenta cambiada with account ids', async () => {
    const h = harness({ worktrees: [stop(7, 'antigravity')], accounts: { antigravity: accounts('g1', 'g2') } })
    await once(h, ['7'])
    assert.deepEqual(h.out, [quotaStop(7, 'agy'), 'cuenta cambiada: agy g1 → g2'])
    assert.deepEqual(accountCalls(h), ['orca account list --agent antigravity --json', 'orca account select --agent antigravity --account g2 --json'])
    assert.deepEqual(JSON.parse(h.files[ACCOUNTS]).agy.resumed, { 7: true })
  })

  test('S9: pi has no Orca accounts and stays blocked as today; claude never switches to another agent', async () => {
    const pi = harness({ worktrees: [stop(9, 'pi')], accounts: { claude: accounts('c1', 'c2') } })
    await once(pi, ['9'])
    assert.deepEqual(pi.out, [quotaStop(9, 'pi')])
    assert.deepEqual(accountCalls(pi), [])
    const claude = harness({ worktrees: [stop(7, 'claude')], accounts: { claude: accounts('c1'), codex: accounts('x1', 'x2') } })
    await once(claude, ['7'])
    assert.deepEqual(claude.out, [quotaStop(7, 'claude')])
    assert.deepEqual(accountCalls(claude), ['orca account list --agent claude --json'])
  })

  test('S10: with no other account, or once the other hits quota too, the agent stays blocked as today and two exhausted accounts never loop', async () => {
    const lone = harness({ worktrees: [stop(7, 'claude')], accounts: { claude: accounts('c1') } })
    await once(lone, ['7'])
    assert.deepEqual(lone.out, [quotaStop(7, 'claude')])
    const h = harness({ worktrees: [stop(7, 'claude')], accounts: { claude: accounts('c1', 'c2') } })
    await once(h, ['7'])
    assert.deepEqual(drain(h), [quotaStop(7, 'claude'), 'cuenta cambiada: claude c1 → c2'])
    // The worker reanudar relaunched on c2 (a new terminal) hits quota too, and so does the next one.
    for (const handle of ['term_7b', 'term_7c']) {
      pendingAfterSwitch(h.io, COMMON, 'claude', 7, true)
      h.world.worktrees = [stop(7, 'claude', handle)]
      await once(h, ['7'])
      assert.deepEqual(drain(h), [quotaStop(7, 'claude')])
    }
    assert.equal(accountCalls(h).filter(call => call.includes(' select ')).length, 1)
    assert.deepEqual(JSON.parse(h.files[ACCOUNTS]).claude.exhausted, ['c1', 'c2'])
  })

  test('S11: a failed orca account list or select keeps the agent blocked as today and reports the error line', async () => {
    for (const [verb, count] of [['list', 1], ['select', 2]]) {
      const h = harness({ worktrees: [stop(7, 'codex')], accounts: { codex: accounts('x1', 'x2') }, accountDown: { [verb]: 'orca: runtime not running' } })
      await once(h, ['7'])
      assert.deepEqual(h.out, [quotaStop(7, 'codex'), `cuenta no cambiada: codex — orca account ${verb} falló: orca: runtime not running`])
      assert.equal(accountCalls(h).length, count)
    }
  })

  test('S12: two workers of the same agent stopping on quota at once cause one select; the second resumes on the selected account', async () => {
    const h = harness({ worktrees: [stop(7, 'claude'), stop(8, 'claude')], accounts: { claude: accounts('c1', 'c2') } })
    await once(h, ['7', '8'])
    assert.deepEqual(h.out, [quotaStop(7, 'claude'), 'cuenta cambiada: claude c1 → c2', quotaStop(8, 'claude'), 'cuenta cambiada: claude c1 → c2'])
    assert.deepEqual(accountCalls(h), ['orca account list --agent claude --json', 'orca account select --agent claude --account c2 --json', 'orca account list --agent claude --json'])
    assert.deepEqual(JSON.parse(h.files[ACCOUNTS]).claude.resumed, { 7: true, 8: true })
  })

  test('S13: the stack only lists and selects Orca accounts and never prints or stores an email', async () => {
    const h = harness({ worktrees: [stop(7, 'claude')], accounts: { claude: accounts('c1', 'c2') } })
    await once(h, ['7'])
    assert.ok(accountCalls(h).length === 2 && accountCalls(h).every(call => /^orca account (list|select) --agent claude /.test(call)))
    assert.ok(![...h.out, ...h.err, ...Object.values(h.files)].some(text => text.includes('@example.com')))
  })
})

describe('deprecation of vigilar --consultas (#464)', () => {
  const WARN = '⚠ vigilar --consultas está deprecado (ADR 0004): los workers le preguntan a main por el buzón del Run. Se saca en la próxima release.'

  test('#464 R2: vigilar --consultas prints the deprecation warning once on stderr across polls and keeps stdout unchanged', async () => {
    const h = harness({ prs: [pr(70)], comments: { 7: [CONSULTA] } })
    h.world.script = [() => {}, world => { world.prs = [pr(70, { state: 'MERGED' })] }]
    assert.equal(await vigilarCommand({ consultas: true }, ['7'], h.io), 0)
    assert.deepEqual(h.err.filter(line => line === WARN), [WARN])
    assert.ok(!h.err.some(line => line.includes('orca-stack consultas está deprecado')))
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'consulta nueva en #7', 'pr-mergeado #7 PR #70 abc1234', 'tanda-cerrada #7'])
  })

  test('#464 R3: vigilar without --consultas prints no deprecation warning', async () => {
    const h = harness({ prs: [pr(70)], comments: { 7: [CONSULTA] } })
    assert.equal(await once(h, ['7']), 0)
    assert.ok(!h.err.some(line => /deprecado/i.test(line)))
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234'])
  })
})
