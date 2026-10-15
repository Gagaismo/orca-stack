import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import { PACKAGE_ROOT } from '../src/util.mjs'

const forbiddenSelector = /--worktree\s*['"`]?\s*(?:,\s*['"`]?|\s+)(?:issue|branch)\s*:/i
const temporary = []

const filesUnder = (root, relative = '') => {
  const absolute = path.join(root, relative)
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) return filesUnder(root, child)
    return [child]
  })
}

const scanFiles = files => files.flatMap(file => {
  if (/\.test\.[^./\\]+$/i.test(file) || /(^|[\\/])mods[\\/].*[\\/]tests[\\/]/i.test(file)) return []
  const text = readFileSync(file, 'utf8')
  return forbiddenSelector.test(text) ? [file] : []
})

const repositorySources = root => {
  const files = ['README.md', 'AGENTS.md']
  for (const directory of ['src', 'bin', 'scripts', 'assets', 'mods', 'docs']) {
    const absolute = path.join(root, directory)
    try {
      files.push(...filesUnder(root, directory).map(file => path.join(root, file)))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return files.filter(file => !file.endsWith(path.sep + 'AGENTS.md') || path.dirname(file) === root)
}

test('Rule 12: repository source, templates, and docs contain no global issue or branch worktree selectors', () => {
  assert.deepEqual(scanFiles(repositorySources(PACKAGE_ROOT)), [])
})

test('Rule 13: selector scan detects an argv-form branch selector in a temporary file', () => {
  const file = path.join(os.tmpdir(), `orca-worktree-selector-${process.pid}-${Date.now()}.txt`)
  temporary.push(file)
  writeFileSync(file, 'orca worktree rm --worktree branch:x')
  assert.deepEqual(scanFiles([file]), [file])
  writeFileSync(file, "['--worktree', `issue:${n}`]")
  assert.deepEqual(scanFiles([file]), [file])
  rmSync(file, { force: true })
})

afterEach(() => {
  for (const file of temporary.splice(0)) rmSync(file, { force: true })
})
