import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { STACK_LEVELS } from '../src/constants.mjs'
import { cmdWrapper, shWrapper } from '../src/templates.mjs'
import { ROOT } from './helpers.mjs'

const SKILLS = path.join(ROOT, 'assets', 'skills')
const read = (...parts) => readFileSync(path.join(...parts), 'utf8').replace(/\r\n/g, '\n')
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')
const provenance = JSON.parse(read(SKILLS, 'ponytail-upstream.json'))
const skill = name => read(SKILLS, name, 'SKILL.md')
// The text after the closing `---` of the frontmatter.
const body = text => text.slice(text.indexOf('\n---\n', 3) + '\n---\n'.length)
const ponytail = skill('ponytail')
const orcaSection = ponytail.slice(ponytail.indexOf('\n## In Orca\n')).replace(/\s+/g, ' ')

describe('vendored ponytail skills (upstream v5.3.2)', () => {
  test('rule 1: the vendored set is the v5.3.2 skills the stack uses, verbatim unless adapted', () => {
    const vendored = readdirSync(SKILLS).filter(name => name.startsWith('ponytail') && statSync(path.join(SKILLS, name)).isDirectory())
    assert.deepEqual(vendored.sort(), Object.keys(provenance.skills).sort())
    assert.deepEqual(Object.keys(provenance.notVendored), ['ponytail-gain'])
    for (const [name, entry] of Object.entries(provenance.skills)) {
      if (!entry.adapted) assert.equal(sha256(skill(name)), entry.upstreamSha256, `${name} differs from upstream v5.3.2`)
    }
  })

  test('rule 2: ponytail keeps the v5.3.2 body and re-applies the Orca adaptations after it', () => {
    assert.ok(ponytail.includes('\n## In Orca\n'), 'ponytail has no "## In Orca" section')
    const upstreamBody = body(ponytail).slice(0, body(ponytail).indexOf('\n## In Orca\n'))
    assert.equal(sha256(upstreamBody), provenance.skills.ponytail.upstreamBodySha256)
    const description = ponytail.slice(0, ponytail.indexOf('\nargument-hint:')).replace(/\s+/g, ' ')
    assert.match(description, /description: >- .*already-selected Orca task, spec, or ticket/)
    assert.match(description, /Do not use this skill as a project methodology, planner, delegator, or communication mode/)
    assert.match(orcaSection, /never cut or question a requirement the spec, ticket or ADRs make explicit/i)
    assert.match(orcaSection, /role brief/)
    assert.match(orcaSection, /tests the project or ticket requires/)
    assert.match(orcaSection, /Do not change Orca lifecycle/)
    assert.match(orcaSection, /`ponytail-review` is a separate, read-only pass after the normal correctness\/spec review/)
  })

  test('rule 3: provenance names the upstream repo, tag v5.3.2 and commit, and the README matches', () => {
    assert.equal(provenance.repo, 'https://github.com/DietrichGebert/ponytail')
    assert.equal(provenance.tag, 'v5.3.2')
    assert.match(provenance.commit, /^[0-9a-f]{40}$/)
    const row = read(ROOT, 'README.md').split('\n').find(line => line.startsWith('| Skills `ponytail`'))
    assert.ok(row, 'README has no ponytail row in "Origen y licencias"')
    assert.ok(row.includes('v5.3.2') && row.includes(provenance.commit.slice(0, 7)), row)
    assert.ok(row.includes('assets/skills/ponytail-upstream.json'), row)
  })

  test('rule 4: ponytail-debt finds `shortcut:` and older `ponytail:` markers, not prose', () => {
    const [, pattern] = skill('ponytail-debt').match(/git grep [^`]*-nE '([^']+)'/) ?? []
    assert.ok(pattern, 'ponytail-debt has no git grep pattern')
    const marker = new RegExp(pattern)
    for (const line of ['# shortcut: global lock, per-account locks if throughput matters', '// ponytail: O(n^2) scan, index it past 10k rows', '/* shortcut: naive retry, backoff if it storms */']) {
      assert.match(line, marker)
    }
    assert.doesNotMatch('The convention is `shortcut: <ceiling>, <upgrade path>`', marker)
  })

  test('rule 4 negative: no text in assets/ asks for new `ponytail:` comments', () => {
    assert.ok(ponytail.includes('`shortcut: <the limit>, <when to upgrade>`'))
    const walk = dir => readdirSync(dir).flatMap(name => {
      const full = path.join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : [full]
    })
    const stale = walk(path.join(ROOT, 'assets'))
      .flatMap(file => read(file).split('\n').map((line, i) => [`${path.relative(ROOT, file)}:${i + 1}`, line]))
      // A marker mention is `ponytail:` followed by a space or a closing backtick; `$ponytail:ponytail` is Codex syntax.
      .filter(([, line]) => /ponytail:[\s`]/.test(line) && !/shortcut:|older/.test(line))
    assert.deepEqual(stale, [])
  })

  test('rule 5: ORCA_STACK_PONYTAIL_LEVEL carries a v5.3.2 level, and an unknown one means full', () => {
    const [, hint] = ponytail.match(/^argument-hint: "\[([^\]]+)\]"$/m) ?? []
    assert.deepEqual(hint?.split('|'), ['lite', 'full', 'ultra'])
    assert.ok(hint.split('|').includes(STACK_LEVELS.ponytail))
    assert.match(shWrapper('claude'), new RegExp(`^ORCA_STACK_PONYTAIL_LEVEL=${STACK_LEVELS.ponytail}$`, 'm'))
    assert.ok(cmdWrapper('claude').includes(`set "ORCA_STACK_PONYTAIL_LEVEL=${STACK_LEVELS.ponytail}"`))
    assert.match(orcaSection, /`ORCA_STACK_PONYTAIL_LEVEL`/)
    assert.match(orcaSection, /unset, empty or any other value means `full`/)
    assert.match(orcaSection, /never turns Ponytail off/)
  })

  test('policy and briefs use the v5 vocabulary', () => {
    const policy = read(ROOT, 'assets', 'stack', 'ORCA-STACK.md')
    assert.match(policy, /`lite`, `full` or `ultra`/)
    assert.match(policy, /`shortcut: <the limit>, <when to upgrade>`/)
    assert.doesNotMatch(policy, /complexity-only/)
    const briefs = read(ROOT, 'assets', 'stack', 'ROLE-BRIEFS.md')
    assert.match(briefs, /smallest complete change/)
    assert.match(briefs, /`shortcut: <the limit>, <when to upgrade>`/)
    const reviewer = briefs.split('\n## Ponytail reviewer\n')[1].split('\n## ')[0]
    assert.match(reviewer, /`ponytail-review`/)
    assert.match(reviewer, /Lean/)
  })
})

describe('#139 ponytail follow-ups', () => {
  test('rule 1: README, next to the hooks exclusion, says to disable the ponytail plugin in Orca sessions and why', () => {
    const lines = read(ROOT, 'README.md').split('\n')
    const exclusion = lines.findIndex(line => line.startsWith('- **Los hooks de ciclo de vida completos de Ponytail'))
    assert.ok(exclusion >= 0, 'README lost the Ponytail hooks exclusion')
    const next = lines[exclusion + 1]
    assert.match(next, /plugin `ponytail`/)
    assert.match(next, /desactivalo en las sesiones de Orca/)
    assert.match(next, /skills adaptadas/)
    assert.match(next, /hooks duplican el control de Orca/)
  })

  test('rule 3: ponytail-help keeps the v5.3.2 body and adds an In Orca section on what applies', () => {
    const entry = provenance.skills['ponytail-help']
    assert.equal(entry.adapted, true)
    assert.equal(entry.upstreamSha256, '86ab0ce0af70cbeeeef499d5c884873b393f87f86401dcc45553662ce2c1eff9')
    const help = skill('ponytail-help')
    assert.ok(help.includes('\n## In Orca\n'), 'ponytail-help has no "## In Orca" section')
    const helpBody = body(help)
    assert.equal(sha256(helpBody.slice(0, helpBody.indexOf('\n## In Orca\n'))), entry.upstreamBodySha256)
    const section = help.slice(help.indexOf('\n## In Orca\n')).replace(/\s+/g, ' ')
    assert.match(section, /`ORCA_STACK_PONYTAIL_LEVEL`/)
    for (const inert of ['`PONYTAIL_DEFAULT_MODE`', 'ponytail `config.json`', '`/ponytail-gain`', '`/plugin`', '`/ponytail band`']) {
      assert.ok(section.includes(inert), `In Orca does not name ${inert}`)
    }
    assert.match(section, /do not apply in Orca/)
    assert.match(section, /`orca-stack global`/)
  })

  test('rule 4: the Ponytail reviewer passes a non-Lean Must fix to main and names its output format', () => {
    const briefs = read(ROOT, 'assets', 'stack', 'ROLE-BRIEFS.md')
    const reviewer = briefs.split('\n## Ponytail reviewer\n')[1].split('\n## ')[0].replace(/\s+/g, ' ')
    assert.match(reviewer, /report only its Lean findings/)
    assert.match(reviewer, /non-Lean \*Must fix\*/)
    assert.match(reviewer, /pass it to main in one line, never drop it/)
    assert.match(reviewer, /Output format: `## BLOQUEA` \/ `## SUGERENCIAS`/)
  })

  test('rule 5: an unattended worker never waits for the user, and at ultra ships the ticket and records its objections', () => {
    assert.match(orcaSection, /At any level, an unattended worker never waits for the user/)
    assert.match(orcaSection, /at `ultra` it builds what was asked and records its objections in its report or `## Desvíos del ticket`/)
    assert.match(orcaSection, /a ticket it thinks over-scoped/)
  })

  test('rule 6: a level the human sets mid-session with /ponytail wins over ORCA_STACK_PONYTAIL_LEVEL', () => {
    assert.match(orcaSection, /`\/ponytail <level>`/)
    assert.match(orcaSection, /the human's choice wins over `ORCA_STACK_PONYTAIL_LEVEL`/)
  })
})

describe('#264 re-vendor ponytail skills from v5.3.2', () => {
  test('Rule 1: provenance has v5.3.2 tag, commit and sha256 hashes, and README matches', () => {
    assert.equal(provenance.tag, 'v5.3.2')
    assert.equal(provenance.commit, '16352ac229eb08a9598dcae48fe9f2b342567d86')
    assert.equal(provenance.skills.ponytail.upstreamSha256, '9badd22a32e19cb884e46dfa8d3aae82bb81dfa5484105b8b4f0262df823a509')
    assert.equal(provenance.skills.ponytail.upstreamBodySha256, 'a04964c38852fed020b41b697e098bfbf93cf43d3137108116894333aedede1c')
    assert.equal(provenance.skills['ponytail-audit'].upstreamSha256, '2b3223a02c386d1263e1b08343cb8eb3a53e444cdafb1d79e26c8ec2a8fcad28')
    assert.equal(provenance.skills['ponytail-debt'].upstreamSha256, 'b5ec2762f6ba8c4af9ea7173aa6c9f91b88655a25e43f9de0264f6ce8722b25f')
    assert.equal(provenance.skills['ponytail-help'].upstreamSha256, '86ab0ce0af70cbeeeef499d5c884873b393f87f86401dcc45553662ce2c1eff9')
    assert.equal(provenance.skills['ponytail-help'].upstreamBodySha256, '7b2ea635e0a6fe6ee9892ff3a60c7d7d985594e41d997f838b46035223e6695d')
    assert.equal(provenance.skills['ponytail-review'].upstreamSha256, '33fe4ebe22a460924e5d4a261e223df22e409cc94ab76182bee9fb91a3ef022e')
    const row = read(ROOT, 'README.md').split('\n').find(line => line.startsWith('| Skills `ponytail`'))
    assert.ok(row, 'README has no ponytail row in "Origen y licencias"')
    assert.ok(row.includes('v5.3.2') && row.includes('16352ac'), row)
  })

  test('Rule 2: ponytail-debt is a byte-for-byte copy of upstream v5.3.2 and its Boundaries paragraph ends with One-shot.', () => {
    const debt = skill('ponytail-debt')
    assert.equal(sha256(debt), provenance.skills['ponytail-debt'].upstreamSha256)
    assert.match(debt, /To persist it, ask and it writes the\r?\nledger to a file \(e\.g\. `PONYTAIL-DEBT\.md`\)\. One-shot\.\r?\n$/)
    assert.doesNotMatch(debt, /"stop ponytail-debt" or "normal mode" to revert/)
  })

  test('Rule 3: ponytail-help keeps the v5.3.2 body with Band (Claude Code) and In Orca lists /ponytail band', () => {
    const help = skill('ponytail-help')
    assert.ok(help.includes('\n## Band (Claude Code)\n'), 'ponytail-help missing ## Band (Claude Code)')
    assert.ok(help.includes('\n## In Orca\n'), 'ponytail-help missing ## In Orca')
    const helpBody = body(help)
    const upstreamBody = helpBody.slice(0, helpBody.indexOf('\n## In Orca\n'))
    assert.equal(sha256(upstreamBody), provenance.skills['ponytail-help'].upstreamBodySha256)
    const orca = help.slice(help.indexOf('\n## In Orca\n')).replace(/\s+/g, ' ')
    for (const inert of ['`PONYTAIL_DEFAULT_MODE`', 'ponytail `config.json`', '`/ponytail-gain`', '`/plugin`', '`/ponytail band`']) {
      assert.ok(orca.includes(inert), `In Orca does not name ${inert}`)
    }
  })

  test('Rule 4: ponytail keeps its Orca frontmatter without off and its upstreamBodySha256 is unchanged', () => {
    const [, hint] = ponytail.match(/^argument-hint: "\[([^\]]+)\]"$/m) ?? []
    assert.deepEqual(hint?.split('|'), ['lite', 'full', 'ultra'])
    assert.doesNotMatch(hint, /\boff\b/)
    const upstreamBody = body(ponytail).slice(0, body(ponytail).indexOf('\n## In Orca\n'))
    assert.equal(sha256(upstreamBody), 'a04964c38852fed020b41b697e098bfbf93cf43d3137108116894333aedede1c')
    assert.equal(provenance.skills.ponytail.upstreamSha256, '9badd22a32e19cb884e46dfa8d3aae82bb81dfa5484105b8b4f0262df823a509')
  })

  test('Rule 5: ponytail-review and ponytail-audit stay byte-identical to their v5.2.0 hashes', () => {
    assert.equal(provenance.skills['ponytail-review'].upstreamSha256, '33fe4ebe22a460924e5d4a261e223df22e409cc94ab76182bee9fb91a3ef022e')
    assert.equal(provenance.skills['ponytail-audit'].upstreamSha256, '2b3223a02c386d1263e1b08343cb8eb3a53e444cdafb1d79e26c8ec2a8fcad28')
    assert.equal(sha256(skill('ponytail-review')), provenance.skills['ponytail-review'].upstreamSha256)
    assert.equal(sha256(skill('ponytail-audit')), provenance.skills['ponytail-audit'].upstreamSha256)
  })

  test('Rule 6: version strings say v5.3.2 in test/ponytail-vendor.test.mjs and doctor keeps 5.2.0 fixture', () => {
    const vendorTest = read(ROOT, 'test', 'ponytail-vendor.test.mjs')
    assert.doesNotMatch(vendorTest, /describe\([^)]*v5\.2\.0/)
    assert.match(vendorTest, /describe\([^)]*v5\.3\.2/)
    assert.equal(provenance.tag, 'v5.3.2')
    const doctorTest = read(ROOT, 'test', 'doctor-ponytail-plugin.test.mjs')
    assert.match(doctorTest, /version:\s*'5\.2\.0'/)
  })

  test('Rule 7: ponytail-gain stays out of the vendored set and notVendored keeps its reason', () => {
    assert.deepEqual(Object.keys(provenance.notVendored), ['ponytail-gain'])
    assert.equal(provenance.notVendored['ponytail-gain'], 'Benchmark scoreboard display: neither implementation policy nor over-engineering review, so it has no role in the stack.')
  })
})
