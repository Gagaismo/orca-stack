import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { citedPaths, dispatch, launcherFor, missingPaths } from '../src/despacho.mjs'
import { stackVars } from '../src/global.mjs'
import { layout } from '../src/util.mjs'
import { cleanup, read, tempDir, write } from './helpers.mjs'

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
  home = tempDir('despacho-home')
  root = path.join(tempDir('despacho-root'), 'proj')
  worktree = path.join(tempDir('despacho-wt'), 'proj-7')
  write(path.join(root, 'x'), '')
  write(path.join(worktree, 'src', 'app.ts'), '')
})
afterEach(() => {
  for (const dir of [home, path.dirname(root), path.dirname(worktree)]) cleanup(dir)
})

// A scripted environment: every external call is recorded; `over` answers specific ones ("cmd arg0 [arg1]").
const fakeIo = (over = {}, { config = PROJECT } = {}) => {
  write(path.join(root, '.orca-stack.json'), JSON.stringify(config))
  const calls = []
  const out = []
  const written = []
  const io = {
    home,
    cwd: root,
    win: true,
    out: line => out.push(line),
    sleep: async () => {},
    exists: existsSync,
    mkdirp: () => {},
    writeFile: (file, text) => {
      written.push([file, text])
      write(file, text)
    },
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      const custom = over[`${cmd} ${args[0]} ${args[1] ?? ''}`.trim()] ?? over[`${cmd} ${args[0]}`]
      if (custom) return custom
      if (cmd === 'git' && args[0] === 'rev-parse') return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nbranch refs/heads/main\n`)
      if (cmd === 'git') return okRes('src/app.ts\n')
      if (cmd === 'gh' && args[0] === 'issue') return json({ state: 'OPEN', assignees: [], title: 't' })
      if (args.join(' ') === 'worktree ps --json') return json({ result: { worktrees: [] } })
      if (args.join(' ').startsWith('worktree create')) return json({ result: { worktree: { path: worktree, branch: 'refs/heads/proj-7' } } })
      if (args[0] === 'terminal' && args[1] === 'create') return json({ result: { terminal: { handle: 'term_1' } } })
      if (args[0] === 'terminal' && args[1] === 'read') return json({ result: { text: 'ready' } })
      return okRes()
    },
  }
  // Calls that change something: every gh issue edit, orca worktree create, terminal create/send, git fetch.
  const writes = () =>
    calls.filter(c => (c[0] === 'gh' && c[2] === 'edit') || (c[0] === 'orca' && (c[2] === 'create' || c[2] === 'send')) || (c[0] === 'git' && c[1] === 'fetch'))

  return { io, calls, out, written, writes }
}

const run = (kind, args, env) => dispatch(kind, args, env.io)

describe('despachar: refusals', () => {
  test('setup pending', async () => {
    const env = fakeIo({}, { config: { ...PROJECT, setup: undefined } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /setup .* pendiente/)
    assert.equal(env.calls.filter(c => c[0] === 'gh').length, 0)
  })

  test('agent not in agentes.usa', async () => {
    const env = fakeIo({}, { config: { ...PROJECT, agentes: { usa: ['claude'] } } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /no está en agentes\.usa/)
  })

  test('preguntarAntes needs --confirmado', async () => {
    await assert.rejects(run('ticket', { n: '7', agent: 'codex-cc' }, fakeIo()), /preguntarle al humano[\s\S]*--confirmado/)
    await run('ticket', { n: '7', agent: 'codex-cc', confirmado: true, dryRun: true }, fakeIo())
  })

  test('assigned and closed issues', async () => {
    const assigned = fakeIo({ 'gh issue': json({ state: 'OPEN', assignees: [{ login: 'me' }] }) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, assigned), /ya tiene assignee/)
    const closed = fakeIo({ 'gh issue': json({ state: 'CLOSED', assignees: [] }) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, closed), /cerrado/)
    assert.deepEqual(assigned.writes(), [])
  })

  test('existing worktree (git) and live agent (orca)', async () => {
    const git = fakeIo({ 'git worktree': okRes(`worktree ${root}\nworktree C:/x/proj-7\nbranch refs/heads/proj-7\n`) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, git), /Ya hay un worktree para proj-7/)
    const live = fakeIo({ 'orca worktree ps': json({ result: { worktrees: [{ repo: 'proj', path: 'C:/other/place', linkedIssue: 7, agents: [{ state: 'working' }] }] } }) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, live), /agente vivo/)
    assert.deepEqual(live.writes(), [])
  })

  test('review: reviewer is the implementer, codex family, missing line', async () => {
    const pr = body => ({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body, number: 9 }) })
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('x\nImplementador: agy\n'))), /nadie revisa su propio PR/)
    await assert.rejects(run('review', { n: '9', agent: 'codex-cc', confirmado: true }, fakeIo(pr('Implementador: codex\n'))), /comparten modelo/)
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('sin línea'))), /no tiene la línea "Implementador/)
  })
})

describe('despachar: failures along the way', () => {
  test('a failed git fetch aborts before any write', async () => {
    const env = fakeIo({ 'git fetch': { status: 1, stdout: '', stderr: 'fatal: no remote' } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /git fetch origin falló.*fatal: no remote/)
    assert.deepEqual(env.calls.filter(c => (c[0] === 'gh' && c[2] === 'edit') || (c[0] === 'orca' && c[2] === 'create')), [])
    assert.equal(env.written.length, 0)
  })

  test('an abort after the worktree exists lists what was left and how to recover', async () => {
    const env = fakeIo({ 'orca terminal create': { status: 1, stdout: '', stderr: 'boom' } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /boom/)
    const text = env.out.join('\n')
    assert.ok(text.includes('quedó a medias'))
    assert.ok(text.includes('el issue #7 asignado') && text.includes(`el worktree ${worktree}`) && text.includes('el brief '))
    assert.ok(text.includes(`orca worktree rm --worktree path:${worktree}`) && text.includes('OK del humano'))
    assert.ok(text.includes('gh issue edit 7 --remove-assignee @me') && text.includes('rechazar el despacho'))
  })

  test('an abort right after assigning only lists the assignee', async () => {
    const env = fakeIo({ 'orca worktree create': { status: 1, stdout: '', stderr: 'no repo' } })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), /no repo/)
    const text = env.out.join('\n')
    assert.ok(text.includes('el issue #7 asignado') && !text.includes('el worktree') && !text.includes('orca worktree rm'))
  })

  test('the implementer line is compared case-insensitively and trimmed', async () => {
    const pr = body => ({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body, number: 9 }) })
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('Implementador:   AGY  \n'))), /nadie revisa su propio PR/)
    await assert.rejects(run('review', { n: '9', agent: 'codex', confirmado: true }, fakeIo(pr('implementador: Codex-CC'))), /comparten modelo/)
  })
})

describe('briefs', () => {
  test('ticket brief keeps markers literal, verification verbatim and the nota', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'agy', nota: 'Mirá `src/app.ts` antes de empezar.' }, env)
    const [file, brief] = env.written[0]
    assert.equal(file, path.join(home, 'orca', 'briefs', 'proj-7.md'))
    for (const marker of ['## Summary', '## Evidencia', '## Merge Danger', '## Desvíos del ticket', 'Implementador: agy', 'Closes #7']) assert.ok(brief.includes(marker), marker)
    assert.ok(brief.includes('npm test -- --run\nnpm run typecheck'))
    assert.ok(brief.includes('gh issue view 7 --comments') && brief.includes('--base main') && brief.includes('proj-7'))
    assert.ok(brief.includes('Mirá `src/app.ts` antes de empezar.'))
    assert.ok(!brief.includes('{{'))
    assert.notEqual(read(file).charCodeAt(0), 0xfeff)
    assert.deepEqual(env.writes().map(c => c.slice(0, 3).join(' ')), ['git fetch origin', 'gh issue edit', 'orca worktree create', 'orca terminal create', 'orca terminal send'])
    assert.deepEqual(env.calls.find(c => c[2] === 'send').slice(3), ['--terminal', 'term_1', '--text', `Read and follow the brief in ${file}`, '--enter'])
  })

  test('review brief: sha, implementer, axes, red check and format', async () => {
    const env = fakeIo({ 'gh pr': json({ headRefName: 'feat/x', headRefOid: 'abc123', body: 'Implementador: codex', number: 9 }) })
    await run('review', { n: '9', agent: 'agy', dryRun: true }, env)
    const text = env.out.join('\n')
    for (const part of ['Revisor: agy', 'Commit: abc123', 'written by codex', '## BLOQUEA', '## SUGERENCIAS', 'Standards', 'git checkout origin/<base> -- <files>', 'git checkout HEAD -- .', 'gh pr review 9 --comment --body-file', '--base-branch origin/feat/x', '--name revision-9']) assert.ok(text.includes(part), part)
  })

  test('a cited path that is not in the base tree aborts a real run with zero writes', async () => {
    const env = fakeIo()
    await assert.rejects(run('ticket', { n: '7', agent: 'agy', nota: 'Seguí `.agents/skills/impeccable/SKILL.md`.' }, env), /\.agents\/skills\/impeccable\/SKILL\.md/)
    assert.equal(env.written.length, 0)
    assert.deepEqual(env.calls.filter(c => c[0] === 'gh' && c[2] === 'edit'), [])
    assert.deepEqual(env.calls.filter(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'create'), [])
    assert.ok(!env.calls.some(c => c[1] === 'terminal'))
  })

  test('citedPaths skips commands, refs, urls and fenced blocks', () => {
    const text = 'Run `npm run test:mods`, see `origin/main`, `https://x.y/z.md`, `~/orca/a.md`, `src/a.ts:12`, `docs/` and `file:line`.\n```\n`fake/path.ts`\n```'
    assert.deepEqual(citedPaths(text), ['src/a.ts', 'docs/'])
    assert.deepEqual(missingPaths(text, p => p === 'docs'), ['src/a.ts'])
  })
})

describe('launchers', () => {
  const vars = stackVars(layout('C:\\Users\\me'))
  const base = { mode: 'ticket', vars, config: {}, win: true, home: 'C:\\Users\\me', briefPath: 'C:\\b.md', session: 'proj-7', skills: 'C:\\skills' }

  test('claude and agy take --model only when configured', () => {
    assert.match(launcherFor({ ...base, agent: 'claude' }), /^& ".*claude-orca-stack\.cmd" --dangerously-skip-permissions$/)
    const config = { agentes: { modelos: { agy: 'gemini-x' } } }
    assert.match(launcherFor({ ...base, agent: 'agy', config }), /agy-orca-stack\.cmd" --dangerously-skip-permissions --model gemini-x$/)
  })

  test('codex and codex-cc use implement or review model and effort', () => {
    const config = { agentes: { modelos: { codex: { implementar: { modelo: 'a', esfuerzo: 'high' }, revisar: { modelo: 'b', esfuerzo: 'low' } } } } }
    assert.match(launcherFor({ ...base, agent: 'codex', config }), /--model a -c model_reasoning_effort="high" -c approval_policy="never" -c sandbox_mode="danger-full-access"$/)
    assert.match(launcherFor({ ...base, agent: 'codex', config, mode: 'review' }), /--model b -c model_reasoning_effort="low"/)
    const cc = launcherFor({ ...base, agent: 'codex-cc' })
    assert.ok(cc.startsWith('$env:CMD_API_KEY = (Get-Content') && cc.includes('model_providers.cc.env_key=CMD_API_KEY') && !cc.includes('--model'))
  })

  test('pi: headless, clears the Orca variables, sets engram, autonomy and the Claude account', () => {
    const config = { piClaudeConfigDir: 'C:\\Users\\me\\.claude-pi' }
    const ps = launcherFor({ ...base, agent: 'pi', config })
    assert.ok(ps.startsWith('Remove-Item Env:ORCA_AGENT_HOOK_ENDPOINT, Env:ORCA_AGENT_HOOK_PORT'))
    assert.ok(ps.includes('Env:ORCA_STACK_CAVEMAN_LEVEL -ErrorAction SilentlyContinue'))
    assert.ok(ps.includes("$env:ENGRAM_DATA_DIR = 'C:\\Users\\me\\.gentle-shell\\engram'"))
    assert.ok(ps.includes("$env:GENTLE_PI_AUTONOMOUS_MODE = '1'") && ps.includes("$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-pi'"))
    assert.ok(ps.endsWith("pi -p --no-skills --skill 'C:\\skills' --session-id proj-7 --tools read,bash,edit,write,grep,find,ls 'Read and carry out the brief in C:\\b.md. Non-interactive: never wait for user input.'"))
    const sh = launcherFor({ ...base, agent: 'pi', win: false, mode: 'review', home: '/h', briefPath: '/b.md', skills: '/s' })
    assert.ok(sh.startsWith('unset ORCA_AGENT_HOOK_ENDPOINT ') && sh.includes(`export ENGRAM_DATA_DIR='${path.join('/h', '.gentle-shell', 'engram')}' GENTLE_PI_AUTONOMOUS_MODE='1';`))
    assert.ok(sh.includes('--tools read,bash,grep,find,ls') && !sh.includes('CLAUDE_CONFIG_DIR'))
  })

  test('the Claude account of pi comes from the personal layer only', async () => {
    write(layout(home).config, JSON.stringify({ agentes: { pi: { claudeConfigDir: '~/.claude-pi' } } }))
    const env = fakeIo({}, { config: { ...PROJECT, agentes: { ...PROJECT.agentes, pi: { claudeConfigDir: 'C:\\evil' } } } })
    await run('ticket', { n: '7', agent: 'pi', dryRun: true }, env)
    const launcher = env.out.find(l => l.startsWith('Lanzador'))
    assert.ok(launcher.includes(path.join(home, '.claude-pi')) && !launcher.includes('evil'))
    assert.ok(!env.calls.some(c => c[2] === 'send'))
  })
})

describe('--dry-run', () => {
  test('executes no write and prints the plan and the brief', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'agy', dryRun: true, nota: 'ojo' }, env)
    assert.deepEqual(env.writes(), [])
    assert.equal(env.written.length, 0)
    assert.ok(!existsSync(path.join(home, 'orca', 'briefs')))
    const text = env.out.join('\n')
    for (const part of ['[simulación] gh issue edit 7 --add-assignee @me', '[simulación] orca worktree create', '--base-branch origin/main', 'brief ->', 'Lanzador (agy)', '--- brief ---', 'ojo']) assert.ok(text.includes(part), part)
  })
})
