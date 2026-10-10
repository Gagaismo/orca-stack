import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

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

// Lazy mode (`gentle.sddOrchestrator: "lazy"`, the default): the block's body is replaced by a short pointer that starts with
// this sentinel; the full body lives in ~/.orca-stack/gentle/sdd-orchestrator.md and is read on demand. The markers stay, so
// `gentle-ai sync` replaces the pointer instead of appending a second block.
export const LAZY_SENTINEL = '<!-- orca-stack:gentle-lazy v1 -->'

// v4 ships no SDD workflow file: its block is the whole ODD orchestrator.
export const lazyPointer = (copyPath, generation = 'v2') => [
  ...(generation === 'v4'
    ? [
        'gentle-ai ODD orchestrator / Judgment Day: only when the human explicitly asks for it.',
        `Before any gentle-ai ODD or Judgment-Day command or phase, read in full \`${copyPath}\`.`,
      ]
    : [
        'gentle-ai SDD / Judgment Day: only when the human explicitly asks for it.',
        `Before any SDD or Judgment-Day command or phase, read in full \`${copyPath}\`, then \`.claude/skills/_shared/sdd-orchestrator-workflow.md\` in the workspace if present, otherwise \`~/.claude/skills/_shared/sdd-orchestrator-workflow.md\`.`,
      ]),
  "When a sub-agent or tool returns a blocking prompt, menu or consent envelope, present it complete and unsummarized, and never answer on the human's behalf.",
]

const eolOf = text => (text.includes('\r\n') ? '\r\n' : '\n')

// Locates the body between one marker pair. { status: 'none' | 'malformed' | 'ok', from, end, inner }.
// Anything but exactly one opener followed by exactly one closer is 'malformed' (nothing may be written).
const markedBlock = (text, { begin: open, end: close }) => {
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

  return { status: 'ok', from, end, inner: text.slice(from, end) }
}

// The orchestrator block, v2 or v4, plus its generation. A file with markers of both generations is 'malformed'.
export const sddBlock = text => {
  if (hasMarkers(text, MARKERS.v2) && hasMarkers(text, MARKERS.v4)) {
    return { status: 'malformed' }
  }
  const generation = generationOf(text)

  return { ...markedBlock(text, MARKERS[generation]), generation }
}

export const NO_BLOCK = 'no hay bloque gentle-ai:orchestrator (v4) ni gentle-ai:sdd-orchestrator (v2/v3)'

export const isLazyBlock = block => block.status === 'ok' && block.inner.includes(LAZY_SENTINEL)

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

// gentle-ai v4 also writes an `agent-routing` block that makes ODD mandatory on every request, in every runtime, with no switch
// to turn it off (v4.0.0 internal/components/agentguidance/routing.go:1-3, rendered at :24-145, injected by inject.go:94-150).
// Lazy mode cuts the ODD paragraphs by exact anchors and keeps the authorization guard (step 1), the routes paragraph, the
// delegation triggers, the RDD switch and the nested remote-authorization block verbatim.
const ROUTING_MARKERS = { begin: '<!-- gentle-ai:agent-routing -->', end: '<!-- /gentle-ai:agent-routing -->' }
const REMOTE_MARKERS = { begin: '<!-- gentle-ai:remote-authorization -->', end: '<!-- /gentle-ai:remote-authorization -->' }

export const routingBlock = text => markedBlock(text, ROUTING_MARKERS)

// What makes ODD the default in a file: the routing protocol heading (routing.go:35) and the orchestrator's own heading.
export const ODD_MANDATE = ['ODD protocol (MANDATORY', 'Organic Driven Development Is The Default Workflow (MANDATORY)']

export const carriesOddMandate = text => ODD_MANDATE.some(phrase => text.includes(phrase))

// Each anchor starts a line (a heading is the whole line) and must appear exactly once outside the nested block.
const ANCHOR = {
  title: '## Implementation Routing', // routing.go:33
  intro: 'Organic Driven Development (ODD) is the predefined workflow', // :34
  protocol: '### ODD protocol (MANDATORY, in this order, on every request)', // :35
  authorize: '1. **Authorize.**', // :36, kept
  explore: '2. **Explore.**', // :39
  close: '7. **Close.**', // :45-47
  resume: 'Resume an interrupted feature', // :49
  routes: 'After explicit change intent is established', // :50, kept
  triggers: '### Mandatory Delegation Triggers', // :76, kept
  organic: '### Organic Driven Development', // :86
  rdd: '### Receipt-driven development is user-owned', // :135, kept; claude and codex only (model/rdd.go:12-17)
  codex: '### Codex ODD worker assignments', // inject.go:110, codex only
}
const HEADINGS = new Set([ANCHOR.title, ANCHOR.protocol, ANCHOR.triggers, ANCHOR.organic, ANCHOR.rdd, ANCHOR.codex])

export const routingPointer = copyPath => [
  'gentle-ai ODD (Organic Driven Development): only when the human explicitly asks for it.',
  `Before using it, read in full \`${copyPath}\`.`,
  'Where the gentle-ai text below refers to the ODD feature document (`odd/tasks/...`), its Engram mirror or the organic flow, it applies only when the human asked for ODD.',
]

const skipRouting = (text, why) => ({ text, skipped: `${why} en el bloque gentle-ai:agent-routing` })

// Pure and all-or-nothing: trims the ODD paragraphs of the routing block for one runtime ('claude' | 'codex' | 'gemini'), or
// changes nothing and says why in `skipped`. Unknown paragraphs are kept; an unknown heading refuses. Returns { text, saved }.
export const trimRoutingBlock = (text, copyPath, runtime) => {
  const block = routingBlock(text)
  if (block.status !== 'ok') {
    return skipRouting(text, block.status === 'none' ? 'no hay marcadores' : 'los marcadores están incompletos, repetidos o desordenados')
  }
  const lines = block.inner.split('\n')
  const title = line => line.trimEnd()
  const nestedFrom = lines.findIndex(line => title(line) === REMOTE_MARKERS.begin)
  const nestedTo = lines.findIndex(line => title(line) === REMOTE_MARKERS.end)
  const nested = i => nestedFrom !== -1 && nestedTo > nestedFrom && i >= nestedFrom && i <= nestedTo
  let fenced = false
  const headingAt = []
  for (const [i, line] of lines.entries()) {
    fenced = /^\s*```/.test(line) ? !fenced : fenced
    headingAt[i] = !fenced && !nested(i) && levelOf(line) > 0
    if (headingAt[i] && !HEADINGS.has(title(line))) {
      return skipRouting(text, `hay un encabezado que no reconozco: ${title(line)}`)
    }
  }
  const required = ['title', 'intro', 'protocol', 'authorize', 'explore', 'close', 'resume', 'routes', 'triggers', 'organic']
  required.push(...(runtime === 'gemini' ? [] : ['rdd']), ...(runtime === 'codex' ? ['codex'] : []))
  const at = {}
  for (const [key, phrase] of Object.entries(ANCHOR)) {
    const found = lines.flatMap((line, i) => (!nested(i) && (HEADINGS.has(phrase) ? title(line) === phrase : line.startsWith(phrase)) ? [i] : []))
    if (found.length > 1 || (found.length === 0 && required.includes(key))) {
      return skipRouting(text, `${found.length === 0 ? 'falta' : 'se repite'} el ancla "${phrase}"`)
    }
    at[key] = found[0]
  }
  const blankAfter = i => lines.findIndex((line, j) => j >= i && line.trim() === '')
  const listEnd = blankAfter(at.authorize)
  if (!(at.protocol < at.authorize && at.authorize < at.explore && at.explore < at.close && (listEnd === -1 || at.close < listEnd))) {
    return skipRouting(text, 'los pasos del protocolo ODD no tienen la forma esperada')
  }
  // A section runs to the next heading or the nested block; the last line (the newline before the closer) always stays.
  const sectionEnd = i => {
    const next = lines.findIndex((line, j) => j > i && (headingAt[j] || j === nestedFrom))

    return next === -1 ? lines.length - 1 : next
  }
  // A paragraph is dropped with the blank line after it.
  const paragraph = i => {
    const blank = blankAfter(i)

    return [i, blank === -1 ? lines.length - 1 : Math.min(blank + 1, lines.length - 1)]
  }
  // [from, to) ranges. Steps 2 to 7 go; anything after step 7 in the same list stays.
  const drop = [paragraph(at.intro), paragraph(at.protocol), [at.explore, at.close + 1], paragraph(at.resume), [at.organic, sectionEnd(at.organic)]]
  if (at.codex !== undefined) {
    drop.push([at.codex, sectionEnd(at.codex)])
  }
  const cr = block.inner.includes('\r\n') ? '\r' : ''
  const kept = lines.flatMap((line, i) => [
    ...(i === at.intro ? [LAZY_SENTINEL, ...routingPointer(copyPath), ''].map(added => added + cr) : []),
    ...(drop.some(([from, to]) => i >= from && i < to) ? [] : [line]),
  ])

  return { text: text.slice(0, block.from) + kept.join('\n') + text.slice(block.end), saved: block.inner }
}

// The three runtime files gentle-ai v4 writes, with one full copy per block. gentle-ai writes codex's file under the home
// directory, not CODEX_HOME (v4.0.0 internal/agents/codex/adapter.go:92-94); antigravity's is ~/.gemini/GEMINI.md
// (internal/agents/antigravity/adapter.go:100-102) and it is not an RDD runtime (internal/model/rdd.go:12-17).
export const gentleTargets = L =>
  [
    { runtime: 'claude', label: '~/.claude/CLAUDE.md', file: L.claudeMd, rdd: true, orchestratorCopy: L.sddCopy },
    { runtime: 'codex', label: '~/.codex/AGENTS.md', file: path.join(L.home, '.codex', 'AGENTS.md'), rdd: true },
    { runtime: 'gemini', label: '~/.gemini/GEMINI.md', file: path.join(L.home, '.gemini', 'GEMINI.md'), rdd: false },
  ].map(target => ({
    orchestratorCopy: path.join(L.gentleDir, `${target.runtime}-orchestrator.md`),
    routingCopy: path.join(L.gentleDir, `${target.runtime}-agent-routing.md`),
    ...target,
  }))

// Both blocks of a target: how to find each one and where its full copy lives.
export const blocksOf = target => [
  { name: 'gentle-ai:orchestrator', locate: sddBlock, copy: target.orchestratorCopy },
  { name: 'gentle-ai:agent-routing', locate: routingBlock, copy: target.routingCopy },
]

// A routing block that has ODD text to trim: any v4 file, or a routing block that names ODD. Older routing blocks have none.
const routingHasOdd = (text, block) => sddBlock(text).generation === 'v4' || /\bODD\b/.test(block.inner)

// Pure: what lazy mode does to one file. { text, copies: [{ file, content, name }], notes }, or { skipped } (touch nothing).
export const planLazyFile = (text, target) => {
  const notes = []
  const copies = []
  let next = text
  const orchestrator = sddBlock(next)
  if (orchestrator.status === 'malformed') {
    return { skipped: 'los marcadores del bloque de gentle-ai están incompletos, repetidos o desordenados' }
  }
  if (orchestrator.status === 'none') {
    notes.push(NO_BLOCK)
  } else if (isLazyBlock(orchestrator)) {
    notes.push('gentle-ai:orchestrator ya está en modo lazy')
  } else {
    const lazy = lazyifyBlock(next, target.orchestratorCopy)
    next = lazy.text
    copies.push({ file: target.orchestratorCopy, content: lazy.saved, name: 'gentle-ai:orchestrator' })
  }
  const routing = routingBlock(next)
  if (routing.status === 'malformed') {
    return { skipped: 'los marcadores del bloque gentle-ai:agent-routing están incompletos, repetidos o desordenados' }
  }
  if (routing.status === 'none') {
    notes.push('no hay bloque gentle-ai:agent-routing')
  } else if (isLazyBlock(routing)) {
    notes.push('gentle-ai:agent-routing ya está en modo lazy')
  } else if (!routingHasOdd(next, routing)) {
    notes.push('gentle-ai:agent-routing no trae el mandato ODD: no hay nada que recortar')
  } else {
    const trim = trimRoutingBlock(next, target.routingCopy, target.runtime)
    if (trim.skipped !== undefined) {
      return { skipped: trim.skipped }
    }
    next = trim.text
    copies.push({ file: target.routingCopy, content: trim.saved, name: 'gentle-ai:agent-routing' })
  }

  return { text: next, copies, notes }
}

// Puts each lazy block of a target back from its copy (`readCopy` returns null when the copy is missing).
// Returns { text, restored: [copy], missing: [copy] }.
export const restoreLazyBlocks = (text, target, readCopy) => {
  let next = text
  const restored = []
  const missing = []
  for (const { locate, copy } of blocksOf(target)) {
    const block = locate(next)
    if (!isLazyBlock(block)) {
      continue
    }
    const saved = readCopy(copy)
    if (saved === null) {
      missing.push(copy)
      continue
    }
    next = next.slice(0, block.from) + saved + next.slice(block.end)
    restored.push(copy)
  }

  return { text: next, restored, missing }
}

// ~/.orca-stack/config.json as an object, or null when it is missing or unreadable (doctor reports the latter).
export const readPersonalConfig = L => {
  try {
    return existsSync(L.config) ? JSON.parse(readFileSync(L.config, 'utf8').replace(/^﻿/, '')) : null
  } catch {
    return null
  }
}

// Personal config `gentle.sddOrchestrator`: 'lazy' (default) | 'full' | null when the value is not one of those.
export const sddMode = config => {
  const value = config?.gentle?.sddOrchestrator

  return value === undefined ? 'lazy' : value === 'lazy' || value === 'full' ? value : null
}
