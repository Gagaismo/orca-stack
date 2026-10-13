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

describe('vendored ponytail skills (upstream v5.2.0)', () => {
  test('rule 1: the vendored set is the v5.2.0 skills the stack uses, verbatim unless adapted', () => {
    const vendored = readdirSync(SKILLS).filter(name => name.startsWith('ponytail') && statSync(path.join(SKILLS, name)).isDirectory())
    assert.deepEqual(vendored.sort(), Object.keys(provenance.skills).sort())
    assert.deepEqual(Object.keys(provenance.notVendored), ['ponytail-gain'])
    for (const [name, entry] of Object.entries(provenance.skills)) {
      if (!entry.adapted) assert.equal(sha256(skill(name)), entry.upstreamSha256, `${name} differs from upstream v5.2.0`)
    }
  })

  test('rule 2: ponytail keeps the v5.2.0 body and re-applies the Orca adaptations after it', () => {
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

  test('rule 3: provenance names the upstream repo, tag v5.2.0 and commit, and the README matches', () => {
    assert.equal(provenance.repo, 'https://github.com/DietrichGebert/ponytail')
    assert.equal(provenance.tag, 'v5.2.0')
    assert.match(provenance.commit, /^[0-9a-f]{40}$/)
    const row = read(ROOT, 'README.md').split('\n').find(line => line.startsWith('| Skills `ponytail`'))
    assert.ok(row, 'README has no ponytail row in "Origen y licencias"')
    assert.ok(row.includes('v5.2.0') && row.includes(provenance.commit.slice(0, 7)), row)
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

  test('rule 5: ORCA_STACK_PONYTAIL_LEVEL carries a v5.2.0 level, and an unknown one means full', () => {
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

  test('rule 3: ponytail-help keeps the v5.2.0 body and adds an In Orca section on what applies', () => {
    const entry = provenance.skills['ponytail-help']
    assert.equal(entry.adapted, true)
    assert.equal(entry.upstreamSha256, '2927276bc9c10221ce8bcf80adb798db130cd70eb33a95db91ab3a0d105f5109')
    const help = skill('ponytail-help')
    assert.ok(help.includes('\n## In Orca\n'), 'ponytail-help has no "## In Orca" section')
    const helpBody = body(help)
    assert.equal(sha256(helpBody.slice(0, helpBody.indexOf('\n## In Orca\n'))), entry.upstreamBodySha256)
    const section = help.slice(help.indexOf('\n## In Orca\n')).replace(/\s+/g, ' ')
    assert.match(section, /`ORCA_STACK_PONYTAIL_LEVEL`/)
    for (const inert of ['`PONYTAIL_DEFAULT_MODE`', 'ponytail `config.json`', '`/ponytail-gain`', '`/plugin`']) {
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
