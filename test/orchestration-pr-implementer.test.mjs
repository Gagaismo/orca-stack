import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { checkEvidencia } from '../scripts/check-evidencia.mjs'
import { main } from '../src/cli.mjs'
import { revisarCommand } from '../src/despacho.mjs'
import { applyPerks, perksOf } from '../src/perks.mjs'
import { policyBlock } from '../src/templates.mjs'
import { layout } from '../src/util.mjs'
import { ROOT, cleanup, read, tempDir, write } from './helpers.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const between = (text, start, end) => text.split(start)[1].split(end)[0]

const PROJECT = {
  setup: 'completo',
  modo: 'multiagente',
  ramaBase: 'main',
  agentes: { usa: ['claude', 'agy', 'codex', 'pi'], preguntarAntes: [] },
  verificacion: { suite: 'npm run verify', typecheck: 'ninguno' },
}

const captureStderr = async fn => {
  const lines = []
  const orig = console.error
  console.error = (...args) => lines.push(args.join(' '))
  try {
    const code = await fn()
    return { code, stderr: lines.join('\n') }
  } finally {
    console.error = orig
  }
}

describe('issue 468: orchestration PRs carry Implementador: and revisar names the line it expects', () => {
  let home
  let root
  let worktree

  beforeEach(() => {
    home = tempDir('home-468')
    root = tempDir('repo-468')
    worktree = path.join(home, 'orca', 'workspaces', path.basename(root), 'revision-61-agy')
    write(layout(home).config, JSON.stringify({}))
    write(path.join(root, '.orca-stack.json'), JSON.stringify(PROJECT))
  })

  afterEach(() => {
    cleanup(home)
    cleanup(root)
  })

  const fakeIo = prBody => {
    const calls = []
    const out = []
    const written = []
    let launchedAgent
    const io = {
      home,
      cwd: root,
      win: true,
      modifiedAt: () => 0,
      out: line => out.push(line),
      sleep: async () => {},
      exists: existsSync,
      readFile: file => readFileSync(file, 'utf8'),
      listFiles: () => [],
      mkdirp: () => {},
      writeFile: (file, text) => {
        written.push([file, text])
        write(file, text)
      },
      rename: renameSync,
      gentleSkills: () => 'C:\\pi\\gentle-pi\\skills',
      sh: (cmd, args) => {
        calls.push([cmd, ...args])
        if (cmd === 'git' && args[0] === 'ls-files') return { status: 1, stdout: '', stderr: '' }
        if (cmd === 'git' && args[0] === 'rev-parse') return okRes(`${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`)
        if (cmd === 'git' && args[0] === 'worktree') return okRes(`worktree ${root}\nbranch refs/heads/main\n`)
        if (cmd === 'git' && args[0] === 'remote') return okRes('https://github.com/Gagaismo/orca-stack.git\n')
        if (cmd === 'git') return okRes('docs/plan.md\n')
        if (cmd === 'gh' && args[0] === 'pr') return json({ headRefName: 'docs/plan', headRefOid: 'abc123', body: prBody, number: 61 })
        if (args.join(' ') === 'worktree ps --json') return json({ result: { worktrees: [] } })
        if (args.join(' ').startsWith('worktree create')) return json({ result: { worktree: { path: worktree, branch: 'refs/heads/revision-61-agy' } } })
        if (args[0] === 'terminal' && args[1] === 'create') {
          launchedAgent = args[args.indexOf('--title') + 1]
          return json({ result: { terminal: { handle: 'term_1' } } })
        }
        if (args[0] === 'terminal' && args[1] === 'send' && args.includes('--wait-submit')) return json({ result: { submission: 'submitted', turnStarted: true } })
        if (args[0] === 'terminal' && args[1] === 'read') return json({ id: `req-${calls.length}`, ok: true, result: { terminal: { tail: launchedAgent === 'agy' ? ['ready', '>'] : ['ready'], latestCursor: calls.length } } })
        if (args[0] === 'terminal' && args[1] === 'list') return json({ result: { terminals: [] } })
        return okRes()
      },
    }
    const launched = () => calls.filter(c => c[0] === 'orca' && (c[2] === 'create' || c[2] === 'send'))
    return { io, calls, out, written, launched }
  }

  test('Rule 1: contract PR section and AGENTS block state orchestration PRs carry Implementador: with session agent', () => {
    const contract = read(path.join(ROOT, 'assets', 'stack', 'CONTRATO.md'))
    const agents = read(path.join(ROOT, 'AGENTS.md'))
    const block = policyBlock({ policyPath: '~/orca/stack/ORCA-STACK.md', briefsPath: '~/orca/stack/ROLE-BRIEFS.md' })

    const prSection = between(contract, '### PRs', '### Dónde vive cada regla')
    const orchestrationBullet = prSection.split(/\r?\n/).find(line => line.includes('Un PR de orquestación'))
    assert.ok(orchestrationBullet, 'CONTRATO.md PR section has an orchestration PR bullet')
    assert.ok(orchestrationBullet.includes('`Closes #`'), orchestrationBullet)
    assert.ok(orchestrationBullet.includes('`Implementador: <agente>`'), orchestrationBullet)
    assert.match(orchestrationBullet, /sesión que escribió su contenido/i, orchestrationBullet)
    assert.match(orchestrationBullet, /`main`/, orchestrationBullet)
    assert.match(orchestrationBullet, /`pi`/, orchestrationBullet)

    assert.ok(agents.includes(applyPerks(contract, perksOf({})).replace(/\s+$/, '')), 'AGENTS.md matches CONTRATO.md')
    assert.ok(block.includes(orchestrationBullet), 'policyBlock for init and global carries the orchestration PR line')
  })

  test('Rule 2: revisar 61 agy on an orchestration PR with Implementador: claude and no Closes # launches review', async () => {
    const env = fakeIo('## Summary\nPlanning docs\n\nImplementador: claude\n')
    const { code, stderr } = await captureStderr(() => main(['revisar', '61', 'agy'], env.io))
    assert.equal(code, 0, stderr)
    assert.equal(stderr, '')
    assert.ok(env.calls.some(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'create'))
    assert.ok(env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create'))
    assert.ok(env.written.length > 0)
  })

  test('Rule 3: revisar 61 agy on a PR with no Implementador: line exits 1, launches nothing, and names ticket and orchestration PRs', async () => {
    const env = fakeIo('## Summary\nPlanning docs without implementer line\n')
    const { code, stderr } = await captureStderr(() => main(['revisar', '61', 'agy'], env.io))
    assert.equal(code, 1)
    assert.equal(
      stderr,
      '✖ El PR #61 no tiene la línea "Implementador: <agente>" (la llevan los PRs de ticket y los de orquestación): sin ella no puedo comprobar que el revisor sea otro.',
    )
    assert.deepEqual(env.launched(), [])
    assert.deepEqual(env.written, [])
  })

  test('Rule 4: revisar 61 agy with Implementador: agy still refuses self-review', async () => {
    const env = fakeIo('## Summary\nOrchestration PR\n\nImplementador: agy\n')
    const { code, stderr } = await captureStderr(() => main(['revisar', '61', 'agy'], env.io))
    assert.equal(code, 1)
    assert.equal(stderr, '✖ agy implementó el PR #61: nadie revisa su propio PR.')
    assert.deepEqual(env.launched(), [])
    assert.deepEqual(env.written, [])
  })

  test('Rule 5: check-evidencia does not require Implementador: on an orchestration PR body', () => {
    const body = '## Summary\nPlanning docs\n\n## Merge Danger\nTwo-way door.\n'
    const result = checkEvidencia(body, ROOT)
    assert.equal(result.ok, true, result.stderr)
  })

  test('Preserve: revisarCommand still dispatches a ticket PR with Implementador: and Closes #', async () => {
    const env = fakeIo('## Summary\nFix bug\n\nImplementador: codex\nCloses #468\n')
    const code = await revisarCommand({}, '61', 'agy', env.io)
    assert.equal(code, 0)
    assert.ok(env.calls.some(c => c[0] === 'orca' && c[1] === 'worktree' && c[2] === 'create'))
    assert.ok(env.calls.some(c => c[0] === 'orca' && c[1] === 'terminal' && c[2] === 'create'))
  })
})
