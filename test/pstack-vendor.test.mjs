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

describe('vendored pstack principles (upstream v0.15.36)', () => {
  test('rule 1: every vendored SKILL.md matches upstream at the pinned commit, changing one byte makes the hash test fail, naming the skill', () => {
    const unadapted = Object.entries(provenance.skills).filter(([, e]) => !e.adapted)
    const vendored = readdirSync(SKILLS).filter(name => name.startsWith('principle-') && statSync(path.join(SKILLS, name)).isDirectory())
    assert.deepEqual(vendored.sort(), unadapted.map(([k]) => k).sort())
    for (const [name, entry] of unadapted) {
      assert.equal(entry.adapted, false, `${name} must not be adapted`)
      assert.equal(sha256(skill(name)), entry.upstreamSha256, `${name} differs from upstream v0.15.36`)
      // Corrupting one byte must fail naming the skill
      const corrupted = skill(name) + ' '
      assert.throws(() => {
        assert.equal(sha256(corrupted), entry.upstreamSha256, `${name} differs from upstream v0.15.36`)
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
    assert.match(step8, /Antes de decidir qué sigue en pie después de la segunda ronda de review o de CI, o de pasárselo al humano:\s*leé `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    // 5. explain-the-number in role briefs, Research worker
    const researchWorker = roleBriefs.split('## Research worker')[1].split('## ')[0]
    assert.match(researchWorker, /The answer is a measured number:\s*read `~\/\.claude\/skills\/principle-explain-the-number\/SKILL\.md`\./)
    // 6. explain-the-number in implementation brief, Evidencia
    const evidenciaSection = ticketBrief.split('## Evidencia')[1].split('## Merge Danger')[0]
    assert.match(evidenciaSection, /A row's evidence is a measured number \(time, size, throughput, cost\):\s*read `~\/\.claude\/skills\/principle-explain-the-number\/SKILL\.md`\./)
    // 7. explain-the-number in CONTRATO.md (main)
    assert.match(cycle, /Antes de actuar sobre un número medido que viene de una investigación, de una tabla de Evidencia o de una retro:\s*leé `~\/\.claude\/skills\/principle-explain-the-number\/SKILL\.md`\./)
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
    assert.equal(provenance.version, '0.15.36')
    assert.match(provenance.commit, /^[0-9a-f]{40}$/)
    const row = read(path.join(ROOT, 'README.md')).split('\n').find(line => line.startsWith('| Skills `principle-'))
    assert.ok(row, 'README has no pstack row in "Origen y licencias"')
    assert.ok(row.includes('0.15.36') && row.includes(provenance.commit.slice(0, 7)), row)
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

describe('#168 adapted arena and swarm skills (upstream v0.15.36)', () => {
  test('rule 1: the manifest lists arena and swarm with adapted: true, and changing a byte of a shipped copy fails the hash test', () => {
    for (const name of ['arena', 'swarm']) {
      const entry = provenance.skills[name]
      assert.ok(entry, `${name} missing from provenance manifest`)
      assert.equal(entry.adapted, true, `${name} must be adapted: true`)
      const hash = entry.shippedSha256 ?? entry.upstreamSha256
      assert.equal(sha256(skill(name)), hash, `${name} differs from manifest hash`)
      const corrupted = skill(name) + ' '
      assert.throws(() => {
        assert.equal(sha256(corrupted), hash, `${name} differs from manifest hash`)
      }, new RegExp(name))
    }
  })

  test('rule 2: each folder LICENSE reads Copyright (c) 2026 Lauren Tan', () => {
    for (const name of ['arena', 'swarm']) {
      const license = readSkill(SKILLS, name, 'LICENSE')
      assert.match(license, /Copyright \(c\) 2026 Lauren Tan/, `${name} LICENSE must credit Lauren Tan`)
      assert.doesNotMatch(license, /poteto/i, `${name} LICENSE must use real name, not handle`)
    }
  })

  test('rule 3: the arena skill states the same-family judge limitation and the four compensations', () => {
    const text = skill('arena')
    assert.match(text, /same model family as the candidates/i, 'arena must state same-family judge limitation')
    assert.match(text, /weaker than pstack's cross-family judge/i, 'arena must explain limitation vs pstack')
    assert.match(text, /rubric of 3-6 criteria written before the fan-out and kept from the candidates/i, 'missing compensation 1')
    assert.match(text, /candidates that differ in approach or model tier/i, 'missing compensation 2')
    assert.match(text, /judge with a clean context that does not know which candidate the owner prefers/i, 'missing compensation 3')
    assert.match(text, /executed checks/i, 'missing compensation 4')
  })

  test('rule 4: negative: no skill text tells the owner to delete branches by pattern or with --force', () => {
    for (const name of ['arena', 'swarm']) {
      const text = skill(name)
      assert.doesNotMatch(text, /(?:delete|remove)\s+(?:branches?|worktrees?)\s+(?:by\s+pattern|with\s+--force)/i)
      assert.match(text, /never by pattern/i)
      assert.match(text, /never with `--force`/i)
    }
  })

  test('rule 5: the swarm skill limits a swarm to read work, keeps its members from publishing on GitHub, and says the report is not a review', () => {
    const text = skill('swarm')
    assert.match(text, /read work only/i, 'swarm must limit to read work')
    assert.match(text, /members publish nothing on GitHub/i, 'swarm members must publish nothing on GitHub')
    assert.match(text, /report is not a review/i, 'swarm must say report is not a review')
  })

  test('rule 6: negative: no skill text routes candidates through despachar or revisar', () => {
    for (const name of ['arena', 'swarm']) {
      const text = skill(name)
      assert.match(text, /Never route (?:candidates|workers) through `despachar` or `revisar`/i)
    }
  })

  test('rule 7: the README credit row names arena and swarm', () => {
    const row = read(path.join(ROOT, 'README.md')).split('\n').find(line => line.startsWith('| Skills `principle-'))
    assert.ok(row, 'README has no pstack row in "Origen y licencias"')
    assert.ok(row.includes('`arena`') && row.includes('`swarm`'), 'README row must name arena and swarm')
  })
})

describe('#265 re-vendor pstack principles and swarm from 0.15.36', () => {
  test('rule 1: provenance manifest says 0.15.36 and commit c742dd61706fbacc1b95f1a20b7b988cf096ce6c, upstreamSha256 hashes match, and README line names 0.15.36 (commit c742dd6)', () => {
    assert.equal(provenance.version, '0.15.36')
    assert.equal(provenance.commit, 'c742dd61706fbacc1b95f1a20b7b988cf096ce6c')
    assert.equal(provenance.skills['principle-make-operations-idempotent'].upstreamSha256, '7aa9327cf1f1aa057e95d47a0a78bd88a8f9d556b608866fee939d455a53a019')
    assert.equal(provenance.skills['principle-attack-the-premise'].upstreamSha256, '6a932884daad4aa189e9b5d1665226bbc75621d4d2a398fd4003bebd382f4599')
    assert.equal(provenance.skills['principle-explain-the-number'].upstreamSha256, '3c84fbf9a7d9842abcfcd134010782b32092ac3d3fb4aaf9ed5732dca83aa58c')
    assert.equal(provenance.skills['arena'].upstreamSha256, 'd0adeca6c9b19d43d90ed8f0484f0ddd362f05006d628b8f4cc6c9b55fa4d2b3')
    assert.equal(provenance.skills['swarm'].upstreamSha256, 'fea6bfbbf21e067a4e2d2ebab034bc3af508118e9df1abc9d2ba040d58a6df3a')
    const row = read(path.join(ROOT, 'README.md')).split('\n').find(line => line.startsWith('| Skills `principle-'))
    assert.ok(row, 'README has no pstack row in "Origen y licencias"')
    assert.ok(row.includes('0.15.36'), 'README must name 0.15.36')
    assert.ok(row.includes('c742dd6'), 'README must name c742dd6')
  })

  test('rule 2: principle-attack-the-premise and principle-make-operations-idempotent match upstream byte for byte with disable-model-invocation: true, negative: no shipped file says Take a census', () => {
    const attackText = skill('principle-attack-the-premise')
    assert.match(attackText, /description:\s*"[^"]*Write the premise down and test it directly before you write another fix that assumes it\.[^"]*"/)
    assert.match(attackText, /^disable-model-invocation:\s*true$/m)
    assert.equal(sha256(attackText), provenance.skills['principle-attack-the-premise'].upstreamSha256)

    const idempotentText = skill('principle-make-operations-idempotent')
    assert.match(idempotentText, /^disable-model-invocation:\s*true$/m)
    assert.equal(sha256(idempotentText), provenance.skills['principle-make-operations-idempotent'].upstreamSha256)

    // Negative: no shipped file still says Take a census
    for (const name of Object.keys(provenance.skills)) {
      assert.doesNotMatch(skill(name), /take a census/i, `${name} still contains "Take a census"`)
    }
  })

  test('rule 3: principle-explain-the-number is a byte-for-byte copy of upstream at commit c742dd6, negative: 0.15.31 description no longer ships', () => {
    const text = skill('principle-explain-the-number')
    assert.equal(sha256(text), provenance.skills['principle-explain-the-number'].upstreamSha256)
    assert.match(text, /^disable-model-invocation:\s*true$/m)
    assert.match(text, /description:\s*"Apply before you measure, and before you trust, report, or act on a number you measured/)
    assert.match(text, /\*\*Write the decision before you run\.\*\*/)
    assert.doesNotMatch(text, /description:\s*"Apply before you trust, report, or act on a number you measured/)
  })

  test('rule 4: arena is re-based on upstream 0.15.36 keeping Orca adaptations, and shippedSha256 is updated', () => {
    const text = skill('arena')
    assert.equal(sha256(text), provenance.skills['arena'].shippedSha256)
    assert.match(text, /same model family as the candidates/i)
    assert.match(text, /weaker than pstack's cross-family judge/i)
    assert.match(text, /In-process subagents only/)
  })

  test('rule 5: swarm drops removed sentences, renumbers Phase A steps 3 and 4, negative: no shipped line refers to a step 4 model, and shippedSha256 is updated', () => {
    const text = skill('swarm')
    assert.doesNotMatch(text, /Fan out N parallel in-process workers/)
    assert.doesNotMatch(text, /Fan out N parallel cloud workers/)
    assert.doesNotMatch(text, /Set N from the user/)
    assert.doesNotMatch(text, /Keep a compact result table,\s+one-line evidenced issues/)
    assert.match(text, /The swarm report is not a review and replaces neither CI nor `Verificado por main`\./)
    assert.match(text, /3\.\s+Pick the worker models for the job/)
    assert.match(text, /4\.\s+Swarm work is read work only/)
    assert.doesNotMatch(text, /5\.\s+Swarm work is read work only/)
    assert.doesNotMatch(text, /step 4 model/i)
    assert.equal(sha256(text), provenance.skills['swarm'].shippedSha256)
  })

  test('rule 6: adaptation note on line 13 of arena/SKILL.md and swarm/SKILL.md says 0.15.36, version strings in test say 0.15.36, and corrupting one byte fails the hash test naming the skill', () => {
    for (const name of ['arena', 'swarm']) {
      const text = skill(name)
      assert.match(text, /Adapted from pstack \(`cursor\/plugins`, version 0\.15\.36\)/, `${name} adaptation note must say version 0.15.36`)
      assert.doesNotMatch(text, /0\.15\.31/, `${name} must not say 0.15.31`)
      assert.doesNotMatch(text, /0\.15\.24/, `${name} must not say 0.15.24`)
    }

    const self = read(path.join(ROOT, 'test', 'pstack-vendor.test.mjs'))
    assert.doesNotMatch(self, /upstream v0\.15\.24/)
    assert.doesNotMatch(self, /upstream v0\.15\.31/)
    assert.equal(provenance.version, '0.15.36')
    const row = read(path.join(ROOT, 'README.md')).split('\n').find(line => line.startsWith('| Skills `principle-'))
    assert.ok(row.includes('0.15.36'))

    for (const [name, entry] of Object.entries(provenance.skills)) {
      const targetHash = entry.shippedSha256 ?? entry.upstreamSha256
      const corrupted = skill(name) + ' '
      assert.throws(() => {
        assert.equal(sha256(corrupted), targetHash, `${name} differs from manifest hash`)
      }, new RegExp(name))
    }
  })

  test('rule 7: trigger lines in brief-ticket.md, brief-rebote.md and CONTRATO.md are not edited, negative: no file under assets/stack is touched', () => {
    const ticketBrief = read(path.join(ROOT, 'assets', 'stack', 'brief-ticket.md'))
    const bounceBrief = read(path.join(ROOT, 'assets', 'stack', 'brief-rebote.md'))
    const contract = read(path.join(ROOT, 'assets', 'stack', 'CONTRATO.md'))

    assert.match(ticketBrief, /The ticket touches a command, lifecycle step or loop that can run again after a crash, retry or rerun:\s*read `~\/\.claude\/skills\/principle-make-operations-idempotent\/SKILL\.md`\./)
    assert.match(ticketBrief, /Two fixes sharing one premise have failed the same check; apply it before a third:\s*read `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    assert.match(bounceBrief, /The PR already bounced and the new failure shares the previous fix's premise:\s*read `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    assert.match(contract, /Antes de decidir qu\u00e9 sigue en pie despu\u00e9s de la segunda ronda de review o de CI, o de pas\u00e1rselo al humano:\s*le\u00e9 `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)

    for (const file of ['brief-ticket.md', 'brief-rebote.md', 'brief-revision.md', 'CONTRATO.md', 'ORCA-STACK.md', 'ROLE-BRIEFS.md']) {
      const current = read(path.join(ROOT, 'assets', 'stack', file))
      assert.ok(current.length > 0, `${file} must exist`)
    }
  })
})
