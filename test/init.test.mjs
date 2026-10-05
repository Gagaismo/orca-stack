import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { backups, cleanup, cli, git, read, snapshot, tempDir, write } from './helpers.mjs'

let home
let repo
beforeEach(() => {
  home = tempDir('home')
  repo = path.join(tempDir('repo'), 'proyecto')
  write(path.join(repo, 'README.md'), '# proyecto\n')
  git(repo, 'init', '-q', '-b', 'main')
})
afterEach(() => {
  cleanup(home)
  cleanup(path.dirname(repo))
})

const run = (...args) => cli(home, ['init', ...args], { cwd: repo })

describe('init', () => {
  test('--dry-run writes nothing', () => {
    const before = snapshot(repo)
    const result = run('--dry-run')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\[simulación\]/)
    assert.deepEqual(snapshot(repo), before)
  })

  test('creates the blocks, the two config files and the .gitignore entry, with portable paths only', () => {
    const result = run()
    assert.equal(result.status, 0, result.out)
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const text = read(path.join(repo, file))
      assert.match(text, /<!-- orca-stack:begin -->[\s\S]*<!-- orca-stack:end -->/, file)
      assert.ok(text.includes('~/orca/stack/ORCA-STACK.md'), file)
      assert.ok(!text.includes(home), `${file} must not contain the home path`)
      assert.doesNotMatch(text, /[A-Z]:\\Users\\|\/Users\/|\/home\//, file)
    }
    assert.match(read(path.join(repo, 'CLAUDE.md')), /AGENTS\.md/)
    assert.deepEqual(JSON.parse(read(path.join(repo, '.orca-stack.json'))), { version: 1 })
    // Empty: any list here would replace the committed and personal ones (lists are not merged).
    assert.deepEqual(JSON.parse(read(path.join(repo, '.orca-stack.local.json'))), {})
    assert.ok(read(path.join(repo, '.gitignore')).split(/\r?\n/).includes('.orca-stack.local.json'))
  })

  test('is idempotent and never overwrites an existing config', () => {
    run()
    write(path.join(repo, '.orca-stack.json'), '{"despacho":{"script":"scripts/x.sh"}}\n')
    const before = snapshot(repo)
    const second = run()
    assert.equal(second.status, 0, second.out)
    assert.deepEqual(snapshot(repo), before)
    assert.deepEqual(backups(home), [])
    const ignore = read(path.join(repo, '.gitignore')).split(/\r?\n/).filter(line => line === '.orca-stack.local.json')
    assert.equal(ignore.length, 1)
  })

  test('keeps existing AGENTS.md content and appends .gitignore without losing lines', () => {
    write(path.join(repo, 'AGENTS.md'), '# Contrato\n\nReglas propias.\n')
    write(path.join(repo, '.gitignore'), 'node_modules/')
    run()
    const agents = read(path.join(repo, 'AGENTS.md'))
    assert.ok(agents.startsWith('# Contrato\n\nReglas propias.\n'))
    assert.equal(read(path.join(repo, '.gitignore')), 'node_modules/\n.orca-stack.local.json\n')
    assert.equal(backups(home).filter(b => b.includes('AGENTS.md')).length, 1)
  })

  test('a CLAUDE.md that only points at AGENTS.md gets the short pointer', () => {
    write(path.join(repo, 'CLAUDE.md'), '# CLAUDE.md\n\nEl contrato de trabajo es AGENTS.md. Leelo entero.\n')
    run()
    const text = read(path.join(repo, 'CLAUDE.md'))
    assert.ok(text.startsWith('# CLAUDE.md'))
    const block = text.slice(text.indexOf('<!-- orca-stack:begin -->'))
    assert.ok(block.split('\n').length < 8, 'short block')
    assert.match(block, /AGENTS\.md/)
  })

  test('a CLAUDE.md with real content gets the full block', () => {
    write(path.join(repo, 'CLAUDE.md'), Array.from({ length: 20 }, (_, i) => `Regla ${i}`).join('\n') + '\n')
    run()
    assert.match(read(path.join(repo, 'CLAUDE.md')), /Orca runtime\/active Dispatch/)
  })

  test('fails clearly outside a git repo', () => {
    const outside = tempDir('outside')
    try {
      const result = cli(home, ['init'], { cwd: outside })
      assert.equal(result.status, 1)
      assert.match(result.out, /no es un repo de git/)
      assert.equal(existsSync(path.join(outside, 'AGENTS.md')), false)
    } finally {
      cleanup(outside)
    }
  })
})
