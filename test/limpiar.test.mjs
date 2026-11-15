import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { main } from '../src/cli.mjs'
import { limpiarCommand } from '../src/limpiar.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = stdout => ({ status: 0, stdout, stderr: '' })
const fail = stderr => ({ status: 1, stdout: '', stderr })

const wt = (path, branch, { agents = [], linkedIssue } = {}) => ({ path, branch, agents, linkedIssue })
const pr = (number, state, headRefName) => ({ number, state, headRefName })

// A fake git, gh and Orca: `orca worktree rm` takes the worktree out of both git's and Orca's lists, as the real one does.
const harness = (world) => {
  const out = []
  const err = []
  const calls = []
  const io = {
    cwd: '/repo',
    home: '/home',
    out: line => out.push(line),
    err: line => err.push(line),
    sh: (cmd, args, { cwd } = {}) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'git' && args.includes('--git-common-dir')) return okRes('/repo/.git\n/repo/.git\n/repo\n')
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return okRes(world.worktrees.map(one => `worktree ${one.path}\nHEAD 1\nbranch refs/heads/${one.branch}\n`).join('\n'))
      }
      if (cmd === 'git' && args[0] === 'status') return okRes((world.dirty ?? []).includes(cwd) ? ' M src/a.mjs\n' : '')
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') {
        return json({ ok: true, result: { worktrees: world.worktrees.map(one => ({ path: one.path, repo: 'orca-stack', linkedIssue: one.linkedIssue ?? null, agents: one.agents })) } })
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return json(world.prs)
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        const found = (world.hiddenPrs ?? []).find(one => String(one.number) === args[2])
        return found ? json(found) : fail(`no pull requests found for branch "${args[2]}"`)
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'close') {
        if (world.closeDown) return fail(world.closeDown)
        return json({ ok: true, result: { closed: 1 } })
      }
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'rm') {
        const target = args[args.indexOf('--worktree') + 1].replace(/^path:/, '')
        world.worktrees = world.worktrees.filter(one => one.path !== target)
        return json({ ok: true })
      }
      return fail(`unexpected call: ${cmd} ${args.join(' ')}`)
    },
  }

  return { io, out, err, calls, world }
}
const mutations = h => h.calls.filter(call => /^orca (terminal close|worktree rm)|push|branch -d|branch -D|rm -rf/.test(call))

const WORLD = () => ({
  worktrees: [
    wt('/repo', 'main'),
    wt('/wt/orca-stack-7', 'Gagaismo/orca-stack-7', { linkedIssue: 7, agents: [{ state: 'done', agentType: 'codex' }] }),
    wt('/wt/revision-70-agy', 'revision-70-agy'),
    wt('/wt/orca-stack-8', 'Gagaismo/orca-stack-8', { linkedIssue: 8 }),
    wt('/wt/orca-stack-9', 'Gagaismo/orca-stack-9', { linkedIssue: 9, agents: [{ state: 'working', agentType: 'antigravity' }] }),
    wt('/wt/orca-stack-10', 'Gagaismo/orca-stack-10', { linkedIssue: 10 }),
    wt('/wt/orca-stack-11', 'Gagaismo/orca-stack-11', { linkedIssue: 11 }),
    wt('/wt/revision-120-pi', 'revision-120-pi'),
  ],
  dirty: ['/wt/orca-stack-8'],
  prs: [
    pr(5, 'MERGED', 'main'),
    pr(70, 'MERGED', 'Gagaismo/orca-stack-7'),
    pr(80, 'CLOSED', 'Gagaismo/orca-stack-8'),
    pr(90, 'MERGED', 'Gagaismo/orca-stack-9'),
    pr(100, 'OPEN', 'Gagaismo/orca-stack-10'),
  ],
  hiddenPrs: [pr(120, 'CLOSED', 'feature/old')],
})

describe('orca-stack limpiar (S13)', () => {
  test('S13: closes the terminals of and removes every worktree whose PR merged or closed, by branch or revision-<pr>-<agent>; skips and reports dirty and working ones', async () => {
    const h = harness(WORLD())
    assert.equal(await limpiarCommand({}, h.io), 0)
    assert.deepEqual(h.out, [
      'Cerré las terminales y saqué /wt/orca-stack-7 (PR #70 mergeado).',
      'Cerré las terminales y saqué /wt/revision-70-agy (PR #70 mergeado).',
      'Omito /wt/orca-stack-8 (PR #80 cerrado): tiene cambios sin commitear.',
      'Omito /wt/orca-stack-9 (PR #90 mergeado): agy está working.',
      'Cerré las terminales y saqué /wt/revision-120-pi (PR #120 cerrado).',
    ])
    assert.deepEqual(h.err, [])
    assert.deepEqual(mutations(h), [
      'orca terminal close --worktree path:/wt/orca-stack-7 --all --json',
      'orca worktree rm --worktree path:/wt/orca-stack-7 --json',
      'orca terminal close --worktree path:/wt/revision-70-agy --all --json',
      'orca worktree rm --worktree path:/wt/revision-70-agy --json',
      'orca terminal close --worktree path:/wt/revision-120-pi --all --json',
      'orca worktree rm --worktree path:/wt/revision-120-pi --json',
    ])
    assert.deepEqual(h.world.worktrees.map(one => one.path), ['/repo', '/wt/orca-stack-8', '/wt/orca-stack-9', '/wt/orca-stack-10', '/wt/orca-stack-11'])
  })

  test('S13: a second run removes nothing and reports the same skipped worktrees', async () => {
    const h = harness(WORLD())
    await limpiarCommand({}, h.io)
    const again = harness(h.world)
    assert.equal(await limpiarCommand({}, again.io), 0)
    assert.deepEqual(again.out, [
      'Omito /wt/orca-stack-8 (PR #80 cerrado): tiene cambios sin commitear.',
      'Omito /wt/orca-stack-9 (PR #90 mergeado): agy está working.',
    ])
    assert.deepEqual(mutations(again), [])
  })

  test('S13: with nothing ended it says so; --dry-run prints the plan and touches nothing', async () => {
    const idle = harness({ worktrees: [wt('/repo', 'main'), wt('/wt/orca-stack-10', 'Gagaismo/orca-stack-10')], prs: [pr(100, 'OPEN', 'Gagaismo/orca-stack-10')] })
    assert.equal(await limpiarCommand({}, idle.io), 0)
    assert.deepEqual(idle.out, ['Nada para limpiar.'])
    assert.deepEqual(mutations(idle), [])

    const dry = harness(WORLD())
    assert.equal(await limpiarCommand({ dryRun: true }, dry.io), 0)
    assert.deepEqual(dry.out, [
      '[simulación] cerraría las terminales y sacaría /wt/orca-stack-7 (PR #70 mergeado).',
      '[simulación] cerraría las terminales y sacaría /wt/revision-70-agy (PR #70 mergeado).',
      'Omito /wt/orca-stack-8 (PR #80 cerrado): tiene cambios sin commitear.',
      'Omito /wt/orca-stack-9 (PR #90 mergeado): agy está working.',
      '[simulación] cerraría las terminales y sacaría /wt/revision-120-pi (PR #120 cerrado).',
    ])
    assert.deepEqual(mutations(dry), [])
    assert.equal(dry.world.worktrees.length, 8)
  })

  test('S13: when closing the terminals fails the worktree stays, the error is reported and the exit code is 1', async () => {
    const world = { worktrees: [wt('/repo', 'main'), wt('/wt/orca-stack-7', 'Gagaismo/orca-stack-7')], prs: [pr(70, 'MERGED', 'Gagaismo/orca-stack-7')], closeDown: 'orca: runtime not running' }
    const h = harness(world)
    assert.equal(await limpiarCommand({}, h.io), 1)
    assert.deepEqual(h.out, [])
    assert.deepEqual(h.err, ['✖ No pude cerrar las terminales de /wt/orca-stack-7 (orca: runtime not running): no saqué el worktree.'])
    assert.deepEqual(mutations(h), ['orca terminal close --worktree path:/wt/orca-stack-7 --all --json'])
    assert.equal(h.world.worktrees.length, 2)
  })

  test('CLI: limpiar is wired with --dry-run', async () => {
    const h = harness({ worktrees: [wt('/repo', 'main')], prs: [] })
    assert.equal(await main(['limpiar', '--dry-run'], h.io), 0)
    assert.deepEqual(h.out, ['Nada para limpiar.'])
  })
})
