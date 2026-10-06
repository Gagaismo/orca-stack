import assert from 'node:assert/strict'
import { chmodSync, existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { REVIEW_SECTIONS, trimReviewSections } from '../src/gentle.mjs'
import { backups, cleanup, cli, read, snapshot, tempDir, write } from './helpers.mjs'

// Mirrors the headings of the block gentle-ai writes (the review sections sit between kept ones).
const KEPT = [
  '## Engram Persistent Memory',
  '# Agent Teams Lite',
  '#### SDD Edit-Authority Consent Relay (MANDATORY)',
  '### Language Domain Contract',
  '### Delegation Rules',
  '#### Mandatory Delegation Triggers',
  '#### Cost and Context Balance',
  '### Research and Pre-Proposal Gate (MANDATORY)',
  '## Model Assignments',
  '## SDD Workflow (lazy-loaded)',
]
const fixture = eol =>
  [
    '## Engram Persistent Memory',
    'engram body',
    '',
    '<!-- gentle-ai:sdd-orchestrator -->',
    '# Agent Teams Lite',
    'intro',
    '### Lossless Blocking Prompts (MANDATORY)',
    'lossless body',
    '#### Gentle AI Provider Defect Handoff (MANDATORY)',
    'defect body',
    '',
    '#### SDD Edit-Authority Consent Relay (MANDATORY)',
    'consent body',
    '### Language Domain Contract',
    'language body',
    '### Delegation Rules',
    'rules body',
    '#### Mandatory Delegation Triggers',
    'triggers body',
    '#### Delegated Verification Gate (MANDATORY)',
    'gate body',
    '#### Native Checking Contract',
    'checking body',
    '#### Review Execution Contract',
    '# Native Compact Review Orchestration',
    '## Entry rule',
    'entry body',
    '### Cross-repository lifecycle root',
    '<!-- authority-first-terminal-procedure:start -->',
    '### Authority-First Terminal Procedure',
    'table',
    '<!-- authority-first-terminal-procedure:end -->',
    '```',
    '# not a heading, inside a fence',
    '```',
    '## Delivery follows ordinary repository policy',
    '### Concurrent Reviewer Group (MANDATORY)',
    'concurrent body',
    '#### Cost and Context Balance',
    'cost body',
    '### Research and Pre-Proposal Gate (MANDATORY)',
    'research body',
    '<!-- gentle-ai:sdd-model-assignments -->',
    '## Model Assignments',
    'models body',
    '<!-- /gentle-ai:sdd-model-assignments -->',
    '## SDD Workflow (lazy-loaded)',
    'workflow body',
    '<!-- /gentle-ai:sdd-orchestrator -->',
    '',
  ].join(eol)

const headings = text => text.split(/\r?\n/).filter(line => /^#{1,6} /.test(line))

describe('trimReviewSections', () => {
  test('removes exactly the five review sections and keeps every other heading and marker', () => {
    const { text, removed } = trimReviewSections(fixture('\n'))
    assert.deepEqual(headings(text), [...KEPT.slice(0, 2), '### Lossless Blocking Prompts (MANDATORY)', ...KEPT.slice(2)])
    for (const gone of REVIEW_SECTIONS) {
      assert.ok(!text.includes(gone), gone)
    }
    for (const kept of KEPT) {
      assert.ok(text.includes(kept), kept)
    }
    for (const body of ['lossless body', 'consent body', 'language body', 'triggers body', 'cost body', 'research body', 'models body', 'workflow body', 'engram body']) {
      assert.ok(text.includes(body), body)
    }
    for (const body of ['defect body', 'gate body', 'checking body', 'entry body', 'table', 'concurrent body', 'inside a fence', 'authority-first']) {
      assert.ok(!text.includes(body), body)
    }
    for (const marker of ['<!-- gentle-ai:sdd-orchestrator -->', '<!-- /gentle-ai:sdd-orchestrator -->', '<!-- gentle-ai:sdd-model-assignments -->', '<!-- /gentle-ai:sdd-model-assignments -->']) {
      assert.ok(text.includes(marker), marker)
    }
    assert.equal(removed, Buffer.byteLength(fixture('\n')) - Buffer.byteLength(text))
    assert.ok(removed > 0)
  })

  test('is idempotent', () => {
    const once = trimReviewSections(fixture('\n')).text
    assert.deepEqual(trimReviewSections(once), { text: once, removed: 0 })
  })

  test('keeps CRLF files CRLF', () => {
    const { text } = trimReviewSections(fixture('\r\n'))
    assert.ok(!/[^\r]\n/.test(text), 'no bare LF')
    assert.ok(!text.includes('gate body'))
  })

  test('leaves a text without the block, or with an endless Review Execution Contract, untouched', () => {
    const plain = '## Engram Persistent Memory\n#### Native Checking Contract\nbody\n'
    assert.deepEqual(trimReviewSections(plain), { text: plain, removed: 0 })
    const broken = fixture('\n').replace('#### Cost and Context Balance', '#### Something else')
    assert.deepEqual(trimReviewSections(broken), { text: broken, removed: 0 })
  })
})

// A fake `gentle-ai` first in the PATH, answering the RDD status the test asks for.
const fakeGentle = (dir, mode) => {
  const win = process.platform === 'win32'
  const file = path.join(dir, win ? 'gentle-ai.cmd' : 'gentle-ai')
  write(file, win ? `@echo receipt-driven development: ${mode} (decided by default)\r\n` : `#!/bin/sh\necho "receipt-driven development: ${mode} (decided by default)"\n`)
  if (!win) {
    chmodSync(file, 0o755)
  }
}
const withPath = bin => {
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH'

  return { [key]: `${bin}${path.delimiter}${process.env[key]}` }
}

describe('global trims the gentle-ai review sections', () => {
  let home
  let bin
  beforeEach(() => {
    home = tempDir('trim-home')
    bin = tempDir('trim-bin')
  })
  afterEach(() => {
    cleanup(home)
    cleanup(bin)
  })
  const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md')

  test('RDD off: trims with a backup, reports the KB, and a second run changes nothing', () => {
    fakeGentle(bin, 'off')
    write(claudeMd(), fixture('\n'))
    const first = cli(home, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
    assert.equal(first.status, 0, first.out)
    assert.match(first.out, /KB menos en cada sesión/)
    assert.match(first.out, /gentle-ai sync/)
    assert.ok(!read(claudeMd()).includes('Native Checking Contract'))
    assert.match(read(claudeMd()), /orca-stack:begin/)
    const saved = backups(home).filter(name => name.endsWith('CLAUDE.md'))
    assert.equal(saved.length, 1)
    assert.equal(read(path.join(home, saved[0])), fixture('\n'))
    const after = snapshot(home)
    const second = cli(home, ['global', '--skip-pi', '--humano', 'Ana'], { env: withPath(bin) })
    assert.equal(second.status, 0, second.out)
    assert.match(second.out, /ya están recortadas/)
    assert.deepEqual(snapshot(home), after)
  })

  test('--dry-run reports the trim and writes nothing', () => {
    fakeGentle(bin, 'off')
    write(claudeMd(), fixture('\n'))
    const before = snapshot(home)
    const result = cli(home, ['global', '--dry-run', '--skip-pi'], { env: withPath(bin) })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\[simulación\] actualizo .*sin las secciones de review/)
    assert.deepEqual(snapshot(home), before)
  })

  test('RDD on: skips and says why', () => {
    fakeGentle(bin, 'on')
    write(claudeMd(), fixture('\n'))
    const result = cli(home, ['global', '--skip-pi'], { env: withPath(bin) })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /RDD\) está prendido/)
    assert.ok(read(claudeMd()).includes('Native Checking Contract'))
    assert.equal(existsSync(path.join(home, '.orca-stack')), true)
  })
})
