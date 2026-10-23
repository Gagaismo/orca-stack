// codex loads the project AGENTS.md files only up to `project_doc_max_bytes` (32 KiB by default) and truncates
// the file that crosses it; the global ~/.codex/AGENTS.md does not count toward it (#269, measured on codex-cli 0.163.0).
export const CODEX_DOC_DEFAULT = 32 * 1024
const FLOOR = 64 * 1024

// The smallest power of two that is at least 64 KiB and at least twice the orca-stack block.
export const codexDocBytesFor = blockBytes => {
  let value = FLOOR
  while (value < 2 * blockBytes) {
    value *= 2
  }

  return value
}

const KEY = /^(\s*project_doc_max_bytes\s*=\s*)([^#\r\n]*?)(\s*(?:#.*)?)$/

// Lines before the first table header are the top-level keys, where the setting lives.
const topLevel = text => {
  const lines = text.split('\n')
  const end = lines.findIndex(line => /^\s*\[/.test(line))

  return { lines, end: end === -1 ? lines.length : end }
}

// { value: number | null } when the key is an integer or absent; { invalid: '<raw>' } otherwise.
export const readCodexDocBytes = text => {
  const { lines, end } = topLevel(text)
  for (const line of lines.slice(0, end)) {
    const match = KEY.exec(line.replace(/\r$/, ''))
    if (match) {
      const raw = match[2].trim()

      return /^\+?\d[\d_]*$/.test(raw) ? { value: Number(raw.replaceAll('_', '')) } : { invalid: raw }
    }
  }

  return { value: null }
}

// Sets the top-level key, touching only its value, or adds it as the first line. The rest stays byte for byte.
export const withCodexDocBytes = (text, value) => {
  const { lines, end } = topLevel(text)
  for (let i = 0; i < end; i += 1) {
    const cr = lines[i].endsWith('\r') ? '\r' : ''
    const match = KEY.exec(lines[i].slice(0, lines[i].length - cr.length))
    if (match) {
      lines[i] = `${match[1]}${value}${match[3]}${cr}`

      return lines.join('\n')
    }
  }
  const bom = text.startsWith('﻿') ? '﻿' : ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'

  return `${bom}project_doc_max_bytes = ${value}${eol}${text.slice(bom.length)}`
}
