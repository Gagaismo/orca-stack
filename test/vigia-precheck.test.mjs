import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { runVigiaPrecheck } from '../scripts/vigia-precheck.mjs'
import { ROOT, cleanup, pathKey, tempDir } from './helpers.mjs'

const PRECHECK_SCRIPT = path.join(ROOT, 'scripts', 'vigia-precheck.mjs')
const FOUR_REPOS = ['org/repo-a', 'org/repo-b', 'org/repo-c', 'org/repo-d']
const STATE_PATH = '/state/precheck-state.json'

const repoNode = ({ issueComments = [], prComments = [], openPrs = [] } = {}) => ({
  issues: {
    nodes: issueComments.length ? [{ number: 1, comments: { nodes: issueComments } }] : [],
  },
  pullRequests: {
    nodes: prComments.length ? [{ number: 2, comments: { nodes: prComments } }] : [],
  },
  openPrs: {
    nodes: openPrs,
  },
})

const graphqlPayload = (reposData = {}) => JSON.stringify({
  data: Object.fromEntries(
    FOUR_REPOS.map((repo, index) => [`r${index}`, repoNode(reposData[repo] ?? {})]),
  ),
})

const fakeIo = ({ files = {}, gh, readOnly = false, cwd = '/work' } = {}) => {
  const calls = []
  const out = []
  const err = []
  let ghIndex = 0
  const io = {
    cwd,
    out: line => out.push(line),
    err: line => err.push(line),
    execGh: (args, timeout) => {
      calls.push({ args, timeout })
      if (typeof gh === 'function') return gh(args, timeout)
      if (Array.isArray(gh)) return gh[Math.min(ghIndex++, gh.length - 1)]
      return gh
    },
    readFile: file => {
      if (!(file in files)) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' })
      return files[file]
    },
    writeFile: (file, text) => {
      if (readOnly) throw new Error('EACCES')
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

const ok = stdout => ({ status: 0, stdout, stderr: '', error: null })

const invoke = (args, world) => {
  const env = fakeIo(world)
  const code = runVigiaPrecheck(args, env.io)
  return { code, ...env }
}

const baseArgs = (repos = FOUR_REPOS.join(','), state = STATE_PATH) => ['--repos', repos, '--state', state]

describe('scripts/vigia-precheck.mjs (#515)', () => {
  test('R1: skips with exit 1 when no new Consulta/Diagnostico comments or newly conflicting PRs exist across the repos', () => {
    const files = {}
    const baselinePayload = graphqlPayload({
      'org/repo-a': {
        issueComments: [{ databaseId: 101, body: 'Diagnóstico: agy\nCausa: x' }],
      },
      'org/repo-b': {
        openPrs: [
          { number: 10, headRefOid: 'sha-10', mergeable: 'MERGEABLE' },
          { number: 11, headRefOid: 'sha-11', mergeable: 'CONFLICTING' },
        ],
      },
    })

    const first = invoke(baseArgs(), { files, gh: ok(baselinePayload) })
    assert.equal(first.code, 0)
    assert.equal(first.calls.length, 1)
    assert.equal(first.calls[0].args[0], 'api')
    assert.equal(first.calls[0].args[1], 'graphql')
    const queryArg = first.calls[0].args.find(arg => arg.startsWith('query='))
    for (const repo of FOUR_REPOS) {
      const [owner, name] = repo.split('/')
      assert.ok(queryArg.includes(`owner: "${owner}", name: "${name}"`), `missing ${repo} in query`)
    }
    const stateFile = path.resolve('/work', STATE_PATH)
    assert.ok(stateFile in files)

    const second = invoke(baseArgs(), { files, gh: ok(baselinePayload) })
    assert.equal(second.code, 1)
    assert.match(second.out.join('\n'), /sin novedades/)

    const unrelatedPayload = graphqlPayload({
      'org/repo-a': {
        issueComments: [
          { databaseId: 101, body: 'Diagnóstico: agy\nCausa: x' },
          { databaseId: 102, body: 'Normal comment mentioning Consulta: in the middle' },
        ],
      },
      'org/repo-b': {
        openPrs: [
          { number: 10, headRefOid: 'sha-10', mergeable: 'MERGEABLE' },
          { number: 11, headRefOid: 'sha-11', mergeable: 'CONFLICTING' },
        ],
      },
    })
    const third = invoke(baseArgs(), { files, gh: ok(unrelatedPayload) })
    assert.equal(third.code, 1)

    const newConflictPayload = graphqlPayload({
      'org/repo-a': {
        issueComments: [{ databaseId: 101, body: 'Diagnóstico: agy\nCausa: x' }],
      },
      'org/repo-b': {
        openPrs: [
          { number: 10, headRefOid: 'sha-10', mergeable: 'CONFLICTING' },
          { number: 11, headRefOid: 'sha-11', mergeable: 'CONFLICTING' },
        ],
      },
    })
    const fourth = invoke(baseArgs(), { files, gh: ok(newConflictPayload) })
    assert.equal(fourth.code, 0)
    assert.equal(invoke(baseArgs(), { files, gh: ok(newConflictPayload) }).code, 1)

    const newShaConflictPayload = graphqlPayload({
      'org/repo-a': {
        issueComments: [{ databaseId: 101, body: 'Diagnóstico: agy\nCausa: x' }],
      },
      'org/repo-b': {
        openPrs: [
          { number: 10, headRefOid: 'sha-10-b', mergeable: 'CONFLICTING' },
          { number: 11, headRefOid: 'sha-11', mergeable: 'CONFLICTING' },
        ],
      },
    })
    assert.equal(invoke(baseArgs(), { files, gh: ok(newShaConflictPayload) }).code, 0)
    assert.equal(invoke(baseArgs(), { files, gh: ok(newShaConflictPayload) }).code, 1)

    const resolvedPayload = graphqlPayload({
      'org/repo-a': {
        issueComments: [{ databaseId: 101, body: 'Diagnóstico: agy\nCausa: x' }],
      },
      'org/repo-b': {
        openPrs: [
          { number: 10, headRefOid: 'sha-10-b', mergeable: 'MERGEABLE' },
          { number: 11, headRefOid: 'sha-11', mergeable: 'CONFLICTING' },
        ],
      },
    })
    assert.equal(invoke(baseArgs(), { files, gh: ok(resolvedPayload) }).code, 1)
    assert.deepEqual(JSON.parse(files[stateFile]).conflictingPrs, ['org/repo-b#11@sha-11'])
    assert.equal(invoke(baseArgs(), { files, gh: ok(newShaConflictPayload) }).code, 0)
  })

  test('R2: exits 0 when a new Consulta or Diagnostico comment appears after the previous run', () => {
    const files = {}
    assert.equal(invoke(baseArgs(), { files, gh: ok(graphqlPayload()) }).code, 0)
    assert.equal(invoke(baseArgs(), { files, gh: ok(graphqlPayload()) }).code, 1)

    const variants = [
      { id: 201, where: 'issueComments', body: 'Consulta: ¿qué hacemos con el flag?' },
      { id: 202, where: 'prComments', body: 'Diagnóstico: agy\nCausa: fallo' },
      { id: 203, where: 'issueComments', body: 'Diagnostico: sin tilde' },
      { id: 204, where: 'prComments', body: 'Diagn?stico: codex en Windows' },
      { id: 205, where: 'prComments', body: '\n  Consulta: con espacios adelante' },
    ]
    const state = { issueComments: [], prComments: [] }
    for (const variant of variants) {
      state[variant.where].push({ databaseId: variant.id, body: variant.body })
      const payload = graphqlPayload({ 'org/repo-c': state })
      const detected = invoke(baseArgs(), { files, gh: ok(payload) })
      assert.equal(detected.code, 0, variant.body)
      const repeated = invoke(baseArgs(), { files, gh: ok(payload) })
      assert.equal(repeated.code, 1, variant.body)
    }
  })

  test('R3: fails open with exit 0 and keeps state intact when gh fails, times out, returns bad output, or args are invalid', () => {
    const files = {}
    assert.equal(invoke(baseArgs(), { files, gh: ok(graphqlPayload()) }).code, 0)
    const stateFile = path.resolve('/work', STATE_PATH)
    const before = files[stateFile]

    const ghFailures = [
      { status: 1, stdout: '', stderr: 'error connecting to api.github.com', error: null },
      { status: 4, stdout: '', stderr: 'not logged into any GitHub hosts', error: null },
      { status: undefined, stdout: '', stderr: '', error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) },
      { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
      ok('not-json'),
      ok(JSON.stringify({ errors: [{ message: 'API rate limit exceeded' }] })),
      ok(JSON.stringify({ data: { r0: repoNode() } })),
    ]
    for (const gh of ghFailures) {
      const res = invoke(baseArgs(), { files, gh })
      assert.equal(res.code, 0, JSON.stringify(gh))
      assert.equal(res.err.length, 1)
      assert.equal(files[stateFile], before)
    }

    const badCliArgs = [
      [],
      ['--repos', 'org/repo-a'],
      ['--state', STATE_PATH],
      ['--repos', 'invalid-repo', '--state', STATE_PATH],
      ['--repos', 'org/repo-a', '--state', STATE_PATH, '--unknown'],
      ['--repos', 'org/repo-a', '--state', STATE_PATH, '--timeout', 'abc'],
      ['extra-positional', '--repos', 'org/repo-a', '--state', STATE_PATH],
    ]
    for (const args of badCliArgs) {
      const res = invoke(args, { files, gh: ok(graphqlPayload()) })
      assert.equal(res.code, 0, JSON.stringify(args))
      assert.equal(res.calls.length, 0)
      assert.equal(res.err.length, 1)
      assert.equal(files[stateFile], before)
    }

    const corruptFiles = { [stateFile]: '{ broken json' }
    assert.equal(invoke(baseArgs(), { files: corruptFiles, gh: ok(graphqlPayload()) }).code, 0)
    assert.equal(invoke(baseArgs(), { files: corruptFiles, gh: ok(graphqlPayload()) }).code, 1)

    const readOnlyRes = invoke(baseArgs(), { files: {}, readOnly: true, gh: ok(graphqlPayload()) })
    assert.equal(readOnlyRes.code, 0)
    assert.ok(readOnlyRes.err.length >= 1)
  })

  test('R1-R3 subprocess: CLI exits 0 on first run, 1 when unchanged, 0 on new Consulta comment, and 0 when gh fails', () => {
    const dir = tempDir('vigia-precheck')
    try {
      const binDir = path.join(dir, 'bin')
      const responseFile = path.join(dir, 'gh-response.json')
      const stateFile = path.join(dir, 'memory', 'state.json')
      mkdirSync(binDir, { recursive: true })

      if (process.platform === 'win32') {
        const fakeGhScript = path.join(binDir, 'fake-gh.mjs')
        writeFileSync(
          fakeGhScript,
          [
            "import { readFileSync } from 'node:fs'",
            'const cfg = JSON.parse(readFileSync(process.env.FAKE_GH_FILE, "utf8"))',
            'if (cfg.stderr) process.stderr.write(cfg.stderr)',
            'if (cfg.stdout) process.stdout.write(cfg.stdout)',
            'process.exit(cfg.status ?? 0)',
          ].join('\n'),
          'utf8',
        )
        writeFileSync(path.join(binDir, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "${fakeGhScript}" %*\r\n`, 'utf8')
      } else {
        const ghPath = path.join(binDir, 'gh')
        writeFileSync(
          ghPath,
          [
            `#!${process.execPath}`,
            "import { readFileSync } from 'node:fs'",
            'const cfg = JSON.parse(readFileSync(process.env.FAKE_GH_FILE, "utf8"))',
            'if (cfg.stderr) process.stderr.write(cfg.stderr)',
            'if (cfg.stdout) process.stdout.write(cfg.stdout)',
            'process.exit(cfg.status ?? 0)',
          ].join('\n'),
          'utf8',
        )
        chmodSync(ghPath, 0o755)
      }

      const key = pathKey()
      const env = {
        ...process.env,
        [key]: `${binDir}${path.delimiter}${process.env[key] ?? ''}`,
        FAKE_GH_FILE: responseFile,
      }

      const twoReposPayload = (issueComments = []) => JSON.stringify({
        data: {
          r0: repoNode({ issueComments }),
          r1: repoNode(),
        },
      })

      const runCli = () => {
        const args = [PRECHECK_SCRIPT, '--repos', 'org/one,org/two', '--state', 'memory/state.json']
        if (process.platform === 'win32') {
          const cmdLine = `"${process.execPath}" "${args[0]}" ${args.slice(1).join(' ')}`
          return spawnSync(cmdLine, { cwd: dir, env, encoding: 'utf8', shell: true, windowsHide: true })
        }
        return spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8', windowsHide: true })
      }

      writeFileSync(responseFile, JSON.stringify({ status: 0, stdout: twoReposPayload() }), 'utf8')
      const first = runCli()
      assert.equal(first.status, 0, first.stderr)
      assert.ok(existsSync(stateFile))

      const second = runCli()
      assert.equal(second.status, 1, second.stderr)

      writeFileSync(
        responseFile,
        JSON.stringify({ status: 0, stdout: twoReposPayload([{ databaseId: 901, body: 'Consulta: nueva duda' }]) }),
        'utf8',
      )
      const third = runCli()
      assert.equal(third.status, 0, third.stderr)

      const fourth = runCli()
      assert.equal(fourth.status, 1, fourth.stderr)

      writeFileSync(responseFile, JSON.stringify({ status: 1, stdout: '', stderr: 'network unreachable' }), 'utf8')
      const fifth = runCli()
      assert.equal(fifth.status, 0, fifth.stderr)
      assert.match(fifth.stderr, /network unreachable/)

      const leftTmp = readdirSync(path.dirname(stateFile)).filter(name => name.endsWith('.tmp'))
      assert.deepEqual(leftTmp, [])
      assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).seenCommentIds, ['901'])
    } finally {
      cleanup(dir)
    }
  })
})
