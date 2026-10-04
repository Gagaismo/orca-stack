import { MARKER_BEGIN, MARKER_END } from './constants.mjs'

const eolOf = text => (text.includes('\r\n') ? '\r\n' : '\n')

const locate = text => {
  const begin = text.indexOf(MARKER_BEGIN)
  const end = text.indexOf(MARKER_END)
  const count = marker => text.split(marker).length - 1
  if (count(MARKER_BEGIN) > 1 || count(MARKER_END) > 1) {
    throw new Error(
      `Hay más de un bloque ${MARKER_BEGIN} / ${MARKER_END} (duplicados). Dejá uno solo a mano y volvé a correr el comando.`,
    )
  }
  if (begin === -1 && end === -1) {
    return null
  }
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `Los marcadores ${MARKER_BEGIN} / ${MARKER_END} están incompletos o desordenados. Arreglalos a mano y volvé a correr el comando.`,
    )
  }

  return { begin, end: end + MARKER_END.length }
}

export const hasBlock = text => locate(text) !== null

export const buildBlock = (body, eol = '\n') =>
  [MARKER_BEGIN, ...body.replace(/\s+$/, '').split('\n'), MARKER_END].join(eol)

// Replaces the marker-delimited block, or appends it; everything outside the markers stays untouched.
export const upsertBlock = (text, body) => {
  const eol = eolOf(text)
  const block = buildBlock(body, eol)
  const found = locate(text)
  if (found) {
    return text.slice(0, found.begin) + block + text.slice(found.end)
  }
  if (text.trim() === '') {
    return block + eol
  }

  return text.replace(/\s*$/, '') + eol + eol + block + eol
}

// Removes the block and the blank line that separated it. Returns { text, found }.
export const removeBlock = text => {
  const found = locate(text)
  if (!found) {
    return { text, found: false }
  }
  const eol = eolOf(text)
  const before = text.slice(0, found.begin).replace(/\s+$/, '')
  const after = text.slice(found.end).replace(/^\s+/, '')
  let joined = before + eol + eol + after
  if (before === '' || after === '') {
    joined = before === '' && after === '' ? '' : before === '' ? after : before + eol
  }

  return { text: joined, found: true }
}
