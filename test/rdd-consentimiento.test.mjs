import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { defaultIo, rddConsentPolicy, writeRddConsent } from '../src/despacho.mjs'
import { cleanup, tempDir } from './helpers.mjs'

// main-autonomo S3: the consent file lives in the per-worktree git dir, read from a real git checkout.
const git = (cwd, ...args) => {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  return res.stdout
}

let dir
let repo
// GIT_CEILING_DIRECTORIES keeps git from finding a repository above the temp dir (a home that is itself a checkout).
const ioFor = () => {
  const out = []
  const sh = (cmd, args, { cwd } = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } })
  return { io: { ...defaultIo(), sh, out: line => out.push(line) }, out }
}

beforeEach(() => {
  dir = tempDir('rdd-consent')
  repo = path.join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base')
})
afterEach(() => cleanup(dir))

describe('S3: rdd-consentimiento.json', () => {
  test('in the main checkout it is written under .git/orca-stack with an empty grant, and printed', () => {
    const { io, out } = ioFor()
    const file = writeRddConsent(io, repo, [])
    const expected = path.join(repo, '.git', 'orca-stack', 'rdd-consentimiento.json')
    // realpath: on Windows the temp dir can come as an 8.3 short name (RUNNER~1) while git prints the long one.
    assert.equal(realpathSync.native(file), realpathSync.native(expected))
    assert.equal(readFileSync(expected, 'utf8'), '{"version":1,"granted":[]}\n')
    assert.deepEqual(out, [`Consentimiento RDD (política): ${file} = {"version":1,"granted":[]}`])
  })

  test('in a linked worktree it goes to that worktree\'s own git dir, grants the head, and git status stays clean', () => {
    const linked = path.join(dir, 'linked')
    git(repo, 'worktree', 'add', '-q', linked)
    const { io } = ioFor()
    const sha = git(linked, 'rev-parse', 'HEAD').trim()
    writeRddConsent(io, linked, [sha])
    const expected = path.join(repo, '.git', 'worktrees', 'linked', 'orca-stack', 'rdd-consentimiento.json')
    assert.equal(readFileSync(expected, 'utf8'), `{"version":1,"granted":["${sha}"]}\n`)
    assert.equal(existsSync(path.join(repo, '.git', 'orca-stack', 'rdd-consentimiento.json')), false)
    assert.equal(git(linked, 'status', '--porcelain', '--untracked-files=all'), '')
  })

  test('outside a git checkout it fails and writes nothing', () => {
    const plain = path.join(dir, 'plain')
    mkdirSync(plain)
    const { io, out } = ioFor()
    assert.throws(() => writeRddConsent(io, plain, []), error => error.message.startsWith(`No pude leer el git dir de ${plain} (git rev-parse --git-dir): `))
    assert.equal(existsSync(path.join(plain, 'orca-stack')), false)
    assert.deepEqual(out, [])
  })

  test('the policy is "politica" when absent, "humano" when asked, and anything else is refused', () => {
    assert.equal(rddConsentPolicy({}, 'pi'), 'politica')
    assert.equal(rddConsentPolicy({ agentes: { pi: { rddConsentimiento: 'politica' } } }, 'pi'), 'politica')
    assert.equal(rddConsentPolicy({ agentes: { codex: { rddConsentimiento: 'humano' } } }, 'codex'), 'humano')
    assert.throws(() => rddConsentPolicy({ agentes: { agy: { rddConsentimiento: true } } }, 'agy'), error =>
      error.message === 'agentes.agy.rddConsentimiento tiene que ser "politica" o "humano", no true.')
  })
})
