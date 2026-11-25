import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { renderBrief } from '../src/despacho.mjs'

// #398: a supervised worker asks main through `orca orchestration ask`, not with a GitHub `Consulta:` comment.
const AGENTS = ['claude', 'codex', 'agy', 'pi']
const brief = agent => renderBrief('ticket', { AGENT: agent, ISSUE: '398', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })

describe('issue #398: worker questions through Orca', () => {
  test('S1: the ticket brief tells a supervised worker to ask with orca orchestration ask, recommended option first, typed answer allowed, and to continue and end its turn until Orca wakes it', () => {
    for (const agent of AGENTS) {
      const text = brief(agent)
      assert.ok(text.includes('## Questions to main\n\nOrca started you as a supervised worker, so your questions to main go through Orca, not GitHub:\n\n```\norca orchestration ask --question "<question>" --options "<recommended>,<other options>"\n```'), agent)
      assert.ok(text.includes('- Asking: put your recommended option first; main may also reply with a typed answer instead of an option. The call returns at once: continue with the tasks that do not depend on the answer, then end your turn. Orca wakes you with the answer.'), agent)
      assert.ok(text.includes('A message from main may arrive while you work. It points at a comment: read it, adjust, and keep going. It never asks you to wait. The answer to an `ask` is different: it arrives as Orca mail, not as a comment.'), agent)
      assert.ok(text.includes('If you are blocked, ask main with `orca orchestration ask` (see `## Questions to main`), then continue with whatever is not blocked.'), agent)
      assert.ok(text.includes('A question, including a deviation that needs a decision, always goes through `orca orchestration ask`.'), agent)
      assert.ok(text.includes('Step 3 (Resolve uncertainty): product questions go to main with `orca orchestration ask` (see `## Questions to main`), then continue with whatever is not blocked; never stop and wait.'), agent)
      assert.ok(!text.includes('Consulta:'), agent)
      // The GitHub question path is gone for the supervised worker; the diagnosis stays on GitHub.
      assert.ok(!text.includes('If you are blocked, ask by commenting on the issue'), agent)
      assert.ok(!text.includes('product questions go to the issue as a comment'), agent)
      assert.ok(!text.includes('Anything you post for main (a question'), agent)
      assert.ok(text.includes(`publish \`Diagnóstico: ${agent}\` with \`Causa:\``), agent)
    }
  })

  test('S2: RDD consent and exact-token decisions never accept a typed answer, and the RDD policy answer stays declined', () => {
    for (const agent of AGENTS) {
      const text = brief(agent)
      assert.ok(text.includes('- Closed decisions stay closed: an RDD consent or an exact-token decision (an answer that must be one exact value) never accepts a typed answer. List only the closed options, and if the reply is not exactly one of them, ask again; never act on it.'), agent)
      assert.ok(text.includes('If RDD asks for consent on your own candidate (an RDD you would start before the PR), the orca-stack policy answer is `declined`'), agent)
      assert.ok(text.includes(`This holds while \`agentes.${agent}.rddConsentimiento\` in .orca-stack.json is absent or \`"politica"\` (the default); with \`"humano"\`, ask main with \`orca orchestration ask\` instead, with only the consent's choices as closed options (see \`## Questions to main\`).`), agent)
      assert.ok(!text.includes('with `"humano"`, ask with a `Consulta:'), agent)
    }
  })

  test('S5: a file outside what the ticket covers is proposed with ask, never self-authorized, recorded under Desvíos del ticket; editing an unrelated module without an approving reply breaks the rule', () => {
    for (const agent of AGENTS) {
      const text = brief(agent)
      assert.ok(text.includes('- Edit surfaces: a file outside what the ticket covers is never self-authorized. Propose it with `ask` (the path and why), continue with independent tasks, and edit it only after a `reply` that approves it; record what was approved under `## Desvíos del ticket`. Editing an unrelated module without a `reply` approving it breaks this rule.'), agent)
    }
  })
})
