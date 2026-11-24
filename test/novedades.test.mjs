import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { novedadesCommand } from '../src/novedades.mjs'
import { ROOT, cleanup, cli, read, tempDir } from './helpers.mjs'

const COMMON = '/repo/.git'
const STATE = path.join(COMMON, 'orca-stack', 'novedades.json')

const snapshot = ({ issue = '2026-11-24T10:00:00Z', pr = '2026-11-24T09:00:00Z', rollup = 'PENDING' } = {}) => JSON.stringify({
  data: {
    repository: {
      issues: { nodes: [{ number: 7, updatedAt: issue }] },
      pullRequests: { nodes: [{ number: 8, updatedAt: pr }] },
      open: { nodes: [{ number: 8, headRefOid: 'abc', commits: { nodes: [{ commit: { statusCheckRollup: { state: rollup } } }] } }] },
    },
  },
})

// A fake io with a fake gh: world.gh is the next gh answer, files is the disk.
const fakeIo = world => {
  const files = world.files ?? {}
  const calls = []
  const out = []
  const err = []
  const io = {
    cwd: '/repo/sub',
    out: line => out.push(line),
    err: line => err.push(line),
    sh: (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'git') return world.noRepo ? { status: 128, stdout: '', stderr: 'fatal: not a git repository' } : { status: 0, stdout: `/repo/.git\n${COMMON}\n/repo\n`, stderr: '' }
      if (cmd === 'gh') return world.gh
      return { status: 127, stdout: '', stderr: `test: unexpected command ${cmd}` }
    },
    exists: file => file in files,
    readFile: file => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`)
      return files[file]
    },
    writeFile: (file, text) => {
      if (world.readOnly) throw new Error('EACCES')
      files[file] = text
    },
    rename: (from, to) => {
      files[to] = files[from]
      delete files[from]
    },
    mkdirp: () => {},
  }
  return { io, files, calls, out, err }
}

const ok = stdout => ({ status: 0, stdout, stderr: '' })

const run = async (world, rest = []) => {
  const env = fakeIo(world)
  const code = await novedadesCommand({}, rest, env.io)
  return { code, ...env }
}

describe('orca-stack novedades: the polling precheck (#433)', () => {
  test('R7: nothing new exits non-zero; a new event exits zero', async () => {
    const files = {}
    const first = await run({ files, gh: ok(snapshot()) })
    assert.equal(first.code, 0)
    assert.deepEqual(first.out, ['novedades: primera corrida, sigue la automatización'])

    const same = await run({ files, gh: ok(snapshot()) })
    assert.equal(same.code, 1)
    assert.deepEqual(same.out, ['novedades: nada nuevo en GitHub desde la última corrida, Orca la saltea'])

    for (const change of [{ issue: '2026-11-24T10:05:00Z' }, { issue: '2026-11-24T10:05:00Z', pr: '2026-11-24T10:06:00Z' }, { issue: '2026-11-24T10:05:00Z', pr: '2026-11-24T10:06:00Z', rollup: 'SUCCESS' }]) {
      const changed = await run({ files, gh: ok(snapshot(change)) })
      assert.equal(changed.code, 0, JSON.stringify(change))
      assert.deepEqual(changed.out, ['novedades: hay novedades en GitHub, sigue la automatización'])
      const again = await run({ files, gh: ok(snapshot(change)) })
      assert.equal(again.code, 1, JSON.stringify(change))
    }
  })

  test('R4: a precheck that fails itself exits zero so the agent runs, and leaves the state as it was', async () => {
    const files = {}
    await run({ files, gh: ok(snapshot()) })
    const before = files[STATE]
    const failures = [
      { gh: { status: 1, stdout: '', stderr: 'error connecting to api.github.com' } },
      { gh: { status: 4, stdout: '', stderr: 'gh auth login' } },
      { gh: ok('not json') },
      { gh: ok(JSON.stringify({ errors: [{ message: 'Could not resolve to a Repository' }] })) },
      { gh: { status: undefined, stdout: '', stderr: '', error: new Error('spawn gh ENOENT') } },
      { gh: { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) } },
      { noRepo: true, gh: ok(snapshot()) },
    ]
    for (const failure of failures) {
      const result = await run({ files, ...failure })
      assert.equal(result.code, 0, JSON.stringify(failure))
      assert.deepEqual(result.out, [])
      assert.equal(result.err.length, 1)
      assert.match(result.err[0], /^novedades: no pude saber si hay novedades \(.+\): sigue la automatización para que el agente lo informe$/)
      assert.equal(files[STATE], before)
    }

    const corrupt = { [STATE]: '{ broken' }
    const recovered = await run({ files: corrupt, gh: ok(snapshot()) })
    assert.equal(recovered.code, 0)
    assert.equal((await run({ files: corrupt, gh: ok(snapshot()) })).code, 1)

    const readOnly = await run({ files: {}, readOnly: true, gh: ok(snapshot()) })
    assert.equal(readOnly.code, 0)
    assert.match(readOnly.err.join('\n'), /no pude guardar/)
  })

  test('R5: each run makes at most one gh call and runs no agent', async () => {
    const files = {}
    for (const gh of [ok(snapshot()), ok(snapshot()), { status: 1, stdout: '', stderr: 'down' }]) {
      const { calls } = await run({ files, gh })
      const others = calls.filter(([cmd]) => cmd !== 'git')
      assert.equal(others.length, 1, JSON.stringify(calls))
      const [cmd, ...args] = others[0]
      assert.equal(cmd, 'gh')
      assert.deepEqual(args.slice(0, 6), ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}'])
    }
    const offline = await run({ files, noRepo: true, gh: ok(snapshot()) })
    assert.deepEqual(offline.calls.filter(([cmd]) => cmd !== 'git'), [])
  })

  test('R4: two named prechecks on the same clone keep their own last run', async () => {
    const files = {}
    assert.equal((await run({ files, gh: ok(snapshot()) }, ['tarde'])).code, 0)
    assert.equal((await run({ files, gh: ok(snapshot()) }, ['madrugada'])).code, 0)
    assert.equal((await run({ files, gh: ok(snapshot()) }, ['tarde'])).code, 1)
    assert.equal((await run({ files, gh: ok(snapshot()) }, ['madrugada'])).code, 1)
    assert.deepEqual(Object.keys(JSON.parse(files[STATE]).ultimas).sort(), ['madrugada', 'tarde'])
  })

  test('R4: a usage mistake in the precheck command exits zero with a warning and never calls gh', async () => {
    for (const [flags, rest, said] of [[{}, ['a', 'b'], /un solo <nombre>/], [{ dryRun: true }, [], /no acepta --dryRun/]]) {
      const files = {}
      const env = fakeIo({ files, gh: ok(snapshot()) })
      assert.equal(await novedadesCommand(flags, rest, env.io), 0)
      assert.equal(env.err.length, 1)
      assert.match(env.err[0], said)
      assert.match(env.err[0], /Uso: orca-stack novedades \[<nombre>\]/)
      assert.deepEqual(env.calls.filter(([cmd]) => cmd !== 'git'), [])
      assert.deepEqual(files, {})
    }
    const home = tempDir('novedades-typo')
    try {
      const typo = cli(home, ['novedades', '--nombre', 'tarde'], { cwd: home })
      assert.equal(typo.status, 0, typo.out)
      assert.match(typo.out, /Opción desconocida: --nombre/)
    } finally {
      cleanup(home)
    }
  })

  test('R4 and R6: novedades --help and the manual document the precheck and how to add it to an existing automation', () => {
    const home = tempDir('novedades-help')
    try {
      const help = cli(home, ['novedades', '--help'])
      assert.equal(help.status, 0)
      assert.match(help.stdout, /^orca-stack novedades \[<nombre>\]/)
      assert.match(help.stdout, /--precheck "orca-stack novedades"/)
      assert.match(cli(home, ['--help']).stdout, /^ {2}novedades /m)
    } finally {
      cleanup(home)
    }
    const manual = read(path.join(ROOT, 'docs', 'manual.md'))
    const section = manual.split('#### `novedades`')[1]?.split('\n#### ')[0] ?? ''
    assert.match(manual, /\| `novedades` \|/)
    assert.match(section, /orca automations create .*--trigger "\*\/30 \* \* \* \*".*--precheck "orca-stack novedades"/)
    assert.match(section, /Las automatizaciones que ya creaste a mano no las toca el stack/)
    assert.match(section, /orca automations edit <id> --precheck "cd <clon> && orca-stack novedades <nombre>"/)
    assert.match(section, /una sola llamada a `gh`/)
  })
})
