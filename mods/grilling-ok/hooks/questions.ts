// Pure helpers: find Q-numbered questions and expand short answers.

// After stripping list/quote/heading prefixes, a question starts with Q<n>
// followed by . : ) or a closing bold marker (a heading may skip the mark).
const PREFIX = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*(#{1,6}[ \t]+)?/
const MARKED = /^(?:\*\*|__)?Q(\d{1,2})(?:[.:)](?=[\s*_]|$)|(?=\*\*|__))/
const BARE_HEADING = /^(?:\*\*|__)?Q(\d{1,2})(?=\s|$)/

export const findQuestions = (text: string): number[] => {
  const found: number[] = []
  for (const line of text.split(/\r?\n/)) {
    const prefix = PREFIX.exec(line)
    const rest = line.slice(prefix?.[0].length ?? 0)
    const isHeading = prefix?.[1] !== undefined
    const match = MARKED.exec(rest) ?? (isHeading ? BARE_HEADING.exec(rest) : null)
    const n = Number(match?.[1])
    if (match !== null && n >= 1 && !found.includes(n)) {
      found.push(n)
    }
  }

  return found
}

// [12,13,14,17] -> "Q12–Q14, Q17"
export const describeRange = (numbers: readonly number[]): string => {
  const sorted = [...numbers].sort((a, b) => a - b)
  const groups: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (sorted[j + 1] === (sorted[j] ?? 0) + 1) {
      j += 1
    }
    groups.push(j > i ? `Q${sorted[i]}–Q${sorted[j]}` : `Q${sorted[i]}`)
    i = j + 1
  }

  return groups.join(', ')
}

export const allOk = (numbers: readonly number[], overrides: Map<number, string> = new Map()): string =>
  numbers.map(n => `Q${n}. ${overrides.get(n) ?? 'ok'}`).join(' ')

const PLAIN_OK = /^(?:ok|todo ok|ok todo)[.!]*$/i
const EXCEPT = /^(?:ok salvo|todo ok salvo|todo ok menos|ok menos)\s+([\s\S]+)$/i
const EXCEPTION = /Q(\d{1,2})\s*[:.\-–]?\s*/gi

// The user's whole prompt as an answer to the pending questions, or undefined
// when it is anything else (the prompt then passes untouched).
export const expandAnswer = (prompt: string, pending: readonly number[]): string | undefined => {
  const text = prompt.trim()
  if (pending.length === 0) {
    return undefined
  }
  if (PLAIN_OK.test(text)) {
    return allOk(pending)
  }
  const rest = EXCEPT.exec(text)?.[1]
  if (rest === undefined) {
    return undefined
  }
  const marks = [...rest.matchAll(EXCEPTION)]
  const overrides = new Map<number, string>()
  marks.forEach((mark, i) => {
    const end = marks[i + 1]?.index ?? rest.length
    const answer = rest
      .slice((mark.index ?? 0) + mark[0].length, end)
      .trim()
      .replace(/[,;]+$/, '')
      .trim()
    overrides.set(Number(mark[1]), answer)
  })
  const isUsable =
    overrides.size > 0 &&
    [...overrides].every(([n, answer]) => pending.includes(n) && answer !== '')

  return isUsable ? allOk(pending, overrides) : undefined
}
