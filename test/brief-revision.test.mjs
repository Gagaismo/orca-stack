import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const MOJIBAKE_REGEX = /(?:[\u00C2\u00C3][\u0080-\u00BF\u0152\u0153\u0160\u0161\u017D\u017E\u0178\u0192\u02C6\u02DC\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]|\u00E2\u20AC|\uFFFD)/

  const BINARY_EXTENSIONS = new Set([
    '.png', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.svgz',
    '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.exe', '.dll', '.so', '.dylib', '.bin',
  ])

  const isBinaryFile = filePath => BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  const isBinaryBuffer = buf => {
    if (Buffer.isBuffer(buf)) return buf.includes(0)
    if (typeof buf === 'string') return buf.includes('\0')
    return false
  }

  const scanTrackedFiles = ({
    root = PACKAGE_ROOT,
    files = null,
    readFile = null,
    exclude = [],
  } = {}) => {
    let tracked = files
    if (!tracked) {
      const result = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) {
        throw new Error(`git ls-files failed: ${result.stderr}`)
      }
      tracked = result.stdout.split(/\r?\n/).filter(Boolean)
    }
    const excludeSet = new Set(exclude)
    const offenders = []
    for (const rawRel of tracked) {
      const rel = rawRel.replace(/\\/g, '/')
      if (excludeSet.has(rel)) continue
      if (isBinaryFile(rel)) continue
      const full = path.join(root, rel)
      if (!readFile && !existsSync(full)) continue
      const buf = readFile ? readFile(full, rel) : readFileSync(full)
      if (!buf) continue
      if (isBinaryBuffer(buf)) continue
      const text = typeof buf === 'string' ? buf : buf.toString('utf8')
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (MOJIBAKE_REGEX.test(lines[i])) {
          offenders.push(`${rel}:${i + 1}`)
        }
      }
    }
    return offenders
  }

  test('Rule 1: a cp1252 mojibake sequence in any tracked text file fails (e.g. assets/stack/CONTRATO.md containing revisi\\u00C3\\u00B3n)', () => {
    const file = 'assets/stack/CONTRATO.md'
    const fakeContent = 'line 1\nrevisi\u00C3\u00B3n\nline 3'
    const offenders = scanTrackedFiles({
      files: [file],
      readFile: () => fakeContent,
    })
    assert.deepEqual(offenders, [`${file}:2`])
  })

  test('Rule 2: an invisible broken í (\\u00C3 + U+00AD) in README.md fails', () => {
    const file = 'README.md'
    const fakeContent = 'line 1\ninv\u00C3\u00ADsible\nline 3'
    const offenders = scanTrackedFiles({
      files: [file],
      readFile: () => fakeContent,
    })
    assert.deepEqual(offenders, [`${file}:2`])
  })

  test('Rule 3: U+FFFD in a tracked text file fails', () => {
    const file = 'src/despacho.mjs'
    const fakeContent = 'const err = "bad \uFFFD replacement"\n'
    const offenders = scanTrackedFiles({
      files: [file],
      readFile: () => fakeContent,
    })
    assert.deepEqual(offenders, [`${file}:1`])
  })

  test('Rule 4: valid accented Spanish never fails (current README.md and docs/guia-setup.md pass)', () => {
    const files = ['README.md', 'docs/guia-setup.md']
    const offenders = scanTrackedFiles({ files })
    assert.deepEqual(offenders, [])

    const validSpanish = 'acción, está, ¿cómo estás?, niño, pingüino, ¡bienvenido!, verificación'
    assert.deepEqual(
      scanTrackedFiles({
        files: ['README.md'],
        readFile: () => validSpanish,
      }),
      []
    )
  })

  test('Rule 5: binary files (.png, .ico, etc.) are not scanned', () => {
    const binaryFiles = ['assets/logo.png', 'assets/favicon.ico']
    const offenders = scanTrackedFiles({
      files: binaryFiles,
      readFile: () => 'revisi\u00C3\u00B3n\uFFFD',
    })
    assert.deepEqual(offenders, [])

    const nullByteFile = 'assets/data.bin'
    const offendersWithNull = scanTrackedFiles({
      files: [nullByteFile],
      readFile: () => Buffer.from([0x00, 0xC3, 0xB3, 0xFF]),
    })
    assert.deepEqual(offendersWithNull, [])
  })

  test('excludes explicit fixtures from scanning', () => {
    const fixturePath = 'test/fixtures/mojibake-fixture.txt'
    const offenders = scanTrackedFiles({
      files: [fixturePath],
      exclude: [fixturePath],
      readFile: () => 'revisi\u00C3\u00B3n',
    })
    assert.deepEqual(offenders, [])
  })

  test('all tracked text files are free of mojibake', () => {
    const result = spawnSync('git', ['ls-files'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`)
    const tracked = result.stdout.split(/\r?\n/).filter(Boolean)

    const requiredAreas = ['assets/', 'docs/', 'README.md', 'mods/', 'test/', 'scripts/', 'bin/', 'shared/', 'src/']
    for (const area of requiredAreas) {
      assert.ok(
        tracked.some(file => file === area || file.startsWith(area)),
        `git ls-files must include entries under ${area}`
      )
    }

    const offenders = scanTrackedFiles()
    assert.deepEqual(offenders, [])
  })
})
