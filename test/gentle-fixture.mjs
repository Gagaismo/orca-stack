import { chmodSync } from 'node:fs'
import path from 'node:path'

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

// The block gentle-ai v4 writes for Claude Code: `<!-- gentle-ai:orchestrator -->` (v4.0.0
// internal/components/agentguidance/orchestrator.go:23 and :454-455), rendered from internal/assets/claude/orchestrator.md with
// the shared ODD sections expanded and the review contract (internal/assets/skills/_shared/review-ledger-contract.md plus the
// Concurrent Reviewer Group, internal/components/reviewassets/contract.go:27,58-59) in place of the Review Execution Contract body.
// The review sections sit between kept ones, as in v2; the agent-routing block outside it is not ours to touch.
export const KEPT_V4 = [
  '## Engram Persistent Memory',
  '## Implementation Routing',
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
    '<!-- gentle-ai:agent-routing -->',
    '## Implementation Routing',
    'routing body',
    '<!-- /gentle-ai:agent-routing -->',
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
