import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { main } from '../src/cli.mjs'
import { vigilarCommand } from '../src/vigilar.mjs'

const COMMON = '/repo/.git'
const CURSOR = path.join(COMMON, 'orca-stack', 'vigilar.json')
const ABC = 'abc1234aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const RUN = 'run_aaa111'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = stdout => ({ status: 0, stdout, stderr: '' })
const fail = stderr => ({ status: 1, stdout: '', stderr })
// Orca's answer to a refused orchestration command: exit 1, the error on stdout as JSON and on stderr as a line.
const orcaFail = message => ({ status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'runtime_unavailable', message } }), stderr: `error: ${message}\n` })

// A message as `orca orchestration check --all --full --json` returns it: the payload is a JSON string.
const msg = (sequence, type, taskId, outcome) =>
  ({ id: `msg_${sequence}`, run_id: RUN, type, subject: 's', body: 'b', sequence, payload: JSON.stringify({ taskId, dispatchId: `ctx_${sequence}`, ...(outcome ? { outcome } : {}) }) })
const TASKS = [
  { id: 'task_7', status: 'completed', title: '#7 claude' },
  { id: 'task_8', status: 'completed', title: '#8 codex' },
  { id: 'task_9', status: 'completed', title: '#9 agy' },
  { id: 'task_x', status: 'completed', title: 'GitHub issue #47 (parent #41): Land the baseline...' },
]
const openPr = { number: 70, state: 'OPEN', headRefName: 'Gagaismo/orca-stack-7', headRefOid: ABC, mergedAt: null, body: '', closingIssuesReferences: [{ number: 7 }], statusCheckRollup: [], mergeable: 'MERGEABLE' }

// A fake GitHub and Orca: `world.run` is the Run bound to main (none when unset), `world.mailbox` its messages and
// `world.tasks` its tasks; `world.orcaDown` makes every orchestration command fail as Orca does.
const harness = (world = {}) => {
  const files = {}
  const out = []
  const err = []
  const calls = []
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
      files[to] = files[from]
      delete files[from]
    },
    mkdirp: () => {},
    now: () => Date.parse('2026-11-20T10:00:00Z'),
    sleep: async () => {
      const next = world.script?.shift()
      if (!next) throw new Error('test: the watcher polled past the scripted world')
      next(world)
    },
    sh: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'git' && args.includes('--git-common-dir')) return okRes(`/repo/.git\n${COMMON}\n/repo\n`)
      if (cmd === 'git' && args[0] === 'worktree') return okRes('worktree /repo\nHEAD 0\nbranch refs/heads/main\n')
      if (cmd === 'orca' && args[0] === 'worktree') return json({ ok: true, result: { worktrees: [] } })
      if (cmd === 'orca' && args[0] === 'orchestration') {
        if (world.orcaDown) return orcaFail(world.orcaDown)
        if (args[1] === 'run-current') return json({ ok: true, result: { runId: world.run ?? null } })
        if (args[1] === 'check') return json({ ok: true, result: { messages: world.mailbox ?? [] } })
        if (args[1] === 'task-list') return json({ ok: true, result: { tasks: world.tasks ?? TASKS } })
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return json(world.prs ?? [])
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') return json({ comments: [], reviews: [] })
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        if (args.includes('comments')) return json({ comments: [] })
        return json({ state: (world.issues ?? {})[args[2]] ?? 'OPEN' })
      }
      return fail(`unexpected call: ${cmd} ${args.join(' ')}`)
    },
  }

  return { io, world, files, out, err, calls }
}

const once = (h, items = ['7']) => vigilarCommand({ unaVez: true }, items, h.io)
const orcaCalls = h => h.calls.filter(call => call.startsWith('orca orchestration'))
const CHECK = `orca orchestration check --run ${RUN} --all --types worker_done,escalation,question --full --json`

describe('orca-stack vigilar: the Run mailbox (S5, #397)', () => {
  test('S5: worker_done succeeded gives ok; failed or an escalation gives partial; a task not titled "#<n> <agente>" is ignored; the mailbox is read without consuming', async () => {
    const h = harness({
      run: RUN,
      prs: [openPr],
      mailbox: [msg(10, 'worker_done', 'task_7', 'succeeded'), msg(11, 'worker_done', 'task_8', 'failed'), msg(12, 'escalation', 'task_9'), msg(13, 'worker_done', 'task_x', 'succeeded'), msg(14, 'worker_done', 'task_unknown', 'succeeded')],
    })
    assert.equal(await once(h), 0)
    assert.deepEqual(h.out, ['pr-abierto #7 PR #70 abc1234', 'worker-terminado #7 claude ok', 'worker-terminado #8 codex partial', 'worker-terminado #9 agy partial'])
    assert.deepEqual(h.err, [])
    assert.deepEqual(orcaCalls(h), ['orca orchestration run-current --json', CHECK, `orca orchestration task-list --run ${RUN} --json`])
    assert.equal(h.calls.some(call => call.includes('--ack') || call.includes('--peek') || call.includes('--unread')), false)
  })

  test('S5: a restart with the same cursor repeats nothing, and a message that arrived between the runs is emitted once', async () => {
    const first = harness({ run: RUN, mailbox: [msg(10, 'worker_done', 'task_7', 'succeeded')] })
    await once(first)
    assert.deepEqual(first.out, ['worker-terminado #7 claude ok'])
    const saved = first.files[CURSOR]

    const restarted = harness({ run: RUN, mailbox: [msg(10, 'worker_done', 'task_7', 'succeeded')] })
    restarted.files[CURSOR] = saved
    await once(restarted)
    assert.deepEqual(restarted.out, [])
    // Nothing new in the mailbox: nothing to map, so the task list is not read.
    assert.deepEqual(orcaCalls(restarted), ['orca orchestration run-current --json', CHECK])
    assert.equal(restarted.files[CURSOR], saved)

    const later = harness({ run: RUN, mailbox: [msg(10, 'worker_done', 'task_7', 'succeeded'), msg(11, 'worker_done', 'task_8', 'failed')] })
    later.files[CURSOR] = saved
    await once(later)
    assert.deepEqual(later.out, ['worker-terminado #8 codex partial'])
    const again = harness({ run: RUN, mailbox: [msg(10, 'worker_done', 'task_7', 'succeeded'), msg(11, 'worker_done', 'task_8', 'failed')] })
    again.files[CURSOR] = later.files[CURSOR]
    await once(again)
    assert.deepEqual(again.out, [])
  })

  test('S5: a message that arrives before its task is listed is not lost: nothing on poll 1, emitted once on poll 2', async () => {
    const h = harness({ run: RUN, mailbox: [msg(10, 'worker_done', 'task_7', 'succeeded')], tasks: [] })
    await once(h)
    assert.deepEqual(h.out, [])
    assert.deepEqual(JSON.parse(h.files[CURSOR])[`run:${RUN}`]?.vistos ?? [], [])

    h.world.tasks = TASKS
    await once(h)
    assert.deepEqual(h.out, ['worker-terminado #7 claude ok'])
    await once(h)
    assert.deepEqual(h.out, ['worker-terminado #7 claude ok'])
  })

  test('S5: with no bound Run or with Orca failing, GitHub events keep flowing, nothing crashes and the Orca error is said once per outage', async () => {
    const unbound = harness({ prs: [openPr] })
    assert.equal(await once(unbound), 0)
    assert.deepEqual(unbound.out, ['pr-abierto #7 PR #70 abc1234'])
    assert.deepEqual(unbound.err, [])
    assert.deepEqual(orcaCalls(unbound), ['orca orchestration run-current --json'])
    assert.equal(JSON.parse(unbound.files[CURSOR])[`run:${RUN}`], undefined)

    const down = harness({ prs: [openPr], run: RUN, mailbox: [msg(10, 'worker_done', 'task_7', 'succeeded')], orcaDown: 'Orca is not running' })
    down.world.script = [
      () => {},
      world => {
        delete world.orcaDown
      },
      world => {
        world.orcaDown = 'Orca is not running'
      },
      world => {
        world.prs = [{ ...openPr, state: 'CLOSED' }]
      },
    ]
    assert.equal(await vigilarCommand({ cada: '1' }, ['7'], down.io), 0)
    assert.deepEqual(down.out, ['pr-abierto #7 PR #70 abc1234', 'worker-terminado #7 claude ok', 'pr-cerrado #7 PR #70', 'tanda-cerrada #7'])
    const said = 'vigilar: no pude leer el buzón del Run de Orca: orca orchestration run-current falló (Orca is not running); sigo vigilando GitHub.'
    assert.deepEqual(down.err, [said, said])
  })

  test('S5: vigilar --help names the Run mailbox and the worker-terminado event', async () => {
    const oldLog = console.log
    let output = ''
    console.log = value => { output += `${value}\n` }
    try {
      assert.equal(await main(['vigilar', '--help']), 0)
    } finally {
      console.log = oldLog
    }
    assert.ok(output.includes('worker-terminado #<n> <agente> ok|partial'))
    assert.ok(output.includes('orca orchestration check'))
  })
})

describe('orca-stack vigilar: worker questions in the Run mailbox (S3, #398)', () => {
  test('S3: each question gives "consulta #<n> <agente> <message_id>" once; a restart with the cursor repeats nothing and a mailbox failure marks nothing told', async () => {
    const question = { ...msg(20, 'question', 'task_8'), subject: 'Question', body: '¿Sigo?' }
    const down = harness({ run: RUN, mailbox: [question], orcaDown: 'Orca is not running' })
    await once(down)
    assert.deepEqual(down.out, [])
    assert.deepEqual(down.err, ['vigilar: no pude leer el buzón del Run de Orca: orca orchestration run-current falló (Orca is not running); sigo vigilando GitHub.'])
    assert.equal(JSON.parse(down.files[CURSOR])[`run:${RUN}`], undefined)

    delete down.world.orcaDown
    await once(down)
    assert.deepEqual(down.out, ['consulta #8 codex msg_20'])
    assert.deepEqual(orcaCalls(down).slice(1), ['orca orchestration run-current --json', CHECK, `orca orchestration task-list --run ${RUN} --json`])
    await once(down)
    assert.deepEqual(down.out, ['consulta #8 codex msg_20'])

    const restarted = harness({ run: RUN, mailbox: [question] })
    restarted.files[CURSOR] = down.files[CURSOR]
    await once(restarted)
    assert.deepEqual(restarted.out, [])
    assert.deepEqual(orcaCalls(restarted), ['orca orchestration run-current --json', CHECK])
    assert.equal(restarted.calls.some(call => call.includes('--ack') || call.includes('--peek') || call.includes('--unread')), false)
  })
})

// #445: Orca's own stop report, "Worker stopped without reporting", is an escalation whose payload has stopReason.
describe('orca-stack vigilar: an escalation without worker_done (#445)', () => {
  const stopped = (sequence, taskId) =>
    ({ id: `msg_${sequence}`, run_id: RUN, type: 'escalation', subject: 'Worker stopped without reporting', body: 'b', sequence, payload: JSON.stringify({ taskId, dispatchId: `ctx_${sequence}`, handle: 'term_1', stopReason: 'finished' }) })
  const tasks = status => [{ id: 'task_430', status, title: '#430 pi' }, { id: 'task_417', status, title: '#417 pi' }]

  test('#445 Rule 1: with the task still dispatched it emits nothing, where it used to emit worker-terminado #430 pi partial', async () => {
    const h = harness({ run: RUN, mailbox: [stopped(10, 'task_430')], tasks: tasks('dispatched') })
    assert.equal(await once(h), 0)
    assert.deepEqual(h.out, [])
    assert.deepEqual(h.err, [])
  })

  test('#445 Rule 2: with the task out of dispatched it emits worker-sin-reporte #417 pi, also when it leaves dispatched on a later poll', async () => {
    for (const status of ['failed', 'completed']) {
      const h = harness({ run: RUN, mailbox: [stopped(10, 'task_417')], tasks: tasks(status) })
      await once(h)
      assert.deepEqual(h.out, ['worker-sin-reporte #417 pi'], status)
    }
    const h = harness({ run: RUN, mailbox: [stopped(10, 'task_417')], tasks: tasks('dispatched') })
    await once(h)
    assert.deepEqual(h.out, [])
    h.world.tasks = tasks('failed')
    await once(h)
    assert.deepEqual(h.out, ['worker-sin-reporte #417 pi'])
  })

  test('#445 Rule 3: a real worker_done partial still emits worker-terminado partial, and an earlier escalation of that task adds nothing', async () => {
    for (const outcome of ['failed', 'partial']) {
      const h = harness({ run: RUN, mailbox: [stopped(10, 'task_430'), msg(11, 'worker_done', 'task_430', outcome)], tasks: tasks('failed') })
      await once(h)
      assert.deepEqual(h.out, ['worker-terminado #430 pi partial'], outcome)
    }
  })

  test('#445 Rule 4: a real worker_done ok still emits worker-terminado ok', async () => {
    const h = harness({ run: RUN, mailbox: [msg(11, 'worker_done', 'task_430', 'succeeded')], tasks: tasks('completed') })
    await once(h)
    assert.deepEqual(h.out, ['worker-terminado #430 pi ok'])
  })

  test('#445 Rule 5: re-running vigilar after a restart does not emit worker-sin-reporte twice for the same escalation', async () => {
    const first = harness({ run: RUN, mailbox: [stopped(10, 'task_417')], tasks: tasks('failed') })
    await once(first)
    assert.deepEqual(first.out, ['worker-sin-reporte #417 pi'])
    const restarted = harness({ run: RUN, mailbox: [stopped(10, 'task_417')], tasks: tasks('failed') })
    restarted.files[CURSOR] = first.files[CURSOR]
    await once(restarted)
    assert.deepEqual(restarted.out, [])
  })

  test('#445 Rule 5: vigilar --help names the worker-sin-reporte event', async () => {
    const oldLog = console.log
    let output = ''
    console.log = value => { output += `${value}\n` }
    try {
      assert.equal(await main(['vigilar', '--help']), 0)
    } finally {
      console.log = oldLog
    }
    assert.ok(output.includes('worker-sin-reporte #<n> <agente>'))
  })
})
