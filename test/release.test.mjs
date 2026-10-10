import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { ROOT, cleanup, git, tempDir } from './helpers.mjs'

const RELEASE_SCRIPT = path.join(ROOT, 'scripts', 'release.mjs')

// Version every fixture starts at, whatever the repo's own package.json says.
const FIXTURE_VERSION = '0.7.1'

// Rewrites the fixture's version files from one version to another.
const setFixtureVersion = (dir, from, to) => {
  const pkgPath = path.join(dir, 'package.json')
  writeFileSync(pkgPath, readFileSync(pkgPath, 'utf8').replace(`"version": "${from}"`, `"version": "${to}"`))
  assert.equal(JSON.parse(readFileSync(pkgPath, 'utf8')).version, to)

  const lockPath = path.join(dir, 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.version = to
  lock.packages[''].version = to
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')

  for (const file of ['README.md', path.join('docs', 'guia-setup.md')]) {
    const filePath = path.join(dir, file)
    writeFileSync(filePath, readFileSync(filePath, 'utf8').replaceAll(`v${from}`, `v${to}`))
  }
}

let baseDir
let remote
let local

const setupFixture = (opts = {}) => {
  baseDir = tempDir('release-test')
  remote = path.join(baseDir, 'remote.git')
  local = path.join(baseDir, 'local')

  mkdirSync(remote, { recursive: true })
  git(remote, 'init', '--bare', '-q', '-b', 'main')

  mkdirSync(local, { recursive: true })
  git(local, 'init', '-q', '-b', 'main')
  git(local, 'config', 'user.name', 'test')
  git(local, 'config', 'user.email', 'test@example.com')
  git(local, 'remote', 'add', 'origin', remote)

  for (const item of [
    'bin',
    'src',
    'assets',
    'scripts',
    'README.md',
    'package.json',
    'package-lock.json',
    'CLAUDE.md',
    '.gitignore',
  ]) {
    cpSync(path.join(ROOT, item), path.join(local, item), { recursive: true })
  }
  mkdirSync(path.join(local, 'docs'), { recursive: true })
  cpSync(path.join(ROOT, 'docs', 'guia-setup.md'), path.join(local, 'docs', 'guia-setup.md'))

  // opts.repoVersion simulates the repo's own package.json at that version (as during a release run).
  let repoVersion = JSON.parse(readFileSync(path.join(local, 'package.json'), 'utf8')).version
  if (opts.repoVersion) {
    setFixtureVersion(local, repoVersion, opts.repoVersion)
    repoVersion = opts.repoVersion
  }
  setFixtureVersion(local, repoVersion, FIXTURE_VERSION)

  // Older AGENTS.md so `init` refreshes it
  writeFileSync(path.join(local, 'AGENTS.md'), '# agents\n<!-- orca-stack:begin -->\nold\n<!-- orca-stack:end -->\n')

  const suiteCmd = opts.suite ?? 'node -e "process.exit(0)"'
  writeFileSync(
    path.join(local, '.orca-stack.json'),
    JSON.stringify({ version: 1, verificacion: { suite: suiteCmd } }, null, 2),
  )

  if (opts.extraSetup) {
    opts.extraSetup(local)
  }

  git(local, 'add', '.')
  git(local, 'commit', '-qm', 'initial commit')
  git(local, 'push', '-u', 'origin', 'main')
}

const runRelease = (...args) =>
  spawnSync(process.execPath, [RELEASE_SCRIPT, ...args], {
    cwd: local,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(baseDir, 'none') },
  })

afterEach(() => {
  if (baseDir) {
    cleanup(baseDir)
  }
})

describe('scripts/release.mjs', () => {
  test('rule 1: clean main at origin/main, current 0.7.1, run 0.7.2 creates release-0.7.2 commit chore: release v0.7.2, bumps version and leaves no v0.7.1 in README.md or docs/guia-setup.md', () => {
    setupFixture()
    const result = runRelease('0.7.2')

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /Release v0.7.2 committed on branch release-0.7.2/)
    assert.match(result.stdout, /Remaining steps for main:/)
    assert.match(result.stdout, /git push -u origin release-0.7.2/)
    assert.match(result.stdout, /gh pr create --base main --head release-0.7.2/)
    assert.match(result.stdout, /git tag v0.7.2/)
    assert.match(result.stdout, /gh release create v0.7.2/)
    assert.match(result.stdout, /npx github:Gagaismo\/orca-stack#v0.7.2 global/)

    // Branch and commit
    const currentBranch = git(local, 'branch', '--show-current').stdout.trim()
    assert.equal(currentBranch, 'release-0.7.2')

    const commitMsg = git(local, 'log', '-1', '--format=%s').stdout.trim()
    assert.equal(commitMsg, 'chore: release v0.7.2')

    // Changed files in release commit match fa6545e
    const changedFiles = git(local, 'diff', 'HEAD~1', '--name-only').stdout.trim().split(/\r?\n/).sort()
    assert.deepEqual(changedFiles, [
      'AGENTS.md',
      'README.md',
      'docs/guia-setup.md',
      'package-lock.json',
      'package.json',
    ])

    // package.json diff is 1 line
    const pkgDiffLines = git(local, 'diff', 'HEAD~1', '--', 'package.json')
      .stdout.trim()
      .split(/\r?\n/)
      .filter(l => l.startsWith('+') || l.startsWith('-'))
      .filter(l => !l.startsWith('+++') && !l.startsWith('---'))
    assert.equal(pkgDiffLines.length, 2, 'package.json diff must be one line changed (one - and one +)')
    assert.equal(JSON.parse(readFileSync(path.join(local, 'package.json'), 'utf8')).version, '0.7.2')

    // package-lock.json diff is 2 lines
    const lockDiffLines = git(local, 'diff', 'HEAD~1', '--', 'package-lock.json')
      .stdout.trim()
      .split(/\r?\n/)
      .filter(l => l.startsWith('+') || l.startsWith('-'))
      .filter(l => !l.startsWith('+++') && !l.startsWith('---'))
    assert.equal(lockDiffLines.length, 4, 'package-lock.json diff must be two lines changed (two - and two +)')
    const parsedLock = JSON.parse(readFileSync(path.join(local, 'package-lock.json'), 'utf8'))
    assert.equal(parsedLock.version, '0.7.2')
    assert.equal(parsedLock.packages[''].version, '0.7.2')

    // No v0.7.1 in README.md or docs/guia-setup.md
    const readme = readFileSync(path.join(local, 'README.md'), 'utf8')
    assert.ok(!readme.includes('v0.7.1'), 'README.md must not contain v0.7.1')
    assert.ok(readme.includes('v0.7.2'), 'README.md must contain v0.7.2')

    const guia = readFileSync(path.join(local, 'docs', 'guia-setup.md'), 'utf8')
    assert.ok(!guia.includes('v0.7.1'), 'docs/guia-setup.md must not contain v0.7.1')
    assert.ok(guia.includes('v0.7.2'), 'docs/guia-setup.md must contain v0.7.2')

    // Never ran git push or git tag
    const tags = git(local, 'tag').stdout.trim()
    assert.equal(tags, '', 'Must not create tags')
    const remoteBranches = git(remote, 'branch').stdout.trim()
    assert.ok(!remoteBranches.includes('release-0.7.2'), 'Must not push branch to remote')
  })

  test('rule 2: uncommitted changes refuse before touching anything, listing them', () => {
    setupFixture()
    writeFileSync(path.join(local, 'dirty.txt'), 'uncommitted changes\n')

    const result = runRelease('0.7.2')

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /uncommitted changes in working tree/)
    assert.match(result.stderr, /dirty\.txt/)

    // Repo not touched
    const currentBranch = git(local, 'branch', '--show-current').stdout.trim()
    assert.equal(currentBranch, 'main')
    const branches = git(local, 'branch').stdout
    assert.ok(!branches.includes('release-0.7.2'))
  })

  test('rule 3: not on main, or HEAD behind or ahead of origin/main after fetch refuses', () => {
    // 1. Not on main
    setupFixture()
    git(local, 'checkout', '-b', 'feature')
    const resNotMain = runRelease('0.7.2')
    assert.notEqual(resNotMain.status, 0)
    assert.match(resNotMain.stderr, /current branch is "feature", must be "main"/)

    // 2. Ahead of origin/main
    git(local, 'checkout', 'main')
    writeFileSync(path.join(local, 'ahead.txt'), 'ahead')
    git(local, 'add', '.')
    git(local, 'commit', '-qm', 'ahead commit')
    const resAhead = runRelease('0.7.2')
    assert.notEqual(resAhead.status, 0)
    assert.match(resAhead.stderr, /HEAD .* does not match origin\/main/)

    // 3. Behind origin/main
    setupFixture()
    // Commit on remote directly
    const other = path.join(baseDir, 'other')
    mkdirSync(other, { recursive: true })
    git(other, 'clone', '-q', remote, other)
    git(other, 'config', 'user.name', 'other')
    git(other, 'config', 'user.email', 'other@example.com')
    writeFileSync(path.join(other, 'new-upstream.txt'), 'upstream')
    git(other, 'add', '.')
    git(other, 'commit', '-qm', 'upstream commit')
    git(other, 'push', '-q', 'origin', 'main')

    const resBehind = runRelease('0.7.2')
    assert.notEqual(resBehind.status, 0)
    assert.match(resBehind.stderr, /HEAD .* does not match origin\/main/)
    assert.equal(git(local, 'branch', '--show-current').stdout.trim(), 'main')
  })

  test('rule 4: 0.7.1, 0.7.0, v0.7.2 or 0.7 refuse with expected format or "must be greater than 0.7.1"', () => {
    setupFixture()

    // Same version
    const resSame = runRelease('0.7.1')
    assert.notEqual(resSame.status, 0)
    assert.match(resSame.stderr, /must be greater than 0\.7\.1/)

    // Lower version
    const resLower = runRelease('0.7.0')
    assert.notEqual(resLower.status, 0)
    assert.match(resLower.stderr, /must be greater than 0\.7\.1/)

    // Leading 'v'
    const resV = runRelease('v0.7.2')
    assert.notEqual(resV.status, 0)
    assert.match(resV.stderr, /invalid version format "v0\.7\.2"\. Expected format is X\.Y\.Z/)

    // Missing patch
    const resShort = runRelease('0.7')
    assert.notEqual(resShort.status, 0)
    assert.match(resShort.stderr, /invalid version format "0\.7"\. Expected format is X\.Y\.Z/)

    // Repo remained on main, clean, no branch
    assert.equal(git(local, 'branch', '--show-current').stdout.trim(), 'main')
    assert.ok(!git(local, 'branch').stdout.includes('release-'))
  })

  test('rule 5: release-0.7.2 or tag v0.7.2 already exists refuses', () => {
    setupFixture()

    // Local branch already exists
    git(local, 'branch', 'release-0.7.2')
    const resBranch = runRelease('0.7.2')
    assert.notEqual(resBranch.status, 0)
    assert.match(resBranch.stderr, /branch release-0\.7\.2 already exists/)

    git(local, 'branch', '-D', 'release-0.7.2')

    // Tag already exists
    git(local, 'tag', 'v0.7.2')
    const resTag = runRelease('0.7.2')
    assert.notEqual(resTag.status, 0)
    assert.match(resTag.stderr, /tag v0\.7\.2 already exists/)
  })

  test('rule 6: package-lock.json with same version dependency changes only the two expected places; aborts if exactly two not found', () => {
    // 1. Dependency having same version 0.7.1: only the two expected places change
    setupFixture({
      extraSetup: dir => {
        const lockPath = path.join(dir, 'package-lock.json')
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
        lock.packages['node_modules/some-dep'] = {
          name: 'some-dep',
          version: '0.7.1',
        }
        writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
      },
    })

    const res = runRelease('0.7.2')
    assert.equal(res.status, 0, res.stderr || res.stdout)

    // Verify package-lock diff changed exactly 2 lines
    const lockDiffLines = git(local, 'diff', 'HEAD~1', '--', 'package-lock.json')
      .stdout.trim()
      .split(/\r?\n/)
      .filter(l => l.startsWith('+') || l.startsWith('-'))
      .filter(l => !l.startsWith('+++') && !l.startsWith('---'))
    assert.equal(lockDiffLines.length, 4, 'Only the two expected places changed')

    const parsedLock = JSON.parse(readFileSync(path.join(local, 'package-lock.json'), 'utf8'))
    assert.equal(parsedLock.version, '0.7.2')
    assert.equal(parsedLock.packages[''].version, '0.7.2')
    assert.equal(parsedLock.packages['node_modules/some-dep'].version, '0.7.1')

    // 2. If it does not find exactly two expected places, abort and restore
    setupFixture({
      extraSetup: dir => {
        const lockPath = path.join(dir, 'package-lock.json')
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
        lock.version = '0.7.0' // does not match old version
        writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
      },
    })

    const resBad = runRelease('0.7.2')
    assert.notEqual(resBad.status, 0)
    assert.match(resBad.stderr, /package-lock\.json: expected exactly two occurrences/)

    // Restores to main, clean, no release branch
    assert.equal(git(local, 'branch', '--show-current').stdout.trim(), 'main')
    assert.equal(git(local, 'status', '--porcelain').stdout.trim(), '')
    assert.ok(!git(local, 'branch').stdout.includes('release-0.7.2'))
  })

  test('rule 7: suite red after bump aborts with tail of output, restores files, returns to main and deletes release-X.Y.Z', () => {
    // Suite outputs lines and fails
    const failingSuite = 'node -e "for(let i=1; i<=30; i++) console.log(\'log-line-\' + i); console.error(\'SUITE-FAILED-CRITICALLY\'); process.exit(1)"'
    setupFixture({ suite: failingSuite })

    const res = runRelease('0.7.2')
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /SUITE-FAILED-CRITICALLY/)
    assert.match(res.stderr, /log-line-30/)
    assert.match(res.stderr, /Aborting and restoring repo to main/)

    // Returned to main, clean, no release branch, nothing committed
    assert.equal(git(local, 'branch', '--show-current').stdout.trim(), 'main')
    assert.equal(git(local, 'status', '--porcelain').stdout.trim(), '')
    assert.ok(!git(local, 'branch').stdout.includes('release-0.7.2'))
    assert.equal(git(local, 'log', '-1', '--format=%s').stdout.trim(), 'initial commit')
    assert.equal(JSON.parse(readFileSync(path.join(local, 'package.json'), 'utf8')).version, '0.7.1')
  })

  test('rule 8: git fetch fails (no network) refuses before touching anything', () => {
    setupFixture()
    git(local, 'remote', 'set-url', 'origin', path.join(baseDir, 'nonexistent-remote'))

    const res = runRelease('0.7.2')
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /git fetch failed; cannot prove base is current/)

    // Repo clean on main, no release branch
    assert.equal(git(local, 'branch', '--show-current').stdout.trim(), 'main')
    assert.equal(git(local, 'status', '--porcelain').stdout.trim(), '')
    assert.ok(!git(local, 'branch').stdout.includes('release-0.7.2'))
  })

  test('rule 9: called twice at the same time finds branch or dirty tree and refuses', () => {
    setupFixture()

    // First run creates release-0.7.2
    const firstRes = runRelease('0.7.2')
    assert.equal(firstRes.status, 0)

    // Second run while on release-0.7.2
    const secondRes = runRelease('0.7.2')
    assert.notEqual(secondRes.status, 0)
    assert.match(secondRes.stderr, /current branch is "release-0\.7\.2", must be "main"/)

    // What if back on main, but branch release-0.7.2 exists?
    git(local, 'checkout', 'main')
    const thirdRes = runRelease('0.7.2')
    assert.notEqual(thirdRes.status, 0)
    assert.match(thirdRes.stderr, /branch release-0\.7\.2 already exists/)
  })

  test('finding 1: restore failure reports RESTORE INCOMPLETE with manual steps and exits with code 2', () => {
    // Failing suite creates index.lock (simulating locked file during checkout) and exits 1
    const failingSuite = 'node -e "const fs = require(\'node:fs\'); fs.writeFileSync(\'.git/index.lock\', \'\'); process.exit(1)"'
    setupFixture({ suite: failingSuite })

    const res = runRelease('0.7.2')
    assert.equal(res.status, 2)
    assert.match(res.stderr, /RESTORE INCOMPLETE/)
    assert.match(res.stderr, /Manual commands to restore repository:/)
    assert.match(res.stderr, /git checkout -f main/)
    assert.match(res.stderr, /git branch -D release-0\.7\.2/)
  })

  test('finding 2: status.showUntrackedFiles=no refuses on untracked file and file survives', () => {
    setupFixture()
    git(local, 'config', 'status.showUntrackedFiles', 'no')
    const untrackedPath = path.join(local, 'untracked-custom.txt')
    writeFileSync(untrackedPath, 'precious untracked work\n')

    const res = runRelease('0.7.2')
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /uncommitted changes in working tree/)
    assert.match(res.stderr, /untracked-custom\.txt/)

    // File survives
    assert.equal(readFileSync(untrackedPath, 'utf8'), 'precious untracked work\n')
    assert.equal(git(local, 'branch', '--show-current').stdout.trim(), 'main')
  })

  test('issue 76 rule 1 and rule 3: repo package.json at 0.7.2 (release run, or after v0.7.2 merges) still starts the fixture at 0.7.1 and releases 0.7.2', () => {
    setupFixture({ repoVersion: '0.7.2' })
    assert.equal(JSON.parse(readFileSync(path.join(local, 'package.json'), 'utf8')).version, '0.7.1')
    assert.ok(readFileSync(path.join(local, 'README.md'), 'utf8').includes('v0.7.1'))
    assert.ok(!readFileSync(path.join(local, 'docs', 'guia-setup.md'), 'utf8').includes('v0.7.2'))

    const res = runRelease('0.7.2')
    assert.equal(res.status, 0, res.stderr || res.stdout)
    assert.match(res.stdout, /Release v0\.7\.2 committed on branch release-0\.7\.2/)
  })

  test('issue 76 rule 2: repo package.json at 0.7.1 (current main) still releases 0.7.2', () => {
    setupFixture({ repoVersion: '0.7.1' })

    const res = runRelease('0.7.2')
    assert.equal(res.status, 0, res.stderr || res.stdout)
    assert.match(res.stdout, /Release v0\.7\.2 committed on branch release-0\.7\.2/)
  })

  test('finding 3: suite with output larger than 1 MiB completes without buffer overflow', () => {
    // Generate ~2 MiB of stdout in the test suite
    const bigOutputSuite = 'node -e "for(let i=0; i<40000; i++) process.stdout.write(\'01234567890123456789012345678901234567890123456789\\n\'); process.exit(0)"'
    setupFixture({ suite: bigOutputSuite })

    const res = runRelease('0.7.2')
    assert.equal(res.status, 0, res.stderr || res.stdout)
    assert.match(res.stdout, /Release v0\.7\.2 committed on branch release-0\.7\.2/)
    assert.equal(git(local, 'branch', '--show-current').stdout.trim(), 'release-0.7.2')
  })
})
