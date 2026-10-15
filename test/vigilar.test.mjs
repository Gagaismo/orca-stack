import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { main } from '../src/cli.mjs'
import { upsertBlock } from '../src/marker.mjs'
import { policyBlock } from '../src/templates.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'
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

const pr = (number, { state = 'OPEN', head = ABC, branch = 'Gagaismo/orca-stack-7', closes = [7], body = '', checks = [] } = {}) =>
  ({ number, state, headRefName: branch, headRefOid: head, body, closingIssuesReferences: closes.map(n => ({ number: n })), statusCheckRollup: checks })

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
        const entries = (world.worktrees ?? []).map(wt => `worktree ${wt.path}\nHEAD 1\nbranch refs/heads/${wt.branch}\n`)
        return okRes(['worktree /repo\nHEAD 0\nbranch refs/heads/main\n', ...entries].join('\n'))
      }
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') {
        if (world.orcaDown) return fail('orca: runtime not running')
        return json({ ok: true, result: { worktrees: (world.worktrees ?? []).map(wt => ({ path: wt.path, repo: 'orca-stack', linkedIssue: wt.linkedIssue })) } })
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
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        if (world.ghDown) return fail(world.ghDown)
        if (args.includes('comments')) return json({ comments: (world.comments ?? {})[args[2]] ?? [] })
        if ((world.issueDown ?? {})[args[2]]) return fail(world.issueDown[args[2]])
        return json({ state: (world.issues ?? {})[args[2]] ?? 'OPEN' })
      }
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return world.userDown ? fail(world.userDown) : json({ login: 'stack-bot' })
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

    // A new head commit starts a new cycle: pending emits nothing and the old commit's result is not repeated.
    h.world.prs = [pr(70, { head: DEF, checks: PENDING })]
    await once(h, ['7'])
    assert.deepEqual(drain(h), [])

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
    assert.deepEqual(h.cursor()['7'], { pr: 70, head: ABC, fin: 'main' })

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
    stale.world.prs = [pr(70, { state: 'MERGED' })]
    stale.world.now = T0 + 31 * MINUTE
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

  test('Rule 19: with --consultas one watcher also reports a new Consulta: comment once; without it no comment is read', async () => {
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
    assert.equal(plain.calls.some(call => call.includes('comments')), false)

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

  test('Rule 22: --help lists vigilar and its flags; CONTRATO steps 5 and 7 name it; the AGENTS.md block equals the asset', async () => {
    const oldLog = console.log
    let output = ''
    console.log = value => { output += `${value}\n` }
    try {
      assert.equal(await main(['--help']), 0)
      assert.match(output, /\n  vigilar\s+\S/)
      for (const flag of ['--cada <segundos>', '--una-vez', '--consultas', '--merge-de-main <pr>']) {
        assert.ok(output.split('\n').some(line => line.trimStart().startsWith(flag) && line.includes('(vigilar)')), flag)
      }
      assert.ok(output.includes('(global, init, remove, despachar, revisar, rebote, brief-revision, consultas, avisar, vigilar)'))
      output = ''
      assert.equal(await main(['vigilar', '--help']), 0)
      assert.ok(output.includes('orca-stack vigilar <n...> [--cada <segundos>] [--una-vez] [--dry-run] [--consultas]'))
      assert.ok(output.includes('orca-stack vigilar --merge-de-main <pr>'))
    } finally {
      console.log = oldLog
    }

    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'CONTRATO.md'), 'utf8')
    const step = n => contract.split(/\r?\n/).find(line => line.startsWith(`${n}. `))
    assert.ok(step(5).includes('un solo Monitor de fondo armado con `orca-stack vigilar <n...>`'))
    assert.ok(step(5).includes('En marcha Proactive, armalo con `--consultas`'))
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
})
