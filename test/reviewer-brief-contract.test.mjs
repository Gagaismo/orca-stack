import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

const files = [
  'assets/stack/brief-revision.md',
  'assets/stack/ROLE-BRIEFS.md',
]

const invariants = [
  {
    name: 'derive independent tests from rules, touched public entries, and invariants',
    matches: text => /requirements verifier/i.test(text)
      && /derive and run your own tests/i.test(text)
      && /(?:every|each|all).{0,40}(?:numbered rule|rule in|## Reglas)/is.test(text)
      && /acceptance criteria/i.test(text)
      && /failure modes/i.test(text)
      && /touched public entr(?:y|ies)/i.test(text)
      && /relevant invariants/i.test(text),
  },
  {
    name: 'do not reuse author tests, fakes, or fixtures and prefer the real external system',
    matches: text => /do not reuse|never reuse/i.test(text)
      && /author'?s tests/i.test(text)
      && /fakes/i.test(text)
      && /fixtures/i.test(text)
      && /external services?/i.test(text)
      && /real (?:system|service)/i.test(text)
      && /when (?:possible|the repository has a way)|when it does not/i.test(text),
  },
  {
    name: 'put each failing verifier test under BLOQUEA with its code',
      matches: text => /(?:failing verifier test|verifier test[s]? that fail[s]?)/i.test(text)
      && /## BLOQUEA/i.test(text)
      && /(?:including|with) (?:its|the) (?:test )?code/i.test(text),
  },
  {
    name: 'retain the inexpensive check that an author test fails without the change',
    matches: text => /(?:author'?s|PR'?s own).{0,40}(?:evidence|secondary)/i.test(text)
      && /secondary/i.test(text)
      && /inexpensive check/i.test(text)
      && /author test fails without (?:the )?change/i.test(text),
  },
  {
    name: 'delete verifier test files after running them',
    matches: text => /delete (?:your )?verifier test files after running them/i.test(text),
  },
  {
    name: 'distinguish implementation and interpretation blockers and route interpretation to the human',
    matches: text => /tag (?:a )?blockers?/i.test(text)
      && /implementaci[oó]n/i.test(text)
      && /interpretaci[oó]n/i.test(text)
      && /interpretaci[oó]n.{0,300}human/is.test(text)
      && /(?:must not|never) settle.{0,30}`?Decidido por main`?/i.test(text),
  },
  {
    name: 'report only without fixing code, with at most three suggestions and no praise list',
    matches: text => /do not (?:fix the code|apply fixes)/i.test(text)
      && /(?:at most three suggestions|at most three, one line each)/i.test(text)
      && /no lists? of what is fine/i.test(text),
  },
  {
    files: ['assets/stack/ROLE-BRIEFS.md'],
    name: 'block a comment finding only as regla escrita citing CODING_STANDARDS.md:<line> or a failing orca-stack lint run, send a disliked comment to SUGERENCIAS, and never flag a Decision Record that cites #n or an ADR',
    matches: text => /comment finding blocks only as `regla escrita`, citing `CODING_STANDARDS\.md:<line>`/.test(text)
      && /or as `comando`, with a failing `orca-stack lint` run/.test(text)
      && /comment you merely dislike goes to `## SUGERENCIAS`/.test(text)
      && /Decision Record that cites an issue `#n` or an ADR is never a finding/.test(text),
  },
  {
    name: 'state the touched public entry definition word for word',
    matches: text => text.includes('A public entry is touched when its own code changed in the diff, or when it calls a shared function whose code changed in the diff. A public entry is a command, endpoint, exported function, screen or scheduled job.'),
  },
]

describe('reviewer brief contract', () => {
  for (const invariant of invariants) {
    for (const file of invariant.files ?? files) {
      test(`${file} states: ${invariant.name}`, () => {
        const text = readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\s+/g, ' ').trim()
        assert.ok(invariant.matches(text), `${file}: missing invariant "${invariant.name}"`)
      })
    }
  }

  test('accepts a rewording that preserves the verifier-test deletion rule', () => {
    const deletionRule = invariants.find(({ name }) => name === 'delete verifier test files after running them')
    const reworded = 'Delete your verifier test files after running them'
      .replace('your verifier', 'verifier')

    assert.equal(deletionRule.matches(reworded), true)
  })

  test('does not require reviewer-only rules to appear in both briefs', () => {
    const reviewerOnlyRule = 'On a re-review, read only the delta since the last reviewed commit'

    assert.equal(invariants.some(({ matches }) => matches(reviewerOnlyRule)), false)
  })

  test('Rule 4 negative: dropping the Decision Record exception or letting a disliked comment block breaks the comment axis invariant', () => {
    const axis = invariants.find(({ name }) => name.startsWith('block a comment finding'))
    const text = readFileSync(path.join(process.cwd(), 'assets/stack/ROLE-BRIEFS.md'), 'utf8').replace(/\s+/g, ' ')
    assert.equal(axis.matches(text), true)
    assert.equal(axis.matches(text.replace('A Decision Record that cites an issue `#n` or an ADR is never a finding.', '')), false)
    assert.equal(axis.matches(text.replace('goes to `## SUGERENCIAS`', 'goes to `## BLOQUEA`')), false)
  })
})
