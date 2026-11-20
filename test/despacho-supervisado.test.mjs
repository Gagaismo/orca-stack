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
const fakeIo = (orch = {}) => {
  write(path.join(root, '.orca-stack.json'), JSON.stringify(PROJECT))
  const calls = []
  const out = []
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
    sleep: async () => {},
    exists: existsSync,
    readFile: file => files.get(file) ?? readFileSync(file, 'utf8'),
    listFiles: dir => dir === sessionRoot ? [sessionDir] : dir === sessionDir ? [...files.keys()] : [],
    mkdirp: () => {},
    writeFile: (file, text) => write(file, text),
    rename: () => {},
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
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
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'create') return json({ result: { worktree: { path: worktree, branch: 'refs/heads/proj-7' } } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create') return json({ result: { terminal: { handle: 'term_1' } } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'read') return json({ result: { terminal: { tail: ['ready'] } } })
      return okRes()
    },
  }
  const orchestration = () => calls.filter(c => c[0] === 'orca' && c[1] === 'orchestration').map(c => c.slice(2))
  const briefSends = () => calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send' && c.includes('--text') && String(c[c.indexOf('--text') + 1]).includes('brief'))
  const index = predicate => calls.findIndex(predicate)

  return { io, calls, out, orchestration, briefSends, index }
}

const briefPath = () => path.join(home, 'orca', 'briefs', 'proj-7.md')
const workerStart = (agent, run = 'run_main') => ['worker-start', '--run', run, '--terminal', 'term_1', '--spec-file', briefPath(), '--task-title', `#7 ${agent}`, '--json']

describe('#397 despachar: supervised start', () => {
  test('S2: despachar starts claude, codex, agy and pi with worker-start in the Run bound to main, after the lock, the worktree and the brief', async () => {
    for (const agent of ['claude', 'codex', 'agy', 'pi']) {
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
      await assert.rejects(dispatch('ticket', { n: '7', agent: 'claude' }, env.io), error => {
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
