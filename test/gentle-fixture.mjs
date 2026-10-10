import { chmodSync } from 'node:fs'
import path from 'node:path'

import { CODEX_ASCII_MARKERS, CODEX_ASCII_RULE } from '../src/codex-windows.mjs'
import { upsertBlock } from '../src/marker.mjs'
import { write } from './helpers.mjs'

// Mirrors the headings of the block gentle-ai writes (the review sections sit between kept ones).
export const KEPT = [
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
export const fixture = eol =>
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
    '// not a heading, inside a fence',
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

// The agent-routing block gentle-ai v4 writes (v4.0.0 internal/components/agentguidance/routing.go:24-145, inject.go:94-150), with
// the real headings and anchor lines and short bodies. `rdd` runtimes (claude, codex) get the RDD switch; codex also gets its
// worker table. The nested remote-authorization block comes last (remote_authorization.go:13-16).
export const routingV4 = runtime => [
  '<!-- gentle-ai:agent-routing -->',
  '## Implementation Routing',
  '',
  'Organic Driven Development (ODD) is the predefined workflow of this orchestrator. Every request enters it, on every runtime, without the user asking for a workflow, a plan, or task tracking.',
  '',
  '### ODD protocol (MANDATORY, in this order, on every request)',
  '',
  '1. **Authorize.** First establish whether the requested outcome explicitly authorizes a change.',
  '   - Read-only work may inspect, explain, compare, and recommend.',
  '   - If change intent is ambiguous or conditional, ask one clarification and remain read-only until answered.',
  '2. **Explore.** Explore the existing code and requirements first.',
  '3. **Resolve uncertainty.** Recommend optional research only for a named uncertainty.',
  '4. **Classify.** The work is substantial when exploration yields two or more meaningful implementation steps.',
  '5. **Track before the first write.** For substantial authorized implementation, create `odd/tasks/<feature-name>.md` and its Engram mirror.',
  '6. **Implement task by task.** Route each task through the smallest useful topology below.',
  '7. **Close.** Report the verified outcome, every failed, skipped, or pending check, and the next step.',
  '',
  'Resume an interrupted feature with `mem_context`, then the task file itself.',
  '',
  'After explicit change intent is established, route work for the requested outcome with the smallest useful topology.',
  '',
  '- **Direct inline:** decide or verify with one parallel batch.',
  '- **Delegated direct:** larger evidence require one read-only explorer.',
  '',
  '### Mandatory Delegation Triggers',
  '',
  'These triggers are mandatory, not advisory.',
  '',
  '- **Route declaration:** for substantial work, record the chosen route per task in the feature document.',
  '- These triggers only choose between direct inline and delegated direct inside the organic flow.',
  '',
  '### Organic Driven Development',
  '',
  'Use this flow for direct and delegated work.',
  '',
  '- Keep `odd/tasks/<feature-name>.md` and an Engram recovery copy.',
  ...(runtime === 'gemini'
    ? []
    : [
        '- When RDD is enabled, first use the existing native candidate risk assessment.',
        '',
        '### Receipt-driven development is user-owned',
        '',
        'The user controls receipt-driven development with a switch: `gentle-ai review mode enable|disable|status`.',
      ]),
  ...(runtime === 'codex'
    ? ['', '', '### Codex ODD worker assignments', '', 'Use the exact model and reasoning_effort for the selected worker class.', '', '| ODD worker class | Model |', '|---|---|', '| `odd-worker` | `gpt` |']
    : []),
  '',
  '<!-- gentle-ai:remote-authorization -->',
  '## Remote operation authorization',
  '',
  'Permission to develop locally does not authorize remote execution or file transfer.',
  '<!-- /gentle-ai:remote-authorization -->',
  '<!-- /gentle-ai:agent-routing -->',
]

// What survives the routing trim, in order (rule 1): the ODD paragraphs and sections are gone, the rest is verbatim.
export const ROUTING_KEPT = [
  '1. **Authorize.**',
  'After explicit change intent is established',
  '### Mandatory Delegation Triggers',
  '<!-- gentle-ai:remote-authorization -->',
  '## Remote operation authorization',
  '<!-- /gentle-ai:remote-authorization -->',
]
export const ROUTING_GONE = [
  'Organic Driven Development (ODD) is the predefined workflow',
  'ODD protocol (MANDATORY',
  '2. **Explore.**',
  '5. **Track before the first write.**',
  '7. **Close.**',
  'Resume an interrupted feature',
  '### Organic Driven Development',
  'Codex ODD worker assignments',
]

// The orchestrator block of a codex or antigravity file: same markers as claude's v4 block, another layout
// (~/.codex/AGENTS.md: `# ODD Orchestrator for Codex`; ~/.gemini/GEMINI.md: `# Agent Teams Lite — Orchestrator Instructions (Antigravity)`).
export const runtimeFile = (runtime, eol = '\n') =>
  [
    `## Hand-written ${runtime} rules`,
    'mine, outside every marker',
    '',
    ...routingV4(runtime),
    '',
    '<!-- gentle-ai:orchestrator -->',
    runtime === 'codex' ? '# ODD Orchestrator for Codex' : '# Agent Teams Lite — Orchestrator Instructions (Antigravity)',
    '### Organic Driven Development Is The Default Workflow (MANDATORY)',
    'odd body',
    ...(runtime === 'codex' ? ['#### Review Execution Contract', 'contract body'] : []),
    '<!-- /gentle-ai:orchestrator -->',
    '',
  ].join(eol) + (runtime === 'codex' ? upsertBlock('', CODEX_ASCII_RULE, CODEX_ASCII_MARKERS).replaceAll('\n', eol) : '')

// The block gentle-ai v4 writes for Claude Code: `<!-- gentle-ai:orchestrator -->` (v4.0.0
// internal/components/agentguidance/orchestrator.go:23 and :454-455), rendered from internal/assets/claude/orchestrator.md with
// the shared ODD sections expanded and the review contract (internal/assets/skills/_shared/review-ledger-contract.md plus the
// Concurrent Reviewer Group, internal/components/reviewassets/contract.go:27,58-59) in place of the Review Execution Contract body.
// The review sections sit between kept ones, as in v2; the agent-routing block outside it is not ours to touch.
export const KEPT_V4 = [
  '## Engram Persistent Memory',
  '## Implementation Routing',
  '### ODD protocol (MANDATORY, in this order, on every request)',
  '### Mandatory Delegation Triggers',
  '### Organic Driven Development',
  '### Receipt-driven development is user-owned',
  '## Remote operation authorization',
  '# Agent Teams Lite — Orchestrator Instructions',
  '## Agent Teams Orchestrator',
  '### Identity Contract',
  '### Organic Driven Development Is The Default Workflow (MANDATORY)',
  '### Lossless Blocking Prompts (MANDATORY)',
  '### Language Domain Contract',
  '### Delegation Rules',
  '#### Mandatory Delegation Triggers',
  '#### Cost and Context Balance',
  '### Work Routing Ladder',
  '#### 1. Inline Direct',
  '### Skill Registry Protocol',
]
export const fixtureV4 = eol =>
  [
    '## Engram Persistent Memory',
    'engram body',
    '',
    ...routingV4('claude'),
    '',
    '<!-- gentle-ai:orchestrator -->',
    '# Agent Teams Lite — Orchestrator Instructions',
    'intro',
    '## Agent Teams Orchestrator',
    '### Identity Contract',
    'identity body',
    '### Organic Driven Development Is The Default Workflow (MANDATORY)',
    'odd body',
    '### Lossless Blocking Prompts (MANDATORY)',
    'lossless body',
    '#### Gentle AI Provider Defect Handoff (MANDATORY)',
    'defect body',
    '',
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
    '## Atomic lifecycle',
    '### Cross-repository lifecycle root',
    '## Capture and correction',
    '## Consent and immutable inspection',
    '### Authority-First Terminal Procedure',
    'table',
    '### Continue after a stop reason code',
    '## Delivery follows ordinary repository policy',
    '### Concurrent Reviewer Group (MANDATORY)',
    'concurrent body',
    '#### Cost and Context Balance',
    'cost body',
    '### Work Routing Ladder',
    '#### 1. Inline Direct',
    'ladder body',
    '### Skill Registry Protocol',
    'registry body',
    '<!-- /gentle-ai:orchestrator -->',
    '',
  ].join(eol)


// A fake `gentle-ai` first in the PATH, answering the RDD status the test asks for.
export const fakeGentle = (dir, mode, source = 'default') => {
  const win = process.platform === 'win32'
  const file = path.join(dir, win ? 'gentle-ai.cmd' : 'gentle-ai')
  const suffix = source ? ` (decided by ${source})` : ''
  write(file, win ? `@echo receipt-driven development: ${mode}${suffix}\r\n` : `#!/bin/sh\necho "receipt-driven development: ${mode}${suffix}"\n`)
  if (!win) {
    chmodSync(file, 0o755)
  }
}
export const withPath = bin => {
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH'

  return { [key]: `${bin}${path.delimiter}${process.env[key]}` }
}


// ~/.orca-stack/config.json with gentle.sddOrchestrator set (lazy is the default when the key is absent).
export const sddConfig = (home, mode) =>
  write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify(mode === undefined ? {} : { gentle: { sddOrchestrator: mode } }))
