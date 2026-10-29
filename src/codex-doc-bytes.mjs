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

// The top-level keys, where the setting lives, are the lines before the first table header. A line inside a
// multiline array or string is not a statement even when it starts with `[` or names the key, so the scan
// tracks open brackets and multiline strings, skipping one-line strings and comments.
const topLevel = text => {
  const lines = text.split('\n')
  const root = []
  let depth = 0
  let quote = null
  for (const [i, line] of lines.entries()) {
    if (depth === 0 && quote === null) {
      if (/^\s*\[/.test(line)) break
      root.push(i)
    }
    let j = 0
    while (j < line.length) {
      if (quote !== null) {
        if (quote === '"""' && line[j] === '\\') {
          j += 2
        } else if (line.startsWith(quote, j)) {
          j += 3
          while (line[j] === quote[0]) j += 1
          quote = null
        } else {
          j += 1
        }
      } else if (line[j] === '#') {
        break
      } else if (line.startsWith('"""', j) || line.startsWith("'''", j)) {
        quote = line.slice(j, j + 3)
        j += 3
      } else if (line[j] === '"' || line[j] === "'") {
        const close = line[j]
        j += 1
        while (j < line.length && line[j] !== close) j += close === '"' && line[j] === '\\' ? 2 : 1
        j += 1
      } else {
        if (line[j] === '[') depth += 1
        if (line[j] === ']') depth -= 1
        j += 1
      }
    }
  }

  return { lines, root }
}

// { value: number | null } when the key is an integer or absent; { invalid: '<raw>' } otherwise.
export const readCodexDocBytes = text => {
  const { lines, root } = topLevel(text)
  for (const i of root) {
    const match = KEY.exec(lines[i].replace(/\r$/, ''))
    if (match) {
      const raw = match[2].trim()

      return /^\+?\d[\d_]*$/.test(raw) ? { value: Number(raw.replaceAll('_', '')) } : { invalid: raw }
    }
  }

  return { value: null }
}

// Sets the top-level key, touching only its value, or adds it as the first line. The rest stays byte for byte.
export const withCodexDocBytes = (text, value) => {
  const { lines, root } = topLevel(text)
  for (const i of root) {
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
