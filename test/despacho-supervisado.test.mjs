import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { dispatch, renderBrief } from '../src/despacho.mjs'
import { cleanup, tempDir, write } from './helpers.mjs'

// #397: despachar starts the ticket worker with `orca orchestration worker-start` inside the Run bound to main.
const PROJECT = {
  setup: 'completo',
  modo: 'multiagente',
  ramaBase: 'main',
  agentes: { usa: ['claude', 'agy', 'codex', 'pi'], preguntarAntes: [], pi: { perfil: 'global' } },
  verificacion: { suite: 'npm test', typecheck: 'npm run typecheck' },
}
const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const STARTED = json({ ok: true, result: { taskId: 'task_1', dispatchId: 'ctx_1', status: 'ready' } })

let home
let root
let worktree
beforeEach(() => {
  home = tempDir('supervisado-home')
  root = path.join(tempDir('supervisado-root'), 'proj')
  worktree = path.join(tempDir('supervisado-wt'), 'proj-7')
  write(path.join(root, 'x'), '')
  write(path.join(worktree, 'x'), '')
  write(path.join(home, '.pi', 'gentle-ai', 'profiles.json'), JSON.stringify({ active: 'default', profiles: { default: { orchestrator: { model: 'claude-bridge/claude-opus-5-5' } } } }))
})
afterEach(() => {
  for (const dir of [home, path.dirname(root), path.dirname(worktree)]) cleanup(dir)
})

// Every external call is recorded; `orch` answers `orca orchestration <verb>` by verb.
// #431: `account` answers `orca account`; the first `quota` terminals created show a usage limit after the launch.
const fakeIo = (orch = {}, { card, account, quota = 0 } = {}) => {
  let terminals = 0
  let launchedAgent
  write(path.join(root, '.orca-stack.json'), JSON.stringify(PROJECT))
  const calls = []
  const out = []
  const err = []
  const files = new Map()
  const sessionRoot = path.join(home, '.pi', 'agent', 'sessions')
  const sessionDir = path.join(sessionRoot, 'project')
  const io = {
    home,
    cwd: root,
    win: true,
    now: () => 100,
    modifiedAt: () => 101,
    out: line => out.push(line),
    err: line => err.push(line),
    sleep: async () => {},
    exists: existsSync,
    readFile: file => files.get(file) ?? readFileSync(file, 'utf8'),
    listFiles: dir => dir === sessionRoot ? [sessionDir] : dir === sessionDir ? [...files.keys()] : [],
    mkdirp: () => {},
    writeFile: (file, text) => write(file, text),
    rename: () => {},
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    gentleAiBinary: async () => null,
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'orca' && args[0] === 'orchestration') {
        const answer = orch[args[1]]
        if (answer) return typeof answer === 'function' ? answer(args) : answer
        if (args[1] === 'run-current') return json({ ok: true, result: { runId: 'run_main' } })
        if (args[1] === 'worker-start') {
          // pi writes its session once its first message (the spec) arrives.
          files.set(path.join(sessionDir, 's.jsonl'), [JSON.stringify({ type: 'session', cwd: worktree }), '{}', '{}', '{}', JSON.stringify({ message: { sections: { tools: '<tools>\n- read' } } })].join('\n'))
          return STARTED
        }
        return { status: 1, stdout: '', stderr: `sin respuesta para ${args[1]}` }
      }
      if (cmd === 'git' && args[0] === 'rev-parse') return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nbranch refs/heads/main\n`)
      if (cmd === 'git' && args[0] === 'remote') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'git' && args[0] === 'ls-files') return { status: 1, stdout: '', stderr: '' }
      if (cmd === 'git') return okRes('x\n')
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') return json({ state: 'OPEN', assignees: [], title: 't' })
      if (cmd === 'orca' && args.join(' ') === 'worktree ps --json') return json({ result: { worktrees: [] } })
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'set' && card) return card
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'create') return json({ result: { worktree: { path: worktree, branch: 'refs/heads/proj-7' } } })
      if (cmd === 'orca' && args[0] === 'account' && account) return account(args)
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create') {
        launchedAgent = args[args.indexOf('--title') + 1]
        return json({ result: { terminal: { handle: `term_${++terminals}` } } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') {
        const n = Number(args[args.indexOf('--terminal') + 1].slice(5))
        const ready = launchedAgent === 'agy' ? ['ready', '>'] : ['ready']
        return json({ result: { terminal: { tail: n <= quota ? [...ready, "You've hit your usage limit."] : ready } } })
      }
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'show') {
        return json({ ok: true, result: { terminal: { handle: args[args.indexOf('--terminal') + 1], agentIdentity: launchedAgent } } })
      }
      return okRes()
    },
  }
  const orchestration = () => calls.filter(c => c[0] === 'orca' && c[1] === 'orchestration').map(c => c.slice(2))
  const briefSends = () => calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send' && c.includes('--text') && String(c[c.indexOf('--text') + 1]).includes('brief'))
  const index = predicate => calls.findIndex(predicate)

  const cards = () => calls.filter(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'set')

  return { io, calls, out, err, orchestration, briefSends, index, cards }
}

const briefPath = () => path.join(home, 'orca', 'briefs', 'proj-7.md')
const workerStart = (agent, run = 'run_main') => ['worker-start', '--run', run, '--terminal', 'term_1', '--spec-file', briefPath(), '--task-title', `#7 ${agent}`, '--json']

describe('#397 despachar: supervised start', () => {
  test('S2: despachar starts codex, agy and pi with worker-start in the Run bound to main, after the lock, the worktree and the brief', async () => {
    for (const agent of ['codex', 'agy', 'pi']) {
      const env = fakeIo()
      assert.equal(await dispatch('ticket', { n: '7', agent }, env.io), 0, agent)
      assert.deepEqual(env.orchestration(), [['run-current', '--json'], workerStart(agent)], agent)
      const assign = env.index(c => c[0] === 'gh' && c.join(' ') === 'gh issue edit 7 --add-assignee @me')
      const created = env.index(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'create')
      const terminal = env.index(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create')
      const start = env.index(c => c[1] === 'orchestration' && c[2] === 'worker-start')
      assert.ok(assign >= 0 && assign < created && created < terminal && terminal < start, agent)
      const create = env.calls[created]
      assert.equal(create[create.indexOf('--base-branch') + 1], 'origin/main')
      assert.ok(readFileSync(briefPath(), 'utf8').startsWith('# Ticket brief: issue #7 (proj)'), agent)
      // The brief reaches the worker once, through worker-start: never typed into the terminal nor on pi's command line.
      assert.deepEqual(env.briefSends(), [], agent)
      const launcher = env.calls[terminal][env.calls[terminal].indexOf('--command') + 1]
      assert.ok(!launcher.includes(briefPath()), `${agent}: ${launcher}`)
      assert.ok(env.out.includes(`\u2714 ${agent} despachado en ${worktree}. Brief: ${briefPath()}`), agent)
      assert.ok(!env.calls.some(c => c.join(' ').includes('--remove-assignee')), agent)
    }
    assert.match(readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8'), /despachar:[\s\S]*?lo arranca con\s+\\`orca orchestration worker-start\\` en el Run ligado a main/)
  })

  test('S2: with no Run bound to main, despachar creates one with run-create and starts the worker in it', async () => {
    const env = fakeIo({
      'run-current': json({ ok: true, result: { runId: null } }),
      'run-create': json({ ok: true, result: { run: { id: 'run_new' } } }),
    })
    assert.equal(await dispatch('ticket', { n: '7', agent: 'codex' }, env.io), 0)
    assert.deepEqual(env.orchestration(), [
      ['run-current', '--json'],
      ['run-create', '--objective', 'orca-stack proj: tickets despachados por main', '--json'],
      workerStart('codex', 'run_new'),
    ])
  })

  test('S3: a failed run-current, run-create or worker-start prints Orca\'s error, keeps the leftover output and leaves the issue not assigned', async () => {
    const refused = { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'terminal_not_found', message: 'terminal term_1 is not a known agent terminal' } }), stderr: '' }
    const cases = [
      ['run-current', { 'run-current': { status: 1, stdout: '', stderr: 'orca is not running' } }, 'orca orchestration run-current falló: orca is not running'],
      ['run-create', { 'run-current': json({ ok: true, result: { runId: null } }), 'run-create': refused }, 'orca orchestration run-create falló: terminal term_1 is not a known agent terminal'],
      ['worker-start', { 'worker-start': refused }, 'orca orchestration worker-start falló: terminal term_1 is not a known agent terminal'],
    ]
    for (const [verb, orch, message] of cases) {
      const env = fakeIo(orch)
      await assert.rejects(dispatch('ticket', { n: '7', agent: 'codex' }, env.io), error => {
        assert.equal(error.message, message, verb)
        return true
      })
      const failed = env.index(c => c[1] === 'orchestration' && c[2] === verb)
      const freed = env.index(c => c.join(' ') === 'gh issue edit 7 --remove-assignee @me')
      assert.ok(failed >= 0 && freed > failed, verb)
      if (verb !== 'worker-start') assert.ok(!env.orchestration().some(c => c[0] === 'worker-start'), verb)
      assert.deepEqual(env.briefSends(), [], verb)
      const text = env.out.join('\n')
      assert.ok(text.includes('El despacho quedó a medias. Quedó:'), verb)
      assert.ok(text.includes(`  - el worktree ${worktree}`) && text.includes(`  - el brief ${briefPath()}`), verb)
      assert.ok(text.includes(`orca worktree rm --worktree path:${worktree}`), verb)
      assert.ok(!text.includes('el issue #7 asignado') && !text.includes('soltá el issue'), verb)
      assert.ok(!env.out.some(line => line.startsWith('\u2714')), verb)
    }
  })

  test('S3: a worker-start whose outcome is unknown keeps the assignee and says how to check whether the worker is running', async () => {
    const unknown = { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'outcome_unknown', message: 'worker start outcome unknown after delivering the spec' }, result: { status: 'outcome_unknown', stage: 'deliver', requestId: 'req_9', dispatchId: 'ctx_9' } }), stderr: '' }
    const env = fakeIo({ 'worker-start': unknown })
    await assert.rejects(dispatch('ticket', { n: '7', agent: 'codex' }, env.io), error => {
      assert.equal(error.message, 'orca orchestration worker-start falló: worker start outcome unknown after delivering the spec\nEl resultado de worker-start es desconocido (outcome_unknown): el worker de #7 codex puede estar corriendo, así que el issue sigue asignado. Comprobalo con `orca orchestration request-show --request req_9 --json`.')
      return true
    })
    assert.ok(!env.calls.some(c => c.join(' ').includes('--remove-assignee')))
    assert.equal(env.orchestration().filter(c => c[0] === 'worker-start').length, 1)
    const leftover = env.out.slice(env.out.indexOf('El despacho quedó a medias. Quedó:'))
    assert.deepEqual(leftover.join('\n').split('\n').slice(0, 4), ['El despacho quedó a medias. Quedó:', '  - el issue #7 asignado', `  - el worktree ${worktree}`, `  - el brief ${briefPath()}`])
    assert.ok(!env.out.some(line => line.startsWith('✔')))
  })

  test('S4: the ticket brief tells the worker to finish with worker_done ok, or partial with the Diagnóstico: text after publishing it on GitHub', () => {
    for (const agent of ['claude', 'codex', 'agy', 'pi']) {
      const brief = renderBrief('ticket', { AGENT: agent, ISSUE: '7', REPO: 'proj', BASE: 'main', BRANCH: 'proj-7' })
      assert.ok(brief.includes('orca orchestration send --type worker_done --outcome succeeded --subject "#7 ok"'), agent)
      assert.ok(brief.includes('orca orchestration send --type worker_done --outcome failed --subject "#7 partial" --body "<the Diagnóstico: text>"'), agent)
      const partial = brief.slice(brief.indexOf('## Finish'))
      assert.match(partial, new RegExp(`Publish the \`Diagnóstico: ${agent}\` on GitHub first: on the open PR \\(gh pr comment <pr> --body-file <file>\\), otherwise on the issue \\(gh issue comment 7 --body-file <file>\\)`), agent)
      assert.ok(partial.includes('Orca only accepts `--outcome succeeded` or `--outcome failed`'), agent)
    }
  })
})

describe('#430 despachar: worktree card', () => {
  const cardSet = agent => ['orca', 'worktree', 'set', '--worktree', `path:${worktree}`, '--comment', `#7 dispatched to ${agent}`, '--workspace-status', 'in-progress', '--json']

  test('#430 S1: despachar sets the card comment "#<n> dispatched to <agent>" and in-progress on the new worktree right after creating it; the issue link stays on create', async () => {
    for (const agent of ['codex', 'agy', 'pi']) {
      const env = fakeIo()
      assert.equal(await dispatch('ticket', { n: '7', agent }, env.io), 0, agent)
      assert.deepEqual(env.cards(), [cardSet(agent)], agent)
      const created = env.index(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'create')
      const set = env.index(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'set')
      const terminal = env.index(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create')
      assert.ok(created >= 0 && created < set && set < terminal, agent)
      const create = env.calls[created]
      assert.equal(create[create.indexOf('--issue') + 1], '7', agent)
      assert.deepEqual(env.err, [], agent)
    }
  })

  test('#430 S4: when orca worktree set fails in despachar, one warning line goes to stderr and the dispatch still succeeds', async () => {
    const env = fakeIo({}, { card: { status: 1, stdout: '', stderr: 'orca: runtime not running\nmore detail' } })
    assert.equal(await dispatch('ticket', { n: '7', agent: 'codex' }, env.io), 0)
    assert.deepEqual(env.cards(), [cardSet('codex')])
    assert.deepEqual(env.err, [`⚠ No pude actualizar la tarjeta de path:${worktree} en Orca (orca worktree set): orca: runtime not running. Sigo.`])
    assert.deepEqual(env.orchestration(), [['run-current', '--json'], workerStart('codex')])
    assert.ok(env.out.includes(`✔ codex despachado en ${worktree}. Brief: ${briefPath()}`))
    assert.ok(!env.calls.some(c => c.join(' ').includes('--remove-assignee')))
  })

  test('#430 S5: no worker brief tells a worker to set card metadata', async () => {
    const env = fakeIo()
    assert.equal(await dispatch('ticket', { n: '7', agent: 'codex' }, env.io), 0)
    const briefs = [readFileSync(briefPath(), 'utf8')]
    for (const agent of ['claude', 'codex', 'agy', 'pi']) {
      briefs.push(renderBrief('ticket', { AGENT: agent, ISSUE: '7', REPO: 'proj', BASE: 'main', BRANCH: 'proj-7' }))
      briefs.push(renderBrief('review', { AGENT: agent, PR: '70', REPO: 'proj', IMPLEMENTER: 'codex', SHA: 'abc1234', BASE: 'main' }))
    }
    for (const brief of briefs) {
      assert.ok(!brief.includes('orca worktree set'), brief.slice(0, 80))
      assert.ok(!brief.includes('--workspace-status'), brief.slice(0, 80))
    }
  })
})

describe('#431 despachar: out of quota right after the launch', () => {
  const switcher = () => {
    let active = 'c1'
    return args => {
      if (args[1] === 'select') active = args[args.indexOf('--account') + 1]
      return json({ ok: true, result: { codex: { accounts: [{ id: 'c1' }, { id: 'c2' }], activeAccountId: active } } })
    }
  }
  const accountCalls = env => env.calls.filter(c => c[0] === 'orca' && c[1] === 'account').map(c => c.join(' '))

  test('S8: a quota stop at launch selects another codex account and relaunches the worker once in the same run; a second quota fails as today', async () => {
    const env = fakeIo({}, { account: switcher(), quota: 1 })
    assert.equal(await dispatch('ticket', { n: '7', agent: 'codex' }, env.io), 0)
    assert.deepEqual(accountCalls(env), ['orca account list --agent codex --json', 'orca account select --agent codex --account c2 --json'])
    assert.ok(env.out.includes('cuenta cambiada: codex c1 → c2'))
    assert.equal(env.orchestration().filter(c => c[0] === 'worker-start').length, 2)

    const twice = fakeIo({}, { account: switcher(), quota: 2 })
    await assert.rejects(() => dispatch('ticket', { n: '7', agent: 'codex' }, twice.io), /term_2\) muestra un límite de cuota/)
    assert.equal(accountCalls(twice).length, 2)
  })
})

// #463 Rule 6, as main decided on #463 (option A): a supervised pi that comes up waiting with an empty input gets its
// dispatch fenced with worker-stop and the same task retried once on a new terminal with --retry-of.
describe('#463 despachar: pi with an empty input on the supervised path', () => {
  const WAITING = ['pi v1.5.2', '', '─ ✿ waiting for input ─── INSERT ─', '', '─'.repeat(40), '~/wt/proj-7 (proj-7)']
  const STOP = ['worker-stop', '--dispatch', 'ctx_1', '--json']
  const RETRY = ['worker-start', '--run', 'run_main', '--task', 'task_1', '--retry-of', 'ctx_1', '--terminal', 'term_2', '--json']
  const emptyPi = retry => {
    let starts = 0
    const session = path.join(home, '.pi', 'agent', 'sessions', 'project', 's2.jsonl')
    const env = fakeIo({
      'worker-start': () => {
        starts += 1
        if (starts === 1) return STARTED
        if (retry) return retry
        write(session, [JSON.stringify({ type: 'session', cwd: worktree }), '{}', '{}', '{}', JSON.stringify({ message: { sections: { tools: '<tools>\n- read' } } })].join('\n'))
        return STARTED
      },
      'worker-stop': json({ ok: true, result: { processAction: 'closed_agent_terminal' } }),
    })
    const sessionDir = path.dirname(session)
    env.io.listFiles = dir => dir === path.dirname(sessionDir) ? [sessionDir] : dir === sessionDir && existsSync(session) ? [session] : []
    const sh = env.io.sh
    env.io.sh = (cmd, args, opts) => {
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') {
        env.calls.push([cmd, ...args])
        return json({ result: { terminal: { tail: WAITING } } })
      }
      return sh(cmd, args, opts)
    }
    return env
  }

  test('#463 Rule 6: despachar stops the empty pi dispatch with worker-stop and retries the same task on a new terminal, once', async () => {
    const env = emptyPi()
    assert.equal(await dispatch('ticket', { n: '7', agent: 'pi' }, env.io), 0)
    assert.deepEqual(env.orchestration(), [['run-current', '--json'], workerStart('pi'), STOP, RETRY])
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'close').length, 0)
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create').length, 2)
    assert.ok(env.out.some(line => line.startsWith('✔ pi despachado')), env.out.join('\n'))
  })

  test('#463 Rule 6: a failed retry worker-start fails naming the new terminal and Orca\'s error, with no third launch', async () => {
    const refused = { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'task_not_ready', message: 'Task task_1 cannot start' } }), stderr: '' }
    const env = emptyPi(refused)
    await assert.rejects(() => dispatch('ticket', { n: '7', agent: 'pi' }, env.io), error => error.message.includes('Task task_1 cannot start') && error.message.includes('term_2'))
    assert.deepEqual(env.orchestration(), [['run-current', '--json'], workerStart('pi'), STOP, RETRY])
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create').length, 2)
  })
})
