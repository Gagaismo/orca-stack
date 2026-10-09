import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { ROOT } from './helpers.mjs'

test('npm install leaves a fresh checkout clean using the committed lockfile', () => {
  const trackedLockfile = spawnSync('git', ['ls-files', '--error-unmatch', 'package-lock.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(trackedLockfile.status, 0, 'package-lock.json must be committed in the repository')

  const checkout = mkdtempSync(path.join(os.tmpdir(), 'orca-stack-npm-install-'))
  try {
    copyFileSync(path.join(ROOT, 'package.json'), path.join(checkout, 'package.json'))
    copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(checkout, 'package-lock.json'))
    assert.equal(JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8')).dependencies, undefined)

    const git = (...args) => spawnSync('git', args, { cwd: checkout, encoding: 'utf8' })
    assert.equal(git('init', '-q').status, 0)
    assert.equal(git('add', 'package.json', 'package-lock.json').status, 0)
    assert.equal(git('-c', 'user.name=orca-stack test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture').status, 0)

    const npm = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm install'], { cwd: checkout, encoding: 'utf8' })
      : spawnSync('npm', ['install'], { cwd: checkout, encoding: 'utf8' })
    assert.equal(npm.status, 0, npm.stdout + npm.stderr)
    const status = git('status', '--short')
    assert.equal(status.status, 0, status.stderr)
    assert.equal(status.stdout, '')
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
})
