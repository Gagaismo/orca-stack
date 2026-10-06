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


// A fake `gentle-ai` first in the PATH, answering the RDD status the test asks for.
export const fakeGentle = (dir, mode) => {
  const win = process.platform === 'win32'
  const file = path.join(dir, win ? 'gentle-ai.cmd' : 'gentle-ai')
  write(file, win ? `@echo receipt-driven development: ${mode} (decided by default)\r\n` : `#!/bin/sh\necho "receipt-driven development: ${mode} (decided by default)"\n`)
  if (!win) {
    chmodSync(file, 0o755)
  }
}
export const withPath = bin => {
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH'

  return { [key]: `${bin}${path.delimiter}${process.env[key]}` }
}

