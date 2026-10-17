import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { AGENTS, briefRevisionCommand, citedPaths, dispatch, launchInWorktree, launcherFor, missingPaths, quotaLine, reboteCommand, renderBrief } from '../src/despacho.mjs'
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

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHIPPED_STACK_FILES = ['CONTRATO.md', 'ORCA-STACK.md', 'ROLE-BRIEFS.md']
const packageOnlyPathRegex = (packageRoot = PACKAGE_ROOT) => {
  // .claude/ is the project's Claude Code directory (for example .claude/worktrees/), never package code.
  const allowedDirectories = new Set(['docs', '.github', '.git', '.claude'])
  const packageOnlyDirectories = readdirSync(packageRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !allowedDirectories.has(entry.name))
    .map(entry => entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?<![\\w./-])(?:${packageOnlyDirectories.join('|')})\\/`)
}

describe('shipped stack file paths', () => {
  test('rejects package-only top-level directories in every shipped stack file', () => {
    const forbiddenPath = packageOnlyPathRegex()
    const filesWithLeaks = SHIPPED_STACK_FILES.filter(filename =>
      forbiddenPath.test(readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', filename), 'utf8')),
    )
    assert.deepEqual(filesWithLeaks, [], 'shipped stack files must not cite package-only paths')
  })

  test('covers bin paths and newly added package directories', () => {
    assert.match('ROLE-BRIEFS.md cites bin/orca-stack.mjs', packageOnlyPathRegex())

    const fixture = tempDir('shipped-stack-paths')
    try {
      write(path.join(fixture, 'future-module', 'index.mjs'), '')
      assert.match('new shipped file cites future-module/index.mjs', packageOnlyPathRegex(fixture))
      assert.doesNotMatch('docs/adr/decision.md is a project path', packageOnlyPathRegex(fixture))
      write(path.join(fixture, '.claude', 'worktrees', 'agent-a1b2', 'index.mjs'), '')
      assert.doesNotMatch('git ignores .claude/worktrees/ in the project', packageOnlyPathRegex(fixture))
    } finally {
      cleanup(fixture)
    }
  })

  test('allows project paths and the installed stack path', () => {
    const projectPaths = 'docs/adr/, GLOSSARY.md, CODING_STANDARDS.md, .orca-stack.json, ~/orca/stack/ORCA-STACK.md'
    assert.doesNotMatch(projectPaths, packageOnlyPathRegex())
  })

  test('does not treat path-like non-path tokens as package paths', () => {
    const tokens = 'origin/<ramaBase>, /code-review, /mattpocock-skills:<skill>'
    assert.doesNotMatch(tokens, packageOnlyPathRegex())
  })
})

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
const fakeIo = (over = {}, { config = PROJECT, piTools = 'available' } = {}) => {
  write(path.join(root, '.orca-stack.json'), JSON.stringify(config))
  const calls = []
  const out = []
  const written = []
  const sleeps = []
  const sessionRoot = path.join(home, '.pi', 'agent', 'sessions')
  const sessionDir = path.join(sessionRoot, 'project')
  const sessionFile = path.join(sessionDir, '2026-10-09T00-00-00-000Z_session.jsonl')
  const files = new Map()
  const io = {
    home,
    cwd: root,
    win: true,
    out: line => out.push(line),
    sleep: async ms => { sleeps.push(ms) },
    exists: existsSync,
    readFile: file => files.get(file) ?? readFileSync(file, 'utf8'),
    listFiles: dir => dir === sessionRoot ? [sessionDir] : dir === sessionDir ? [...files.keys()].filter(file => path.dirname(file) === sessionDir) : [],
    mkdirp: () => {},
    writeFile: (file, text) => {
      written.push([file, text])
      write(file, text)
    },
    gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      const found = over[`${cmd} ${args[0]} ${args[1] ?? ''}`.trim()] ?? over[`${cmd} ${args[0]}`]
      const custom = typeof found === 'function' ? found(args) : found
      if (custom) return custom
      if (cmd === 'git' && args[0] === 'ls-files') return { status: 1, stdout: '', stderr: '' } // not tracked
      if (cmd === 'git' && args[0] === 'rev-parse') return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
      if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nbranch refs/heads/main\n`)
      if (cmd === 'git' && args[0] === 'remote') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
      if (cmd === 'git') return okRes('src/app.ts\n')
      if (cmd === 'gh' && args[0] === 'issue') return json({ state: 'OPEN', assignees: [], title: 't' })
      if (args.join(' ') === 'worktree ps --json') return json({ result: { worktrees: [] } })
      if (args.join(' ').startsWith('worktree create')) return json({ result: { worktree: { path: worktree, branch: 'refs/heads/proj-7' } } })
      if (args[0] === 'terminal' && args[1] === 'create') {
        if (String(args[args.indexOf('--command') + 1] ?? '').includes('pi -p')) {
          const text = piTools === 'none' ? '<tools>\n(none)' : '<tools>\n- read: Read file contents\n- bash: Execute commands'
          files.set(sessionFile, [
            JSON.stringify({ type: 'session', cwd: worktree }),
            '{}', '{}', '{}', JSON.stringify({ type: 'message', message: { role: 'system', content: '', sections: { tools: text } } }),
          ].join('\n'))
        }
        return json({ result: { terminal: { handle: 'term_1' } } })
      }
      if (args[0] === 'terminal' && args[1] === 'send' && args.includes('--wait-submit')) return json({ result: { submission: 'submitted', turnStarted: true } })
      if (args[0] === 'terminal' && args[1] === 'read') return json({ id: `req-${calls.length}`, ok: true, result: { terminal: { tail: ['ready'], latestCursor: calls.length } } })
      return okRes()
    },
  }
  // Calls that change something: every gh issue edit, orca worktree create, terminal create/send, git fetch.
  const writes = () =>
    calls.filter(c => (c[0] === 'gh' && c[2] === 'edit') || (c[0] === 'orca' && (c[2] === 'create' || c[2] === 'send')) || (c[0] === 'git' && c[1] === 'fetch'))

  return { io, calls, out, written, writes, sleeps }
}

const run = (kind, args, env) => dispatch(kind, args, env.io)
const withModels = modelos => ({ ...PROJECT, agentes: { ...PROJECT.agentes, modelos } })
// What fakeIo's dispatches launch for codex under PROJECT (no models): the pre-#236 launcher plus the Fast mode flag.
const codexLauncher = () => `& "${path.win32.join(home, 'orca', 'stack', 'scripts', 'codex-orca-stack.cmd')}" -c features.fast_mode=false -c approval_policy="never" -c sandbox_mode="danger-full-access"`

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
    // `orca worktree rm` leaves the entry as prunable until `git worktree prune`: it is not taken.
    const pruned = fakeIo({ 'git worktree': okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree C:/x/proj-7\nHEAD abc\nbranch refs/heads/proj-7\nprunable gitdir file points to non-existent location\n`) })
    await run('ticket', { n: '7', agent: 'agy', dryRun: true }, pruned)
    const live = fakeIo({ 'orca worktree ps': json({ result: { worktrees: [{ repo: 'proj', path: 'C:/other/place', linkedIssue: 7, agents: [{ state: 'working' }] }] } }) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, live), /agente vivo/)
    assert.deepEqual(live.writes(), [])
  })

  test('review: reviewer is the implementer, same model family, missing line', async () => {
    const pr = body => ({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body, number: 9 }) })
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('x\nImplementador: agy\n'))), /nadie revisa su propio PR/)
    await assert.rejects(run('review', { n: '9', agent: 'codex-cc', confirmado: true }, fakeIo(pr('Implementador: codex\n'), { config: withModels({ 'codex-cc': 'gpt-6-luna' }) })), /familia gpt, comparten modelo/)
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('sin línea'))), /no tiene la línea "Implementador/)
  })

  test('review: the family comes from the configured model, and pi may review a Claude agent', async () => {
    const pr = body => ({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body, number: 9 }) })
    // codex-cc on GLM reviews codex (gpt); with no model it proves nothing and is not stopped either.
    await run('review', { n: '9', agent: 'codex-cc', confirmado: true, dryRun: true }, fakeIo(pr('Implementador: codex'), { config: withModels({ 'codex-cc': { revisar: { modelo: 'z-ai/glm-5.3-flash' } } }) }))
    await run('review', { n: '9', agent: 'codex-cc', confirmado: true, dryRun: true }, fakeIo(pr('Implementador: codex')))
    // agy on a Claude model does not review claude; pi does, and claude reviews pi.
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, fakeIo(pr('Implementador: claude'), { config: withModels({ agy: 'claude-sonnet-5-5' }) })), /familia claude/)
    await run('review', { n: '9', agent: 'pi', dryRun: true }, fakeIo(pr('Implementador: claude')))
    await run('review', { n: '9', agent: 'claude', dryRun: true }, fakeIo(pr('Implementador: pi')))
  })

  test('a guardia.bloquear rule stops despachar and revisar, from any layer', async () => {
    const until = new Date(Date.now() + 86_400_000 * 3)
    const hasta = `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, '0')}-${String(until.getDate()).padStart(2, '0')}`
    write(layout(home).config, JSON.stringify({ guardia: { bloquear: [{ agente: 'codex', hasta, motivo: 'codex no tiene cuota: usá codex-cc.' }] } }))
    // The project layer has its own list: the personal block still applies.
    const env = fakeIo({}, { config: { ...PROJECT, guardia: { bloquear: [{ agente: 'agy', hasta: '2020-01-01' }] } } })
    await assert.rejects(run('ticket', { n: '7', agent: 'codex' }, env), /No despacho a codex: codex no tiene cuota: usá codex-cc\./)
    assert.deepEqual(env.writes(), [])
    await run('ticket', { n: '7', agent: 'agy', dryRun: true }, env) // an expired rule does nothing
    const pr = { 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: agy', number: 9 }) }
    await assert.rejects(run('review', { n: '9', agent: 'codex' }, fakeIo(pr)), /No despacho a codex/)
    write(layout(home).config, JSON.stringify({ guardia: { bloquear: [{ agente: 'codex', hasta: '29/10' }] } }))
    await assert.rejects(run('ticket', { n: '7', agent: 'codex' }, fakeIo()), /fecha "hasta" que no es AAAA-MM-DD/)
  })
})

describe('issue #198: branch output and post-launch terminal checks', () => {
  test('Rule 1: despachar prints the branch returned by Orca before the brief', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const create = env.out.findIndex(line => line.includes('orca worktree create'))
    const branch = env.out.indexOf('Rama: proj-7')
    const brief = env.out.findIndex(line => line.includes('brief ->'))
    assert.ok(create < branch && branch < brief)
  })

  test('Rule 2: dry-run says Orca will define the branch and preserves the previewed brief', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'agy', dryRun: true }, env)
    assert.ok(env.out.includes('[simulaci\u00f3n] Rama: la define Orca al crear el worktree (se pidi\u00f3 --name proj-7)'))
    assert.ok(!env.out.includes('Rama: proj-7'))
    assert.ok(env.out.some(line => line.includes('gh pr create --base main --head proj-7')))
  })

  test('Rule 3: revisar never prints Rama in real or dry-run dispatches', async () => {
    for (const dryRun of [false, true]) {
      const env = fakeIo({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: agy', number: 9 }) })
      await run('review', { n: '9', agent: 'codex', dryRun }, env)
      assert.ok(!env.out.some(line => line.startsWith('Rama:')))
    }
    const briefRevision = fakeIo({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: agy' }) }, { config: { ...PROJECT, modo: 'un-agente' } })
    await briefRevisionCommand({ n: '9', modelo: 'gpt-6-luna', dryRun: true }, briefRevision.io)
    assert.ok(!briefRevision.out.some(line => line.startsWith('Rama:')))
  })

  test('Rule 4: quota on the first post-launch read fails with recovery details and no success', async () => {
    let reads = 0
    const quota = '\u26A0 Individual quota reached\u2026 Resets in 10h45m19s'
    const env = fakeIo({ 'orca terminal read': () => json({ result: { terminal: { tail: ++reads <= 3 ? ['ready'] : [quota] } } }) })
    await assert.rejects(run('ticket', { n: '7', agent: 'agy' }, env), error =>
      error.message.includes('agy') && error.message.includes('term_1') && error.message.includes(quota))
    assert.ok(env.out.some(line => line.includes('El despacho qued\u00f3 a medias')))
    assert.ok(!env.out.some(line => line.includes('\u2714 agy despachado')))
  })

  test('Rule 5: PowerShell prompt on the second post-launch read fails but bash prompt does not', async () => {
    let reads = 0
    const env = fakeIo({ 'orca terminal read': () => json({ result: { terminal: { tail: ++reads <= 4 ? ['ready'] : ['PS C:\\work>'] } } }) })
    await assert.rejects(run('ticket', { n: '7', agent: 'codex' }, env), /codex[\s\S]*term_1[\s\S]*PS C:\\work>/)

    let bashReads = 0
    const bash = fakeIo({ 'orca terminal read': () => json({ result: { terminal: { tail: ++bashReads <= 3 ? ['ready'] : ['$ '] } } }) })
    await run('ticket', { n: '7', agent: 'codex' }, bash)
  })

  test('Rule 6: healthy screens make three extra reads and two five-second pauses; pi is not read', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'codex' }, env)
    assert.equal(env.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'read').length, 6)
    assert.deepEqual(env.sleeps.filter(ms => ms === 5000), [5000, 5000])
    assert.ok(!env.writes().some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'read'))
    const pi = fakeIo()
    await run('ticket', { n: '7', agent: 'pi' }, pi)
    assert.equal(pi.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'read').length, 0)
  })

  test('Rule 7: quota words outside the bottom fifteen lines do not fail launch', async () => {
    const env = fakeIo({ 'orca terminal read': () => json({ result: { terminal: { tail: ['rate limit', ...Array(15).fill('ready')] } } }) })
    await run('ticket', { n: '7', agent: 'codex' }, env)
    assert.ok(env.out.some(line => line.includes('\u2714 codex despachado')))
  })

  test('Rule 9: quotaLine matches only the bottom fifteen lines', () => {
    const quota = '\u26A0 Individual quota reached\u2026 Resets in 10h45m19s'
    assert.equal(quotaLine(['ready', quota]), quota)
    assert.equal(quotaLine(['working\u2026']), undefined)
    assert.equal(quotaLine(['rate limit', ...Array(15).fill('ready')]), undefined)
  })

  test('Rule 11: README and despachar help document branch output and the PowerShell-only screen look', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const cli = readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8')
    assert.match(readme, /`despachar`[\s\S]*?`Rama: <rama>`[\s\S]*?PowerShell/)
    assert.match(cli, /despachar:[\s\S]*?Rama: <rama>[\s\S]*?prompt de PowerShell/)
  })
})

describe('issue 196 brief hygiene', () => {
  test('Rule 1: verify script composes the configured suite without shell chaining in config', () => {
    const packageJson = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    const config = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, '.orca-stack.json'), 'utf8'))
    assert.equal(packageJson.scripts.verify, 'npm test && npm run test:mods')
    assert.equal(config.verificacion.suite, 'npm run verify')
    for (const value of Object.values(config.verificacion)) assert.doesNotMatch(value, /&&|\|\||;/)
  })

  test('Rule 2: verification block treats trimmed case-insensitive ninguno as empty', async () => {
    const env = fakeIo({}, { config: { ...PROJECT, verificacion: { suite: 'npm test', typecheck: ' Ninguno ' } } })
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const brief = env.written[0][1]
    assert.match(brief, /```\n(?:npm test)\n```/)
    assert.doesNotMatch(brief, /Ninguno/)
  })

  test('Rule 3: verification block keeps other command names and the typecheck command', async () => {
    const typed = fakeIo({}, { config: { ...PROJECT, verificacion: { suite: 'npm test', typecheck: 'npm run typecheck' } } })
    await run('ticket', { n: '7', agent: 'agy' }, typed)
    assert.ok(typed.written[0][1].includes('npm test\nnpm run typecheck'))
    for (const value of ['npm run ninguno', 'ninguno-lint']) {
      const nonEmpty = fakeIo({}, { config: { ...PROJECT, verificacion: { suite: value, typecheck: '' } } })
      await run('ticket', { n: '7', agent: 'agy' }, nonEmpty)
      assert.ok(nonEmpty.written[0][1].includes(value))
    }
  })

  test('Rule 4: two empty or ninguno values render the no-checks fallback', async () => {
    const empty = fakeIo({}, { config: { ...PROJECT, verificacion: { suite: ' Ninguno ', typecheck: '' } } })
    await run('ticket', { n: '7', agent: 'agy' }, empty)
    assert.ok(empty.written[0][1].includes("(none configured: run the project's own checks)"))
    const blank = fakeIo({}, { config: { ...PROJECT, verificacion: { suite: '', typecheck: '' } } })
    await run('ticket', { n: '7', agent: 'agy' }, blank)
    assert.ok(blank.written[0][1].includes("(none configured: run the project's own checks)"))
  })

  test('Rule 5: ticket, bounce, and review briefs share the ninguno filter', async () => {
    const config = { ...PROJECT, verificacion: { suite: 'npm test', typecheck: 'ninguno' } }
    const verificationContent = brief => /```([\s\S]*?)```/.exec(brief)?.[1].trim()
    const ticket = fakeIo({}, { config })
    await run('ticket', { n: '7', agent: 'agy' }, ticket)
    assert.equal(verificationContent(ticket.written[0][1]), 'npm test')

    const review = fakeIo({ 'gh pr': json({ headRefName: 'feat/x', headRefOid: 'abc123', body: 'Implementador: codex', number: 9 }) }, { config })
    await run('review', { n: '9', agent: 'agy' }, review)
    assert.equal(verificationContent(review.written[0][1]), 'npm test')

    const source = readFileSync(path.join(PACKAGE_ROOT, 'src/despacho.mjs'), 'utf8')
    assert.equal((source.match(/VERIFICATION: verificationBlock\(config\)/g) ?? []).length, 3)
  })

  test('Rule 8: ticket brief mentions root CODING_STANDARDS only when listed in the base tree', async () => {
    const absent = fakeIo({ 'git ls-tree -r': okRes('src/app.ts\ndocs/CODING_STANDARDS.md\n') })
    await run('ticket', { n: '7', agent: 'agy' }, absent)
    assert.doesNotMatch(absent.written[0][1], /CODING_STANDARDS/)

    const present = fakeIo({ 'git ls-tree -r': okRes('src/app.ts\nCODING_STANDARDS.md\n') })
    await run('ticket', { n: '7', agent: 'agy' }, present)
    assert.equal((present.written[0][1].match(/CODING_STANDARDS\.md/g) ?? []).length, 1)
    assert.match(present.written[0][1], /Read CODING_STANDARDS\.md and check the change against it before every commit\./)
  })

  test('Rules 9-10: review brief standards reflect the listed tree and missing listing is safe', async () => {
    const present = fakeIo({
      'git ls-tree -r': okRes('src/app.ts\nCODING_STANDARDS.md\n'),
      'gh pr': json({ headRefName: 'feat/x', headRefOid: 'abc123', body: 'Implementador: codex', number: 9 }),
    })
    await run('review', { n: '9', agent: 'agy' }, present)
    assert.ok(present.written[0][1].includes('CODING_STANDARDS.md and AGENTS.md'))

    const unlisted = fakeIo({
      'git ls-tree -r': okRes('src/app.ts\n'),
      'gh pr': json({ headRefName: 'feat/x', headRefOid: 'abc123', body: 'Implementador: codex', number: 9 }),
    })
    await run('review', { n: '9', agent: 'agy' }, unlisted)
    assert.ok(!unlisted.written[0][1].includes('CODING_STANDARDS'))
    assert.doesNotMatch(renderBrief('review', { PR: '1', REPO: 'repo', AGENT: 'agy', BASE: 'main', SHA: 'abc123', IMPLEMENTER: 'codex', VERIFICATION: 'npm test' }), /\{\{/)
  })

  test('Rule 6: ticket brief reads issue title, body, and comments as JSON', () => {
    const ticket = readFileSync(path.join(PACKAGE_ROOT, 'assets/stack/brief-ticket.md'), 'utf8')
    assert.match(ticket, /gh issue view \{\{ISSUE\}\} --json title,body,comments/)
    assert.doesNotMatch(ticket, /gh issue view \{\{ISSUE\}\} --comments/)
  })

  test('Rule 7: contract reads issue and PR bodies plus comments and review records', () => {
    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets/stack/CONTRATO.md'), 'utf8')
    const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
    assert.match(agents, /gh issue view <n> --json title,body,comments/)
    assert.match(agents, /gh pr view <n> --json title,body,comments,reviews/)
    assert.match(contract, /gh issue view <n> --json title,body,comments/)
    assert.match(contract, /gh pr view <n> --json title,body,comments,reviews/)
    assert.match(contract, /gh pr view <n> --json headRefOid/)
    assert.match(contract, /gh pr checks <n>/)
  })

  test('Rule 11: review brief reads PR title, body, comments, and reviews as JSON', () => {
    const review = readFileSync(path.join(PACKAGE_ROOT, 'assets/stack/brief-revision.md'), 'utf8')
    assert.match(review, /gh pr view \{\{PR\}\} --json title,body,comments,reviews, gh pr diff \{\{PR\}\}/)
    assert.doesNotMatch(review, /gh pr view \{\{PR\}\} --comments/)
  })
})

describe('revisar: one worktree per reviewer', () => {
  const pr = over => fakeIo({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: codex', number: 9 }), ...over })

  test('a second reviewer of the same PR gets its own worktree, brief and session', async () => {
    const taken = { 'git worktree': okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree C:/x/revision-9-agy\nbranch refs/heads/revision-9-agy\n`) }
    await assert.rejects(run('review', { n: '9', agent: 'agy' }, pr(taken)), /Ya hay un worktree para revision-9-agy/)
    const env = pr(taken)
    await run('review', { n: '9', agent: 'pi', dryRun: true }, env)
    const text = env.out.join('\n')
    for (const part of ['--name revision-9-pi', 'proj-revision-9-pi.md', '--session-id proj-revision-9-pi']) assert.ok(text.includes(part), part)
  })
})

describe('despachar: the TUI wait', () => {
  test('a still screen is stable even though every read carries a new request id', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'claude' }, env)
    const sent = env.calls.find(c => c[1] === 'terminal' && c[2] === 'send')
    assert.ok(sent?.includes('--text') && sent.some(a => String(a).startsWith('Read and follow the brief in ')))
  })

  test('codex trust screen fails with the repo trust hint and never sends the brief', async () => {
    const env = fakeIo({
      'orca terminal read': args => json({ result: { terminal: { tail: ['Trust this folder?'] } } }),
    })
    await assert.rejects(run('ticket', { n: '7', agent: 'codex' }, env), /confiá la raíz del repo en Codex[\s\S]*\[projects\.'/i)
    assert.ok(!env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send'))
    assert.ok(!env.out.some(line => line.includes('✔ codex despachado')))
  })

  test('revisar applies the same trust check before sending its brief', async () => {
    const env = fakeIo({
      'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: agy', number: 9 }),
      'orca terminal read': args => json({ result: { terminal: { tail: ['Trust this folder?'] } } }),
    })
    await assert.rejects(run('review', { n: '9', agent: 'codex' }, env), /confiá la raíz del repo en Codex/i)
    assert.ok(!env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send'))
  })

  test('revisar reports success after Orca observes its review turn start', async () => {
    const env = fakeIo({
      'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: agy', number: 9 }),
    })
    await run('review', { n: '9', agent: 'codex' }, env)
    assert.ok(env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send' && c.includes('--wait-submit')))
    assert.ok(env.out.some(line => line.includes('✔ codex despachado')))
  })

  test('a launched agent that exits to PowerShell fails without sending or reporting success', async () => {
    const env = fakeIo({
      'orca terminal read': args => json({ result: { terminal: { tail: ['PS C:\\work>'] } } }),
    })
    await assert.rejects(run('ticket', { n: '7', agent: 'claude' }, env), /shell prompt[\s\S]*PS C:/i)
    assert.ok(!env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send'))
    assert.ok(!env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('only an observed submitted turn prints dispatch success', async () => {
    const env = fakeIo({
      'orca terminal send': args => args.includes('--wait-submit')
        ? json({ result: { submission: 'submitted', turnStarted: true } })
        : okRes(),
    })
    await run('ticket', { n: '7', agent: 'claude' }, env)
    const send = env.calls.find(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send')
    assert.ok(send.includes('--wait-submit') && send.includes('--json'))
    assert.ok(env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('an old host without --wait-submit falls back to a changed terminal screen', async () => {
    let reads = 0
    const env = fakeIo({
      'orca terminal read': () => json({ result: { terminal: { tail: [reads++ < 3 ? 'ready' : 'prompt submitted'] } } }),
      'orca terminal send': args => args.includes('--wait-submit')
        ? { status: 1, stdout: '', stderr: 'unknown option --wait-submit' }
        : okRes(),
    })
    await run('ticket', { n: '7', agent: 'claude' }, env)
    const sends = env.calls.filter(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'send')
    assert.equal(sends.length, 2)
    assert.ok(sends[0].includes('--wait-submit') && !sends[1].includes('--wait-submit'))
    assert.ok(env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('an accepted but unobserved prompt is not reported as a started turn', async () => {
    const env = fakeIo({
      'orca terminal send': args => args.includes('--wait-submit')
        ? json({ result: { inputAccepted: true, turnStarted: false } })
        : okRes(),
      'orca terminal read': args => json({ result: { terminal: { tail: ['ready'] } } }),
    })
    await assert.rejects(run('ticket', { n: '7', agent: 'claude' }, env), /no hay evidencia.*turno haya arrancado/i)
    assert.ok(!env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('a send transport error prints recovery details and never reports success', async () => {
    const env = fakeIo({
      'orca terminal send': { status: 1, stdout: '', stderr: 'agent_prompt_blocked' },
    })
    await assert.rejects(run('ticket', { n: '7', agent: 'claude' }, env), /agent_prompt_blocked/)
    assert.ok(env.out.join('\n').includes('El despacho quedó a medias'))
    assert.ok(!env.out.some(line => line.includes('✔ claude despachado')))
  })

  test('a pi review with no tools fails fast, while the normal read/bash review tools pass', async () => {
    const pr = { 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: claude', number: 9 }) }
    const none = fakeIo(pr, { piTools: 'none' })
    await assert.rejects(run('review', { n: '9', agent: 'pi' }, none), /no tiene herramientas.*\(none\)/i)
    assert.ok(!none.out.some(line => line.includes('✔ pi despachado')))
    const available = fakeIo(pr, { piTools: 'available' })
    await run('review', { n: '9', agent: 'pi' }, available)
    assert.ok(available.out.some(line => line.includes('✔ pi despachado')))
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
    await assert.rejects(run('review', { n: '9', agent: 'codex', confirmado: true }, fakeIo(pr('implementador: Codex-CC'), { config: withModels({ 'codex-cc': 'gpt-6-luna' }) })), /comparten modelo/)
  })
})

describe('briefs', () => {
  const fanoutNote = 'arena, N=3, r\u00FAbrica \u2026, Agent tool only'

  test('Rule 1: a claude ticket brief without a note forbids arena/swarm, not its own subagents', () => {
    const brief = renderBrief('ticket', { AGENT: 'claude' })
    assert.doesNotMatch(brief, /Do not spawn subagents/i)
    assert.match(brief, /you may use your session's subagents \(the Agent tool\) for ODD's explorer and verifier and for the code-review rounds/)
    assert.match(brief, /code-review/)
    const policy = readFileSync(new URL('../assets/stack/ORCA-STACK.md', import.meta.url), 'utf8')
    assert.match(policy, /A Claude worker may run an arena or swarm only when its dispatch or bounce note[\s\S]*authorizes that fan-out for the ticket; read-only swarms require the note too/i)
  })

  test('Rule 2: a claude fan-out line separates authorized own delegation from arena/swarm', () => {
    const brief = renderBrief('ticket', { AGENT: 'claude' })
    assert.match(brief, /No arena or swarm is authorized without an approved note/i)
    assert.match(brief, /you may use your session's subagents \(the Agent tool\)/)
  })

  test('Rule 3: a claude brief still forbids an unrequested arena/swarm fan-out', () => {
    const brief = renderBrief('ticket', { AGENT: 'claude' })
    assert.match(brief, /Do not use Workflow or run an unrequested arena or swarm fan-out/i)
  })

  test('Rule 6: an approved claude note carries the exact one-round limit and effort', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'claude', nota: fanoutNote }, env)
    const brief = env.written[0][1]
    assert.match(brief, /the approved N, one round, no retry/)
    assert.match(brief, /Agent tool only/)
    assert.match(brief, /Candidates run at your effort unless the approved note specifies otherwise/)
  })

  test('Rule 4: non-claude ticket briefs reject arena and swarm even with a note', () => {
    for (const agent of ['codex', 'codex-cc', 'agy', 'pi']) {
      const brief = renderBrief('ticket', { AGENT: agent }, fanoutNote)
      assert.match(brief, new RegExp(`Arena and swarm are not supported for ${agent}, even when the note includes authorization`))
      assert.doesNotMatch(brief, /Do not spawn subagents/i)
      assert.match(brief, /you may use your session's subagents.*for ODD's explorer and verifier/)
    }
  })

  test('Rule 4: main reports note/result N mismatch without blocking merge', () => {
    const contract = readFileSync(new URL('../assets/stack/CONTRATO.md', import.meta.url), 'utf8')
    assert.match(contract, /N=4[\s\S]*nota aprob\u00F3 N=3[\s\S]*resumen de merge reporta el mismatch[\s\S]*el merge sigue/i)
  })

  test('Rule 6: main only writes a fan-out note after human OK, including autonomous and ultracode', () => {
    const contract = readFileSync(new URL('../assets/stack/CONTRATO.md', import.meta.url), 'utf8')
    assert.match(contract, /Escribe esa nota solo con el OK expl\u00EDcito del humano[\s\S]*modo aut\u00F3nomo[\s\S]*ultracode/i)
  })

  test('ticket brief defines RED/PRESERVE slices and evidence rows for rules and touched entries', async () => {
    const env = fakeIo({
      'gh issue view': json({
        state: 'OPEN', assignees: [], title: 'ticket with rules',
        body: '## Reglas\n1. `cliente` (`docs/example.md`): match this example.\n\n## Acceptance criteria\n- Keep this behavior',
      }),
    })
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const brief = env.written[0][1]
    const touched = 'A public entry is touched when its own code changed in the diff, or when it calls a shared function whose code changed in the diff. A public entry is a command, endpoint, exported function, screen or scheduled job.'
    assert.match(brief, /\*\*RED:\*\* Write one test per rule[\s\S]*?examples, edges and errors/i)
    assert.match(brief, /\*\*PRESERVE:\*\* Write one test per existing public entry the change touches/i)
    assert.match(brief, /Nothing else/i)
    assert.ok(brief.includes(touched))
    assert.match(brief, /When a rule cites an artifact.*test against that artifact, not a paraphrase/i)
    assert.match(brief, /one row per rule.*one row per touched public entry/i)

    const roleBriefs = readFileSync(new URL('../assets/stack/ROLE-BRIEFS.md', import.meta.url), 'utf8')
    const contract = readFileSync(new URL('../assets/stack/CONTRATO.md', import.meta.url), 'utf8')
    assert.ok(roleBriefs.includes(touched))
    assert.match(roleBriefs, /RED is one test per rule[\s\S]*PRESERVE is one test per existing public entry[\s\S]*Nothing else/i)
    assert.match(roleBriefs, /If a rule\s+cites an artifact, test against that artifact, not a paraphrase/i)
    assert.doesNotMatch(contract, /A public entry is touched when its own code changed in the diff/)
    assert.match(contract, /## Evidencia` con una fila por cada regla[\s\S]*por cada entrada pública tocada \(la definición está en el brief del ticket que arma `orca-stack despachar`\)/i)
    const reviewSection = contract.split('### Review')[1].split('### Skills de Matt')[0]
    assert.match(reviewSection, /Los ejes, los tests derivados, la comprobación de que un test del autor falle sin el cambio y la limpieza de tests están en el brief de revisión que arman `orca-stack revisar` y `orca-stack brief-revision`\./)
    assert.doesNotMatch(reviewSection, /se revisa en tres ejes|deriva y corre sus propios tests/i)
    assert.match(reviewSection, /Bloquean:.*No bloquean/is)
    assert.match(reviewSection, /una regla mecánica que ya tiene chequeo en la CI/)
    assert.match(reviewSection, /`implementación`.*`interpretación`.*humano.*`Decidido por main`/is)
    assert.doesNotMatch(contract, /assets\//)
    for (const marker of ['## BLOQUEA', '## SUGERENCIAS', 'Revisor:', 'Commit:', 'Implementador:', 'Verificado por main:', 'Decidido por main:', 'Suite:']) {
      assert.ok(contract.includes(marker), marker)
    }
  })

  const contractStep = n => readFileSync(new URL('../assets/stack/CONTRATO.md', import.meta.url), 'utf8')
    .split('\n').find(line => line.startsWith(`${n}. `))

  test('step 7 (c): with CI, main needs no Suite: line of its own after a bounce', () => {
    const c = contractStep(7).split('(c)')[1].split('(d)')[0]
    assert.match(c, /solo en un repo sin CI, después de un rebote, el comentario de `main` lleva también su propia línea `Suite: <comando> en verde`/)
  })

  test('step 7 (c): without CI, main still adds Suite: on the bounced commit', () => {
    const c = contractStep(7).split('(c)')[1].split('(d)')[0]
    assert.match(c, /sin CI[^;]*`Suite: <comando> en verde`, corrida sobre ese mismo commit;/)
  })

  test('step 8: the Commit: sha is the one main ran, taken before the run and never re-read from gh', () => {
    const step = contractStep(8)
    assert.match(step, /ese `Commit:` es el `git rev-parse HEAD` del checkout donde la corriste, tomado antes de correrla con `git status --porcelain` vacío, y no lo volvés a leer de `gh` al escribir el comentario/)
    assert.match(step, /si el autor pushea durante la corrida, el paso 7 \(b\) frena el merge/)
  })

  test('step 7, rule 6: a merge refused because the branch is behind ramaBase is update-branch, CI on the new head, merge', () => {
    const step = contractStep(7)
    assert.match(step, /Si `gh pr merge` se niega porque la rama del PR está atrás de `ramaBase`[^.]*corré `gh pr update-branch <n>`, esperá la CI sobre el head nuevo y mergeá; no busques otra forma de rodearlo\./)
    assert.match(step, /los merges de una tanda van de a uno/)
  })

  test('step 7 (b), rule 1: a GitHub-made update-branch merge (web-flow, verified, first parent reviewed) keeps the review', () => {
    const step = contractStep(7)
    assert.match(step, /siguen contando con el `Commit:` del commit anterior solo si el head nuevo es un merge hecho por GitHub: su committer es `web-flow`, su firma está verificada y su primer padre es ese commit/)
    assert.ok(step.includes("`gh api repos/<owner>/<repo>/commits/<headRefOid> --jq '{committer: .committer.login, verified: .commit.verification.verified, parents: [.parents[].sha]}'`"))
    assert.match(step, /el chequeo vale para github\.com/)
  })

  test('step 7 (b), rule 2: a hand-pushed merge on the reviewed commit needs a review on headRefOid', () => {
    const step = contractStep(7)
    assert.match(step, /Un merge pusheado a mano no cuenta aunque su primer padre sea el commit revisado: el review tiene que ser sobre el `headRefOid`, como siempre\./)
  })

  test('step 7 (b), rule 3: a riesgo PR still requests the step 6 reviews on the new head', () => {
    const step = contractStep(7)
    assert.match(step, /En un PR que toca `riesgo`, los reviews del paso 6 se piden de nuevo sobre el head nuevo/)
  })

  test('step 9, rule 5: with a protected ramaBase, main integrates GLOSSARY and ADR proposals in its own orchestration PR', () => {
    const step = contractStep(9)
    assert.match(step, /`## Propuesta de ADR` \(si `ramaBase` está protegida, en un PR de orquestación tuyo y no con un push directo a `ramaBase`, porque la protección lo rechaza\)/)
  })

  test('ticket brief falls back to acceptance criteria and failure modes as RED list for legacy tickets', async () => {
    const env = fakeIo({
      'gh issue view': json({
        state: 'OPEN', assignees: [], title: 'legacy ticket',
        body: '## Acceptance criteria\n- Keep this behavior\n\n## Modos de falla\n- An external call fails',
      }),
    })
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const brief = env.written[0][1]
    assert.match(brief, /If the ticket has no `## Reglas`, use its acceptance criteria and failure modes as the RED list/i)
  })

  test('ticket brief permits zero PRESERVE rows when no public entry is touched', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const brief = env.written[0][1]
    assert.match(brief, /If no existing public entry is touched, state "none touched"; do not add a placeholder row/i)
  })

  test('Rule 7: despachar still writes the usual brief and keeps its refusal behavior', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'claude' }, env)
    const brief = env.written[0][1]
    assert.match(brief, /Read the issue and its comments first: gh issue view 7 --json title,body,comments/)
    assert.match(brief, /No arena or swarm is authorized/)
    const refused = fakeIo({}, { config: { ...PROJECT, setup: undefined } })
    await assert.rejects(run('ticket', { n: '7', agent: 'claude' }, refused), /setup .* pendiente/)
  })

  test('dispatching a legacy ticket with only Modos de falla preserves acceptance criteria as TDD slices', async () => {
    const env = fakeIo({
      'gh issue view': json({
        state: 'OPEN', assignees: [], title: 'legacy ticket',
        body: '## Acceptance criteria\n- Keep this behavior\n\n## Modos de falla\n- An external call fails',
      }),
    })
    await run('ticket', { n: '7', agent: 'agy' }, env)
    const brief = env.written[0][1]
    assert.match(brief, /If the ticket has no `## Reglas`, use its acceptance criteria and failure modes as the RED list/i)
    assert.doesNotMatch(brief, /requires? `?## Reglas`?/i)
  })

  test('ticket brief keeps markers literal, verification verbatim and the nota', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'agy', nota: 'Mirá `src/app.ts` antes de empezar.' }, env)
    const [file, brief] = env.written[0]
    assert.equal(file, path.join(home, 'orca', 'briefs', 'proj-7.md'))
    for (const marker of ['## Summary', '## Evidencia', '## Merge Danger', '## Desvíos del ticket', 'Implementador: agy', 'Closes #7']) assert.ok(brief.includes(marker), marker)
    assert.ok(brief.includes('npm test -- --run\nnpm run typecheck'))
    assert.ok(brief.includes('gh issue view 7 --json title,body,comments') && brief.includes('--base main') && brief.includes('proj-7'))
    assert.ok(brief.includes('Mirá `src/app.ts` antes de empezar.'))
    assert.ok(!brief.includes('{{'))
    assert.notEqual(read(file).charCodeAt(0), 0xfeff)
    assert.deepEqual(env.writes().map(c => c.slice(0, 3).join(' ')), ['git fetch origin', 'gh issue edit', 'orca worktree create', 'orca terminal create', 'orca terminal send'])
    assert.deepEqual(env.calls.find(c => c[2] === 'send').slice(3), ['--terminal', 'term_1', '--text', `Read and follow the brief in ${file}`, '--enter', '--wait-submit', '10', '--json'])
  })

  test('review brief: sha, implementer, axes, red check and format', async () => {
    const env = fakeIo({ 'gh pr': json({ headRefName: 'feat/x', headRefOid: 'abc123', body: 'Implementador: codex', number: 9 }) })
    await run('review', { n: '9', agent: 'agy', dryRun: true }, env)
    const text = env.out.join('\n')
    const brief = renderBrief('review', {
      PR: '9', REPO: 'repo', AGENT: 'agy', IMPLEMENTER: 'codex', SHA: 'abc123', BASE: 'main', VERIFICATION: 'npm test',
    })
    for (const part of [
      'Revisor: agy', 'Commit: abc123', 'written by codex', '## BLOQUEA', '## SUGERENCIAS', 'Standards',
      'Derive and run your own tests', 'every numbered rule in `## Reglas`', 'A public entry is touched when its own code changed in the diff, or when it calls a shared function whose code changed in the diff. A public entry is a command, endpoint, exported function, screen or scheduled job.',
      'external service', 'real system', 'test code', 'implementación', 'interpretación', 'Delete your verifier test files',
      'tell `main` to send it to the human', '`main` must not settle it with `Decidido por main`',
      'acceptance criteria and failure modes', 'git checkout origin/<base> -- <files>', 'git checkout HEAD -- .',
    ]) assert.ok(brief.includes(part), part)
    for (const part of ['gh pr review 9 --comment --body-file', '--base-branch origin/feat/x', '--name revision-9-agy', 'proj-revision-9-agy.md']) assert.ok(text.includes(part), part)
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
  const base = { mode: 'ticket', config: {}, win: true, home: 'C:\\Users\\me', briefPath: 'C:\\b.md', session: 'proj-7', skills: 'C:\\skills' }

  test('claude and agy take --model only when configured', () => {
    assert.match(launcherFor({ ...base, agent: 'claude' }), /^& ".*claude-orca-stack\.cmd" --dangerously-skip-permissions$/)
    const config = { agentes: { modelos: { agy: 'gemini-x' } } }
    assert.match(launcherFor({ ...base, agent: 'agy', config }), /agy-orca-stack\.cmd" --dangerously-skip-permissions --model gemini-x$/)
  })

  test('the target platform, not the host, decides the wrapper and the paths', () => {
    const posix = { ...base, win: false, home: '/home/me', briefPath: '/b.md', skills: '/s' }
    assert.equal(launcherFor({ ...posix, agent: 'claude' }), '"/home/me/orca/stack/scripts/claude-orca-stack.sh" --dangerously-skip-permissions')
    assert.ok(launcherFor({ ...posix, agent: 'codex' }).startsWith('"/home/me/orca/stack/scripts/codex-orca-stack.sh" '))
    assert.ok(launcherFor({ ...posix, agent: 'codex-cc' }).startsWith('export CMD_API_KEY='))
    assert.ok(launcherFor({ ...posix, agent: 'pi' }).includes("ENGRAM_DATA_DIR='/home/me/.gentle-shell/engram'"))
    assert.equal(launcherFor({ ...base, agent: 'claude' }), '& "C:\\Users\\me\\orca\\stack\\scripts\\claude-orca-stack.cmd" --dangerously-skip-permissions')
  })

  test('codex and codex-cc use implement or review model and effort', () => {
    const config = { agentes: { modelos: { codex: { implementar: { modelo: 'a', esfuerzo: 'high' }, revisar: { modelo: 'b', esfuerzo: 'low' } } } } }
    assert.match(launcherFor({ ...base, agent: 'codex', config }), /--model a -c model_reasoning_effort="high" -c features\.fast_mode=false -c approval_policy="never" -c sandbox_mode="danger-full-access"$/)
    assert.match(launcherFor({ ...base, agent: 'codex', config, mode: 'review' }), /--model b -c model_reasoning_effort="low"/)
    const cc = launcherFor({ ...base, agent: 'codex-cc' })
    assert.ok(cc.startsWith('$env:CMD_API_KEY = (Get-Content') && cc.includes('model_providers.cc.env_key=CMD_API_KEY') && !cc.includes('--model'))
  })

  // despachar uses mode 'ticket' and revisar mode 'review'; rebote and reanudar relaunch with mode 'ticket'.
  test('issue 236 Rule 1: the codex launcher carries -c features.fast_mode=false in every mode', () => {
    const config = { agentes: { modelos: { codex: { implementar: { modelo: 'gpt-6-luna', esfuerzo: 'high' }, revisar: { modelo: 'gpt-6-sol', esfuerzo: 'low' } } } } }
    const wrapper = '& "C:\\Users\\me\\orca\\stack\\scripts\\codex-orca-stack.cmd"'
    assert.equal(launcherFor({ ...base, agent: 'codex', config }), `${wrapper} --model gpt-6-luna -c model_reasoning_effort="high" -c features.fast_mode=false -c approval_policy="never" -c sandbox_mode="danger-full-access"`)
    assert.equal(launcherFor({ ...base, agent: 'codex', config, mode: 'review' }), `${wrapper} --model gpt-6-sol -c model_reasoning_effort="low" -c features.fast_mode=false -c approval_policy="never" -c sandbox_mode="danger-full-access"`)
  })

  test('issue 236 Rule 2: the flag is there with no model or effort configured', () => {
    for (const config of [{}, { agentes: { modelos: {} } }]) {
      assert.equal(launcherFor({ ...base, agent: 'codex', config }), '& "C:\\Users\\me\\orca\\stack\\scripts\\codex-orca-stack.cmd" -c features.fast_mode=false -c approval_policy="never" -c sandbox_mode="danger-full-access"')
      assert.equal(launcherFor({ ...base, agent: 'codex', config, win: false, home: '/home/me' }), '"/home/me/orca/stack/scripts/codex-orca-stack.sh" -c features.fast_mode=false -c approval_policy="never" -c sandbox_mode="danger-full-access"')
    }
  })

  test('issue 236 Rule 3: the claude, codex-cc, agy and pi launchers do not change', () => {
    const config = { agentes: { modelos: { claude: 'opus-x', agy: 'gemini-x', 'codex-cc': { modelo: 'glm-x', esfuerzo: 'high' } } } }
    const scripts = 'C:\\Users\\me\\orca\\stack\\scripts'
    assert.equal(launcherFor({ ...base, agent: 'claude', config }), `& "${scripts}\\claude-orca-stack.cmd" --dangerously-skip-permissions --model opus-x`)
    assert.equal(launcherFor({ ...base, agent: 'agy', config }), `& "${scripts}\\agy-orca-stack.cmd" --dangerously-skip-permissions --model gemini-x`)
    assert.equal(launcherFor({ ...base, agent: 'codex-cc', config }), `$env:CMD_API_KEY = (Get-Content -Raw -Encoding UTF8 -LiteralPath "$HOME\\.pi\\agent\\auth.json" | ConvertFrom-Json).commandcode.key; & "${scripts}\\codex-orca-stack.cmd" -c model_provider=cc -c model_providers.cc.name=CommandCode -c model_providers.cc.base_url=https://api.commandcode.ai/provider/v1 -c model_providers.cc.env_key=CMD_API_KEY -c model_providers.cc.wire_api=responses --model glm-x -c model_reasoning_effort="high" -c approval_policy="never" -c sandbox_mode="danger-full-access"`)
    for (const agent of ['claude', 'codex-cc', 'agy', 'pi']) {
      for (const win of [true, false]) assert.ok(!launcherFor({ ...base, agent, config, win }).includes('fast_mode'), `${agent} (win: ${win})`)
    }
  })

  test('issue 236 Rule 4: despachar --dry-run prints the codex launcher with the flag', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'codex', dryRun: true }, env)
    assert.ok(env.out.includes(`Lanzador (codex): ${codexLauncher()}`))
    assert.ok(env.out.some(line => line.startsWith('[simulaci\u00f3n] orca terminal create') && line.includes(JSON.stringify(codexLauncher()))))
  })

  test('issue 236 Rule 5: despachar and revisar launch as before, codex only gains the flag', async () => {
    const prView = { 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: agy', number: 9 }) }
    const claude = `& "${path.win32.join(home, 'orca', 'stack', 'scripts', 'claude-orca-stack.cmd')}" --dangerously-skip-permissions`
    for (const [kind, n, over] of [['ticket', '7', {}], ['review', '9', prView]]) {
      for (const [agent, launcher] of [['codex', codexLauncher()], ['claude', claude]]) {
        const env = fakeIo(over)
        await run(kind, { n, agent, dryRun: true }, env)
        assert.equal(env.out.find(line => line.startsWith(`Lanzador (${agent}):`)), `Lanzador (${agent}): ${launcher}`, `${kind} ${agent}`)
      }
    }
  })

  test('pi: headless, clears the Orca variables, sets engram, autonomy and the Claude account', () => {
    const config = { piClaudeConfigDir: 'C:\\Users\\me\\.claude-pi' }
    const ps = launcherFor({ ...base, agent: 'pi', config })
    assert.ok(ps.startsWith('Remove-Item Env:ORCA_AGENT_HOOK_ENDPOINT, Env:ORCA_AGENT_HOOK_PORT'))
    assert.ok(ps.includes('Env:ORCA_STACK_CAVEMAN_LEVEL -ErrorAction SilentlyContinue'))
    assert.ok(ps.includes("$env:ENGRAM_DATA_DIR = 'C:\\Users\\me\\.gentle-shell\\engram'"))
    assert.ok(ps.includes("$env:GENTLE_PI_AUTONOMOUS_MODE = '1'") && ps.includes("$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-pi'"))
    assert.ok(ps.endsWith("pi -p --no-skills --skill 'C:\\skills' --session-id proj-7 'Read and carry out the brief in C:\\b.md. Non-interactive: never wait for user input.'"))
    assert.ok(!ps.includes('--tools'), "a ticket keeps all of pi's tools: subagents, SDD, engram")
    const sh = launcherFor({ ...base, agent: 'pi', win: false, mode: 'review', home: '/h', briefPath: '/b.md', skills: '/s' })
    assert.ok(sh.startsWith('unset ORCA_AGENT_HOOK_ENDPOINT ') && sh.includes("export ENGRAM_DATA_DIR='/h/.gentle-shell/engram' GENTLE_PI_AUTONOMOUS_MODE='1';"))
    assert.ok(sh.includes("--tools 'read,bash,grep,find,ls,codemode'") && !sh.includes('CLAUDE_CONFIG_DIR'))
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

describe('pi: --perfil-pi', () => {
  const PROFILES = {
    kind: 'gentle-pi.agent_model_profiles',
    version: 1,
    active: 'samu-balanceado',
    profiles: {
      'opus-haiku': { orchestrator: { model: 'claude-bridge/claude-opus-5-5', thinking: 'high' }, 'gentle-ai-worker': { model: 'claude-bridge/claude-haiku-5-5', thinking: 'high' } },
      'samu-balanceado': { orchestrator: { model: 'claude-bridge/claude-opus-5-5', thinking: 'high' } },
    },
  }
  const store = () => path.join(home, '.pi', 'gentle-ai', 'profiles.json')
  const pinFile = () => path.join(worktree, '.pi', 'gentle-ai', 'profile.json')
  const exclude = () => path.join(root, '.git', 'info', 'exclude')
  const launcher = env => {
    const call = env.calls.find(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create')

    return call[call.indexOf('--command') + 1]
  }
  const EXCLUDE_LINE = '/.pi/gentle-ai/profile.json'
  // Not ignored until the exclude entry is there (what git does).
  const notIgnored = { 'git check-ignore': () => ({ status: existsSync(exclude()) && read(exclude()).includes(EXCLUDE_LINE) ? 0 : 1, stdout: '', stderr: '' }) }
  // A .gitignore negation: git keeps reporting the file as not ignored.
  const negated = { 'git check-ignore': { status: 1, stdout: '', stderr: '' } }
  const tracked = { 'git ls-files': { status: 0, stdout: '.pi/gentle-ai/profile.json\n', stderr: '' } }
  const trackedPin = profile => write(pinFile(), JSON.stringify({ kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile }))
  beforeEach(() => write(store(), JSON.stringify(PROFILES)))

  test('writes the worktree pin, excludes it once, and launches pi with the profile orchestrator', async () => {
    const env = fakeIo(notIgnored)
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env)
    assert.deepEqual(JSON.parse(read(pinFile())), { kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile: 'opus-haiku' })
    assert.equal(read(exclude()), '/.pi/gentle-ai/profile.json\n')
    assert.ok(launcher(env).includes("--model 'claude-bridge/claude-opus-5-5' --thinking high"), launcher(env))
    // The pin exists before pi starts.
    const order = env.calls.map(c => c.join(' '))
    assert.ok(order.findIndex(l => l.startsWith('git check-ignore')) < order.findIndex(l => l.startsWith('orca terminal create')))
  })

  test('the exclude entry is appended once and keeps what was there', async () => {
    write(exclude(), '# mine')
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo(notIgnored))
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo(notIgnored))
    assert.equal(read(exclude()), '# mine\n/.pi/gentle-ai/profile.json\n')
  })

  test('an already ignored pin touches no exclude file', async () => {
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo())
    assert.ok(existsSync(pinFile()) && !existsSync(exclude()))
  })

  test('a tracked pin that declares the same profile is left untouched', async () => {
    trackedPin('opus-haiku')
    const env = fakeIo(tracked)
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env)
    assert.equal(env.written.filter(([file]) => file === pinFile()).length, 0)
    assert.ok(!existsSync(exclude()))
    assert.ok(launcher(env).includes('--model'))
  })

  test('a tracked pin that declares another profile (or is unreadable) fails without writing', async () => {
    trackedPin('samu-balanceado')
    const env = fakeIo(tracked)
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env), /versionado.*declara el perfil "samu-balanceado".*--perfil-pi samu-balanceado/)
    assert.equal(JSON.parse(read(pinFile())).profile, 'samu-balanceado')
    assert.ok(env.out.join('\n').includes('El despacho quedó a medias'))
    assert.ok(!env.calls.some(c => c[1] === 'terminal' && c[2] === 'create'))
    write(pinFile(), '{ not json')
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo(tracked)), /versionado.*no se puede leer/)
    assert.equal(read(pinFile()), '{ not json')
  })

  test('a pin that a .gitignore negation keeps visible fails instead of writing; the exclude entry is added once', async () => {
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo(negated)), /git no ignora \.pi\/gentle-ai\/profile\.json.*gana sobre info\/exclude/)
    }
    assert.ok(!existsSync(pinFile()))
    assert.equal(read(exclude()), '/.pi/gentle-ai/profile.json\n')
  })

  test('a clone-local pin on another profile fails before any write; the same one is fine', async () => {
    const pin = profile => write(path.join(root, '.git', 'gentle-ai', 'profile-pin.json'), JSON.stringify({ kind: 'gentle-pi.agent_model_profile_pin', version: 1, profile }))
    pin('samu-balanceado')
    const env = fakeIo()
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env), /fija el perfil de Pi "samu-balanceado"/)
    assert.deepEqual(env.writes(), [])
    pin('opus-haiku')
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku', dryRun: true }, fakeIo())
  })

  test('an unknown profile fails before any write and lists the existing ones', async () => {
    const env = fakeIo()
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'nope' }, env), /No existe el perfil de Pi "nope".*opus-haiku, samu-balanceado/)
    assert.deepEqual(env.writes(), [])
    await assert.rejects(run('ticket', { n: '7', agent: 'pi', perfilPi: 'a b; rm' }, fakeIo()), /no es un nombre válido/)
    await assert.rejects(run('ticket', { n: '7', agent: 'agy', perfilPi: 'opus-haiku' }, fakeIo()), /solo vale para el agente pi/)
  })

  test('agentes.pi.perfil applies, the flag wins, and "preguntar" or nothing changes nothing', async () => {
    const withPerfil = perfil => ({ ...PROJECT, agentes: { ...PROJECT.agentes, pi: { perfil } } })
    await run('ticket', { n: '7', agent: 'pi' }, fakeIo({}, { config: withPerfil('samu-balanceado') }))
    assert.equal(JSON.parse(read(pinFile())).profile, 'samu-balanceado')
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, fakeIo({}, { config: withPerfil('samu-balanceado') }))
    assert.equal(JSON.parse(read(pinFile())).profile, 'opus-haiku')
    for (const config of [withPerfil('preguntar'), withPerfil(' Preguntar '), PROJECT]) {
      cleanup(path.dirname(pinFile()))
      const env = fakeIo({}, { config })
      await run('ticket', { n: '7', agent: 'pi' }, env)
      assert.ok(!existsSync(pinFile()) && !launcher(env).includes('--model') && !launcher(env).includes('--thinking'))
    }
    // No profiles store is needed when no profile is asked for.
    cleanup(store())
    await run('ticket', { n: '7', agent: 'pi', dryRun: true }, fakeIo())
  })

  test('an invalid thinking in the profile is warned about and not passed to pi', async () => {
    write(store(), JSON.stringify({ ...PROFILES, profiles: { 'opus-haiku': { orchestrator: { model: 'claude-bridge/claude-opus-5-5', thinking: 'turbo' } } } }))
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku' }, env)
    assert.match(env.out.join('\n'), /thinking "turbo", que no es válido.*se ignora/)
    assert.ok(launcher(env).includes('--model') && !launcher(env).includes('--thinking'))
    const dry = fakeIo()
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku', dryRun: true }, dry)
    assert.ok(!dry.out.join('\n').includes('(turbo)'))
  })

  test('--dry-run narrates the pin and the model and writes nothing', async () => {
    const env = fakeIo()
    await run('ticket', { n: '7', agent: 'pi', perfilPi: 'opus-haiku', dryRun: true }, env)
    const text = env.out.join('\n')
    for (const part of ['[simulación] perfil de Pi "opus-haiku"', 'profile.json', 'exclude', "--model 'claude-bridge/claude-opus-5-5'"]) assert.ok(text.includes(part), part)
    assert.ok(!existsSync(pinFile()) && !existsSync(exclude()))
    assert.deepEqual(env.writes(), [])
    const review = fakeIo({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: claude', number: 9 }) })
    await run('review', { n: '9', agent: 'pi', perfilPi: 'opus-haiku', dryRun: true }, review)
    assert.ok(review.out.join('\n').includes('perfil de Pi "opus-haiku"'))
  })

  test('launcherFor adds --model only when given, in PowerShell and POSIX', () => {
    const base = { mode: 'ticket', config: {}, home: '/h', briefPath: '/b.md', session: 's', skills: '/s', agent: 'pi' }
    assert.ok(!launcherFor({ ...base, win: false }).includes('--model'))
    assert.ok(launcherFor({ ...base, win: false, piModel: 'p/m' }).includes("--session-id s --model 'p/m' 'Read"))
    assert.ok(launcherFor({ ...base, win: true, piModel: 'p/m', piThinking: 'bogus' }).includes("--model 'p/m' 'Read"))
  })
})

describe('--dry-run', () => {
  test('keeps launch output stable for claude, codex, agy and pi', async () => {
    for (const agent of ['claude', 'codex', 'agy', 'pi']) {
      const env = fakeIo()
      await run('ticket', { n: '7', agent, dryRun: true }, env)
      const output = env.out.join('\n')
      const briefPath = path.join(home, 'orca', 'briefs', 'proj-7.md')
      const launcher = launcherFor({ agent, mode: 'ticket', config: PROJECT, win: true, home, briefPath, session: 'proj-7', skills: agent === 'pi' ? 'C:\\pi\\gentle-pi\\skills' : null })
      const start = env.out.findIndex(line => line.startsWith(`Lanzador (${agent}):`))
      const launchLines = env.out.slice(start)

      assert.equal(launchLines[0], `Lanzador (${agent}): ${launcher}`)
      assert.equal(launchLines[1], `[simulaci\u00f3n] orca terminal create --worktree path:<worktree> --title ${agent} --command ${JSON.stringify(launcher)} --json`)
      if (agent !== 'pi') {
        assert.equal(launchLines[2], `[simulaci\u00f3n] esperar la TUI de ${agent}${agent === 'agy' ? ' (confirmar la carpeta con Enter)' : ''} y enviar: Read and follow the brief in ${briefPath}`)
      } else {
        assert.ok(!output.includes('esperar la TUI'))
      }
      assert.ok(!env.writes().some(call => call[0] === 'orca' && call[1] === 'terminal'))
    }
  })

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

describe('launchInWorktree', () => {
  test('Rule 1: refuses the Codex update menu without sending the brief', async () => {
    const menu = [
      'Update available \u00B7 0.162.1 \u2192 0.163.0',
      '› 1. Update now (runs `npm install -g @openai/codex`)',
      '2. Skip',
    ]
    const env = fakeIo({ 'orca terminal read': () => json({ result: { terminal: { tail: menu } } }) })
    await assert.rejects(() => launchInWorktree({
      agent: 'codex', mode: 'ticket', worktree, briefPath: path.join(home, 'orca', 'briefs', 'existing.md'),
      brief: 'brief', session: 'existing', config: PROJECT, win: true, home, repositoryRoot: root, io: env.io,
    }), error => {
      assert.match(error.message, /Codex muestra su men[u\u00FA] de actualizaci[o\u00F3]n/)
      assert.match(error.message, /term_1/)
      assert.match(error.message, /orca-stack reanudar/)
      return true
    })
    assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'send').length, 0)
  })

  test('builds and launches the configured agent using an existing worktree without dispatch reads', async () => {
    const env = fakeIo()
    const briefPath = path.join(home, 'orca', 'briefs', 'existing.md')
    const config = { ...PROJECT, agentes: { ...PROJECT.agentes, modelos: { claude: 'launch-model' } } }

    await launchInWorktree({
      agent: 'claude',
      mode: 'ticket',
      worktree,
      briefPath,
      session: 'existing',
      config,
      win: true,
      home,
      io: env.io,
    })

    const create = env.calls.find(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'create')
    assert.equal(create[create.indexOf('--worktree') + 1], `path:${worktree}`)
    assert.match(create[create.indexOf('--command') + 1], /claude-orca-stack\.cmd/)
    assert.match(create[create.indexOf('--command') + 1], /--model launch-model/)
    assert.ok(env.calls.some(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'send' && call.includes(`Read and follow the brief in ${briefPath}`)))
    assert.ok(!env.calls.some(call => call[0] === 'gh' || (call[0] === 'git' && call[1] !== '')))
    assert.ok(!env.calls.some(call => call[0] === 'orca' && call[1] === 'worktree'))
    assert.ok(env.out.some(line => line.includes(`\u2714 claude despachado en ${worktree}. Brief: ${briefPath}`)))
  })
})

describe('rebote', () => {
  const pr = (overrides = {}) => ({
    state: 'OPEN', headRefName: 'feat/fix', headRefOid: 'abc123', body: 'Implementador: agy',
    statusCheckRollup: [],
    reviews: [{ body: 'Revisor: codex\nCommit: abc123\n\n## BLOQUEA\n1. `src/app.mjs:1` (introducido, concreta, implementaci\u00F3n): fix it.\n\n## SUGERENCIAS\n(none)', url: 'https://example.test/review/1' }],
    comments: [], ...overrides,
  })
  const bounceEnv = (pull = pr(), extra = {}, config = PROJECT) => {
    const env = fakeIo({ 'gh pr': json(pull), 'git worktree': okRes(`worktree ${root}\nbranch refs/heads/main\n\nworktree ${worktree}\nHEAD abc123\nbranch refs/heads/feat/fix\n`), 'git status': okRes(''), ...extra }, { config })
    const original = env.io.sh
    env.io.sh = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return okRes(`${pull.headRefOid}\n`)
      return original(cmd, args, opts)
    }
    return env
  }

  test('Rule 3: rebote does not print a branch line', async () => {
    const env = bounceEnv(pr(), {}, PROJECT)
    await reboteCommand({ dryRun: true }, '12', env.io)
    assert.ok(!env.out.some(line => line.startsWith('Rama:')))
  })

  test('Rule 8: rebote does not post its marker when the relaunched author shows quota', async () => {
    let reads = 0
    const quota = '\u26A0 Individual quota reached\u2026 Resets in 10h45m19s'
    const env = bounceEnv(pr(), {
      'orca terminal read': () => json({ result: { terminal: { tail: ++reads <= 3 ? ['ready'] : [quota] } } }),
    })
    await assert.rejects(reboteCommand({}, '12', env.io), error =>
      error.message.includes('agy') && error.message.includes('term_1') && error.message.includes(quota))
    assert.ok(!env.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'comment'))
  })

  test('Rule 1: relaunches author with current blockers and posts Rebote only after launch', async () => {
    const env = bounceEnv(pr({ comments: [{ body: 'Commit: abc123\n## BLOQUEA\n2. otra cosa', url: 'https://example.test/comment/2' }] }))
    await reboteCommand({}, '12', env.io)
    const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
    assert.match(brief, /fix it/)
    assert.match(brief, /otra cosa/)
    assert.match(brief, /https:\/\/example\.test\/comment\/2/)
    assert.ok(env.calls.some(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'create'))
    const comment = env.calls.findIndex(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'comment')
    const launch = env.calls.findIndex(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'send')
    assert.ok(comment > launch)
    assert.equal(env.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote: abc123\n')
  })

  test('Rule 2: permits same-head retry marker but refuses when head advanced', async () => {
    const same = bounceEnv(pr({ comments: [{ body: 'Rebote: abc123' }] }))
    await reboteCommand({ dryRun: true }, '12', same.io)
    const advanced = bounceEnv(pr({ headRefOid: 'def456', comments: [{ body: 'Rebote: abc123' }] }))
    await assert.rejects(reboteCommand({}, '12', advanced.io), /avanz\u00F3 desde el rebote.*Decidido por main/)
  })

  test('Rule 3: interpretation blockers are listed and never relaunched', async () => {
    const env = bounceEnv(pr({ reviews: [{ body: 'Commit: abc123\n## BLOQUEA\n1. (inferida, interpretaci\u00F3n): product disagreement' }] }))
    await assert.rejects(reboteCommand({}, '12', env.io), /interpretaci\u00F3n.*product disagreement/)
    assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
  })

  test('Rule 4: refuses absent current blocker and stale review commit', async () => {
    await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ reviews: [{ body: 'Commit: abc123\n## BLOQUEA\nnada' }] })).io), /no tiene un review bloqueante vigente/)
    await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ reviews: [{ body: 'Commit: oldsha\n## BLOQUEA\n1. finding' }] })).io), /no tiene un review bloqueante vigente/)
  })

  test('Rule 5: refuses closed or merged PRs', async () => {
    for (const state of ['CLOSED', 'MERGED']) await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ state })).io), /no se puede rebotar/)
  })

  test('Rule 6: requires the matching clean worktree at the PR head', async () => {
    await assert.rejects(reboteCommand({}, '12', bounceEnv(pr(), { 'git worktree': okRes(`worktree ${root}\nbranch refs/heads/main\n`) }).io), /No hay un worktree/)
    await assert.rejects(reboteCommand({}, '12', bounceEnv(pr(), { 'git status': okRes(' M src/app.mjs\n') }).io), /worktree .* est\u00E1 sucio/)
    const wrong = bounceEnv(pr(), { 'git merge-base': { status: 1, stdout: '', stderr: '' } })
    const base = wrong.io.sh
    wrong.io.sh = (cmd, args, opts) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD' ? okRes('oldsha\n') : base(cmd, args, opts)
    await assert.rejects(reboteCommand({}, '12', wrong.io), /no en el head del PR/)
  })

  describe('issue 241: a worktree behind the PR head', () => {
    const behindPr = () => pr({ headRefOid: 'd25b997c0ffee', reviews: [{ body: 'Commit: d25b997c0ffee\n## BLOQUEA\n1. fix it', url: 'https://example.test/review/1' }] })
    // Like a real repo, the PR head commit is unknown (exit 128) until the branch is fetched.
    const behindEnv = (ancestor, extra = {}) => {
      const fetched = () => env.calls.some(call => call[0] === 'git' && call[1] === 'fetch')
      const env = bounceEnv(behindPr(), {
        'git merge-base': () => fetched() ? { status: ancestor, stdout: '', stderr: '' } : { status: 128, stdout: '', stderr: 'fatal: Not a valid commit name d25b997c0ffee' },
        ...extra,
      })
      const base = env.io.sh
      env.io.sh = (cmd, args, opts) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD' ? okRes('46f2431beef00\n') : base(cmd, args, opts)
      return env
    }
    const gitCalls = (env, sub) => env.calls.filter(call => call[0] === 'git' && call[1] === sub)

    test('Rule 1: fast-forwards a clean worktree whose HEAD is an ancestor of the PR head and bounces', async () => {
      const env = behindEnv(0)
      await reboteCommand({}, '12', env.io)
      assert.deepEqual(gitCalls(env, 'fetch'), [['git', 'fetch', 'origin', 'feat/fix']])
      assert.deepEqual(gitCalls(env, 'merge-base'), [['git', 'merge-base', '--is-ancestor', 'HEAD', 'd25b997c0ffee']])
      assert.deepEqual(gitCalls(env, 'merge'), [['git', 'merge', '--ff-only', 'd25b997c0ffee']])
      assert.ok(env.out.includes('Adelanté el worktree de 46f2431 a d25b997 (el head del PR).'))
      const merge = env.calls.findIndex(call => call[0] === 'git' && call[1] === 'merge')
      const launch = env.calls.findIndex(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'create')
      assert.ok(merge >= 0 && merge < launch)
      assert.equal(env.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote: d25b997c0ffee\n')
    })

    test('Rule 2: a worktree with local commits not in the PR head keeps the refusal word for word and is not touched', async () => {
      const env = behindEnv(1)
      await assert.rejects(reboteCommand({}, '12', env.io), error => {
        assert.equal(error.message, `El worktree ${worktree} está en 46f2431beef00, no en el head del PR d25b997c0ffee.`)
        return true
      })
      assert.equal(gitCalls(env, 'merge').length, 0)
      assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
    })

    test('Rule 3: a dirty worktree keeps the refusal and is not fast-forwarded even when it is behind', async () => {
      const env = behindEnv(0, { 'git status': okRes('?? notes.txt\n') })
      await assert.rejects(reboteCommand({}, '12', env.io), error => {
        assert.equal(error.message, `El worktree ${worktree} está sucio; guardá o descartá sus cambios antes de relanzar.`)
        return true
      })
      for (const sub of ['fetch', 'merge-base', 'merge']) assert.equal(gitCalls(env, sub).length, 0, sub)
    })

    test('Rule 4: --dry-run prints the fast-forward it would do and changes nothing', async () => {
      const env = behindEnv(0)
      await reboteCommand({ dryRun: true }, '12', env.io)
      assert.ok(env.out.includes('[simulación] Adelanté el worktree de 46f2431 a d25b997 (el head del PR).'))
      assert.equal(gitCalls(env, 'merge').length, 0)
      assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
      assert.ok(!env.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'comment'))
      assert.equal(env.written.length, 0)
    })

    test('Rule 5: a worktree already at the PR head bounces without fetching or fast-forwarding', async () => {
      const env = bounceEnv()
      await reboteCommand({}, '12', env.io)
      for (const sub of ['fetch', 'merge-base', 'merge']) assert.equal(gitCalls(env, sub).length, 0, sub)
      assert.ok(!env.out.some(line => line.includes('Adelanté')))
      assert.equal(env.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote: abc123\n')
    })
  })

  test('Rule 7: refuses a live agent in the existing worktree', async () => {
    const env = bounceEnv(pr(), { 'orca worktree': json({ result: { worktrees: [{ path: worktree, agents: [{ state: 'working' }] }] } }) })
    await assert.rejects(reboteCommand({}, '12', env.io), /agente vivo/)
  })

  test('Rule 8: applies agent use, block and preguntarAntes guards', async () => {
    await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ body: 'Implementador: claude' }), {}, { ...PROJECT, agentes: { usa: ['agy'] } }).io), /no est\u00E1 en agentes\.usa/)
    const blocked = { ...PROJECT, guardia: { bloquear: [{ agente: 'agy', hasta: '2999-01-01', motivo: 'paused' }] } }
    await assert.rejects(reboteCommand({}, '12', bounceEnv(pr(), {}, blocked).io), /paused/)
    await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ body: 'Implementador: codex-cc' })).io), /preguntarle al humano/)
  })

  test('issue 236 Rules 1 and 5: rebote relaunches a codex author with only the Fast mode flag added', async () => {
    const env = bounceEnv(pr({ body: 'Implementador: codex' }))
    await reboteCommand({ dryRun: true }, '12', env.io)
    assert.equal(env.out.find(line => line.startsWith('Lanzador (codex):')), `Lanzador (codex): ${codexLauncher()}`)
  })

  test('Rule 9: refuses missing Implementador marker', async () => {
    await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ body: 'no author' })).io), /no tiene la l\u00EDnea "Implementador/)
  })

  test('Rule 10: Pi bounce uses a fresh session id', async () => {
    const env = bounceEnv(pr({ body: 'Implementador: pi' }))
    env.io.gentleSkills = () => 'C:\\pi\\skills'
    env.io.now = () => 100
    env.io.modifiedAt = () => 101
    await reboteCommand({}, '12', env.io)
    const launch = env.calls.find(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'create')
    assert.match(launch[launch.indexOf('--command') + 1], /--session-id proj-pr-12-rebote-100/)
    const stale = bounceEnv(pr({ body: 'Implementador: pi' }))
    stale.io.gentleSkills = () => 'C:\\pi\\skills'
    stale.io.now = () => 100
    stale.io.modifiedAt = () => 99
    await assert.rejects(reboteCommand({}, '12', stale.io), /No observ\u00E9 una sesi\u00F3n nueva de Pi/)
    assert.ok(!stale.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'comment'))
  })

  test('Rule 5: bounce briefs restrict arena/swarm, not the agent\'s own subagents', async () => {
    for (const agent of ['claude', 'codex', 'codex-cc', 'agy', 'pi']) {
      const env = bounceEnv(pr({ body: `Implementador: ${agent}` }))
      if (agent === 'pi') {
        env.io.gentleSkills = () => 'C:\\pi\\skills'
        env.io.now = () => 100
        env.io.modifiedAt = () => 101
      }
      await reboteCommand(agent === 'codex-cc' ? { confirmado: true } : {}, '12', env.io)
      const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
      assert.ok(brief, `${agent} bounce brief was written`)
      assert.doesNotMatch(brief, /Do not spawn subagents/i)
      if (agent === 'claude') {
        assert.match(brief, /No arena or swarm is authorized without an approved note/i)
        assert.match(brief, /unrequested.*arena or swarm fan-out/i)
      } else {
        assert.match(brief, new RegExp(`Arena and swarm are not supported for ${agent}, even when the note includes authorization`))
      }
    }
  })

  test('Rule 5: a bounce fan-out note requires a new human OK', async () => {
    const env = bounceEnv(pr({ body: 'Implementador: claude' }))
    await reboteCommand({ nota: 'arena, N=3, r\u00FAbrica \u2026, Agent tool only' }, '12', env.io)
    const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
    assert.match(brief, /new human OK[\s\S]*previous dispatch approval does not carry over/i)
    assert.match(brief, /arena, N=3, r\u00FAbrica \u2026, Agent tool only/)
    assert.match(brief, /the approved N, one round, no retry/)
  })

  test('Rule 7: rebote keeps its ordinary brief and refusal behavior without a new note', async () => {
    const env = bounceEnv(pr({ body: 'Implementador: claude' }))
    await reboteCommand({}, '12', env.io)
    const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
    assert.match(brief, /## Review findings/)
    assert.match(brief, /## Failed checks/)
    assert.match(brief, /No arena or swarm is authorized/)
    const refused = bounceEnv(pr({ reviews: [] }))
    await assert.rejects(reboteCommand({}, '12', refused.io), /no tiene un review bloqueante vigente/)
  })

  test('Rule 11: launch failure does not post a Rebote marker', async () => {
    const env = bounceEnv()
    const original = env.io.sh
    env.io.sh = (cmd, args, opts) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create' ? { status: 1, stdout: '', stderr: 'launch failed' } : original(cmd, args, opts)
    await assert.rejects(reboteCommand({}, '12', env.io), /launch failed/)
    assert.ok(!env.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'comment'))
  })

  test('Rule 1: failed CheckRuns and StatusContexts relaunch with each failed check and a CI marker', async () => {
    const checks = [
      { __typename: 'CheckRun', name: 'Windows / Node 20', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/456' },
      { __typename: 'CheckRun', name: 'Timed out job', status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/458' },
      { __typename: 'CheckRun', name: 'Startup failure', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE', detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/459' },
      { __typename: 'CheckRun', name: 'Action required', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED', detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/460' },
      { __typename: 'StatusContext', context: 'failed status', state: 'FAILURE', targetUrl: 'https://ci.example.test/failure/1' },
      { __typename: 'StatusContext', context: 'lint', state: 'ERROR', targetUrl: 'https://ci.example.test/lint/1' },
      { __typename: 'CheckRun', name: 'Passing job', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'Neutral job', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { __typename: 'CheckRun', name: 'Skipped job', status: 'COMPLETED', conclusion: 'SKIPPED', detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/457' },
    ]
    const env = bounceEnv(pr({ reviews: [], statusCheckRollup: checks }))
    await reboteCommand({}, '12', env.io)
    const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
    assert.match(brief, /Windows \/ Node 20[\s\S]*https:\/\/github\.com\/org\/repo\/actions\/runs\/123\/job\/456[\s\S]*gh run view --job 456 --log-failed/)
    assert.match(brief, /lint[\s\S]*https:\/\/ci\.example\.test\/lint\/1/)
    assert.match(brief, /failed status[\s\S]*https:\/\/ci\.example\.test\/failure\/1/)
    assert.match(brief, /Startup failure/)
    assert.match(brief, /Action required/)
    assert.doesNotMatch(brief, /Skipped job/)
    assert.doesNotMatch(brief, /Passing job|Neutral job/)
    assert.ok(env.calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'view').some(arg => arg.includes('statusCheckRollup')))
    assert.equal(env.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote CI: abc123\n')
  })

  test('Rule 2: red CI and a current blocking review relaunch once and post both markers', async () => {
    const env = bounceEnv(pr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit tests', status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: 'https://github.com/org/repo/actions/runs/321/job/654' }] }))
    await reboteCommand({}, '12', env.io)
    const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
    assert.match(brief, /fix it/)
    assert.match(brief, /unit tests/)
    assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'create').length, 1)
    assert.equal(env.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote: abc123\nRebote CI: abc123\n')
  })

  test('Rule 3: pending checks refuse before relaunch even with a blocking review', async () => {
    const env = bounceEnv(pr({ statusCheckRollup: [
      { __typename: 'CheckRun', name: 'still running', status: 'IN_PROGRESS' },
      { __typename: 'StatusContext', context: 'queued context', state: 'PENDING' },
    ] }))
    await assert.rejects(reboteCommand({}, '12', env.io), /esper[aá].*CI|CI.*pendiente/i)
    assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
  })

  test('Rule 4: cancelled CI refuses with a rerun command even if another check failed', async () => {
    const checks = [
      { __typename: 'CheckRun', name: 'cancelled job', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/org/repo/actions/runs/987/job/111' },
      { __typename: 'CheckRun', name: 'ci-ok', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/org/repo/actions/runs/987/job/222' },
    ]
    const env = bounceEnv(pr({ statusCheckRollup: checks }))
    await assert.rejects(reboteCommand({}, '12', env.io), /gh run rerun 987 --failed/)
    assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
  })

  test('Rule 5: two prior distinct CI bounces reach the human, while the current sha retry is allowed', async () => {
    const exhausted = bounceEnv(pr({ reviews: [], statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', conclusion: 'FAILURE' }], comments: [{ body: 'Rebote CI: old1\nRebote CI: old2' }] }))
    await assert.rejects(reboteCommand({}, '12', exhausted.io), /dos rebotes de CI.*humano/i)
    assert.equal(exhausted.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)

    const sameSha = bounceEnv(pr({ reviews: [], statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', conclusion: 'FAILURE' }], comments: [{ body: 'Rebote CI: old1' }, { body: 'Rebote CI: abc123' }] }))
    await reboteCommand({}, '12', sameSha.io)
    assert.equal(sameSha.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote CI: abc123\n')
  })

  test('Rule 6: CI markers do not consume a later review bounce on a new head', async () => {
    const env = bounceEnv(pr({ headRefOid: 'def456', reviews: [{ body: 'Commit: def456\n## BLOQUEA\n1. finding' }], comments: [{ body: 'Rebote CI: abc123' }] }))
    await reboteCommand({}, '12', env.io)
    assert.equal(env.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote: def456\n')
  })

  test('Rule 7: no failed checks and no current blocker keeps the existing refusal', async () => {
    const env = bounceEnv(pr({ reviews: [], statusCheckRollup: [{ __typename: 'CheckRun', name: 'passing', status: 'COMPLETED', conclusion: 'SUCCESS' }] }))
    await assert.rejects(reboteCommand({}, '12', env.io), /no tiene un review bloqueante vigente/)
    assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
    const noChecks = bounceEnv(pr({ reviews: [], statusCheckRollup: [] }))
    await assert.rejects(reboteCommand({}, '12', noChecks.io), /no tiene un review bloqueante vigente/)
  })

  test('Rule 8: interpretation blockers do not prevent or enter a CI-only bounce', async () => {
    const env = bounceEnv(pr({ reviews: [{ body: 'Commit: abc123\n## BLOQUEA\n1. (inferida, interpretaci\u00F3n): product disagreement' }], statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', conclusion: 'FAILURE' }] }))
    await reboteCommand({}, '12', env.io)
    const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
    assert.doesNotMatch(brief, /product disagreement/)
    assert.match(brief, /unit/)
    assert.equal(env.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote CI: abc123\n')
  })

  test('Rule 9: failed launch does not post a CI marker', async () => {
    const env = bounceEnv(pr({ reviews: [], statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', conclusion: 'FAILURE' }] }))
    const original = env.io.sh
    env.io.sh = (cmd, args, opts) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create' ? { status: 1, stdout: '', stderr: 'launch failed' } : original(cmd, args, opts)
    await assert.rejects(reboteCommand({}, '12', env.io), /launch failed/)
    assert.ok(!env.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'comment'))
  })

  test('Rule 10 (#206): a CANCELLED ci-ok row that a later run replaced does not refuse; a latest CANCELLED row still does', async () => {
    const okRow = (conclusion, startedAt, run) => ({
      __typename: 'CheckRun', name: 'ci-ok', workflowName: 'CI', status: 'COMPLETED', conclusion, startedAt,
      detailsUrl: `https://github.com/org/repo/actions/runs/${run}/job/1`,
    })
    const replaced = bounceEnv(pr({ statusCheckRollup: [okRow('CANCELLED', '2026-10-15T10:00:00Z', 987), okRow('SUCCESS', '2026-10-15T10:30:00Z', 988)] }))
    await reboteCommand({}, '12', replaced.io)
    assert.equal(replaced.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote: abc123\n')

    const latest = bounceEnv(pr({ statusCheckRollup: [okRow('SUCCESS', '2026-10-15T10:00:00Z', 987), okRow('CANCELLED', '2026-10-15T10:30:00Z', 988)] }), { 'gh run': json([]) })
    await assert.rejects(reboteCommand({}, '12', latest.io), {
      message: 'El PR #12 tiene checks CANCELLED en abc123; no lo rebotes hasta volver a ejecutar CI:\nci-ok: gh run rerun 988 --failed',
    })
    assert.equal(latest.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
  })

  test('Issue 225 Rule 8: rebote treats a cancelled run with a higher listed run as pending and never suggests rerun', async () => {
    const cancelled = {
      __typename: 'CheckRun', name: 'ci-ok', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED',
      detailsUrl: 'https://github.com/org/repo/actions/runs/38843085964/job/1',
    }
    const replacement = [{ databaseId: 38843110472, status: 'queued', conclusion: null }]
    const replaced = bounceEnv(pr({ statusCheckRollup: [cancelled] }), { 'gh run': json(replacement) })
    await assert.rejects(reboteCommand({}, '12', replaced.io), {
      message: 'El PR #12 tiene una corrida nueva de CI en curso (38843110472) que reemplaza a la cancelada; esperá a que termine antes de rebotar.',
    })
    assert.ok(!replaced.out.some(line => line.includes('gh run rerun')))
    assert.equal(replaced.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)

    const unreplaced = bounceEnv(pr({ statusCheckRollup: [cancelled] }), { 'gh run': json([]) })
    await assert.rejects(reboteCommand({}, '12', unreplaced.io), {
      message: 'El PR #12 tiene checks CANCELLED en abc123; no lo rebotes hasta volver a ejecutar CI:\nci-ok: gh run rerun 38843085964 --failed',
    })

    const missing = bounceEnv(pr({ statusCheckRollup: [
      { __typename: 'CheckRun', name: 'matrix', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/org/repo/actions/runs/10/job/1' },
      { __typename: 'CheckRun', name: 'ci-ok', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/org/repo/actions/runs/11/job/1' },
    ] }))
    await assert.rejects(reboteCommand({}, '12', missing.io), /pendientes .*matrix/)

    const failed = bounceEnv(pr({ statusCheckRollup: [cancelled] }), { 'gh run': { status: 1, stdout: '', stderr: 'temporary failure' } })
    await assert.rejects(reboteCommand({}, '12', failed.io), /gh run list.*temporary failure/)
    assert.equal(failed.written.length, 0)
    assert.equal(failed.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
  })

  test('Issue 240 Rule 4: rebote bounces a real failure and lists cancelled siblings as following from it', async () => {
    const checks = [
      {
        __typename: 'CheckRun', name: 'ubuntu-latest / Node 20', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE',
        startedAt: '2026-10-15T10:00:05Z', completedAt: '2026-10-15T10:00:40Z',
        detailsUrl: 'https://github.com/org/repo/actions/runs/999/job/1',
      },
      {
        __typename: 'CheckRun', name: 'ubuntu-latest / Node 22', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED',
        startedAt: '2026-10-15T10:00:05Z', completedAt: '2026-10-15T10:00:41Z',
        detailsUrl: 'https://github.com/org/repo/actions/runs/999/job/2',
      },
      {
        __typename: 'CheckRun', name: 'windows-latest / Node 20', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED',
        startedAt: '2026-10-15T10:00:05Z', completedAt: '2026-10-15T10:00:41Z',
        detailsUrl: 'https://github.com/org/repo/actions/runs/999/job/3',
      },
    ]
    const env = bounceEnv(pr({ reviews: [], statusCheckRollup: checks }), { 'gh run': json([]) })
    await reboteCommand({}, '12', env.io)
    const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
    assert.match(brief, /ubuntu-latest \/ Node 20/)
    assert.match(brief, /https:\/\/github\.com\/org\/repo\/actions\/runs\/999\/job\/1/)
    assert.match(brief, /gh run view --job 1 --log-failed/)
    assert.match(brief, /Cancelled siblings.*ubuntu-latest \/ Node 22, windows-latest \/ Node 20/)
    assert.equal(env.written.find(([file]) => file.endsWith('-comment.md'))?.[1], 'Rebote CI: abc123\n')
  })

  test('Issue 240 PRESERVE: reboteCommand retains rerun refusal when cancellation has no real failure', async () => {
    const checks = [
      {
        __typename: 'CheckRun', name: 'matrix-job', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED',
        startedAt: '2026-10-15T02:57:40Z', completedAt: '2026-10-15T02:58:16Z',
        detailsUrl: 'https://github.com/org/repo/actions/runs/38843085964/job/1',
      },
      {
        __typename: 'CheckRun', name: 'ci-ok', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE',
        startedAt: '2026-10-15T02:59:09Z', completedAt: '2026-10-15T02:59:15Z',
        detailsUrl: 'https://github.com/org/repo/actions/runs/38843085964/job/2',
      },
    ]
    const env = bounceEnv(pr({ statusCheckRollup: checks }), { 'gh run': json([]) })
    await assert.rejects(reboteCommand({}, '12', env.io), {
      message: 'El PR #12 tiene checks CANCELLED en abc123; no lo rebotes hasta volver a ejecutar CI:\nmatrix-job: gh run rerun 38843085964 --failed',
    })
  })

  test('Issue 225 PRESERVE: reboteCommand retains existing arguments, refusals and Rebote CI counters', async () => {
    const closed = bounceEnv(pr({ state: 'CLOSED' }))
    await assert.rejects(reboteCommand({}, '12', closed.io), /no se puede rebotar/)

    const nonExistentReview = bounceEnv(pr({ reviews: [] }))
    await assert.rejects(reboteCommand({}, '12', nonExistentReview.io), /no tiene un review bloqueante vigente/)

    const twoCiBounces = bounceEnv(pr({
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', conclusion: 'FAILURE' }],
      reviews: [
        { body: 'Rebote CI: oldsha1' },
        { body: 'Rebote CI: oldsha2' },
      ],
    }))
    await assert.rejects(reboteCommand({}, '12', twoCiBounces.io), /dos rebotes de CI distintos.*humano/i)
  })

  test('Rule 10: existing worktree guards still apply to a CI bounce', async () => {
    const env = bounceEnv(pr({ reviews: [], statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', conclusion: 'FAILURE' }] }), { 'git status': okRes(' M src/app.mjs\n') })
    await assert.rejects(reboteCommand({}, '12', env.io), /worktree .* est[aá] sucio/)
    assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
  })

  test('CLI help and bounce brief describe CI findings and safe repair rules', () => {
    const cli = readFileSync(path.join(PACKAGE_ROOT, 'src', 'cli.mjs'), 'utf8')
    const brief = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'brief-rebote.md'), 'utf8')
    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'CONTRATO.md'), 'utf8')
    assert.match(cli, /rebote\s+Relanza al autor de un PR bloqueado o con CI roja/i)
    assert.match(brief, /## Failed checks/)
    assert.match(brief, /do not delete, skip or weaken a test/i)
    assert.match(brief, /do not edit `\.github\/workflows\/`/i)
    assert.match(contract, /rebote.*CI roja/i)
    assert.match(contract, /gh run view.*--log-failed/i)
    assert.match(contract, /gh run rerun.*--failed/i)
  })

  describe('BLOQUEA section boundary (issue #105)', () => {
    test('Rule 1: review with findings 1 and 2 separated by newlines followed by SUGERENCIAS includes both findings in brief', async () => {
      const env = bounceEnv(pr({
        reviews: [{
          body: 'Revisor: codex\nCommit: abc123\n\n## BLOQUEA\n1. first blocker\n2. second blocker\n\n## SUGERENCIAS\nsuggestion text',
          url: 'https://example.test/review/1',
        }],
      }))
      await reboteCommand({}, '12', env.io)
      const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
      assert.match(brief, /1\. first blocker/)
      assert.match(brief, /2\. second blocker/)
      assert.ok(!brief.includes('SUGERENCIAS'))
      assert.ok(!brief.includes('suggestion text'))
    })

    test('Rule 2: BLOQUEA as last section with three findings and trailing newline includes all three in brief', async () => {
      const env = bounceEnv(pr({
        reviews: [{
          body: 'Revisor: codex\nCommit: abc123\n\n## BLOQUEA\n1. first finding\n2. second finding\n3. third finding\n',
          url: 'https://example.test/review/2',
        }],
      }))
      await reboteCommand({}, '12', env.io)
      const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
      assert.match(brief, /1\. first finding/)
      assert.match(brief, /2\. second finding/)
      assert.match(brief, /3\. third finding/)
    })

    test('Rule 3: interpretación finding on line 2 of section causes rebote to refuse and list it', async () => {
      const env = bounceEnv(pr({
        reviews: [{
          body: 'Revisor: codex\nCommit: abc123\n\n## BLOQUEA\n1. first mechanical finding\n2. `src/x.js:5` (inferida, interpretaci\u00F3n): product disagreement\n\n## SUGERENCIAS\n(none)',
          url: 'https://example.test/review/3',
        }],
      }))
      await assert.rejects(reboteCommand({}, '12', env.io), /Los bloqueos de interpretaci[o\u00F3]n van al humano[\s\S]*product disagreement/)
      assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal').length, 0)
    })

    test('Rule 4: BLOQUEA followed by nada and then SUGERENCIAS with text is not blocking', async () => {
      const env = bounceEnv(pr({
        reviews: [{
          body: 'Revisor: codex\nCommit: abc123\n\n## BLOQUEA\nnada\n\n## SUGERENCIAS\nconsider refactoring helper\n',
          url: 'https://example.test/review/4',
        }],
      }))
      await assert.rejects(reboteCommand({}, '12', env.io), /no tiene un review bloqueante vigente/)
    })

    test('Rule 5: finding with ## in middle of line is kept whole and does not terminate section prematurely', async () => {
      const env = bounceEnv(pr({
        reviews: [{
          body: 'Revisor: codex\nCommit: abc123\n\n## BLOQUEA\n1. check docs under `## Desv\u00EDos del ticket` in PR\n2. next line finding\n\n## SUGERENCIAS\nother suggestions',
          url: 'https://example.test/review/5',
        }],
      }))
      await reboteCommand({}, '12', env.io)
      const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
      assert.match(brief, /under `## Desv\u00EDos del ticket` in PR/)
      assert.match(brief, /2\. next line finding/)
      assert.ok(!brief.includes('other suggestions'))
    })

    test('Rule 6: CRLF line endings produce same results as LF', async () => {
      const env = bounceEnv(pr({
        reviews: [{
          body: 'Revisor: codex\r\nCommit: abc123\r\n\r\n## BLOQUEA\r\n1. first crlf finding\r\n2. second crlf finding\r\n\r\n## SUGERENCIAS\r\ncrlf suggestion\r\n',
          url: 'https://example.test/review/6',
        }],
      }))
      await reboteCommand({}, '12', env.io)
      const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
      assert.match(brief, /1\. first crlf finding/)
      assert.match(brief, /2\. second crlf finding/)
      assert.ok(!brief.includes('crlf suggestion'))
    })

    test('PRESERVE: reboteCommand retains existing single-finding blocker bounce behavior', async () => {
      const env = bounceEnv(pr({
        reviews: [{
          body: 'Revisor: codex\nCommit: abc123\n\n## BLOQUEA\n1. `src/app.mjs:1` (introducido, concreta, implementaci\u00F3n): fix it.\n\n## SUGERENCIAS\n(none)',
          url: 'https://example.test/review/1',
        }],
      }))
      await reboteCommand({}, '12', env.io)
      const brief = env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
      assert.match(brief, /1\. `src\/app\.mjs:1`.*fix it\./)
      assert.ok(env.written.some(([file]) => file.endsWith('-comment.md')))
    })
  })

  describe('issue #165: worker questions in briefs', () => {
    test('Rule 5: The brief despachar renders for every implementing agent carries the Consulta: line and the re-read line, and the bounce brief names the PR as the place to ask', () => {
      for (const agent of ['claude', 'codex', 'agy', 'pi']) {
        const brief = renderBrief('ticket', { AGENT: agent, ISSUE: '165', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
        assert.ok(brief.includes(`Consulta: ${agent}`), `${agent} brief must carry Consulta: ${agent}`)
        assert.ok(brief.includes('Before opening the PR, re-read the issue comments and handle any `Respuesta de main:` / `Respuesta del humano:`.'), `${agent} brief must carry the re-read line`)
      }
      const bounceBrief = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'brief-rebote.md'), 'utf8')
      assert.match(bounceBrief, /ask.*`Consulta:`.*PR/i, 'bounce brief must name the PR as the place to ask with Consulta:')
    })

    test('Rule 6: The review brief does not change', () => {
      const reviewBrief = readFileSync(path.join(PACKAGE_ROOT, 'assets', 'stack', 'brief-revision.md'), 'utf8')
      assert.ok(!reviewBrief.includes('Consulta:'), 'review brief must not mention Consulta:')
      assert.ok(!reviewBrief.includes('Respuesta de main:'), 'review brief must not mention Respuesta de main:')
      assert.ok(!reviewBrief.includes('Respuesta del humano:'), 'review brief must not mention Respuesta del humano:')
    })

    test("Rule 8: Brief rendering and despachar's refusals behave as before for every agent", async () => {
      for (const agent of ['claude', 'codex', 'agy', 'pi']) {
        const brief = renderBrief('ticket', { AGENT: agent, ISSUE: '165', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
        assert.ok(brief.startsWith('# Ticket brief: issue #165 (orca-stack)'))
        assert.ok(brief.includes('## Setup'))
        assert.ok(brief.includes('## Verification'))
        assert.ok(brief.includes('## Pull request'))
        assert.ok(brief.includes('## Rules'))
        assert.ok(brief.includes('## Remote authorization'))
        assert.ok(brief.includes('## Method: gentle-ai ODD'))
      }
      await assert.rejects(
        () => dispatch('ticket', { n: '165', agent: 'unknown' }),
        /Agente desconocido: unknown/,
      )
    })
  })

  describe('issue #224: ticket brief before the PR', () => {
    const fanoutNote = 'arena, N=3, r\u00FAbrica \u2026, Agent tool only'
    const ticketBrief = (agent, nota) => renderBrief('ticket', { AGENT: agent, ISSUE: '300', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' }, nota)
    const subagentsScope = "for ODD's explorer and verifier and for the code-review rounds of ## Pull request, and for nothing else, except an arena or swarm fan-out that the Fan-out line under ## Rules allows."
    const fanoutLine = (agent, bounce) => {
      const approval = bounce ? 'A new fan-out note on this bounce requires a new human OK; previous dispatch approval does not carry over. ' : ''
      return agent === 'claude'
        ? `- Fan-out: ${approval}No arena or swarm is authorized without an approved note. Do not use Workflow or run an unrequested arena or swarm fan-out.`
        : `- Fan-out: ${approval}Arena and swarm are not supported for ${agent}, even when the note includes authorization. Do not run an arena or swarm fan-out.`
    }

    test('Rule 1: every check finishes before the PR opens and no code-review instruction is left below gh pr create', () => {
      for (const agent of AGENTS) {
        const brief = ticketBrief(agent)
        const create = brief.indexOf('gh pr create --base')
        const before = brief.slice(brief.indexOf('## Pull request'), create)
        assert.ok(before.includes('Every check runs and finishes before the PR opens: the configured verification, any verifier ODD launches, and the code-review rounds below.'), agent)
        assert.ok(before.includes('Before opening the PR, run the `code-review` skill'), agent)
        assert.doesNotMatch(brief.slice(create), /code-review/i, `${agent}: a code-review instruction is left below gh pr create`)
      }
    })

    test('Rule 2: opening the PR is the last change to the branch', () => {
      const after = ticketBrief('claude').split('gh pr create --base main --head branch')[1]
      assert.ok(after.includes('Opening the PR is the last change to the branch: after `gh pr create`, write your final summary and end your turn. Push again only when main relaunches you with `orca-stack rebote` or `orca-stack reanudar`.'))
    })

    test('Rule 3: the Evidencia table comes first, then at most two code-review rounds, all before the PR', () => {
      const brief = ticketBrief('codex')
      const steps = [
        '1. Write the PR body file (shape below) with its Evidencia table: one row per rule of `## Reglas` and per touched public entry, each naming its test.',
        "2. Before opening the PR, run the `code-review` skill on the diff as round 1, with that table and the issue as input: besides the diff, it checks that every rule has a row and that the row's test proves that rule.",
        '3. Fix what round 1 found.',
        '4. Run round 2 only when round 1 led to a change of code or tests, and only on the delta since round 1. A reviewer always asks for something, so "it asked for changes" is never the reason for another round.',
        '5. There is no round 3: what round 2 leaves open goes under `## Desv\u00EDos del ticket`.',
      ].map(step => brief.indexOf(step))
      assert.ok(steps.every(index => index > -1), JSON.stringify(steps))
      assert.deepEqual([...steps].sort((a, b) => a - b), steps)
      assert.ok(steps[4] < brief.indexOf('gh pr create --base'))
    })

    test('Rule 4: one subagents line rendered per agent, and fanoutInstructions no longer repeats it', () => {
      const perAgent = {
        claude: `- Subagents: you may use your session's subagents (the Agent tool) ${subagentsScope} Dispatching Orca workers is not allowed.`,
        codex: `- Subagents: you may use your session's subagents (\`spawn_agent\`) ${subagentsScope} Dispatching Orca workers is not allowed. This line is the explicit request to spawn agents that your default asks for.`,
      }
      const others = `- Subagents: when your runtime has subagents, you may use your session's subagents ${subagentsScope} Dispatching Orca workers is not allowed. When it has none, do those steps inline and note it under ## Desv\u00EDos del ticket.`
      for (const agent of AGENTS) {
        for (const nota of [undefined, fanoutNote]) {
          const brief = ticketBrief(agent, nota)
          assert.ok(brief.includes(perAgent[agent] ?? others), `${agent} subagents line`)
          assert.equal(brief.match(/session's (?:own )?subagents/g)?.length, 1, `${agent}: the session's subagents sentence appears once`)
        }
        assert.ok(ticketBrief(agent).includes(fanoutLine(agent, false)), `${agent} fan-out line`)
      }
      assert.ok(ticketBrief('claude', fanoutNote).includes('- Fan-out: The approved note authorizes fan-out for this ticket only. Use the Agent tool only, never Workflow. Run only the approved N, one round, no retry.'))
    })

    test('Rule 5: a verifier copies the commit with git clone --local, never git archive or git worktree add', () => {
      const verification = ticketBrief('pi').split('## Verification')[1].split('## Pull request')[0]
      assert.ok(verification.includes('When a verifier or a review subagent needs the commit in its own directory, copy it with `git clone --local --no-checkout <worktree> <dir>` and `git -C <dir> checkout --detach <sha>`, with `<dir>` outside this worktree, and delete `<dir>` afterwards.'))
      assert.ok(verification.includes("If `<dir>` cannot be deleted (on Windows the clone's packs are read-only and may be hard links), that does not block: note it in your final summary."))
      assert.ok(verification.includes('Do not use `git archive` (it leaves no git index, and tests that need one fail without a defect) or `git worktree add` (it adds a worktree that Orca lists and someone has to remove).'))
    })

    test("Rule 6: claude, codex and pi are told AGENTS.md is already loaded; agy and codex-cc keep today's line", () => {
      const today = '- Read the project instructions (AGENTS.md, and GLOSSARY.md or CONTEXT.md and docs/adr when they exist).'
      const loaded = '- AGENTS.md is already in your context: do not read it again. Read GLOSSARY.md or CONTEXT.md and docs/adr when they exist.'
      for (const agent of AGENTS) {
        const brief = ticketBrief(agent)
        const expected = ['claude', 'codex', 'pi'].includes(agent) ? loaded : today
        assert.ok(brief.includes(expected), `${agent}: ${expected}`)
        assert.ok(!brief.includes(expected === loaded ? today : loaded), agent)
      }
    })

    test('Rule 7: the PR body is UTF-8 without a BOM and the brief names the PowerShell trap', () => {
      assert.ok(ticketBrief('agy').includes("The body is UTF-8 without a BOM (Windows PowerShell's `Out-File` and `Set-Content -Encoding utf8` write one) and has exactly this shape."))
    })

    test('Rule 8: despachar renders a ticket brief for every agent; the rebote and revisar briefs change only in the fanoutInstructions sentence', async () => {
      for (const agent of AGENTS) {
        const env = fakeIo()
        await run('ticket', { n: '300', agent, dryRun: true, ...(agent === 'codex-cc' ? { confirmado: true } : {}) }, env)
        const out = env.out.join('\n')
        assert.ok(out.includes('# Ticket brief: issue #300'), `${agent} ticket brief`)
        assert.ok(out.includes("- Subagents: "), `${agent} subagents line`)
        assert.ok(!out.includes('{{'), `${agent}: placeholder left`)

        const bounce = bounceEnv(pr({ body: `Implementador: ${agent}` }))
        if (agent === 'pi') {
          bounce.io.gentleSkills = () => 'C:\\pi\\skills'
          bounce.io.now = () => 100
          bounce.io.modifiedAt = () => 101
        }
        await reboteCommand(agent === 'codex-cc' ? { confirmado: true } : {}, '12', bounce.io)
        const bounceBrief = bounce.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
        assert.ok(bounceBrief.includes(`${fanoutLine(agent, true)}\n- Work only in this existing worktree`), `${agent} bounce fan-out line`)
        assert.doesNotMatch(bounceBrief, /session's (?:own )?subagents|AGENTS\.md is already/, agent)
      }
      const review = fakeIo({ 'gh pr': json({ headRefName: 'feat', headRefOid: 'abc123', body: 'Implementador: codex', number: 9 }) })
      await run('review', { n: '9', agent: 'agy', dryRun: true }, review)
      const reviewOut = review.out.join('\n')
      assert.ok(reviewOut.includes('Revisor: agy'), 'review brief rendered')
      assert.doesNotMatch(reviewOut, /- Subagents: |AGENTS\.md is already|Every check runs and finishes/)
    })
  })

  describe('issue 250: merge conflict bounce', () => {
    const conflicting = (overrides = {}) => pr({ reviews: [], mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', baseRefName: 'main', ...overrides })
    const mergeTree = { status: 1, stdout: '4b825dc642cb6eb9a060e54bf8d69288fbee4904\0docs/manual.md\0src/despacho.mjs\0', stderr: '' }
    const baseLog = okRes('dfc7ad2 Merge pull request #248\ndec52eb docs(manual): rebote paragraph\n')
    const conflictEnv = (pull = conflicting(), extra = {}) => bounceEnv(pull, { 'git merge-tree': mergeTree, 'git log': baseLog, ...extra })
    const briefOf = env => env.written.find(([file]) => file.endsWith('proj-pr-12-rebote.md'))?.[1]
    const markerOf = env => env.written.find(([file]) => file.endsWith('-comment.md'))?.[1]
    const launches = env => env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal')
    const commented = env => env.calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'comment')

    test('Rule 1: a conflicting PR with green or missing CI and no blocking review is relaunched (#246 after #248)', async () => {
      for (const statusCheckRollup of [[{ __typename: 'CheckRun', name: 'ci-ok', status: 'COMPLETED', conclusion: 'SUCCESS' }], []]) {
        const env = conflictEnv(conflicting({ statusCheckRollup }))
        await reboteCommand({}, '12', env.io)
        const view = env.calls.find(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'view')
        for (const field of ['mergeable', 'mergeStateStatus', 'baseRefName']) assert.ok(view[view.indexOf('--json') + 1].split(',').includes(field), field)
        assert.equal(env.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'create').length, 1)
        assert.equal(markerOf(env), 'Rebote conflicto: abc123\n')
      }
    })

    test('Rule 2: the brief gets a Merge conflict section with the base, the merge steps, the files and the base commits', async () => {
      const env = conflictEnv()
      await reboteCommand({}, '12', env.io)
      const section = briefOf(env).split('## Merge conflict')[1]?.split(/\n## /)[0] ?? ''
      assert.ok(section.includes('`main`'), 'names the base branch')
      for (const step of ['git fetch origin', 'git merge origin/main', 'never rebase', 'never force push', 'Push', 'Comment on PR #12']) assert.ok(section.includes(step), step)
      assert.match(section, /run the configured verification/i)
      assert.match(section, /how each conflicting file was resolved/)
      assert.match(section, /- `docs\/manual\.md`\n- `src\/despacho\.mjs`/)
      assert.match(section, /dfc7ad2 Merge pull request #248\ndec52eb docs\(manual\): rebote paragraph/)
      const log = env.calls.find(call => call[0] === 'git' && call[1] === 'log')
      assert.deepEqual(log.slice(1), ['log', '--oneline', 'abc123..origin/main', '--', 'docs/manual.md', 'src/despacho.mjs'])
      assert.ok(env.calls.some(call => call.join(' ') === 'git fetch origin main'))
      assert.ok(env.calls.find(call => call[0] === 'git' && call[1] === 'merge-tree').includes('-z'))

      const noLog = conflictEnv(conflicting(), { 'git log': { status: 128, stdout: '', stderr: 'fatal: bad revision' } })
      await reboteCommand({}, '12', noLog.io)
      const partial = briefOf(noLog).split('## Merge conflict')[1].split(/\n## /)[0]
      assert.match(partial, /- `docs\/manual\.md`\n- `src\/despacho\.mjs`/)
      assert.match(partial, /could not compute the base commits/)

      const unknown = conflictEnv(conflicting(), { 'git merge-tree': { status: 128, stdout: '', stderr: 'fatal: unknown option' } })
      await reboteCommand({}, '12', unknown.io)
      const fallback = briefOf(unknown).split('## Merge conflict')[1].split(/\n## /)[0]
      assert.match(fallback, /could not compute the conflicting files/)
      assert.doesNotMatch(fallback, /docs\/manual\.md/)
      assert.equal(markerOf(unknown), 'Rebote conflicto: abc123\n')
    })

    test('Rule 3: a conflict bounce allows git fetch origin; other bounces keep their remote operations', async () => {
      const env = conflictEnv()
      await reboteCommand({}, '12', env.io)
      const ops = briefOf(env).split('- Operations: ')[1].split('\n')[0]
      assert.match(ops, /`git fetch origin` \(the base branch `main`\)/)
      const review = bounceEnv(pr())
      await reboteCommand({}, '12', review.io)
      assert.doesNotMatch(briefOf(review).split('- Operations: ')[1].split('\n')[0], /git fetch/)
    })

    test('Rule 4: Rebote conflicto is published only after the author starts', async () => {
      const env = conflictEnv()
      await reboteCommand({}, '12', env.io)
      const launch = env.calls.findIndex(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'send')
      const comment = env.calls.findIndex(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'comment')
      assert.ok(launch > -1 && comment > launch)
      assert.ok(env.out.includes('Rebote conflicto: abc123'))

      const failed = conflictEnv()
      const original = failed.io.sh
      failed.io.sh = (cmd, args, opts) => cmd === 'orca' && args[0] === 'terminal' && args[1] === 'create' ? { status: 1, stdout: '', stderr: 'launch failed' } : original(cmd, args, opts)
      await assert.rejects(reboteCommand({}, '12', failed.io), /launch failed/)
      assert.ok(!commented(failed))
    })

    test('Rule 5: UNKNOWN mergeability refuses with the next step and launches and publishes nothing', async () => {
      for (const pull of [pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', baseRefName: 'main' }), conflicting({ mergeable: 'UNKNOWN' })]) {
        const env = conflictEnv(pull)
        await assert.rejects(reboteCommand({}, '12', env.io), /GitHub todavía está calculando si el PR #12 se puede mergear; repetí el comando/)
        assert.equal(launches(env).length, 0)
        assert.ok(!commented(env))
        assert.equal(env.written.length, 0)
      }
    })

    test('Rule 6: a PR that is only behind, with no blocker and green CI, is refused pointing to gh pr update-branch', async () => {
      const env = bounceEnv(pr({ reviews: [], mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', baseRefName: 'main', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci-ok', status: 'COMPLETED', conclusion: 'SUCCESS' }] }))
      await assert.rejects(reboteCommand({}, '12', env.io), /no tiene un review bloqueante vigente[\s\S]*gh pr update-branch 12/)
      assert.equal(launches(env).length, 0)
    })

    test('Rule 7: pending or cancelled checks do not refuse a conflict bounce; failed head checks join the brief', async () => {
      const pending = conflictEnv(conflicting({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'old head job', status: 'IN_PROGRESS' }] }))
      await reboteCommand({}, '12', pending.io)
      assert.match(briefOf(pending), /## Failed checks\n\nNone\.\n/)
      assert.equal(markerOf(pending), 'Rebote conflicto: abc123\n')

      const cancelled = conflictEnv(conflicting({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci-ok', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/org/repo/actions/runs/987/job/1' }] }))
      await reboteCommand({}, '12', cancelled.io)
      assert.ok(!cancelled.calls.some(call => call[0] === 'gh' && call[1] === 'run'))
      assert.equal(markerOf(cancelled), 'Rebote conflicto: abc123\n')

      const red = conflictEnv(conflicting({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/org/repo/actions/runs/5/job/6' }] }))
      await reboteCommand({}, '12', red.io)
      assert.match(briefOf(red).split('## Failed checks')[1], /unit[\s\S]*gh run view --job 6 --log-failed/)
    })

    test('Rule 8: conflict plus review blockers or red CI on the head: one brief, every marker', async () => {
      const review = conflictEnv(conflicting({ reviews: pr().reviews }))
      await reboteCommand({}, '12', review.io)
      assert.match(briefOf(review), /fix it[\s\S]*## Merge conflict/)
      assert.equal(review.calls.filter(call => call[0] === 'orca' && call[1] === 'terminal' && call[2] === 'create').length, 1)
      assert.equal(markerOf(review), 'Rebote: abc123\nRebote conflicto: abc123\n')

      const red = conflictEnv(conflicting({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] }))
      await reboteCommand({}, '12', red.io)
      assert.match(briefOf(red), /unit[\s\S]*## Merge conflict/)
      assert.equal(markerOf(red), 'Rebote CI: abc123\nRebote conflicto: abc123\n')
    })

    test('Rule 9: conflict bounces have their own count and refuse a repeat on the same head', async () => {
      const spent = conflictEnv(conflicting({ comments: [{ body: 'Rebote: old1' }, { body: 'Rebote CI: old1\nRebote CI: old2' }, { body: 'Rebote conflicto: old1' }] }))
      await reboteCommand({}, '12', spent.io)
      assert.equal(markerOf(spent), 'Rebote conflicto: abc123\n')

      const again = conflictEnv(conflicting({ comments: [{ body: 'Rebote conflicto: old1' }, { body: 'Rebote conflicto: abc123' }] }))
      await assert.rejects(reboteCommand({}, '12', again.io), /ya rebotó por conflicto en abc123/)
      assert.equal(launches(again).length, 0)
      assert.ok(!commented(again))

      // Three PRs merged one by one: the last one is conflict-bounced on two different heads.
      const second = conflictEnv(conflicting({ headRefOid: 'def456', comments: [{ body: 'Rebote conflicto: abc123' }] }))
      await reboteCommand({}, '12', second.io)
      assert.equal(markerOf(second), 'Rebote conflicto: def456\n')

      // A conflict marker is not a review or CI bounce: later bounces on a new head still go through.
      const review = bounceEnv(pr({ headRefOid: 'def456', reviews: [{ body: 'Commit: def456\n## BLOQUEA\n1. finding' }], comments: [{ body: 'Rebote conflicto: abc123' }] }))
      await reboteCommand({}, '12', review.io)
      assert.equal(markerOf(review), 'Rebote: def456\n')
      const ci = bounceEnv(pr({ reviews: [], statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', conclusion: 'FAILURE' }], comments: [{ body: 'Rebote conflicto: old1' }, { body: 'Rebote conflicto: old2' }] }))
      await reboteCommand({}, '12', ci.io)
      assert.equal(markerOf(ci), 'Rebote CI: abc123\n')

      // The review limit still applies when the conflict comes with review blockers on a new head.
      const spentReview = conflictEnv(conflicting({ headRefOid: 'def456', reviews: [{ body: 'Commit: def456\n## BLOQUEA\n1. finding' }], comments: [{ body: 'Rebote: abc123' }] }))
      await assert.rejects(reboteCommand({}, '12', spentReview.io), /avanzó desde el rebote/)
      assert.equal(launches(spentReview).length, 0)
    })

    test('Rule 10: contract step 8 and the manual say how main merges after a conflict bounce', () => {
      const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets/stack/CONTRATO.md'), 'utf8')
      const agents = readFileSync(path.join(PACKAGE_ROOT, 'AGENTS.md'), 'utf8')
      const manual = readFileSync(path.join(PACKAGE_ROOT, 'docs/manual.md'), 'utf8')
      const rule = 'Después de un rebote por conflicto, el merge commit del autor es un push a mano: las líneas `Commit:` anteriores dejan de contar (paso 7 (b)) y main mergea con un review nuevo sobre el head nuevo o, fuera de `riesgo`, con `Verificado por main` escrito después de leer el diff de la resolución; en un PR que toca `riesgo`, los reviews del paso 6 se piden de nuevo sobre el head nuevo.'
      const step8 = text => text.split(/\r?\n/).find(line => line.startsWith('8. Un PR rebota una sola vez por review.')) ?? ''
      assert.ok(step8(contract).includes(rule))
      assert.ok(step8(agents).includes(rule))
      assert.ok(manual.includes(rule))
    })

    test('Rule 11: with the new fields on a non-conflicting PR, existing refusals and --dry-run keep their result', async () => {
      const clean = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main' }
      await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ ...clean, reviews: [] })).io), /no tiene un review bloqueante vigente en abc123\.$/)
      await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ ...clean, statusCheckRollup: [{ __typename: 'CheckRun', name: 'still running', status: 'IN_PROGRESS' }] })).io), /pendientes/)
      await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ ...clean, headRefOid: 'def456', comments: [{ body: 'Rebote: abc123' }] })).io), /avanzó desde el rebote/)
      for (const state of ['CLOSED', 'MERGED']) await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ ...clean, state })).io), /no se puede rebotar/)
      await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ ...clean, body: 'no author' })).io), /no tiene la línea "Implementador/)
      await assert.rejects(reboteCommand({}, '12', bounceEnv(pr(clean), { 'git status': okRes(' M src/app.mjs\n') }).io), /está sucio/)
      const diverged = bounceEnv(pr(clean), { 'git merge-base': { status: 1, stdout: '', stderr: '' } })
      const sh = diverged.io.sh
      diverged.io.sh = (cmd, args, opts) => cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD' ? okRes('other\n') : sh(cmd, args, opts)
      await assert.rejects(reboteCommand({}, '12', diverged.io), /no en el head del PR/)
      await assert.rejects(reboteCommand({}, '12', bounceEnv(pr(clean), { 'orca worktree': json({ result: { worktrees: [{ path: worktree, agents: [{ state: 'working' }] }] } }) }).io), /agente vivo/)
      await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ ...clean, reviews: [{ body: 'Commit: abc123\n## BLOQUEA\n1. (inferida, interpretación): product disagreement' }] })).io), /interpretación/)
      await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ ...clean, statusCheckRollup: [{ __typename: 'CheckRun', name: 'job', status: 'COMPLETED', conclusion: 'CANCELLED', detailsUrl: 'https://github.com/org/repo/actions/runs/987/job/1' }] })).io), /gh run rerun 987 --failed/)
      await assert.rejects(reboteCommand({}, '12', bounceEnv(pr({ ...clean, reviews: [], statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', conclusion: 'FAILURE' }], comments: [{ body: 'Rebote CI: old1\nRebote CI: old2' }] })).io), /dos rebotes de CI/)

      const plain = bounceEnv(pr(clean))
      await reboteCommand({ dryRun: true }, '12', plain.io)
      assert.ok(plain.out.some(line => line.includes('# PR bounce brief')))
      assert.ok(!plain.out.some(line => line.includes('## Merge conflict')))
      assert.ok(!plain.calls.some(call => call[0] === 'git' && (call[1] === 'merge-tree' || call.join(' ') === 'git fetch origin main')))
      assert.ok(plain.out.some(line => line.includes('[simulación] Rebote: abc123')))
      assert.equal(plain.written.length, 0)
      assert.ok(!commented(plain))

      const dry = conflictEnv()
      await reboteCommand({ dryRun: true }, '12', dry.io)
      assert.ok(dry.out.some(line => line.includes('## Merge conflict')))
      assert.ok(dry.calls.some(call => call.join(' ') === 'git fetch origin main'))
      assert.ok(dry.out.some(line => line.includes('[simulación] Rebote conflicto: abc123')))
      assert.equal(dry.written.length, 0)
      assert.ok(!commented(dry))
    })

    test('Rule 12: --help, the manual and the contract name the conflict source and the markers', () => {
      const cli = readFileSync(path.join(PACKAGE_ROOT, 'src/cli.mjs'), 'utf8')
      const help = cli.split('rebote: `orca-stack rebote')[1].split('`,\n')[0]
      assert.match(help, /conflicto/)
      assert.match(help, /Rebote conflicto: <sha>/)
      const manual = readFileSync(path.join(PACKAGE_ROOT, 'docs/manual.md'), 'utf8')
      const section = manual.split('#### `rebote`')[1].split('\n#### ')[0]
      assert.match(section, /Rebote conflicto: <sha>/)
      const table = manual.split('## 5. Casos borde')[1]
      assert.ok(table.split(/\r?\n/).some(line => line.startsWith('| PR en conflicto con la base') && line.includes('Rebote conflicto: <sha>')))
      for (const file of ['assets/stack/CONTRATO.md', 'AGENTS.md']) {
        const text = readFileSync(path.join(PACKAGE_ROOT, file), 'utf8')
        const markers = text.split(/\r?\n/).find(line => line.includes('son marcas fijas del protocolo')) ?? ''
        for (const marker of ['`Rebote: <sha>`', '`Rebote CI: <sha>`', '`Rebote conflicto: <sha>`']) assert.ok(markers.includes(marker), `${file}: ${marker}`)
        const step8 = text.split(/\r?\n/).find(line => line.startsWith('8. Un PR rebota una sola vez por review.')) ?? ''
        assert.match(step8, /conflicto con la base[\s\S]*Rebote conflicto: <sha>/, file)
      }
    })
  })

  describe('issue #249: local pre-check from verificacion.cuerpoPR', () => {
    test('Rule 1: local pre-check from config renders step 6 right before gh pr create with {file} replaced by <your body file>', async () => {
      const configWithPrecheck = {
        ...PROJECT,
        verificacion: {
          ...PROJECT.verificacion,
          cuerpoPR: 'node scripts/check-evidencia.mjs {file}',
        },
      }
      const env = fakeIo({}, { config: configWithPrecheck })
      await run('ticket', { n: '300', agent: 'claude', dryRun: true }, env)
      const out = env.out.join('\n')
      assert.ok(out.includes('node scripts/check-evidencia.mjs <your body file>'))
      assert.ok(out.includes('6. Run `node scripts/check-evidencia.mjs <your body file>` on your PR body file and fix the body until it passes.'))
      const step6Index = out.indexOf('6. Run `node scripts/check-evidencia.mjs <your body file>`')
      const createIndex = out.indexOf('gh pr create --base')
      const step5Index = out.indexOf('5. There is no round 3: what round 2 leaves open goes under `## Desv\u00EDos del ticket`.')
      assert.ok(step5Index < step6Index && step6Index < createIndex)
    })

    test('Rule 2: when verificacion.cuerpoPR is absent, no pre-check step and no empty placeholder or {{...}}', () => {
      const brief = renderBrief('ticket', { AGENT: 'claude', ISSUE: '300', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
      assert.ok(!brief.includes('6.'))
      assert.ok(!brief.includes('<your body file>'))
      assert.ok(!brief.includes('{{BODY_PRECHECK_STEP}}'))
      assert.ok(brief.includes('5. There is no round 3: what round 2 leaves open goes under `## Desv\u00EDos del ticket`.\n\nWhen the work is done and verified, push the branch and open the PR with a body file'))
    })

    test('Preserve touched public entries in despacho: renderBrief and dispatch retain behavior', async () => {
      const ticketBrief = renderBrief('ticket', { AGENT: 'agy', ISSUE: '300', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
      assert.ok(ticketBrief.includes('# Ticket brief: issue #300 (orca-stack)'))
      assert.ok(ticketBrief.includes('gh pr create --base main --head branch'))

      const reviewBrief = renderBrief('review', { AGENT: 'codex', PR: '42', REPO: 'orca-stack', BASE: 'main', SHA: '1234567', IMPLEMENTER: 'agy' })
      assert.ok(reviewBrief.includes('# Review brief: PR #42 (orca-stack)'))

      const env = fakeIo()
      await run('ticket', { n: '300', agent: 'agy', dryRun: true }, env)
      const out = env.out.join('\n')
      assert.ok(out.includes('brief -> '))
    })
  })
})


