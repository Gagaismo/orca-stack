import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { citedPaths, missingPaths, renderBrief } from '../src/despacho.mjs'
import { statechartRuntimeOk, statechartWarnings } from '../src/doctor.mjs'
import { listFiles } from '../src/templates.mjs'
import { binaryVersion, which } from '../src/util.mjs'
import { ROOT, backups, cleanup, cli, read, snapshot, tempDir, write } from './helpers.mjs'

const SKILLS = path.join(ROOT, 'assets', 'skills')
const readSkill = (...parts) => readFileSync(path.join(...parts), 'utf8').replace(/\r\n/g, '\n')
const sha256 = text => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
const provenance = JSON.parse(readSkill(SKILLS, 'pstack-upstream.json'))
const skill = name => readSkill(SKILLS, name, 'SKILL.md')
// Where a skill's bytes come from: its own version and commit (#412), else the manifest's top-level pin.
const pinOf = (manifest, name) => ({
  version: manifest.skills[name].version ?? manifest.version,
  commit: manifest.skills[name].commit ?? manifest.commit,
})

// Skills shipped verbatim (adapted: false): every principle-* folder plus these two (#303) and statechart (#305).
const FORMAL = ['create-formal-verification-skill', 'maintain-formal-verification-skill']
const isVerbatimFolder = name => name.startsWith('principle-') || FORMAL.includes(name) || name === 'statechart'
// The recorded hash of a skill's SKILL.md: statechart (#305) records one hash per file instead of upstreamSha256.
const skillMdHash = entry => entry.shippedSha256 ?? entry.upstreamSha256 ?? entry.files?.['SKILL.md']
const assertVerbatimSet = (skills, folders) => {
  const unadapted = Object.entries(skills).filter(([, e]) => !e.adapted).map(([k]) => k).sort()
  for (const name of unadapted) {
    assert.ok(isVerbatimFolder(name), `${name} is unadapted but is neither a principle, a formal-verification skill nor statechart`)
  }
  assert.deepEqual(folders.filter(isVerbatimFolder).sort(), unadapted)
}

describe('vendored pstack principles (upstream v0.15.36)', () => {
  test('rule 1: every vendored SKILL.md matches upstream at the pinned commit, changing one byte makes the hash test fail, naming the skill', () => {
    const unadapted = Object.entries(provenance.skills).filter(([, e]) => !e.adapted)
    const folders = readdirSync(SKILLS).filter(name => statSync(path.join(SKILLS, name)).isDirectory())
    assertVerbatimSet(provenance.skills, folders)
    for (const [name, entry] of unadapted) {
      assert.equal(entry.adapted, false, `${name} must not be adapted`)
      const { version } = pinOf(provenance, name)
      assert.equal(sha256(skill(name)), skillMdHash(entry), `${name} differs from upstream v${version}`)
      // Corrupting one byte must fail naming the skill
      const corrupted = skill(name) + ' '
      assert.throws(() => {
        assert.equal(sha256(corrupted), skillMdHash(entry), `${name} differs from upstream v${version}`)
      }, new RegExp(name))
    }
  })

  test('rule 2: every copy keeps disable-model-invocation: true, negative: no copy drops the flag or loads by name', () => {
    for (const name of Object.keys(provenance.skills)) {
      const text = skill(name)
      assert.match(text, /^disable-model-invocation:\s*true$/m, `${name} missing disable-model-invocation: true`)
      assert.doesNotMatch(text, /^disable-model-invocation:\s*false$/m, `${name} has disable-model-invocation: false`)
    }
    for (const file of ['brief-ticket.md', 'brief-rebote.md', 'brief-revision.md', 'CONTRATO.md', 'MAIN.md', 'ORCA-STACK.md', 'ROLE-BRIEFS.md']) {
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
    // Issue 325: main's cycle moved to MAIN.md.
    const contract = read(path.join(ROOT, 'assets', 'stack', 'MAIN.md'))

    // 1. make-operations-idempotent in implementation brief, Rules
    assert.match(ticketBrief, /The ticket touches a command, lifecycle step or loop that can run again after a crash, retry or rerun:\s*read `~\/\.claude\/skills\/principle-make-operations-idempotent\/SKILL\.md`\./)
    // 2. attack-the-premise in implementation brief, Rules
    assert.match(ticketBrief, /Two fixes sharing one premise have failed the same check; apply it before a third:\s*read `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    // 3. attack-the-premise in bounce brief, Work
    assert.match(bounceBrief, /The PR already bounced and the new failure shares the previous fix's premise:\s*read `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    // 4. attack-the-premise in MAIN.md step 8 (main)
    const cycle = contract.split('### Ciclo de `main`')[1].split('\n### Arena y swarm')[0]
    const step8 = cycle.split('\n').find(line => line.startsWith('8. '))
    assert.ok(step8, 'step 8 not found in Ciclo de main')
    assert.match(step8, /Antes de decidir qué sigue en pie después de la segunda ronda de review o de CI, o de pasárselo al humano:\s*leé `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    // 5. explain-the-number in role briefs, Research worker
    const researchWorker = roleBriefs.split('## Research worker')[1].split('## ')[0]
    assert.match(researchWorker, /The answer is a measured number:\s*read `~\/\.claude\/skills\/principle-explain-the-number\/SKILL\.md`\./)
    // 6. explain-the-number in implementation brief, Evidencia
    const evidenciaSection = ticketBrief.split('## Evidencia')[1].split('## Merge Danger')[0]
    assert.match(evidenciaSection, /A row's evidence is a measured number \(time, size, throughput, cost\):\s*read `~\/\.claude\/skills\/principle-explain-the-number\/SKILL\.md`\./)
    // 7. explain-the-number in MAIN.md (main)
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
    // #412 moved the three principles to 0.15.43 (2f87c85); their pins are checked in the #412 block.
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

  test('rule 3: principle-explain-the-number is a byte-for-byte copy of upstream at its recorded commit, negative: 0.15.31 description no longer ships', () => {
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
      const targetHash = skillMdHash(entry)
      const corrupted = skill(name) + ' '
      assert.throws(() => {
        assert.equal(sha256(corrupted), targetHash, `${name} differs from manifest hash`)
      }, new RegExp(name))
    }
  })

  test('rule 7: trigger lines in brief-ticket.md, brief-rebote.md and CONTRATO.md are not edited, negative: no file under assets/stack is touched', () => {
    const ticketBrief = read(path.join(ROOT, 'assets', 'stack', 'brief-ticket.md'))
    const bounceBrief = read(path.join(ROOT, 'assets', 'stack', 'brief-rebote.md'))
    const contract = read(path.join(ROOT, 'assets', 'stack', 'MAIN.md'))

    assert.match(ticketBrief, /The ticket touches a command, lifecycle step or loop that can run again after a crash, retry or rerun:\s*read `~\/\.claude\/skills\/principle-make-operations-idempotent\/SKILL\.md`\./)
    assert.match(ticketBrief, /Two fixes sharing one premise have failed the same check; apply it before a third:\s*read `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    assert.match(bounceBrief, /The PR already bounced and the new failure shares the previous fix's premise:\s*read `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
    assert.match(contract, /Antes de decidir qu\u00e9 sigue en pie despu\u00e9s de la segunda ronda de review o de CI, o de pas\u00e1rselo al humano:\s*le\u00e9 `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)

    for (const file of ['brief-ticket.md', 'brief-rebote.md', 'brief-revision.md', 'CONTRATO.md', 'MAIN.md', 'ORCA-STACK.md', 'ROLE-BRIEFS.md']) {
      const current = read(path.join(ROOT, 'assets', 'stack', file))
      assert.ok(current.length > 0, `${file} must exist`)
    }
  })
})

describe('#303 vendored create- and maintain-formal-verification-skill (upstream v0.15.36)', () => {
  const UPSTREAM = {
    'create-formal-verification-skill': '30ef0ac27612ecd16fdc081112113221d673053cef3f8603db11932193861211',
    'maintain-formal-verification-skill': '0c96f54293542d3818b68754562b338073958781a9684454611dca37592e2d2c',
  }
  const assertMatchesUpstream = (name, text) =>
    assert.equal(sha256(text), provenance.skills[name].upstreamSha256, `${name} differs from upstream v0.15.36`)

  test('rule 1: each SKILL.md is a verbatim copy of pstack/skills/<name>/SKILL.md at c742dd6 recorded as adapted: false, and changing one byte fails naming the skill', () => {
    assert.equal(provenance.commit, 'c742dd61706fbacc1b95f1a20b7b988cf096ce6c')
    for (const [name, hash] of Object.entries(UPSTREAM)) {
      assert.deepEqual(provenance.skills[name], { adapted: false, upstreamSha256: hash })
      assertMatchesUpstream(name, skill(name))
      assert.throws(() => assertMatchesUpstream(name, skill(name).replace('formal', 'Formal')), new RegExp(name))
    }
  })

  test('rule 2: both keep disable-model-invocation: true, negative: neither loads by name in a brief or in the contract', () => {
    for (const name of FORMAL) {
      assert.match(skill(name), /^disable-model-invocation:\s*true$/m, `${name} missing disable-model-invocation: true`)
    }
    for (const file of ['brief-ticket.md', 'brief-rebote.md', 'brief-revision.md', 'CONTRATO.md', 'MAIN.md', 'ORCA-STACK.md', 'ROLE-BRIEFS.md']) {
      const content = read(path.join(ROOT, 'assets', 'stack', file))
      for (const name of FORMAL) {
        assert.ok(!content.includes(name), `${file} must not load ${name} by name`)
      }
    }
  })

  test('rule 3: each folder carries the LICENSE note and the README pstack credit row lists both skills', () => {
    const reference = readSkill(SKILLS, 'principle-attack-the-premise', 'LICENSE')
    for (const name of FORMAL) {
      assert.equal(readSkill(SKILLS, name, 'LICENSE'), reference, `${name} LICENSE must match the other pstack folders`)
    }
    const row = read(path.join(ROOT, 'README.md')).split('\n').find(line => line.startsWith('| Skills `principle-'))
    assert.ok(row, 'README has no pstack row in "Origen y licencias"')
    for (const name of FORMAL) {
      assert.ok(row.includes(`\`${name}\``), `README pstack row must name ${name}`)
    }
  })

  test('rule 4: the unadapted set is exactly the principles plus the two formal-verification skills, negative: an unknown unadapted folder still fails', () => {
    const folders = readdirSync(SKILLS).filter(name => statSync(path.join(SKILLS, name)).isDirectory())
    assertVerbatimSet(provenance.skills, folders)
    const unknown = { ...provenance.skills, 'some-skill': { adapted: false, upstreamSha256: '0'.repeat(64) } }
    assert.throws(() => assertVerbatimSet(unknown, [...folders, 'some-skill']), /some-skill/)
    const missingFolder = folders.filter(name => name !== 'maintain-formal-verification-skill')
    assert.throws(() => assertVerbatimSet(provenance.skills, missingFolder))
  })

  test('rule 5: global installs both under the Claude and agents skill roots byte-identical to the vendored copies, negative: an installed copy whose hash differs fails', () => {
    const home = tempDir('pstack-formal')
    try {
      const result = cli(home, ['global', '--skip-pi'])
      assert.equal(result.status, 0, result.out)
      for (const root of ['.claude', '.agents']) {
        for (const name of FORMAL) {
          for (const file of ['SKILL.md', 'LICENSE']) {
            const installed = readFileSync(path.join(home, root, 'skills', name, file))
            assert.ok(installed.equals(readFileSync(path.join(SKILLS, name, file))), `${root}/skills/${name}/${file} differs from the vendored copy`)
          }
          const installed = path.join(home, root, 'skills', name, 'SKILL.md')
          assertMatchesUpstream(name, readSkill(installed))
          writeFileSync(installed, readSkill(installed).replace('---', '--- '))
          assert.throws(() => assertMatchesUpstream(name, readSkill(installed)), new RegExp(name))
        }
      }
    } finally {
      cleanup(home)
    }
  })

  test('rule 6: the skills table in docs/manual.md lists both as optional and says what they are for', () => {
    const line = read(path.join(ROOT, 'docs', 'manual.md')).split('\n').find(l => l.startsWith('| `create-formal-verification-skill`'))
    assert.ok(line, 'docs/manual.md has no row for the formal-verification skills')
    assert.ok(line.includes('`maintain-formal-verification-skill`'), line)
    assert.match(line, /Opcionales/)
    assert.match(line, /verificación formal \(máquinas de estado, carreras e invariantes\)/)
  })
})

describe('#320 docs/manual.md statechart rows match the vendored skill', () => {
  const manualRow = start => read(path.join(ROOT, 'docs', 'manual.md')).split('\n').find(l => l.startsWith(start))

  test('R1: the formal-verification row says it uses the installed /statechart to read TLA+ results, negative: no "llega en el ticket siguiente" or "#305" as a future event', () => {
    const line = manualRow('| `create-formal-verification-skill`')
    assert.ok(line, 'docs/manual.md has no row for the formal-verification skills')
    assert.match(line, /para leer los resultados de TLA\+ usan `\/statechart` \(ver la fila siguiente\)/)
    assert.doesNotMatch(line, /llega en el ticket siguiente/)
    assert.doesNotMatch(line, /#305/)
  })

  test('R2: the statechart row states exactly the runtimes the vendored scripts/statechart launcher accepts, plus mise and the network on the first run', () => {
    const line = manualRow('| `statechart`')
    assert.ok(line, 'docs/manual.md has no row for statechart')
    const message = /^echo "statechart needs (.*)\." >&2$/m.exec(readSkill(SKILLS, 'statechart', 'scripts', 'statechart'))
    assert.ok(message, 'scripts/statechart no longer prints its runtime requirement')
    assert.equal(message[1], 'Node 22.18 to 22.x, Node 23.6 or later, Bun 1.1.5 or later, or Deno 2.0 or later')
    assert.match(skill('statechart'), /The first run installs TLC and Java with mise and needs the network\./)
    assert.match(line, /Necesita Node 22\.18 a 22\.x, Node 23\.6 o posterior, Bun 1\.1\.5 o posterior, o Deno 2\.0 o posterior \(lo exige `scripts\/statechart`\), `mise` y red en la primera corrida/)
    assert.doesNotMatch(line, /Node 22\.18\+/)
  })

  test('R3: the statechart row keeps the Windows note', () => {
    assert.match(manualRow('| `statechart`'), /en Windows, WSL o un contenedor \|$/)
  })
})

describe('#305 vendored statechart with per-file hashes (upstream v0.15.36)', () => {
  const STATECHART = path.join(SKILLS, 'statechart')
  const entry = provenance.skills.statechart
  // LF-normalized for text, raw bytes otherwise (a file with a NUL byte counts as binary).
  const fileHash = data => (data.includes(0) ? createHash('sha256').update(data).digest('hex') : sha256(data.toString('utf8')))
  const assertFilesMatch = dir => {
    for (const [rel, hash] of Object.entries(entry.files)) {
      assert.equal(fileHash(readFileSync(path.join(dir, ...rel.split('/')))), hash, `statechart/${rel} differs from upstream v0.15.36`)
    }
  }
  const assertFileList = dir =>
    assert.deepEqual(listFiles(dir), [...Object.keys(entry.files), 'LICENSE'].sort(), 'statechart file list differs from the files map plus LICENSE')
  const copyOf = prefix => {
    const dir = tempDir(prefix)
    cpSync(STATECHART, dir, { recursive: true })

    return dir
  }

  test('rule 1: every vendored statechart file matches its hash in the files map at c742dd6, and changing one byte of scripts/ir.ts fails naming statechart/scripts/ir.ts', () => {
    assert.equal(provenance.commit, 'c742dd61706fbacc1b95f1a20b7b988cf096ce6c')
    assert.deepEqual(Object.keys(entry).sort(), ['adapted', 'files'])
    assert.equal(entry.adapted, false)
    assert.equal(Object.keys(entry.files).length, 31)
    assertFilesMatch(STATECHART)
    const copy = copyOf('statechart-byte')
    try {
      const file = path.join(copy, 'scripts', 'ir.ts')
      const data = readFileSync(file)
      data[0] = data[0] === 0x61 ? 0x62 : 0x61
      writeFileSync(file, data)
      assert.throws(() => assertFilesMatch(copy), /statechart\/scripts\/ir\.ts/)
    } finally {
      cleanup(copy)
    }
  })

  test('rule 2: the vendored file list equals the files map keys plus LICENSE, negative: no scripts/test file and no file absent upstream is vendored', () => {
    assertFileList(STATECHART)
    assert.ok(!Object.keys(entry.files).some(rel => rel.startsWith('scripts/test/')), 'a scripts/test file is in the files map')
    assert.equal(readSkill(STATECHART, 'LICENSE'), readSkill(SKILLS, 'principle-attack-the-premise', 'LICENSE'))
    const copy = copyOf('statechart-extra')
    try {
      write(path.join(copy, 'scripts', 'test', 'cli.test.ts'), 'test')
      assert.throws(() => assertFileList(copy), /statechart file list differs/)
    } finally {
      cleanup(copy)
    }
  })

  test('rule 3: statechart SKILL.md keeps disable-model-invocation: true', () => {
    assert.match(skill('statechart'), /^disable-model-invocation:\s*true$/m)
    assert.doesNotMatch(skill('statechart'), /^disable-model-invocation:\s*false$/m)
  })

  test('rule 4: global installs every statechart file under both skill roots byte-identical, the launcher is executable on macOS and Linux, negative: an installed file whose hash differs fails', () => {
    const home = tempDir('statechart-global')
    try {
      const result = cli(home, ['global', '--skip-pi'])
      assert.equal(result.status, 0, result.out)
      for (const root of ['.claude', '.agents']) {
        const installed = path.join(home, root, 'skills', 'statechart')
        assertFileList(installed)
        for (const rel of listFiles(STATECHART)) {
          const same = readFileSync(path.join(installed, rel)).equals(readFileSync(path.join(STATECHART, rel)))
          assert.ok(same, `${root}/skills/statechart/${rel} differs from the vendored copy`)
        }
        assertFilesMatch(installed)
        if (process.platform !== 'win32') {
          assert.ok(statSync(path.join(installed, 'scripts', 'statechart')).mode & 0o100, `${root} launcher is not executable`)
        }
        const run = path.join(installed, 'scripts', 'run.ts')
        writeFileSync(run, readFileSync(run, 'utf8') + '\n')
        assert.throws(() => assertFilesMatch(installed), /statechart\/scripts\/run\.ts/)
      }
    } finally {
      cleanup(home)
    }
  })

  test('rule 5: doctor warns, never fails, when statechart is installed and no runtime is available or mise is missing, and with Node 26 and mise present there is no warning', () => {
    const linux = (versions, mise = true) => statechartWarnings({ installed: true, platform: 'linux', versions, mise })
    assert.deepEqual(linux({ node: '26.13.0' }), [])
    assert.deepEqual(statechartWarnings({ installed: false, platform: 'win32', versions: {}, mise: false }), [])
    for (const versions of [{ node: '22.18.0' }, { node: '22.99.0' }, { node: '23.6.0' }, { bun: '1.1.5' }, { deno: '2.0.0' }]) {
      assert.deepEqual(linux(versions), [], JSON.stringify(versions))
    }
    for (const versions of [{}, { node: '22.17.9' }, { node: '23.5.0' }, { node: '20.19.0', bun: '1.1.4', deno: '1.46.3' }]) {
      const warnings = linux(versions)
      assert.equal(warnings.length, 1, JSON.stringify(versions))
      assert.match(warnings[0], /Node 22\.18 a 22\.x, Node 23\.6 o más nuevo, Bun 1\.1\.5 o más nuevo, o Deno 2\.0 o más nuevo/)
    }
    const [mise] = linux({ node: '26.13.0' }, false)
    assert.match(mise, /`mise` no está en el PATH: la primera corrida instala TLC y Java con mise y necesita red/)
    assert.match(mise, /`TLA2TOOLS`.*`JAVA`/)
    const [windows] = statechartWarnings({ installed: true, platform: 'win32', versions: { node: '26.13.0' }, mise: true })
    assert.match(windows, /Windows nativo no corre.*WSL o un contenedor.*`TLA2TOOLS`.*`JAVA`/)

    const home = tempDir('statechart-doctor')
    try {
      const doctor = (env = {}) => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home, env })
      assert.doesNotMatch(doctor().out, /skill statechart/)
      assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
      // An empty PATH: no node, bun, deno or mise for doctor to find, on every platform.
      const empty = tempDir('statechart-empty-path')
      try {
        const out = doctor({ PATH: empty, Path: empty }).out
        assert.doesNotMatch(out, /✖ skill statechart/)
        assert.match(out, /⚠ skill statechart - necesita Node 22\.18 a 22\.x/)
        assert.match(out, /⚠ skill statechart - `mise` no está en el PATH/)
        if (process.platform === 'win32') {
          assert.match(out, /⚠ skill statechart - en Windows nativo no corre/)
        }
      } finally {
        cleanup(empty)
      }
    } finally {
      cleanup(home)
    }
  })

  test('rule 6: docs/guia-setup.md and the README pstack credit row name statechart, its runtimes and that the first run downloads TLC and Java with mise over the network', () => {
    const row = read(path.join(ROOT, 'README.md')).split('\n').find(line => line.startsWith('| Skills `principle-'))
    const guide = read(path.join(ROOT, 'docs', 'guia-setup.md')).split('\n').find(line => line.includes('skill `statechart`'))
    assert.ok(guide, 'docs/guia-setup.md does not name the statechart skill')
    for (const text of [row, guide]) {
      assert.ok(text.includes('`statechart`'), text)
      assert.match(text, /Node 22\.18 a 22\.x.*23\.6 o más nuevo.*Bun 1\.1\.5 o más nuevo.*Deno 2\.0 o más nuevo/)
      assert.match(text, /primera corrida descarga TLC y Java con mise/)
      assert.match(text, /red/)
      assert.match(text, /Windows nativo no corre/)
      assert.match(text, /WSL/)
      assert.match(text, /`TLA2TOOLS`.*`JAVA`.*se saltea mise/)
    }
  })

  const versions = Object.fromEntries(['node', 'bun', 'deno'].map(bin => [bin, which(bin) ? binaryVersion(bin) : null]))
  const corpusSkip =
    process.platform === 'win32'
      ? 'native Windows has no /bin/sh, which the skill spawns (#305); CI runs this on ubuntu'
      : !statechartRuntimeOk(versions)
        ? 'no Node 22.18+, Bun 1.1.5+ or Deno 2.0+ on the PATH'
        : !process.env.TLA2TOOLS && !which('mise')
          ? 'neither TLA2TOOLS nor mise is available to find TLC'
          : false

  test('rule 7: the installed launcher checks the upstream Counter corpus example and writes the report and the Mermaid chart', { skip: corpusSkip, timeout: 300_000 }, () => {
    const home = tempDir('statechart-run')
    const work = tempDir('statechart-counter')
    try {
      assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
      const fixture = path.join(ROOT, 'test', 'fixtures', 'statechart-counter')
      for (const name of ['Counter.tla', 'Counter.cfg']) {
        cpSync(path.join(fixture, name), path.join(work, name))
      }
      const launcher = path.join(home, '.claude', 'skills', 'statechart', 'scripts', 'statechart')
      const result = spawnSync(launcher, ['Counter.tla', '--out', 'out'], { cwd: work, encoding: 'utf8', timeout: 280_000 })
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      const report = readFileSync(path.join(work, 'out', 'report.md'), 'utf8')
      assert.match(report, /^# Counter\n/)
      assert.match(report, /TLC reached 4 states and 3 steps/)
      assert.equal(readFileSync(path.join(work, 'out', 'chart.mmd'), 'utf8'), readSkill(fixture, 'chart.mmd'))
    } finally {
      cleanup(home)
      cleanup(work)
    }
  })

  test('PRESERVE: global still renders the other skills .md files and copies their other files unchanged', () => {
    const home = tempDir('statechart-preserve-global')
    try {
      assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
      for (const root of ['.claude', '.agents']) {
        const policy = readFileSync(path.join(home, root, 'skills', 'orca-stack-policy', 'SKILL.md'), 'utf8')
        assert.doesNotMatch(policy, /\{\{[A-Z_]+\}\}/, `${root} orca-stack-policy keeps a placeholder`)
        for (const name of FORMAL) {
          const installed = readFileSync(path.join(home, root, 'skills', name, 'LICENSE'))
          assert.ok(installed.equals(readFileSync(path.join(SKILLS, name, 'LICENSE'))), `${root} ${name} LICENSE differs`)
        }
      }
    } finally {
      cleanup(home)
    }
  })

  test('PRESERVE: doctor still reports the installed skill count under both roots', () => {
    const home = tempDir('statechart-preserve-doctor')
    try {
      assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
      const out = cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home }).out
      const count = readdirSync(SKILLS).filter(name => statSync(path.join(SKILLS, name)).isDirectory()).length
      assert.match(out, new RegExp(`✔ ~[\\\\/]\\.claude[\\\\/]skills - ${count} skills`))
      assert.match(out, new RegExp(`✔ ~[\\\\/]\\.agents[\\\\/]skills - ${count} skills`))
    } finally {
      cleanup(home)
    }
  })
})

describe('#412 re-vendor the three pstack principles from 0.15.43 (2f87c85)', () => {
  const OLD = { version: '0.15.36', commit: 'c742dd61706fbacc1b95f1a20b7b988cf096ce6c' }
  const NEW = { version: '0.15.43', commit: '2f87c854fe3e2fcda44ca86b46ede35aad3c46b7' }
  // sha256 of pstack/skills/<name>/SKILL.md at 2f87c854 (unchanged up to 0b46ec3, pstack 0.15.46).
  const UPSTREAM = {
    'principle-attack-the-premise': '831e916c540f4b6b720b7472aeea6e6ef93996655e36cc2517221f6f2081b480',
    'principle-explain-the-number': 'e6a3f00991f4949cf18a0b5c77dd3126ca4402b8553f88c9c7905e577512676e',
    'principle-make-operations-idempotent': '76ad0a99b6ff2a05a159accfeee48412d62f62774eb8d05bbff26a1f3aa3eab5',
  }
  // #427 pinned sharpen and reframe to their own later commit.
  const LATER = { sharpen: { version: '0.15.48', commit: '005d8f6e8ec057b738adcd08a08b30db0478402d' }, reframe: { version: '0.15.48', commit: '005d8f6e8ec057b738adcd08a08b30db0478402d' } }
  const assertPinsTruthful = manifest => {
    for (const name of Object.keys(manifest.skills)) {
      assert.deepEqual(pinOf(manifest, name), name in UPSTREAM ? NEW : (LATER[name] ?? OLD), `${name} provenance names the wrong upstream commit`)
    }
  }

  test('R1: the three principles are byte-for-byte copies of upstream at 2f87c854 recorded with their own version and commit, and changing one byte fails naming the skill', () => {
    for (const [name, hash] of Object.entries(UPSTREAM)) {
      assert.deepEqual(provenance.skills[name], { adapted: false, ...NEW, upstreamSha256: hash })
      assert.equal(sha256(skill(name)), hash, `${name} differs from upstream v0.15.43`)
      assert.throws(() => assert.equal(sha256(skill(name) + ' '), hash, `${name} differs from upstream v0.15.43`), new RegExp(name))
    }
  })

  test('R2: every other vendored skill still resolves to 0.15.36 c742dd6, negative: a single top-level 0.15.43 pin or a principle without its own pin is rejected naming the skill', () => {
    assert.deepEqual({ version: provenance.version, commit: provenance.commit }, OLD)
    assertPinsTruthful(provenance)
    const topLevelOnly = structuredClone(provenance)
    Object.assign(topLevelOnly, NEW)
    for (const name of Object.keys(UPSTREAM)) {
      delete topLevelOnly.skills[name].version
      delete topLevelOnly.skills[name].commit
    }
    assert.throws(() => assertPinsTruthful(topLevelOnly), /create-formal-verification-skill|statechart|arena|swarm/)
    const unpinned = structuredClone(provenance)
    delete unpinned.skills['principle-explain-the-number'].commit
    assert.throws(() => assertPinsTruthful(unpinned), /principle-explain-the-number/)
  })

  test('R3: the three keep disable-model-invocation: true and the description lines the MAIN.md and brief triggers paraphrase', () => {
    const descriptions = {
      'principle-attack-the-premise': 'description: "Apply when two or more fixes that share one premise have failed the same gate. Write the premise down and test it directly before you write another fix that assumes it."',
      'principle-explain-the-number': 'description: "Apply before you measure, and before you trust, report, or act on a number you measured: a speedup, a regression, a throughput, a latency, or an eval result. Find what limits it, and rule out that it measured something other than the work you think."',
      'principle-make-operations-idempotent': 'description: "Apply when designing commands, lifecycle steps, or processing loops that run amid crashes, restarts, and retries. Converge to the same end state regardless of partial prior runs."',
    }
    for (const [name, line] of Object.entries(descriptions)) {
      const text = skill(name)
      assert.match(text, /^disable-model-invocation:\s*true$/m, `${name} missing disable-model-invocation: true`)
      assert.ok(text.split('\n').includes(line), `${name} description changed`)
    }
    const main = read(path.join(ROOT, 'assets', 'stack', 'MAIN.md'))
    assert.match(main, /Antes de actuar sobre un número medido que viene de una investigación, de una tabla de Evidencia o de una retro:\s*leé `~\/\.claude\/skills\/principle-explain-the-number\/SKILL\.md`\./)
    assert.match(main, /Antes de decidir qué sigue en pie después de la segunda ronda de review o de CI, o de pasárselo al humano:\s*leé `~\/\.claude\/skills\/principle-attack-the-premise\/SKILL\.md`\./)
  })

  test('R4: negative: arena and swarm are not re-vendored, their entries and adaptation notes still name 0.15.36', () => {
    assert.deepEqual(provenance.skills.arena, {
      adapted: true,
      upstreamSha256: 'd0adeca6c9b19d43d90ed8f0484f0ddd362f05006d628b8f4cc6c9b55fa4d2b3',
      shippedSha256: '7e4a44eedfaa02ea9333b7b6210074078ba1c938ba7bc03f1a044155afbcaa4c',
    })
    assert.deepEqual(provenance.skills.swarm, {
      adapted: true,
      upstreamSha256: 'fea6bfbbf21e067a4e2d2ebab034bc3af508118e9df1abc9d2ba040d58a6df3a',
      shippedSha256: '44eef5766263162698dde1082176907079e1c027279e8c1bc64166d0ec46ef26',
    })
    for (const name of ['arena', 'swarm']) {
      assert.equal(sha256(skill(name)), provenance.skills[name].shippedSha256, `${name} changed`)
      assert.match(skill(name), /Adapted from pstack \(`cursor\/plugins`, version 0\.15\.36\)/)
    }
  })

  test('R5: negative: no statechart file changes, its 31 files still hash to the c742dd6 map', () => {
    const entry = provenance.skills.statechart
    assert.deepEqual(Object.keys(entry).sort(), ['adapted', 'files'])
    assert.deepEqual(pinOf(provenance, 'statechart'), OLD)
    assert.equal(Object.keys(entry.files).length, 31)
    for (const [rel, hash] of Object.entries(entry.files)) {
      const data = readFileSync(path.join(SKILLS, 'statechart', ...rel.split('/')))
      const actual = data.includes(0) ? createHash('sha256').update(data).digest('hex') : sha256(data.toString('utf8'))
      assert.equal(actual, hash, `statechart/${rel} changed`)
    }
  })

  test('R6: the README pstack credit row names every recorded pin, 0.15.43 (commit 2f87c85) for the three principles and 0.15.36 (commit c742dd6) for the rest', () => {
    const row = read(path.join(ROOT, 'README.md')).split('\n').find(line => line.startsWith('| Skills `principle-'))
    assert.ok(row, 'README has no pstack row in "Origen y licencias"')
    for (const name of Object.keys(provenance.skills)) {
      const { version, commit } = pinOf(provenance, name)
      assert.ok(row.includes(`\`${version}\``) && row.includes(`\`${commit.slice(0, 7)}\``), `README row does not name ${name}'s pin ${version} ${commit.slice(0, 7)}`)
    }
    assert.match(row, /`principle-make-operations-idempotent`, `principle-attack-the-premise` y `principle-explain-the-number`, versión `0\.15\.43`, commit `2f87c85`/)
    assert.match(row, /versión `0\.15\.36`, commit `c742dd6`/)
  })
})

describe('#427 vendored and adapted sharpen and reframe (upstream v0.15.48)', () => {
  const PIN = { version: '0.15.48', commit: '005d8f6e8ec057b738adcd08a08b30db0478402d' }
  const NAMES = ['sharpen', 'reframe']
  const note = text => text.split('\n## Adaptation Note\n')[1] ?? ''
  // Undo every change the adaptation note lists: the result must be upstream's bytes.
  const UNDO = {
    sharpen: text => text.split('\n## Adaptation Note\n')[0],
    reframe: text => text.split('\n## Adaptation Note\n')[0].replaceAll('the human', 'the operator'),
  }
  const HUMAN_ONLY = '`grill-with-docs`, `sharpen`, `reframe`, `to-spec`, `to-tickets`, `wayfinder`, `triage`, `retro` y `ask-matt` solo las puede disparar el humano'

  test('R1: both are pinned to 0.15.48 (005d8f6) as adapted, keep the MIT license, and undoing the listed changes gives upstream byte for byte', () => {
    for (const name of NAMES) {
      const entry = provenance.skills[name]
      assert.deepEqual(pinOf(provenance, name), PIN, `${name} pin`)
      assert.equal(entry.adapted, true, `${name} must be adapted: true`)
      assert.equal(sha256(skill(name)), entry.shippedSha256, `${name} differs from its shippedSha256`)
      assert.throws(() => assert.equal(sha256(skill(name) + ' '), entry.shippedSha256, `${name} differs from its shippedSha256`), new RegExp(name))
      assert.equal(sha256(UNDO[name](skill(name))), entry.upstreamSha256, `${name}: undoing the adaptation note does not give upstream`)
      assert.match(note(skill(name)), /Adapted from pstack \(`cursor\/plugins`, version 0\.15\.48, commit `005d8f6`\)\. Changes from upstream:/)
      assert.equal(readSkill(SKILLS, name, 'LICENSE'), readSkill(SKILLS, 'principle-attack-the-premise', 'LICENSE'), `${name} LICENSE`)
    }
    assert.match(note(skill('reframe')), /"the operator" is "the human"/)
  })

  test('R2: both carry disable-model-invocation: true and sit with grill-with-docs in the human-only list, negative: no brief tells a worker to run them', () => {
    for (const name of NAMES) {
      assert.match(skill(name), /^disable-model-invocation:\s*true$/m, `${name} missing disable-model-invocation: true`)
      assert.match(note(skill(name)), /only the human triggers this skill, like `grill-with-docs`/)
    }
    for (const rel of ['assets/stack/CONTRATO.md', 'AGENTS.md', 'docs/manual.md']) {
      assert.ok(read(path.join(ROOT, rel)).includes(HUMAN_ONLY), `${rel} does not list sharpen and reframe as human-only`)
    }
    for (const file of ['brief-ticket.md', 'brief-rebote.md', 'brief-revision.md', 'ROLE-BRIEFS.md', 'ORCA-STACK.md']) {
      assert.doesNotMatch(read(path.join(ROOT, 'assets', 'stack', file)), /\/sharpen|\/reframe|`sharpen`|`reframe`/, `${file} must not name sharpen or reframe`)
    }
    const brief = renderBrief('ticket', { AGENT: 'pi', ISSUE: '427', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
    assert.doesNotMatch(brief, /\/sharpen|\/reframe|`sharpen`|`reframe`/)
  })

  test('R3: MAIN.md step 1 lets main propose /sharpen or /reframe for a vague idea and wait, negative: main never runs them on its own', () => {
    const main = read(path.join(ROOT, 'assets', 'stack', 'MAIN.md'))
    const step1 = main.split('### Ciclo de `main`')[1].split('\n').find(line => line.startsWith('1. '))
    assert.ok(step1, 'step 1 not found')
    assert.ok(step1.includes('Para una idea vaga puede proponer antes `/sharpen` o `/reframe`. Proponé la skill que corresponde y esperá al humano.'))
    assert.equal(main.split('\n').filter(line => /sharpen|reframe/.test(line)).length, 1, 'only step 1 names them')
  })

  test('R4: negative: the shipped text names no Cursor tool or model outside the provenance line', () => {
    for (const name of NAMES) {
      const body = skill(name).split('\n## Adaptation Note\n')[0]
      assert.doesNotMatch(body, /cursor|composer|\.mdc|pstack|operator/i, `${name} keeps an upstream-specific word`)
      assert.match(note(skill(name)), /names no Cursor-specific tool or model/)
    }
  })

  test('R5: global installs both under both skill roots, and doctor reports them missing when absent', () => {
    const home = tempDir('pstack-427')
    try {
      assert.equal(cli(home, ['global', '--skip-pi']).status, 0)
      for (const root of ['.claude', '.agents']) {
        for (const name of NAMES) {
          for (const file of ['SKILL.md', 'LICENSE']) {
            const installed = readFileSync(path.join(home, root, 'skills', name, file))
            assert.ok(installed.equals(readFileSync(path.join(SKILLS, name, file))), `${root}/skills/${name}/${file} differs from the vendored copy`)
          }
        }
      }
      const doctor = () => cli(home, ['doctor', '--offline', '--skip-pi'], { cwd: home }).out
      assert.doesNotMatch(doctor(), /faltan: .*(sharpen|reframe)/)
      for (const name of NAMES) cleanup(path.join(home, '.claude', 'skills', name))
      assert.match(doctor(), /✖ ~[\\/]\.claude[\\/]skills - faltan: reframe, sharpen/)
    } finally {
      cleanup(home)
    }
  })

  test('R6: the manual skills table and the README pstack credit row name both skills and their pin', () => {
    const row = read(path.join(ROOT, 'docs', 'manual.md')).split('\n').find(l => l.startsWith('| `sharpen`, `reframe`'))
    assert.ok(row, 'docs/manual.md has no row for sharpen and reframe')
    assert.match(row, /Las dispara solo el humano \(`\/sharpen`, `\/reframe`\); `main` puede proponerlas en el paso 1 para una idea vaga y espera/)
    const credit = read(path.join(ROOT, 'README.md')).split('\n').find(line => line.startsWith('| Skills `principle-'))
    assert.match(credit, /`sharpen` y `reframe`, versión `0\.15\.48`, commit `005d8f6`/)
  })
})
