import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { citedPaths, missingPaths, renderBrief } from '../src/despacho.mjs'
import { ROOT, backups, cleanup, cli, read, snapshot, tempDir } from './helpers.mjs'

const SKILLS = path.join(ROOT, 'assets', 'skills')
const readSkill = (...parts) => readFileSync(path.join(...parts), 'utf8').replace(/\r\n/g, '\n')
const sha256 = text => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
const provenance = JSON.parse(readSkill(SKILLS, 'pstack-upstream.json'))
const skill = name => readSkill(SKILLS, name, 'SKILL.md')

describe('vendored pstack principles (upstream v0.15.24)', () => {
  test('rule 1: every vendored SKILL.md matches upstream at the pinned commit, changing one byte makes the hash test fail, naming the skill', () => {
    const vendored = readdirSync(SKILLS).filter(name => name.startsWith('principle-') && statSync(path.join(SKILLS, name)).isDirectory())
    assert.deepEqual(vendored.sort(), Object.keys(provenance.skills).sort())
    for (const [name, entry] of Object.entries(provenance.skills)) {
      assert.equal(entry.adapted, false, `${name} must not be adapted`)
      assert.equal(sha256(skill(name)), entry.upstreamSha256, `${name} differs from upstream v0.15.24`)
      // Corrupting one byte must fail naming the skill
      const corrupted = skill(name) + ' '
      assert.throws(() => {
        assert.equal(sha256(corrupted), entry.upstreamSha256, `${name} differs from upstream v0.15.24`)
      }, new RegExp(name))
    }
  })

  test('rule 2: every copy keeps disable-model-invocation: true, negative: no copy drops the flag or loads by name', () => {
    for (const name of Object.keys(provenance.skills)) {
      const text = skill(name)
      assert.match(text, /^disable-model-invocation:\s*true$/m, `${name} missing disable-model-invocation: true`)
      assert.doesNotMatch(text, /^disable-model-invocation:\s*false$/m, `${name} has disable-model-invocation: false`)
    }
    for (const file of ['brief-ticket.md', 'brief-rebote.md', 'brief-revision.md', 'CONTRATO.md', 'ORCA-STACK.md', 'ROLE-BRIEFS.md']) {
      const content = read(path.join(ROOT, 'assets', 'stack', file))
      assert.doesNotMatch(content, /(?:^|\s)\/principle-/, `${file} must not invoke principles by slash command`)
      assert.doesNotMatch(content, /--skill\s+principle-/, `${file} must not load principles by name`)
    }
  })

  test('rule 3: every LICENSE reads Copyright (c) 2026 Lauren Tan', () => {
    for (const name of Object.keys(provenance.skills)) {
      const license = readSkill(SKILLS, name, 'LICENSE')
      assert.match(license, /Copyright \(c\) 2026 Lauren Tan/, `${name} LICENSE must credit Lauren Tan`)
      assert.doesNotMatch(license, /poteto/i, `${name} LICENSE must use real name, not handle`)
    }
  })

  test('rule 4: a brief rendered by despachar for claude, codex, agy or pi carries the read-by-path lines, and despachar cited-path check does not refuse ~', () => {
    for (const agent of ['claude', 'codex', 'agy', 'pi']) {
      const brief = renderBrief('ticket', { AGENT: agent, ISSUE: '160', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
      assert.ok(brief.includes('read `~/.claude/skills/principle-make-operations-idempotent/SKILL.md`'), `${agent} brief missing make-operations-idempotent`)
      assert.ok(brief.includes('read `~/.claude/skills/principle-attack-the-premise/SKILL.md`'), `${agent} brief missing attack-the-premise`)
      assert.ok(brief.includes('read `~/.claude/skills/principle-explain-the-number/SKILL.md`'), `${agent} brief missing explain-the-number`)
      const paths = citedPaths(brief)
      assert.ok(!paths.some(p => p.startsWith('~')), 'citedPaths must skip paths starting with ~')
      const missing = missingPaths(brief, () => false)
      assert.ok(!missing.some(p => p.includes('principle-')), 'missingPaths must not flag ~ paths as missing repo paths')
    }
  })

  test("rule 5: each trigger line names its condition as in the table, and the line in step 8 sits in main's cycle", () => {
    const ticketBrief = read(path.join(ROOT, 'assets', 'stack', 'brief-ticket.md'))
    const bounceBrief = read(path.join(ROOT, 'assets', 'stack', 'brief-rebote.md'))
    const roleBriefs = read(path.join(ROOT, 'assets', 'stack', 'ROLE-BRIEFS.md'))
    const contract = read(path.join(ROOT, 'assets', 'stack', 'CONTRATO.md'))

    // 1. make-operations-idempotent in implementation brief, Rules
    assert.match(ticketBrief, /The ticket touches a command, lifecycle step or loop that can run again after a crash, retry or rerun:\s*read `~\/\.claude\/skills\/principle-make-operations-idempotent\/SKILL\.md`\./)
    // 2. attack-the-premise in implementation brief, Rules
    assert.match(ticketBrief, /Two fixes sharing one premise have failed the same check; apply it before a third:\s*read `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    // 3. attack-the-premise in bounce brief, Work
    assert.match(bounceBrief, /The PR already bounced and the new failure shares the previous fix's premise:\s*read `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    // 4. attack-the-premise in CONTRATO.md step 8 (main)
    const cycle = contract.split('### Ciclo de `main`')[1].split('\n### Verificación')[0]
    const step8 = cycle.split('\n').find(line => line.startsWith('8. '))
    assert.ok(step8, 'step 8 not found in Ciclo de main')
    assert.match(step8, /Before deciding what still stands after the second review or CI round, or passing it to the human:\s*read `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    // 5. explain-the-number in role briefs, Research worker
    const researchWorker = roleBriefs.split('## Research worker')[1].split('## ')[0]
    assert.match(researchWorker, /The answer is a measured number:\s*read `~\/\.claude\/skills\/principle-explain-the-number\/SKILL\.md`\./)
    // 6. explain-the-number in implementation brief, Evidencia
    const evidenciaSection = ticketBrief.split('## Evidencia')[1].split('## Merge Danger')[0]
    assert.match(evidenciaSection, /A row's evidence is a measured number \(time, size, throughput, cost\):\s*read `~\/\.claude\/skills\/principle-explain-the-number\/SKILL\.md`\./)
    // 7. explain-the-number in CONTRATO.md (main)
    assert.match(cycle, /Before acting on a measured number from research, an Evidencia table or a retro:\s*read `~\/\.claude\/skills\/principle-explain-the-number\/SKILL\.md`\./)
  })

  test('rule 6: the review brief has no principle line', () => {
    const reviewBrief = read(path.join(ROOT, 'assets', 'stack', 'brief-revision.md'))
    assert.doesNotMatch(reviewBrief, /principle-/)
  })

  test('rule 7: running orca-stack global twice leaves one copy of each skill', () => {
    const home = tempDir('pstack-global')
    try {
      const first = cli(home, ['global', '--skip-pi'])
      assert.equal(first.status, 0, first.out)
      for (const root of ['.claude', '.agents']) {
        for (const name of Object.keys(provenance.skills)) {
          assert.ok(existsSync(path.join(home, root, 'skills', name, 'SKILL.md')), `${name} SKILL.md missing in ${root}`)
          assert.ok(existsSync(path.join(home, root, 'skills', name, 'LICENSE')), `${name} LICENSE missing in ${root}`)
        }
      }
      const snap1 = snapshot(home)
      const second = cli(home, ['global', '--skip-pi'])
      assert.equal(second.status, 0, second.out)
      const snap2 = snapshot(home)
      assert.deepEqual(snap2, snap1)
      assert.deepEqual(backups(home), [])
    } finally {
      cleanup(home)
    }
  })

  test('provenance manifest and README credit row match', () => {
    assert.equal(provenance.repo, 'https://github.com/cursor/plugins')
    assert.equal(provenance.version, '0.15.24')
    assert.match(provenance.commit, /^[0-9a-f]{40}$/)
    const row = read(path.join(ROOT, 'README.md')).split('\n').find(line => line.startsWith('| Skills `principle-'))
    assert.ok(row, 'README has no pstack row in "Origen y licencias"')
    assert.ok(row.includes('0.15.24') && row.includes(provenance.commit.slice(0, 7)), row)
    assert.ok(row.includes('assets/skills/pstack-upstream.json'), row)
    assert.ok(row.includes('Lauren Tan'), row)
  })

  test('PRESERVE: public entry despachar renders valid briefs without path rejection', () => {
    const brief = renderBrief('ticket', { AGENT: 'agy', ISSUE: '160', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
    assert.ok(brief.startsWith('# Ticket brief: issue #160 (orca-stack)'))
    assert.ok(brief.includes('## Setup'))
    assert.ok(brief.includes('## Verification'))
    assert.ok(brief.includes('## Pull request'))
    assert.ok(brief.includes('## Rules'))
    assert.ok(brief.includes('## Remote authorization'))
    assert.ok(brief.includes('## Method: gentle-ai ODD'))
  })
})
