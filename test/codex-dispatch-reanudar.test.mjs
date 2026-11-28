import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { dispatch, despacharCommand, launchInWorktree, leftover, reboteCommand, revisarCommand } from '../src/despacho.mjs'
import { reanudarCommand } from '../src/reanudar.mjs'
import { cleanup, tempDir, write } from './helpers.mjs'

const PROJECT = {
  setup: 'completo',
  modo: 'multiagente',
  ramaBase: 'main',
  agentes: { usa: ['agy', 'codex', 'pi'], preguntarAntes: [] },
  verificacion: { suite: 'npm test', typecheck: 'npm run typecheck' },
}
const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = (stdout = '') => ({ status: 0, stdout, stderr: '' })

let home
let root
let worktree
beforeEach(() => {
  home = tempDir('521-home')
  root = path.join(tempDir('521-root'), 'proj')
  worktree = path.join(tempDir('521-wt'), 'proj-7')
  write(path.join(root, 'x'), '')
  write(path.join(worktree, 'x'), '')
  write(path.join(root, '.orca-stack.json'), JSON.stringify(PROJECT))
})
afterEach(() => {
  for (const dir of [home, path.dirname(root), path.dirname(worktree)]) cleanup(dir)
})

const dispatchHarness = (over = {}) => {
  const calls = []
  const out = []
  const files = new Map()
  const io = {
    home,
    cwd: root,
    win: true,
    now: () => 1760616000000,
    out: line => out.push(line),
    err: () => {},
    sleep: async () => {},
    exists: file => files.has(file) || existsSync(file),
    readFile: file => files.get(file) ?? readFileSync(file, 'utf8'),
    listFiles: () => [],
    mkdirp: () => {},
    writeFile: (file, text) => {
      files.set(file, text)
      write(file, text)
    },
    rename: (from, to) => {
      files.set(to, files.get(from))
      files.delete(from)
    },
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    gentleAiBinary: async () => null,
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      const key = `${cmd} ${args[0]} ${args[1] ?? ''}`.trim()
      const custom = over[key] ?? over[`${cmd} ${args[0]}`]
      if (custom) return typeof custom === 'function' ? custom(args) : custom
      if (cmd === 'git' && args[0] === 'rev-parse') return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nbranch refs/heads/main\n`)
      if (cmd === 'git' && args[0] === 'remote') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'git' && args[0] === 'ls-files') return { status: 1, stdout: '', stderr: '' }
      if (cmd === 'git') return okRes('x\n')
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') return json({ state: 'OPEN', assignees: [], title: 't' })
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') return json({ result: { worktrees: [] } })
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'create') return json({ result: { worktree: { path: worktree, branch: 'refs/heads/proj-7' } } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create') return json({ result: { terminal: { handle: 'term_1' } } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') return json({ result: { terminal: { tail: ['OpenAI Codex'] } } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'show') return json({ ok: true, result: { terminal: { handle: 'term_1', agentIdentity: 'codex' } } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'send') return json({ result: { submission: 'submitted', turnStarted: true } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') return json({ result: { terminals: [] } })
      if (cmd === 'orca' && args[0] === 'orchestration' && args[1] === 'run-current') return json({ ok: true, result: { runId: 'run_main' } })
      if (cmd === 'orca' && args[0] === 'orchestration' && args[1] === 'worker-start') return json({ ok: true, result: { taskId: 'task_1', dispatchId: 'ctx_1', status: 'ready' } })
      return okRes()
    },
  }
  return { io, calls, out, files }
}

describe('#521 despachar codex startup race (R1, R2)', () => {
  test('R1: despachar <n> codex waits past stable screen reads until orca terminal show reports recognized agentIdentity before calling worker-start', async () => {
    let shows = 0
    const timeline = []
    const env = dispatchHarness({
      'orca terminal show': () => {
        shows += 1
        timeline.push(`show:${shows}`)
        return json({
          ok: true,
          result: { terminal: { handle: 'term_1', ...(shows >= 3 ? { agentIdentity: 'codex' } : {}) } },
        })
      },
      'orca orchestration worker-start': () => {
        timeline.push('worker-start')
        return json({ ok: true, result: { taskId: 'task_1', dispatchId: 'ctx_1', status: 'ready' } })
      },
    })

    assert.equal(await dispatch('ticket', { n: '7', agent: 'codex' }, env.io), 0)
    assert.equal(shows, 3)
    assert.deepEqual(timeline, ['show:1', 'show:2', 'show:3', 'worker-start'])
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'orchestration' && c[2] === 'worker-start').length, 1)
    assert.ok(env.out.some(line => line.startsWith('✔ codex despachado')))
  })

  test('R1: despachar <n> codex times out without calling worker-start when terminal never reports a recognized agent, lists created artifacts and recovery, and releases assignee', async () => {
    const env = dispatchHarness({
      'orca terminal show': () => json({ ok: true, result: { terminal: { handle: 'term_1' } } }),
    })

    await assert.rejects(() => dispatch('ticket', { n: '7', agent: 'codex' }, env.io), error => {
      assert.match(error.message, /term_1/)
      assert.match(error.message, /agente reconocido/i)
      assert.match(error.message, /worker-start/)
      return true
    })

    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'orchestration' && c[2] === 'worker-start').length, 0)
    assert.ok(env.calls.some(c => c.join(' ') === 'gh issue edit 7 --remove-assignee @me'))
    const text = env.out.join('\n')
    assert.ok(text.includes('El despacho quedó a medias. Quedó:'), text)
    assert.ok(text.includes(`  - el worktree ${worktree}`), text)
    assert.ok(text.includes(`  - el brief ${path.join(home, 'orca', 'briefs', 'proj-7.md')}`), text)
    assert.ok(text.includes('  - la terminal term_1'), text)
    assert.ok(text.includes(`orca worktree rm --worktree path:${worktree}`), text)
    assert.ok(!env.out.some(line => line.startsWith('✔')))
  })

  test('R2: a second despachar after an R1 timeout does not duplicate worktree or terminal and refuses naming what exists', async () => {
    const first = dispatchHarness({
      'orca terminal show': () => json({ ok: true, result: { terminal: { handle: 'term_1' } } }),
    })
    await assert.rejects(() => dispatch('ticket', { n: '7', agent: 'codex' }, first.io), /agente reconocido/i)

    for (const assignees of [[], [{ login: 'me' }]]) {
      const second = dispatchHarness({
        'gh issue view': json({ state: 'OPEN', assignees, title: 't' }),
        'git worktree': okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD abc123\nbranch refs/heads/proj-7\n`),
        'orca worktree ps': json({ result: { worktrees: [{ repo: 'proj', path: worktree, linkedIssue: 7, agents: [] }] } }),
        'orca terminal list': json({ result: { terminals: [{ handle: 'term_1', worktreePath: worktree, title: 'codex' }] } }),
      })

      await assert.rejects(() => dispatch('ticket', { n: '7', agent: 'codex' }, second.io), error => {
        if (assignees.length === 0) {
          assert.match(error.message, /Ya hay un worktree para proj-7/)
          assert.ok(error.message.includes(worktree), error.message)
          assert.ok(error.message.includes('term_1'), error.message)
        } else {
          assert.match(error.message, /ya tiene assignee/)
        }
        return true
      })

      assert.equal(second.calls.filter(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'create').length, 0)
      assert.equal(second.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create').length, 0)
      assert.equal(second.calls.filter(c => c[0] === 'orca' && c[1] === 'orchestration' && c[2] === 'worker-start').length, 0)
    }
  })
})

describe('#521 reanudar after worker_done failed (R3, R4)', () => {
  const URL = 'https://github.com/Gagaismo/orca-stack/issues/7#issuecomment-521001'
  const reanudarHarness = ({
    workers = [{ dispatchId: 'ctx_old', taskId: 'task_old', state: 'failed', terminal: 'term_1' }],
    workerListRes,
    workerStartRes = json({ ok: true, result: { taskId: 'task_new', dispatchId: 'ctx_new', status: 'ready' } }),
    dirty = '',
    screen = ['\u{273b} Baked for 2m 5s'],
    state = 'done',
    runId = 'run_main',
  } = {}) => {
    const calls = []
    const out = []
    const files = new Map()
    const briefFile = path.join(home, 'orca', 'briefs', 'orca-stack-7.md')
    const briefContent = 'You are the implementer (codex) of issue #7.\n'
    files.set(briefFile, briefContent)
    write(briefFile, briefContent)
    const io = {
      home,
      cwd: root,
      win: true,
      now: () => 1760616000000,
      out: line => out.push(line),
      sleep: async () => {},
      exists: file => files.has(file),
      readFile: file => {
        if (!files.has(file)) throw new Error(`ENOENT ${file}`)
        return files.get(file)
      },
      writeFile: (file, text) => files.set(file, text),
      rename: (from, to) => {
        files.set(to, files.get(from))
        files.delete(from)
      },
      mkdirp: () => {},
      gentleAiBinary: async () => null,
      sh: (cmd, args) => {
        calls.push([cmd, ...args])
        if (cmd === 'git' && args[0] === 'rev-parse') return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
        if (cmd === 'git' && args[0] === 'remote') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
        if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nHEAD 1\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD 2\nbranch refs/heads/Gagaismo/proj-7\n`)
        if (cmd === 'git' && args[0] === 'status') return okRes(dirty)
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return json({ login: 'stack-bot' })
        if (cmd === 'gh' && args[0] === 'api') return json({ user: { login: 'stack-bot' }, body: 'Respuesta de main: siga.', html_url: URL })
        if (cmd === 'gh' && args[0] === 'pr') return json([])
        if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'ps') {
          return json({ result: { worktrees: [{ path: worktree, repo: 'proj', linkedIssue: 7, agents: state ? [{ paneKey: 'tab-1:leaf-1', state, agentType: 'codex' }] : [] }] } })
        }
        if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'list') {
          return json({ result: { terminals: [{ handle: 'term_1', tabId: 'tab-1', leafId: 'leaf-1', title: 'codex', agentIdentity: 'codex', worktreePath: worktree }] } })
        }
        if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') return json({ result: { terminal: { tail: screen } } })
        if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'send') {
          return json({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'req-1', stages: ['input_accepted'], observation: 'supported' } } } })
        }
        if (cmd === 'orca' && args[0] === 'orchestration' && args[1] === 'run-current') return json({ ok: true, result: { runId } })
        if (cmd === 'orca' && args[0] === 'orchestration' && args[1] === 'worker-list') return workerListRes ?? json({ ok: true, result: { workers } })
        if (cmd === 'orca' && args[0] === 'orchestration' && args[1] === 'worker-start') return workerStartRes
        return okRes()
      },
    }
    const sends = () => calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send')
    const starts = () => calls.filter(c => c[0] === 'orca' && c[1] === 'orchestration' && c[2] === 'worker-start')
    return { io, calls, out, files, sends, starts }
  }

  test('R3: reanudar on a done worker whose dispatch closed (worker_done failed) opens a new dispatch on the same terminal without raw terminal send', async () => {
    const h = reanudarHarness({ dirty: ' M src/app.mjs\n' })
    assert.equal(await reanudarCommand({}, '7', URL, h.io), 0)
    assert.equal(h.sends().length, 0)
    assert.equal(h.starts().length, 1)
    const specFile = path.join(home, 'orca', 'briefs', 'orca-stack-7-reanudar-msg.md')
    assert.deepEqual(h.starts()[0], ['orca', 'orchestration', 'worker-start', '--run', 'run_main', '--terminal', 'term_1', '--spec-file', specFile, '--task-title', '#7 codex reanudado', '--json'])
    assert.equal(h.files.get(specFile), `Message from main: ${URL} . Continue the ticket per your brief: ${path.join(home, 'orca', 'briefs', 'orca-stack-7.md')}.\n`)
    assert.ok(h.out.some(line => line.includes('ctx_old') && line.includes('term_1')), h.out.join('\n'))

    await assert.rejects(() => reanudarCommand({}, '7', URL, h.io), /Ya intenté reanudar con el comentario 521001/)
    assert.equal(h.starts().length, 1)
    assert.equal(h.sends().length, 0)
  })

  test('R3: --dry-run on a closed dispatch reports the new worker-start without writing or sending', async () => {
    const h = reanudarHarness()
    assert.equal(await reanudarCommand({ dryRun: true }, '7', URL, h.io), 0)
    assert.equal(h.sends().length, 0)
    assert.equal(h.starts().length, 0)
    assert.equal(h.files.has(path.join(home, 'orca', 'briefs', 'orca-stack-7-reanudar-msg.md')), false)
    assert.ok(h.out.some(line => line.includes('[simulación]') && line.includes('worker-start') && line.includes('--terminal term_1')), h.out.join('\n'))
  })

  test('R3/R4: if opening a new dispatch fails on a closed terminal, reanudar does not send a raw line and tells what to run', async () => {
    const refused = { status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'dispatch_refused', message: 'cannot reuse terminal' } }), stderr: '' }
    const h = reanudarHarness({ workerStartRes: refused })
    await assert.rejects(() => reanudarCommand({}, '7', URL, h.io), error => {
      assert.match(error.message, /cannot reuse terminal/)
      assert.match(error.message, /ctx_old/)
      assert.match(error.message, /orca terminal close --terminal term_1 --json/)
      assert.match(error.message, /orca-stack reanudar 7/)
      return true
    })
    assert.equal(h.sends().length, 0)
  })

  test('R4: if worker-list fails while checking a bound Run, reanudar fails closed without sending a line that risks consumer_fenced', async () => {
    const h = reanudarHarness({ workerListRes: { status: 1, stdout: '', stderr: 'orca runtime error' } })
    await assert.rejects(() => reanudarCommand({}, '7', URL, h.io), error => {
      assert.match(error.message, /worker-list/)
      assert.match(error.message, /consumer_fenced/)
      return true
    })
    assert.equal(h.sends().length, 0)
    assert.equal(h.starts().length, 0)
  })

  test('R3: when a newer dispatch on the terminal is active above an older closed dispatch, reanudar uses the active dispatch via terminal send', async () => {
    const h = reanudarHarness({
      workers: [
        { dispatchId: 'ctx_new', taskId: 'task_new', state: 'ready', terminal: 'term_1' },
        { dispatchId: 'ctx_old', taskId: 'task_old', state: 'failed', terminal: 'term_1' },
      ],
    })
    assert.equal(await reanudarCommand({}, '7', URL, h.io), 0)
    assert.equal(h.sends().length, 1)
    assert.equal(h.starts().length, 0)
  })
})

describe('#521 PRESERVE: touched public entries', () => {
  test('PRESERVE despacharCommand and dispatch: healthy codex, agy and pi dispatches keep existing flow', async () => {
    const env = dispatchHarness()
    assert.equal(await despacharCommand({}, '7', 'codex', env.io), 0)
    assert.ok(env.calls.some(c => c[0] === 'orca' && c[1] === 'orchestration' && c[2] === 'worker-start'))
    assert.ok(env.out.some(line => line.startsWith('✔ codex despachado')))
  })

  test('PRESERVE launchInWorktree: unsupervised codex launch works without terminal show or worker-start', async () => {
    const env = dispatchHarness({ 'orca terminal show': { status: 1, stdout: '', stderr: 'should not be called' } })
    const briefPath = path.join(home, 'orca', 'briefs', 'existing.md')
    assert.equal(await launchInWorktree({
      agent: 'codex', mode: 'review', worktree, briefPath, brief: 'review brief', session: 'existing',
      config: PROJECT, win: true, home, repositoryRoot: root, io: env.io,
    }), 0)
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'show').length, 0)
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'orchestration' && c[2] === 'worker-start').length, 0)
  })

  test('PRESERVE leftover: omits terminal line when absent and lists terminal handle when present', () => {
    assert.equal(leftover({ assigned: false, worktree: null, brief: null }, '7', 'main'), 'No quedó nada a medias.')
    const withoutTerm = leftover({ assigned: true, worktree: 'C:\\wt\\proj-7', brief: 'C:\\b.md' }, '7', 'main')
    assert.ok(!withoutTerm.includes('la terminal'))
    const withTerm = leftover({ assigned: false, worktree: 'C:\\wt\\proj-7', brief: 'C:\\b.md', terminal: 'term_1' }, '7', 'main')
    assert.ok(withTerm.includes('  - la terminal term_1'))
  })

  test('PRESERVE reboteCommand: supervised codex bounce waits for recognized agent and posts Rebote marker', async () => {
    const env = dispatchHarness({
      'gh pr': json({
        state: 'OPEN', headRefName: 'feat/7', headRefOid: 'abc123', body: 'Implementador: codex\nCloses #7',
        statusCheckRollup: [], comments: [],
        reviews: [{ body: 'Revisor: agy\nCommit: abc123\n\n## BLOQUEA\n1. `src/a.mjs:1` (introducido, test, implementación): fix.\n\n## SUGERENCIAS\nnada', url: 'https://example.test/r/1' }],
      }),
      'git worktree': okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD abc123\nbranch refs/heads/feat/7\n`),
      'git status': okRes(''),
      'git rev-parse': args => args.includes('HEAD') ? okRes('abc123\n') : okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`),
    })
    assert.equal(await reboteCommand({}, '12', env.io), 0)
    assert.ok(env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'show'))
    assert.ok(env.calls.some(c => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'comment'))
  })

  test('PRESERVE revisarCommand: codex review dispatch works without terminal show or worker-start', async () => {
    const env = dispatchHarness({
      'gh pr': json({ headRefName: 'feat/7', headRefOid: 'abc123', body: 'Implementador: agy', number: 9 }),
      'orca terminal show': { status: 1, stdout: '', stderr: 'should not be called' },
    })
    assert.equal(await revisarCommand({}, '9', 'codex', env.io), 0)
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'show').length, 0)
    assert.ok(env.out.some(line => line.startsWith('✔ codex despachado')))
  })

  test('PRESERVE reanudarCommand: paused done codex with no closed dispatch still sends only the single URL line', async () => {
    const URL = 'https://github.com/Gagaismo/orca-stack/issues/7#issuecomment-521002'
    const briefFile = path.join(home, 'orca', 'briefs', 'orca-stack-7.md')
    const env = dispatchHarness({
      'git worktree': okRes(`worktree ${root}\nHEAD 1\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD 2\nbranch refs/heads/Gagaismo/proj-7\n`),
      'git status': okRes(''),
      'gh api': args => args[1] === 'user' ? json({ login: 'stack-bot' }) : json({ user: { login: 'stack-bot' }, body: 'Respuesta de main: siga.', html_url: URL }),
      'gh pr': json([]),
      'orca worktree ps': json({ result: { worktrees: [{ path: worktree, repo: 'proj', linkedIssue: 7, agents: [{ paneKey: 'tab-1:leaf-1', state: 'done', agentType: 'codex' }] }] } }),
      'orca terminal list': json({ result: { terminals: [{ handle: 'term_1', tabId: 'tab-1', leafId: 'leaf-1', title: 'codex', agentIdentity: 'codex', worktreePath: worktree }] } }),
      'orca terminal send': json({ ok: true, result: { send: { accepted: true, prompt: { requestId: 'req-1', stages: ['input_accepted'], observation: 'supported' } } } }),
      'orca orchestration worker-list': json({ ok: true, result: { workers: [] } }),
    })
    env.files.set(briefFile, 'You are the implementer (codex) of issue #7.\n')
    assert.equal(await reanudarCommand({}, '7', URL, env.io), 0)
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send').length, 1)
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'orchestration' && c[2] === 'worker-start').length, 0)
  })
})
