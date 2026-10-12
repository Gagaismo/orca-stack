import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'

import { run } from './util.mjs'

// gentle-ai writes this managed block into ~/.claude/CLAUDE.md. With receipt-driven development (RDD) off,
// its review sections are no-ops that every session still pays for, so `global` trims them.
// v2/v3 name it `sdd-orchestrator`; v4 retired SDD, renames the block in place to `orchestrator` and keeps the same
// review sections (gentle-ai v4.0.0 internal/components/agentguidance/orchestrator.go:23-28,435-455).
const MARKERS = {
  v2: { begin: '<!-- gentle-ai:sdd-orchestrator -->', end: '<!-- /gentle-ai:sdd-orchestrator -->' },
  v4: { begin: '<!-- gentle-ai:orchestrator -->', end: '<!-- /gentle-ai:orchestrator -->' },
}

const hasMarkers = (text, { begin, end }) => text.includes(begin) || text.includes(end)

// The marker pair the text uses: v4 when any v4 marker is there, v2 otherwise.
const generationOf = text => (hasMarkers(text, MARKERS.v4) ? 'v4' : 'v2')

const REVIEW_CONTRACT = '#### Review Execution Contract'
// Its subtree has `#`, `##` and `###` headings of its own, so it ends at a named heading, not at a level.
const REVIEW_CONTRACT_END = '#### Cost and Context Balance'

export const REVIEW_SECTIONS = new Set([
  '#### Gentle AI Provider Defect Handoff (MANDATORY)',
  '#### Delegated Verification Gate (MANDATORY)',
  '#### Native Checking Contract',
  REVIEW_CONTRACT,
  '## Lens selection',
  '### Concurrent Reviewer Group (MANDATORY)',
])

// Headings that belong to the Review Execution Contract's own subtree (`# Native Compact Review Orchestration` and the
// authority-first markers). Anything else found inside what would be removed means gentle-ai's text changed shape.
const CONTRACT_SUBTREE = new Set([
  '# Native Compact Review Orchestration',
  '## Entry rule',
  '## Atomic lifecycle',
  '### Cross-repository lifecycle root',
  '## Capture and correction',
  '## Consent and immutable inspection',
  '### Authority-First Terminal Procedure',
  '### Continue after a stop reason code',
  '## Delivery follows ordinary repository policy',
])

const levelOf = line => /^(#{1,6})\s/.exec(line)?.[1].length ?? 0

// Pure and all-or-nothing: removes the review sections from the gentle-ai block, or changes nothing. Each section runs from
// its heading to the next heading of level 4 or higher that is not itself in the list. If a section has no end, if the text
// to remove holds a heading that is neither a listed section nor part of the contract's known subtree, or if a code fence is
// left open, it returns the text unchanged with `skipped` saying why. Returns { text, removed (bytes), skipped? }.
export const trimReviewSections = text => {
  const markers = MARKERS[generationOf(text)]
  const begin = text.indexOf(markers.begin)
  const end = text.indexOf(markers.end)
  if (begin === -1 || end === -1 || end < begin) {
    return { text, removed: 0 }
  }
  const from = begin + markers.begin.length
  const kept = []
  let skipping = false
  let until = null // set while inside the Review Execution Contract
  let fenced = false
  let unknown = null
  const removedLines = []
  for (const line of text.slice(from, end).split('\n')) {
    const title = line.trimEnd()
    if (/^\s*```/.test(line)) {
      fenced = !fenced
    }
    const heading = !fenced && levelOf(line) > 0
    if (skipping && heading) {
      if (until !== null ? title === until : !REVIEW_SECTIONS.has(title) && levelOf(line) <= 4) {
        skipping = false
        until = null
      } else if (title === REVIEW_CONTRACT) {
        until = REVIEW_CONTRACT_END
      } else if (!REVIEW_SECTIONS.has(title) && !(until !== null && CONTRACT_SUBTREE.has(title))) {
        unknown ??= title
      }
    }
    if (!skipping && heading && REVIEW_SECTIONS.has(title)) {
      skipping = true
      until = title === REVIEW_CONTRACT ? REVIEW_CONTRACT_END : null
    }
    if (skipping) {
      removedLines.push(line)
    } else {
      kept.push(line)
    }
  }
  // Second pass, ignoring fences: an unbalanced fence closed later in kept text hides headings from the first one.
  // A fence that opens and closes inside the removed range hides its `# comment` lines (level 1); one left open there does not.
  let inside = false
  const flagged = removedLines.map(line => {
    inside = /^\s*```/.test(line) ? !inside : inside

    return { title: line.trimEnd(), inFence: inside }
  })
  const balanced = !inside
  unknown ??= flagged.find(({ title, inFence }) => !(balanced && inFence && levelOf(title) === 1) && levelOf(title) > 0 && !REVIEW_SECTIONS.has(title) && !CONTRACT_SUBTREE.has(title))?.title ?? null
  const skip = skipped => ({ text, removed: 0, skipped })
  if (fenced) {
    return skip('hay un bloque de código sin cerrar')
  }
  if (skipping) {
    return skip('una sección de review no tiene un encabezado donde termine')
  }
  if (unknown !== null) {
    return skip(`entre las secciones a sacar hay un encabezado que no reconozco: ${unknown}`)
  }
  const next = text.slice(0, from) + kept.join('\n') + text.slice(end)

  return { text: next, removed: Buffer.byteLength(text) - Buffer.byteLength(next) }
}

// { mode: 'on' | 'off' | null, source: string | null }: the first line of `gentle-ai review mode status`.
export const rddMode = bin => {
  if (!bin) {
    return { mode: null, source: null }
  }
  const result = run(bin, ['review', 'mode', 'status'], { timeout: 20_000 })
  if (result.status !== 0) {
    return { mode: null, source: null }
  }
  const match = /receipt-driven development:\s*(\w+)(?:[^\r\n]*\(decided by\s*([\w-]+)\))?/i.exec(result.stdout)
  const rawMode = match?.[1]?.toLowerCase()
  const mode = rawMode === 'on' || rawMode === 'off' ? rawMode : null
  const source = mode ? (match?.[2]?.toLowerCase() ?? null) : null

  return { mode, source }
}

// Lazy mode (`gentle.orchestrator: "lazy"`, the default): the block's body is replaced by a short pointer that starts with
// this sentinel; the full body lives in ~/.orca-stack/gentle/orchestrator.md and is read on demand. The markers stay, so
// `gentle-ai sync` replaces the pointer instead of appending a second block.
export const LAZY_SENTINEL = '<!-- orca-stack:gentle-lazy v1 -->'

// v4 ships no SDD workflow file: its block is the whole ODD orchestrator.
export const lazyPointer = (copyPath, generation = 'v2') => [
  ...(generation === 'v4' ? ['ODD is the default workflow (see the agent-routing block).'] : []),
  `The full gentle-ai coordinator rules are in \`${copyPath}\`: read them in full when you are the orchestrating session (\`main\`).`,
  "When a sub-agent or tool returns a blocking prompt, menu or consent envelope, present it complete and unsummarized, and never answer on the human's behalf.",
]

const eolOf = text => (text.includes('\r\n') ? '\r\n' : '\n')

// Locates the block body between the markers. { status: 'none' | 'malformed' | 'ok', generation, from, end, inner }.
// Anything but exactly one opener followed by exactly one closer of one generation is 'malformed' (nothing may be written).
export const sddBlock = text => {
  if (hasMarkers(text, MARKERS.v2) && hasMarkers(text, MARKERS.v4)) {
    return { status: 'malformed' }
  }
  const generation = generationOf(text)
  const { begin: open, end: close } = MARKERS[generation]
  const count = marker => text.split(marker).length - 1
  const opens = count(open)
  const closes = count(close)
  if (opens === 0 && closes === 0) {
    return { status: 'none' }
  }
  const begin = text.indexOf(open)
  const end = text.indexOf(close)
  if (opens !== 1 || closes !== 1 || end < begin) {
    return { status: 'malformed' }
  }
  const from = begin + open.length

  return { status: 'ok', generation, from, end, inner: text.slice(from, end) }
}

export const NO_BLOCK = 'no hay bloque gentle-ai:orchestrator (v4) ni gentle-ai:sdd-orchestrator (v2/v3)'

export const isLazyBlock = block => block.status === 'ok' && block.inner.includes(LAZY_SENTINEL)

export const refreshLazyPointer = (text, copyPath) => {
  const block = sddBlock(text)
  if (!isLazyBlock(block)) {
    return text
  }
  const eol = eolOf(text)
  const current = [eol + LAZY_SENTINEL, ...lazyPointer(copyPath, block.generation)].join(eol) + eol

  return block.inner === current ? text : text.slice(0, block.from) + current + text.slice(block.end)
}

// Migrate the old copy path without losing either file when both names exist.
// The newer mtime wins; ties keep the canonical orchestrator path.
export const migrateOrchestratorCopy = ctx => {
  const current = ctx.L.orchestratorCopy
  const legacy = ctx.L.legacyOrchestratorCopy
  if (!existsSync(legacy)) {
    return { path: current, skipped: false }
  }

  const currentExists = existsSync(current)
  const legacyWins = !currentExists || statSync(legacy).mtimeMs > statSync(current).mtimeMs
  if (legacyWins) {
    const result = ctx.writeOwned(current, readFileSync(legacy), {
      force: true,
      label: `${ctx.show(current)} (copia completa del bloque de gentle-ai)`,
    })
    if (result === 'skipped') {
      return { path: current, skipped: true }
    }
  }

  ctx.act(`respaldo y migro ${ctx.show(legacy)} a ${ctx.show(current)}`)
  if (!ctx.dryRun) {
    ctx.backup(legacy)
    unlinkSync(legacy)
  }

  return { path: ctx.dryRun && !currentExists ? legacy : current, skipped: false }
}

// Pure: swaps the body for the pointer. Returns { text, saved (the exact body replaced) }, or { text, skipped } untouched.
export const lazyifyBlock = (text, copyPath) => {
  const block = sddBlock(text)
  if (block.status !== 'ok') {
    return { text, skipped: block.status === 'none' ? NO_BLOCK : 'los marcadores del bloque de gentle-ai están incompletos, repetidos o desordenados' }
  }
  const eol = eolOf(text)
  const inner = [eol + LAZY_SENTINEL, ...lazyPointer(copyPath, block.generation)].join(eol) + eol

  return { text: text.slice(0, block.from) + inner + text.slice(block.end), saved: block.inner }
}

// Pure: puts a saved body back between the markers.
export const restoreBlock = (text, saved) => {
  const block = sddBlock(text)

  return block.status === 'ok' ? text.slice(0, block.from) + saved + text.slice(block.end) : text
}

// ~/.orca-stack/config.json as an object, or null when it is missing or unreadable (doctor reports the latter).
export const readPersonalConfig = L => {
  try {
    return existsSync(L.config) ? JSON.parse(readFileSync(L.config, 'utf8').replace(/^﻿/, '')) : null
  } catch {
    return null
  }
}

// New config wins when present; the legacy key remains a fallback during migration.
export const orchestratorMode = config => {
  const gentle = config?.gentle ?? {}
  const value = Object.hasOwn(gentle, 'orchestrator') ? gentle.orchestrator : gentle.sddOrchestrator

  return value === undefined ? 'lazy' : value === 'lazy' || value === 'full' ? value : null
}

export const hasLegacyOrchestratorMode = config => Object.hasOwn(config?.gentle ?? {}, 'sddOrchestrator')
