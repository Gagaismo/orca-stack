import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { planificarCommand, slugOf } from '../src/planificar.mjs'
import { vigilarCommand } from '../src/vigilar.mjs'
import { cleanup, tempDir, write } from './helpers.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = (stdout = '') => ({ status: 0, stdout, stderr: '' })

const PROJECT = {
  setup: 'completo',
  modo: 'multiagente',
  ramaBase: 'main',
  agentes: { usa: ['claude', 'pi'], preguntarAntes: [], pi: { perfil: 'global' } },
}
const UMBRELLA = { number: 29, title: 'Finanzas: cuotas y pagos del Centro', state: 'OPEN', body: 'Paraguas de Finanzas.' }

let home
let root
let worktree
beforeEach(() => {
  home = tempDir('planificar-home')
  root = path.join(tempDir('planificar-root'), 'proj')
  worktree = path.join(tempDir('planificar-wt'), 'proj-planificacion-29')
  write(path.join(root, '.orca-stack.json'), JSON.stringify(PROJECT))
  write(path.join(worktree, 'GLOSSARY.md'), '')
  write(path.join(home, '.pi', 'gentle-ai', 'profiles.json'), JSON.stringify({ active: 'default', profiles: { default: { orchestrator: { model: 'claude-bridge/claude-opus-5-5' } } } }))
})
afterEach(() => {
  for (const dir of [home, path.dirname(root), path.dirname(worktree)]) cleanup(dir)
})

// A scripted gh, git and Orca: every call is recorded; `over` answers specific ones ("cmd arg0 [arg1]").
const fakeIo = (over = {}, world = {}) => {
  const calls = []
  const out = []
  const err = []
  const sessionRoot = path.join(home, '.pi', 'agent', 'sessions')
  const sessionDir = path.join(sessionRoot, 'proj')
  const sessionFile = path.join(sessionDir, '2026-11-15T00-00-00-000Z_session.jsonl')
  const files = new Map()
  const io = {
    home,
    cwd: root,
    win: true,
    modifiedAt: () => Date.now() + 1000,
    out: line => out.push(line),
    err: line => err.push(line),
    sleep: async () => {},
    exists: existsSync,
    readFile: file => files.get(file) ?? readFileSync(file, 'utf8'),
    listFiles: dir => (dir === sessionRoot ? [sessionDir] : dir === sessionDir ? [...files.keys()] : []),
    mkdirp: () => {},
    writeFile: (file, text) => write(file, text),
    rename: renameSync,
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      const found = over[`${cmd} ${args[0]} ${args[1] ?? ''}`.trim()] ?? over[`${cmd} ${args[0]}`]
      if (found) return typeof found === 'function' ? found(args) : found
      if (cmd === 'git' && args[0] === 'rev-parse') return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'remote') return okRes('https://github.com/Gagaismo/proj.git\n')
      if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nHEAD 0\nbranch refs/heads/main\n`)
      if (cmd === 'git') return okRes()
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') return json(args.join(' ').includes('state') && !args.join(' ').includes('title') ? { state: world.umbrella?.state ?? UMBRELLA.state } : (world.umbrella ?? UMBRELLA))
      if (cmd === 'gh' && args[0] === 'api' && /\/issues\/29\/sub_issues/.test(args[1] ?? '')) return json((world.subIssues ?? []).map(number => ({ number, state: 'open' })))
      if (cmd === 'orca' && args.join(' ') === 'worktree ps --json') return json({ result: { worktrees: [] } })
      if (cmd === 'orca' && args[0] === 'worktree' && args[1] === 'create') return json({ result: { worktree: { path: worktree, branch: `refs/heads/${args[args.indexOf('--branch') + 1]}` } } })
      if (cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create') {
        files.set(sessionFile, [
          JSON.stringify({ type: 'session', cwd: worktree }),
          '{}', '{}', '{}', JSON.stringify({ type: 'message', message: { role: 'system', content: '', sections: { tools: '<tools>\n- read: Read file contents' } } }),
        ].join('\n'))
        return json({ result: { terminal: { handle: 'term_1' } } })
      }
      return { status: 1, stdout: '', stderr: `unexpected call: ${cmd} ${args.join(' ')}` }
    },
  }
  // Calls that change something: a fetch, a worktree or terminal Orca creates, anything gh writes.
  const writes = () => calls.filter(c => (c[0] === 'git' && c[1] === 'fetch') || (c[0] === 'orca' && c[2] === 'create') || (c[0] === 'gh' && ['edit', 'comment', 'create'].includes(c[2])))

  return { io, calls, out, err, writes }
}

const BRIEF = () => path.join(home, 'orca', 'briefs', 'proj-planificacion-29.md')

describe('orca-stack planificar <umbrella> (S3, #370)', () => {
  test('slug of the umbrella title: lowercase ASCII words joined by dashes, accents dropped', () => {
    assert.equal(slugOf('Finanzas: cuotas y pagos del Centro'), 'finanzas-cuotas-y-pagos-del-centro')
    assert.equal(slugOf('  Planificación de Áreas (2026)  '), 'planificacion-de-areas-2026')
    assert.equal(slugOf('¿?!'), '')
  })

  test('creates the Orca worktree on docs/<slug> from origin/<ramaBase>, writes the planning brief and launches pi', async () => {
    const env = fakeIo()
    assert.equal(await planificarCommand({}, '29', env.io), 0)

    assert.deepEqual(env.calls.find(c => c[0] === 'gh' && c[1] === 'issue'), ['gh', 'issue', 'view', '29', '--json', 'number,title,state,body'])
    const fetch = env.calls.findIndex(c => c[0] === 'git' && c[1] === 'fetch')
    const create = env.calls.findIndex(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'create')
    assert.ok(fetch >= 0 && fetch < create, 'git fetch origin runs before the worktree is created')
    assert.deepEqual(env.calls[create], ['orca', 'worktree', 'create', '--name', 'proj-planificacion-29', '--branch', 'docs/finanzas-cuotas-y-pagos-del-centro', '--base-branch', 'origin/main', '--issue', '29', '--no-parent', '--json'])
    assert.ok(env.out.includes('Rama: docs/finanzas-cuotas-y-pagos-del-centro'))

    const brief = readFileSync(BRIEF(), 'utf8')
    for (const text of [
      'umbrella issue #29',
      'GLOSSARY.md',
      'docs/adr/',
      'grill-with-docs',
      'to-spec',
      'to-tickets',
      'docs/finanzas-cuotas-y-pagos-del-centro',
      'git push -u origin docs/finanzas-cuotas-y-pagos-del-centro',
      'sub-issue of #29',
      'gh api repos/Gagaismo/proj/issues/29/sub_issues -X POST -F sub_issue_id=<id>',
      '`Planificación publicada: #a, #b`',
    ]) assert.ok(brief.includes(text), text)
    assert.ok(brief.includes('The human drives this session'))
    assert.doesNotMatch(brief, /unattended/i)
    assert.doesNotMatch(brief, /\{\{[A-Z_]+\}\}/)

    const terminal = env.calls.find(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create')
    const launcher = terminal[terminal.indexOf('--command') + 1]
    assert.match(launcher, /(^|; )pi /)
    assert.ok(launcher.includes('--session-id proj-planificacion-29'))
    assert.ok(launcher.includes(BRIEF()))
    // An interactive launch (the human drives it): no unattended first message, no autonomous mode.
    assert.ok(launcher.includes('the human drives this session'))
    assert.equal(launcher.includes('Unattended'), false)
    assert.equal(launcher.includes("$env:GENTLE_PI_AUTONOMOUS_MODE = '1'"), false)
    assert.ok(terminal.includes(`path:${worktree}`))
    assert.ok(env.out.includes(`\u2714 pi despachado en ${worktree}. Brief: ${BRIEF()}`))
  })

  test('negative: a closed umbrella is refused before any effect', async () => {
    const env = fakeIo({}, { umbrella: { ...UMBRELLA, state: 'CLOSED' } })
    await assert.rejects(planificarCommand({}, '29', env.io), error => error.message === 'El issue paraguas #29 está cerrado: no planifico sobre él.')
    assert.deepEqual(env.writes(), [])
    assert.equal(existsSync(BRIEF()), false)
  })

  test('negative: an umbrella with an empty title, or one that leaves no slug, is refused before any effect', async () => {
    for (const title of ['', '   ', '¿?!']) {
      const env = fakeIo({}, { umbrella: { ...UMBRELLA, title } })
      await assert.rejects(planificarCommand({}, '29', env.io), error => error.message === 'El issue paraguas #29 no tiene un título del que salga la rama docs/<slug>: ponele título y repetí.', JSON.stringify(title))
      assert.deepEqual(env.writes(), [])
    }
    assert.equal(existsSync(BRIEF()), false)
  })

  test('negative: --dry-run creates nothing and shows the plan and the brief', async () => {
    const env = fakeIo()
    assert.equal(await planificarCommand({ dryRun: true }, '29', env.io), 0)
    assert.deepEqual(env.writes(), [])
    assert.equal(env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal'), false)
    assert.equal(existsSync(BRIEF()), false)
    assert.ok(env.out.includes('[simulación] orca worktree create --name proj-planificacion-29 --branch docs/finanzas-cuotas-y-pagos-del-centro --base-branch origin/main --issue 29 --no-parent --json'))
    assert.ok(env.out.some(line => line.startsWith('\n--- brief ---\n# Planning brief: umbrella #29 (proj)')))
  })

  test('negative: a worktree already on docs/<slug> is refused before any effect', async () => {
    const env = fakeIo({ 'git worktree': okRes(`worktree ${root}\nHEAD 0\nbranch refs/heads/main\n\nworktree C:/x/other\nHEAD 1\nbranch refs/heads/docs/finanzas-cuotas-y-pagos-del-centro\n`) })
    await assert.rejects(planificarCommand({}, '29', env.io), /Ya hay un worktree para la planificación de #29/)
    assert.deepEqual(env.writes(), [])
  })

  test('negative: a missing or non-numeric umbrella is refused with the usage line and no call', async () => {
    for (const value of [undefined, 'abc']) {
      const env = fakeIo()
      await assert.rejects(planificarCommand({}, value, env.io), error => error.message === 'Uso: orca-stack planificar <issue-paraguas> [--perfil-pi <nombre>] [--dry-run].')
      assert.deepEqual(env.calls, [])
    }
  })

  test('the sub-issues the umbrella already had are not news to vigilar --paraguas', async () => {
    const world = { subIssues: [10, 11] }
    const env = fakeIo({}, world)
    await planificarCommand({}, '29', env.io)
    env.out.length = 0
    await vigilarCommand({ paraguas: '29', unaVez: true }, [], env.io)
    await vigilarCommand({ paraguas: '29', unaVez: true }, [], env.io)
    assert.deepEqual(env.out, [])
    world.subIssues = [10, 11, 63]
    await vigilarCommand({ paraguas: '29', unaVez: true }, [], env.io)
    await vigilarCommand({ paraguas: '29', unaVez: true }, [], env.io)
    assert.deepEqual(env.out, ['planificacion-publicada #29 #63'])
  })
})
