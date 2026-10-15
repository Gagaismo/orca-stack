import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMANDS = new Set(['npm', 'npx', 'node', 'gh', 'git', 'orca-stack', 'orca', 'claude', 'bash', 'sh', 'pnpm', 'yarn', 'bun'])

function splitCells(line) {
  const cells = []
  let cell = ''
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '|') {
      let slashes = 0
      for (let j = cell.length - 1; j >= 0 && cell[j] === '\\'; j -= 1) slashes += 1
      if (slashes % 2 === 1) {
        cell = `${cell.slice(0, -1)}|`
        continue
      }
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell.trim())
  if (cells[0] === '') cells.shift()
  if (cells.at(-1) === '') cells.pop()
  return cells
}

function removeCommentsAndFences(text) {
  const lines = text.split(/\r?\n/)
  let fence
  const withoutFences = lines.filter(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = undefined
      return false
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length }
      return false
    }
    return true
  }).join('\n')
  return withoutFences.replace(/<!--[\s\S]*?-->/g, '')
}

function evidenceSection(body) {
  const lines = removeCommentsAndFences(String(body ?? '')).split(/\r?\n/)
  const start = lines.findIndex(line => line.trimEnd() === '## Evidencia')
  if (start === -1) return ''
  let end = lines.findIndex((line, index) => index > start && /^## /.test(line))
  if (end === -1) end = lines.length
  return lines.slice(start + 1, end).join('\n')
}

function isSeparator(line) {
  const cells = splitCells(line)
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))
}

function tables(text) {
  const lines = text.split(/\r?\n/)
  const found = []
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i].includes('|') || !isSeparator(lines[i + 1])) continue
    const headers = splitCells(lines[i])
    if (headers.length < 2) continue
    const rows = []
    for (i += 2; i < lines.length && lines[i].includes('|'); i += 1) rows.push(splitCells(lines[i]))
    found.push({ headers, rows })
    i -= 1
  }
  return found
}

function backticked(text) {
  return [...text.matchAll(/`([^`\r\n]*)`/g)].map(match => match[1])
}

function isExempt(name) {
  const command = name.match(/^([^ ]+) /)
  if (command && COMMANDS.has(command[1])) return true
  return !/\s/.test(name) && (/[\\/]/.test(name) || /\.[A-Za-z0-9]{1,10}(?:#L\d+)?$/.test(name))
}

function runnerTitles(cell) {
  const titles = []
  for (const span of backticked(cell)) {
    const match = span.match(/^\u2714\s+(.+?)\s+\([^)]*ms\)$/)
      ?? span.match(/^\(pass\)\s+(.+?)\s+\[[^\]]*ms\]$/)
    if (match) titles.push(match[1])
  }
  return titles
}

function walk(directory, accept, found = []) {
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(file, accept, found)
    else if (entry.isFile() && accept(file)) found.push(file)
  }
  return found
}

function declarationsIn(source) {
  const titles = []
  const declarationPrefix = /(?<![\w$.])(?:test|it|describe)(?:\.(?:skip|only|todo))?\s*\(\s*$/
  const blank = text => [...text].map(char => char === '\n' ? '\n' : ' ')
  let codeTail = ''
  const append = text => { codeTail = (codeTail + text).slice(-100) }
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      let end = source.indexOf('\n', i + 2)
      if (end === -1) end = source.length
      append(blank(source.slice(i, end)).join(''))
      i = end - 1
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2)
      const end = close === -1 ? source.length : close + 2
      append(blank(source.slice(i, end)).join(''))
      i = end - 1
    } else if (char === '/' && regexCanStart(codeTail)) {
      const end = regexLiteralEnd(source, i)
      if (end > i + 1) {
        append(blank(source.slice(i, end)).join(''))
        i = end - 1
      } else append(char)
    } else if (char === '"' || char === "'" || char === '`') {
      const start = i
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === char) break
        i += 1
      }
      const raw = source.slice(start + 1, i)
      if (declarationPrefix.test(codeTail)) titles.push(titlePattern(literalValue(raw, char)))
      append(blank(source.slice(start, Math.min(i + 1, source.length))).join(''))
    } else append(char)
  }
  return titles
}

function regexCanStart(codeTail) {
  const previous = codeTail.trimEnd()
  const last = previous.at(-1)
  return !previous || '([{=,:;!?&|+-*%^~<>'.includes(last)
    || /(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await)$/.test(previous)
}

function regexLiteralEnd(source, start) {
  let inClass = false
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i]
    if (char === '\n' || char === '\r') return start + 1
    if (char === '\\') { i += 1; continue }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) {
      i += 1
      while (/[A-Za-z]/.test(source[i] ?? '')) i += 1
      return i
    }
  }
  return start + 1
}

function literalValue(raw, quote) {
  if (quote === '`') return raw
  if (quote === '"') {
    try { return JSON.parse(`"${raw}"`) } catch { return raw }
  }
  return raw.replace(/\\([\\'"bfnrtv])/g, (_, char) => ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[char] ?? char))
}

function titlePattern(title) {
  if (!title.includes('${')) return { exact: title }
  const fragments = title.split(/\$\{[^}]*\}/)
  const escaped = fragments.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return { pattern: new RegExp(`^${escaped.join('.*')}$`, 's') }
}

function readTitles(root) {
  if (!root) return []
  const base = path.resolve(root)
  const files = walk(path.join(base, 'test'), file => file.endsWith('.test.mjs'))
  const mods = walk(path.join(base, 'mods'), file => {
    const relative = path.relative(path.join(base, 'mods'), file).split(path.sep)
    return relative.length >= 3 && relative[1] === 'tests' && /\.test\.tsx?$/.test(file)
  })
  const declarations = []
  for (const file of [...files, ...mods]) {
    declarations.push(...declarationsIn(readFileSync(file, 'utf8')))
  }
  return declarations
}

export function checkEvidencia(body, root) {
  const section = evidenceSection(body)
  const checked = tables(section).filter(table => /^Test/i.test(table.headers[1] ?? ''))
  if (!checked.length || checked.every(table => table.rows.length === 0)) {
    return { ok: true, count: 0, stdout: 'Sin ## Evidencia: nada que comprobar\n', stderr: '' }
  }

  const titles = readTitles(root)
  const misses = []
  let rowNumber = 0
  let count = 0
  for (const table of checked) {
    for (const row of table.rows) {
      rowNumber += 1
      const names = [...backticked(row[1] ?? '').filter(name => !isExempt(name))]
      names.push(...runnerTitles(row[2] ?? ''))
      for (const name of names) {
        count += 1
        const exists = titles.some(title => title.exact === name || title.pattern?.test(name))
        if (!exists) misses.push(`Evidencia fila ${rowNumber}: no encuentro el test \`${name}\` en test/ ni mods/*/tests/`)
      }
    }
  }
  if (misses.length) return { ok: false, count, stdout: '', stderr: `${misses.join('\n')}\n` }
  return { ok: true, count, stdout: `Evidencia OK: ${count} nombres de test verificados\n`, stderr: '' }
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('Uso: node scripts/check-evidencia.mjs <body-file>\n')
    process.exitCode = 2
  } else {
    try {
      const result = checkEvidencia(readFileSync(file, 'utf8'), process.cwd())
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      if (!result.ok) process.exitCode = 1
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    }
  }
}
