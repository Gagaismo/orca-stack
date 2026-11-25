// Protocol markers: the leading `<marker>:` of a line that orca-stack, main and the workers write in PR and issue
// comments. Every reader matches them through this file, so a body written by a tool that adds a UTF-8 BOM, or a blank
// line before the first marker, reads the same as a clean one (#365). (src/marker.mjs is about AGENTS.md blocks.)
export const MARKERS = [
  'Revisor', 'Commit', 'Implementador', 'Rebote', 'Rebote CI', 'Rebote conflicto', 'RDD',
  'Respuesta de main', 'Respuesta del humano', 'Verificado por main', 'Decidido por main', 'Sin review',
]

const BOM = String.fromCharCode(0xfeff)
const LEADING = new RegExp(`^[${BOM}\\s]+`)
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The body without its leading BOM and whitespace; the rest is untouched.
export const normalizeBody = body => String(body ?? '').replace(LEADING, '')

// Every line of the body, each without a leading BOM and surrounding whitespace. A quoted line keeps its `>`, so a
// quoted marker is never a marker.
export const markerLines = body => normalizeBody(body).split(/\r?\n/).map(line => line.replace(LEADING, '').trimEnd())

// Whether the body itself starts with `<marker>:` (case-sensitive, as the protocol writes it).
export const startsWithMarker = (body, marker) => normalizeBody(body).startsWith(`${marker}:`)

// The text after `<marker>:` on the first line that starts with it (case-insensitive), or undefined. `within` limits
// the search to the first lines of the body.
export const markerValue = (body, marker, { within = Infinity } = {}) => {
  const pattern = new RegExp(`^${escape(marker)}:\\s*(.*)$`, 'i')
  for (const line of markerLines(body).slice(0, within)) {
    const match = pattern.exec(line)
    if (match) return match[1].trim()
  }

  return undefined
}

// `Commit: <sha>` or `Commit: `<sha>``: the sha (7 to 40 hex characters), lowercased, or undefined.
export const commitOf = (body, options) => /^(`?)([0-9a-f]{7,40})\1$/i.exec(markerValue(body, 'Commit', options) ?? '')?.[2]?.toLowerCase()

// Whether an abbreviated or full sha names this head commit.
export const namesCommit = (sha, head) => typeof sha === 'string' && sha.length >= 7 && String(head ?? '').toLowerCase().startsWith(sha.toLowerCase())
