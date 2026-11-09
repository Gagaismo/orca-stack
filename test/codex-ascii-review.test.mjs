import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { CODEX_ASCII_RULE } from '../src/codex-windows.mjs'
import { renderBrief } from '../src/despacho.mjs'

const review = extra => renderBrief('review', { AGENT: 'codex', PR: '340', REPO: 'orca-stack', BASE: 'main', SHA: 'abc1234', IMPLEMENTER: 'claude', ...extra })
const GLOBAL_RULES = "Only a rule written in the repo's own AGENTS.md is `regla escrita`: a rule from your own global instructions (for example `~/.codex/AGENTS.md`, such as its rule to escape non-ASCII characters) is for the code you write, not for the reviewed code, and does not block. For example, `está` in a string literal of the reviewed code does not block unless that rule is written in the repo's own AGENTS.md."

describe('issue 342: the codex ASCII rule is for code codex writes', () => {
  test('rule 1: the rendered codex review brief says global instructions are not regla escrita, and a repo rule still blocks', () => {
    const brief = review()
    assert.ok(brief.includes(GLOBAL_RULES), brief)
    // Negative: a rule written in the repo's own files is still regla escrita.
    assert.ok(brief.includes('`regla escrita` (Standards): a `file:line` as in the reviewed commit that breaks a rule written in AGENTS.md, quoting the rule.'))
    const withStandards = review({ HAS_CODING_STANDARDS: true })
    assert.ok(withStandards.includes("Only a rule written in the repo's own CODING_STANDARDS.md and AGENTS.md is `regla escrita`:"), withStandards)
    assert.ok(withStandards.includes("unless that rule is written in the repo's own CODING_STANDARDS.md and AGENTS.md."))
  })

  test('rule 2: the codex block says it is a rule for the code codex writes, not a review criterion, and keeps the escape rule', () => {
    assert.ok(CODEX_ASCII_RULE.includes('write every non-ASCII character in a string literal as a `\\u` escape'))
    assert.ok(CODEX_ASCII_RULE.includes("- This rule is for the code you write. It is not a review criterion: when you review another agent's code, do not block or flag its non-ASCII characters; only a rule in that repo's own `AGENTS.md` or `CODING_STANDARDS.md` counts."), CODEX_ASCII_RULE)
  })
})
