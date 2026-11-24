import assert from 'node:assert/strict'
import { copyFileSync, existsSync, linkSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { AST_GREP_PLATFORMS, AST_GREP_VERSION, platformKey, runAstGrep, runAstGrepJson, verifyAstGrep } from '../src/ast-grep.mjs'
import { cleanup, tempDir } from './helpers.mjs'

const withDir = run => {
  const dir = tempDir('ast-grep')
  try {
    return run(dir)
  } finally {
    cleanup(dir)
  }
}

const COMMENT_RULE = 'id: comment\nlanguage: javascript\nrule:\n  kind: comment'
const pinned = AST_GREP_PLATFORMS[platformKey()]

describe('pinned ast-grep wrapper (#419)', () => {
  test('S9: the version is pinned to 0.51.3 with a sha256 for win32-x64 and linux-x64', () => {
    assert.equal(AST_GREP_VERSION, '0.51.3')
    assert.equal(AST_GREP_PLATFORMS['win32-x64'].package, '@ast-grep/cli-win32-x64-msvc')
    assert.equal(AST_GREP_PLATFORMS['linux-x64'].package, '@ast-grep/cli-linux-x64-gnu')
    for (const entry of Object.values(AST_GREP_PLATFORMS)) assert.match(entry.sha256, /^[0-9a-f]{64}$/)
  })

  test('S9: a checksum mismatch fails naming 0.51.3 and never runs the binary', () => {
    withDir(dir => {
      // A real executable (node) under the override path: if the wrapper ran it unverified, it would write the marker.
      const fake = path.join(dir, path.basename(pinned?.binary ?? 'ast-grep'))
      try {
        linkSync(process.execPath, fake)
      } catch {
        copyFileSync(process.execPath, fake)
      }
      const marker = path.join(dir, 'ran')
      const env = { ...process.env, ORCA_STACK_AST_GREP: fake }
      const args = ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`]
      assert.throws(() => runAstGrep(args, { env }), error => {
        assert.match(error.message, /ast-grep 0\.51\.3/)
        assert.match(error.message, /checksum/)
        assert.match(error.message, /no se ejecutó/)
        return true
      })
      assert.equal(existsSync(marker), false, 'the unverified binary ran')
    })
  })

  test('S9: a missing binary fails naming 0.51.3 and how to install it', () => {
    withDir(dir => {
      const env = { ...process.env, ORCA_STACK_AST_GREP: path.join(dir, 'missing', 'ast-grep') }
      assert.throws(() => verifyAstGrep({ env }), error => {
        assert.match(error.message, /ast-grep 0\.51\.3/)
        assert.match(error.message, /npm ci/)
        return true
      })
    })
  })

  test('S9: a platform without a pinned binary fails naming 0.51.3', () => {
    assert.throws(() => verifyAstGrep({ platform: 'sunos', arch: 'sparc' }), /ast-grep 0\.51\.3.*sunos-sparc/)
  })

  test('S9: the pinned binary verifies and finds the comments of a JS snippet from any cwd', { skip: !pinned && `no pinned ast-grep for ${platformKey()}` }, () => {
    withDir(dir => {
      const env = { ...process.env }
      delete env.ORCA_STACK_AST_GREP
      const file = verifyAstGrep({ env })
      assert.equal(path.basename(file), pinned.binary)
      const input = 'const a = 1 // note\nconst s = "// not a comment"\n'
      const found = runAstGrepJson(['scan', '--inline-rules', COMMENT_RULE, '--stdin', '--json=compact'], { input, cwd: dir, env })
      assert.deepEqual(found.map(match => match.text), ['// note'])
    })
  })

  test('S9: a non-zero exit of ast-grep is an error with its stderr', { skip: !pinned && `no pinned ast-grep for ${platformKey()}` }, () => {
    const env = { ...process.env }
    delete env.ORCA_STACK_AST_GREP
    assert.throws(() => runAstGrep(['run', '--bogus'], { env }), /ast-grep 0\.51\.3 terminó con código 2[\s\S]*--bogus/)
  })
})
