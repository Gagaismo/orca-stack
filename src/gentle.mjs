import { run } from './util.mjs'

// gentle-ai writes this managed block into ~/.claude/CLAUDE.md. With receipt-driven development (RDD) off,
// its review sections are no-ops that every session still pays for, so `global` trims them.
const BLOCK_BEGIN = '<!-- gentle-ai:sdd-orchestrator -->'
const BLOCK_END = '<!-- /gentle-ai:sdd-orchestrator -->'

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
  const begin = text.indexOf(BLOCK_BEGIN)
  const end = text.indexOf(BLOCK_END)
  if (begin === -1 || end === -1 || end < begin) {
    return { text, removed: 0 }
  }
  const from = begin + BLOCK_BEGIN.length
  const kept = []
  let skipping = false
  let until = null // set while inside the Review Execution Contract
  let fenced = false
  let unknown = null
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
    if (!skipping) {
      kept.push(line)
    }
  }
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

// 'on' | 'off' | null (gentle-ai missing or unreadable): the first line of `gentle-ai review mode status`.
export const rddMode = bin => {
  const result = run(bin, ['review', 'mode', 'status'], { timeout: 20_000 })
  const mode = result.status === 0 ? /receipt-driven development:\s*(\w+)/i.exec(result.stdout)?.[1]?.toLowerCase() : undefined

  return mode === 'on' || mode === 'off' ? mode : null
}
