import { LEGACY_BEGIN, LEGACY_END, MARKER_BEGIN, MARKER_END } from './constants.mjs'

const eolOf = text => (text.includes('\r\n') ? '\r\n' : '\n')

const locate = (text, open = MARKER_BEGIN, close = MARKER_END) => {
  const begin = text.indexOf(open)
  const end = text.indexOf(close)
  const count = marker => text.split(marker).length - 1
  if (count(open) > 1 || count(close) > 1) {
    throw new Error(`Hay más de un bloque ${open} / ${close} (duplicados). Dejá uno solo a mano y volvé a correr el comando.`)
  }
  if (begin === -1 && end === -1) {
    return null
  }
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `Los marcadores ${open} / ${close} están incompletos o desordenados. Arreglalos a mano y volvé a correr el comando.`,
    )
  }

  return { begin, end: end + close.length }
}

// Cuts [begin, end) and the blank line that separated it from its neighbours.
const cut = (text, { begin, end }) => {
  const eol = eolOf(text)
  const before = text.slice(0, begin).replace(/\s+$/, '')
  const after = text.slice(end).replace(/^\s+/, '')
  if (before === '' || after === '') {
    return before === '' && after === '' ? '' : before === '' ? after : before + eol
  }

  return before + eol + eol + after
}

export const hasBlock = text => locate(text) !== null

export const buildBlock = (body, eol = '\n') =>
  [MARKER_BEGIN, ...body.replace(/\s+$/, '').split('\n'), MARKER_END].join(eol)

// Replaces the marker-delimited block, or appends it; everything outside the markers stays untouched.
// A legacy block takes the new block's place, or is dropped when the new block already exists.
export const upsertBlock = (text, body) => {
  const eol = eolOf(text)
  const block = buildBlock(body, eol)
  const legacy = locate(text, LEGACY_BEGIN, LEGACY_END)
  if (legacy && !hasBlock(text)) {
    return text.slice(0, legacy.begin) + block + text.slice(legacy.end)
  }
  const current = legacy ? cut(text, legacy) : text
  const found = locate(current)
  if (found) {
    return current.slice(0, found.begin) + block + current.slice(found.end)
  }
  if (current.trim() === '') {
    return block + eol
  }

  return current.replace(/\s*$/, '') + eol + eol + block + eol
}

// Removes the block and the blank line that separated it. Returns { text, found }.
export const removeBlock = text => {
  const found = locate(text)

  return found ? { text: cut(text, found), found: true } : { text, found: false }
}

// Same, for installs that predate the policy moving into the project: the legacy block goes too.
export const removeAnyBlock = text => {
  const legacy = locate(text, LEGACY_BEGIN, LEGACY_END)
  const first = legacy ? { text: cut(text, legacy), found: true } : { text, found: false }
  const current = removeBlock(first.text)

  return { text: current.text, found: first.found || current.found }
}
