import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { briefRevisionCommand, renderBrief } from '../src/despacho.mjs'
import { main } from '../src/cli.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'

const temporary = []
const tempDir = prefix => {
  const dir = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  temporary.push(dir)
  return dir
}
afterEach(() => temporary.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

const setup = ({ mode = 'un-agente', body = 'Implementador: codex', registered = false } = {}) => {
  const home = tempDir('brief-revision-home')
  const root = path.join(tempDir('brief-revision-repo'), 'repo')
  mkdirSync(root)
  const tracked = path.join(root, 'tracked.txt')
  writeFileSync(tracked, 'keep these bytes\n')
  writeFileSync(path.join(root, '.orca-stack.json'), JSON.stringify({ setup: 'completo', modo: mode, ramaBase: 'main', verificacion: { suite: 'npm test', typecheck: 'ninguno' } }))
  const calls = []
  const writes = []
  const out = []
  const worktreePath = path.join(path.dirname(root), 'repo-revision-7-subagente')
  const briefPath = path.join(home, 'orca', 'briefs', 'repo-revision-7-subagente.md')
  const reviewPath = path.join(home, 'orca', 'briefs', 'repo-revision-7-subagente.review.md')
  let hasWorktree = registered
  const io = {
    home,
    cwd: root,
    win: false,
    out: line => out.push(line),
    exists: existsSync,
    mkdirp: dir => mkdirSync(dir, { recursive: true }),
    writeFile: (file, text) => { writes.push([file, text]); writeFileSync(file, text, 'utf8') },
    sh: (cmd, args, options = {}) => {
      calls.push({ cmd, args, cwd: options.cwd })
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--path-format=absolute') return { status: 0, stdout: `${path.join(root, '.git')}\n${path.join(root, '.git')}\n${root}\n`, stderr: '' }
      if (cmd === 'gh' && args[0] === 'pr') return { status: 0, stdout: JSON.stringify({ number: 7, headRefOid: 'abc123', body }), stderr: '' }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: `worktree ${root}\n${hasWorktree ? `\nworktree ${worktreePath}\nHEAD abc123\n` : ''}`, stderr: '' }
      if (cmd === 'git' && args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') return { status: 0, stdout: 'abc123\n', stderr: '' }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') { hasWorktree = true; return { status: 0, stdout: '', stderr: '' } }
      return { status: 0, stdout: '', stderr: '' }
    },
  }
  return { io, calls, writes, out, tracked, worktreePath, briefPath, reviewPath }
}

describe('brief-revision', () => {
  test('Rule 1: derives reviewer instructions from the shared brief-revision template', async () => {
    const env = setup()
    await briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io)
    const brief = readFileSync(env.briefPath, 'utf8')
    assert.match(brief, /What to review[\s\S]*Standards: the code follows/)
    assert.match(brief, /Revisor: subagente \(gpt-6\)/)
    const changedTemplate = renderBrief('review', {
      REPO: 'repo', PR: '7', IMPLEMENTER: 'codex', SHA: 'abc123', BASE: 'main', VERIFICATION: 'npm test',
      AGENT: 'agy',
    }).replace('Standards: the code follows', 'Standards: changed shared source')
    assert.match(changedTemplate, /Standards: changed shared source/)
    assert.equal((brief.match(/What to review/g) ?? []).length, 1)
  })

  test('Rule 2: leaves the main checkout tracked file byte-for-byte unchanged', async () => {
    const env = setup()
    const before = readFileSync(env.tracked)
    await briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io)
    assert.deepEqual(readFileSync(env.tracked), before)
    assert.ok(env.calls.every(call => call.cwd === env.io.cwd))
  })

  test('Rule 3: refuses multiagente mode without creating anything', async () => {
    const env = setup({ mode: 'multiagente' })
    await assert.rejects(briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io), /orca-stack revisar <pr> <agente>/)
    assert.deepEqual(env.writes, [])
    assert.equal(env.calls.some(call => call.args[0] === 'fetch' || call.args[0] === 'worktree' && call.args[1] === 'add'), false)
  })

  test('Rule 4: refuses missing or empty --modelo without side effects', async () => {
    const env = setup()
    await assert.rejects(briefRevisionCommand({ n: '7' }, env.io), /necesita --modelo/)
    await assert.rejects(briefRevisionCommand({ n: '7', modelo: '  ' }, env.io), /necesita --modelo/)
    assert.deepEqual(env.writes, [])
  })

  test('Rule 5: refuses a PR without Implementador and creates nothing', async () => {
    const env = setup({ body: 'No implementer marker' })
    await assert.rejects(briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io), /no tiene la .*nea "Implementador:/)
    assert.deepEqual(env.writes, [])
    assert.equal(env.calls.some(call => call.args[0] === 'fetch' || call.args[0] === 'worktree' && call.args[1] === 'add'), false)
  })

  test('Rule 6: refuses the second run and names the existing worktree path', async () => {
    const env = setup()
    await briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io)
    await assert.rejects(briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io), new RegExp(env.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await assert.rejects(briefRevisionCommand({ n: '7', modelo: 'other-model' }, env.io), new RegExp(env.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  test('Rule 7: requires the main checkout and complete setup', async () => {
    const worktreeEnv = setup()
    worktreeEnv.io.sh = (cmd, args) => cmd === 'git' && args[0] === 'rev-parse'
      ? { status: 0, stdout: `${worktreeEnv.io.cwd}\\.git\nC:\\main\\.git\n${worktreeEnv.io.cwd}\n`, stderr: '' }
      : { status: 0, stdout: '', stderr: '' }
    await assert.rejects(briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, worktreeEnv.io), /checkout principal/)
    const setupEnv = setup()
    writeFileSync(path.join(setupEnv.io.cwd, '.orca-stack.json'), JSON.stringify({ setup: 'pendiente', modo: 'un-agente', ramaBase: 'main' }))
    await assert.rejects(briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, setupEnv.io), /setup de orca-stack est.* pendiente/)
  })

  test('Rule 8: writes the brief to UTF-8 file and never prints its accented review text', async () => {
    const env = setup()
    await briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io)
    const brief = readFileSync(env.briefPath, 'utf8')
    assert.match(brief, /implementación\|interpretación/)
    assert.ok(!env.out.join('\n').includes('implementación'))
    assert.ok(!env.out.join('\n').includes('interpretación'))
    assert.ok(!env.out.join('\n').includes('# Review brief:'))
  })

  test('Rule 9: dry-run prints planned actions and writes neither worktree nor brief', async () => {
    const env = setup()
    await briefRevisionCommand({ n: '7', modelo: 'gpt-6', dryRun: true }, env.io)
    assert.deepEqual(env.writes, [])
    assert.ok(!env.calls.some(call => call.args[0] === 'fetch' || call.args[0] === 'worktree' && call.args[1] === 'add'))
    assert.ok(env.out.some(line => line.includes('git worktree add --detach')))
  })

  test('Acceptance: generated brief tells the reviewer to stay in its worktree, write a file, and identifies model and commit', async () => {
    const env = setup()
    await briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io)
    const brief = readFileSync(env.briefPath, 'utf8')
    assert.match(brief, /work only inside that worktree/)
    assert.match(brief, /Write the review body to the UTF-8 file/)
    assert.ok(brief.includes(env.reviewPath))
    assert.match(brief, /Revisor: subagente \(gpt-6\)/)
    assert.match(brief, /Commit: abc123/)
    assert.match(brief, /Do not checkout or modify the main checkout/)
    assert.ok(env.out.some(line => line === `review body: ${env.reviewPath}`))
    assert.ok(path.relative(env.worktreePath, env.reviewPath).startsWith('..'))
  })

  test('Acceptance: creates a detached worktree at the exact fetched PR head commit', async () => {
    const env = setup()
    await briefRevisionCommand({ n: '7', modelo: 'gpt-6' }, env.io)
    assert.ok(env.calls.some(call => call.cmd === 'git' && call.args.join(' ') === `worktree add --detach ${env.worktreePath} abc123`))
    assert.ok(env.calls.some(call => call.cmd === 'git' && call.args.join(' ') === 'fetch origin refs/pull/7/head'))
  })

  test('Acceptance: command help and top-level usage list brief-revision', async () => {
    const oldLog = console.log
    let output = ''
    console.log = value => { output += `${value}\n` }
    try {
      await main(['brief-revision', '--help'])
      assert.match(output, /orca-stack brief-revision <pr> --modelo <modelo>/)
      output = ''
      await main(['--help'])
      assert.match(output, /brief-revision/)
    } finally {
      console.log = oldLog
    }
  })

  test('Preserve: revisar keeps its original PR checkout and body-file instructions', () => {
    const brief = renderBrief('review', {
      REPO: 'repo', PR: '7', IMPLEMENTER: 'codex', SHA: 'abc123', BASE: 'main', VERIFICATION: 'npm test', AGENT: 'agy',
    })
    assert.ok(brief.includes('This worktree must be at that commit: run git rev-parse HEAD, and if it differs, git fetch origin and git checkout --detach abc123.'))
    assert.ok(brief.includes('Write the review in a UTF-8 file and publish it with a body file, never through a pipe:'))
    assert.ok(brief.includes('gh pr review 7 --comment --body-file <file>'))
    assert.ok(brief.includes('Revisor: agy\nCommit: abc123'))
  })

  test('CONTRATO keeps the human reviewer marker literal and the review body outside the discardable worktree', () => {
    const contract = readFileSync(path.join(PACKAGE_ROOT, 'assets/stack/CONTRATO.md'), 'utf8')
    assert.match(contract, /Si `review` es `"humano"`[\s\S]*?`Revisor: humano` y `Commit: <sha>`/)
    assert.match(contract, /--modelo <modelo>/)
    assert.match(contract, /<repo>-revision-<pr>-subagente\.review\.md/)
    assert.match(contract, /worktree descartable/)
  })
  test('all files under src are free of the mojibake marker', () => {
    const sourceRoot = path.join(PACKAGE_ROOT, 'src')
    const files = []
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(fullPath)
        else files.push(fullPath)
      }
    }
    walk(sourceRoot)
    const marker = String.fromCharCode(0x00c3)
    const offenders = files.filter(file => readFileSync(file, 'utf8').includes(marker))
    assert.deepEqual(offenders.map(file => path.relative(PACKAGE_ROOT, file)), [])
  })
})
