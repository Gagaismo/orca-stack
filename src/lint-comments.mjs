import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { runAstGrepJson } from './ast-grep.mjs'

export const COMMENT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'])
export const MODULE_LOCATION = '<módulo>'

const ACTIONS = {
  'comment-excuse': { type: 'Excuse', action: 'borralo y abrí un issue para arreglar la implementación' },
  'comment-tautology': { type: 'Tautology', action: 'borralo' },
  'comment-stale': { type: 'Stale', action: 'borralo' },
}

const LANGUAGES = ['javascript', 'typescript', 'tsx']
const SYMBOL_KINDS = ['function_declaration', 'generator_function_declaration', 'class_declaration', 'method_definition']
const TS_SYMBOL_KINDS = ['abstract_class_declaration']
const FUNCTION_VALUES = ['arrow_function', 'function_expression', 'generator_function', 'class']

const symbolRule = language => [
  `id: symbol-${language}`,
  `language: ${language}`,
  'rule:',
  '  has:',
  '    field: name',
  '    pattern: $NAME',
  '  any:',
  ...[...SYMBOL_KINDS, ...(language === 'javascript' ? [] : TS_SYMBOL_KINDS)].map(kind => `    - kind: ${kind}`),
  '    - kind: variable_declarator',
  '      has:',
  '        field: value',
  '        any:',
  ...FUNCTION_VALUES.map(kind => `          - kind: ${kind}`),
].join('\n')

const RULES = LANGUAGES.flatMap(language => [
  `id: comment-${language}\nlanguage: ${language}\nrule:\n  kind: comment`,
  symbolRule(language),
]).join('\n---\n')

// #419: Windows caps a command line at 32,767 characters, so file paths go to ast-grep in batches.
const ARG_BUDGET = 24000

const batches = files => {
  const out = []
  let current = []
  let size = 0
  for (const file of files) {
    if (current.length > 0 && size + file.length + 3 > ARG_BUDGET) {
      out.push(current)
      current = []
      size = 0
    }
    current.push(file)
    size += file.length + 3
  }
  if (current.length > 0) out.push(current)
  return out
}

const relative = (root, file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/')

const scan = (root, files) => {
  const byFile = new Map(files.map(file => [file, { comments: [], symbols: [] }]))
  for (const batch of batches(files)) {
    for (const match of runAstGrepJson(['scan', '--inline-rules', RULES, '--json=compact', '--', ...batch], { cwd: root })) {
      const found = byFile.get(relative(root, match.file))
      if (!found) continue
      const { start, end } = match.range.byteOffset
      if (match.ruleId.startsWith('comment-')) {
        found.comments.push({ text: match.text, start, end, line: match.range.start.line, endLine: match.range.end.line })
      } else {
        const isClass = /^(?:abstract\s+)?class\b|^[\w$]+\s*(?::[^=]*)?=\s*class\b/.test(match.text)
        found.symbols.push({ name: match.metaVariables.single.NAME.text, start, end, isClass })
      }
    }
  }
  return byFile
}

const readSource = full => {
  try {
    if (!lstatSync(full).isFile()) return undefined
  } catch {
    return undefined
  }
  return readFileSync(full)
}

const normalize = raw => raw
  .replace(/^\/\/+|^\/\*+|\*+\/$/g, '')
  .split('\n')
  .map(line => line.replace(/^\s*\*+(?!\/)/, ''))
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim()

const fingerprint = text => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`

const blank = (bytes, comments) => {
  const out = Buffer.from(bytes)
  const fill = (start, end) => {
    for (let i = start; i < end; i++) if (out[i] !== 0x0a && out[i] !== 0x0d) out[i] = 0x20
  }
  if (out[0] === 0x23 && out[1] === 0x21) fill(0, out.indexOf(0x0a) === -1 ? out.length : out.indexOf(0x0a))
  for (const comment of comments) fill(comment.start, comment.end)
  return out
}

const DIRECTIVE = /^(?:eslint\b|eslint-|global\s|globals\s|jshint\b|jscs:|@ts-|ts-|prettier-ignore|c8\s+ignore|v8\s+ignore|istanbul\s+ignore|node:coverage|biome-ignore|deno-lint-ignore|deno-fmt-ignore|tslint:|oxlint-|stylelint-|@jsx|@flow|@refresh|@vite-ignore|@license|@preserve|[#@]__PURE__|[#@]\s*sourceMappingURL|webpack[A-Z]|type-coverage:|<reference\b|<amd-)/
const JSDOC_TYPE = /@(?:type|typedef|param|arg|argument|returns?|template|callback|property|prop|enum|this|satisfies|implements|extends|augments|overload|import|throws|yields)\b/
const LICENSE = /\b(?:license[ds]?|copyright|spdx-license-identifier)\b|©/i
const DECISION_RECORD = /(?<![\w&])#\d+\b|\badr[ -]?\d{4}\b|docs\/adr\/\d{4}-/i
const EXCUSE_MARKER = /(?<![\p{L}\p{N}_])(?:TODO|FIXME|XXX)(?![\p{L}\p{N}_])/u
const EXCUSE = /\b(?:hack|workarounds?|for now|upgrade when)\b|\btemporary\b(?!\s+(?:files?|dir(?:ector(?:y|ies))?|folders?|paths?|homes?|repos?|cop(?:y|ies)|names?|worktrees?)\b)|\bshortcut:/i

const isLicenseHeader = (comment, text, blanked) => LICENSE.test(text) && blanked.subarray(0, comment.start).toString('utf8').trim() === ''

const notAComment = (comment, text, blanked) => DIRECTIVE.test(text)
  || (comment.text.startsWith('/**') && JSDOC_TYPE.test(text))
  || isLicenseHeader(comment, text, blanked)

const STOP_WORDS = new Set(['the', 'a', 'an', 'this', 'that', 'it', 'its', 'to', 'of', 'value', 'variable', 'by', 'one'])
const VERBS = [
  [/\+\+|\+=\s*1\b/, ['increment', 'increase']],
  [/--|-=\s*1\b/, ['decrement', 'decrease']],
  [/^return\b/, ['return']],
  [/^(?:const|let|var)\b/, ['declare', 'define']],
  [/(?<![=!<>])=(?!=)/, ['set', 'assign']],
]

const words = text => text
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(Boolean)

const stem = word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)

const lineOf = (lines, index) => lines[index] ?? ''
const commentOnly = (lines, blankedLines, index) => lineOf(lines, index).trim() !== '' && lineOf(blankedLines, index).trim() === ''

const isTautology = (comment, text, context) => {
  const { lines, blankedLines } = context
  if (!comment.text.startsWith('//') || comment.line !== comment.endLine) return false
  if (lineOf(blankedLines, comment.line).trim() !== '') return false
  if (commentOnly(lines, blankedLines, comment.line - 1) || commentOnly(lines, blankedLines, comment.line + 1)) return false
  const statement = lineOf(blankedLines, comment.line + 1).replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').trim()
  if (statement === '') return false
  const said = words(text).filter(word => !STOP_WORDS.has(word))
  if (said.length < 2 || said.length > 6) return false
  const code = new Set(words(statement).map(stem))
  if (code.size > said.length + 2) return false
  for (const [pattern, verbs] of VERBS) if (pattern.test(statement)) verbs.forEach(verb => code.add(verb))
  return said.every(word => code.has(stem(word)))
}

const codeLike = name => /[a-z0-9][A-Z]/.test(name) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(name)

// #419: per Lautaro's reading of R5, Stale checks only a bare name() call, never a backticked identifier.
const calledNames = text => [...new Set([...text.matchAll(/(?<![\w$.`/#-])([A-Za-z_$][\w$]*)\(\)/g)]
  .map(([, name]) => name)
  .filter(codeLike))]

const isStale = (text, context) => calledNames(text).some(name => {
  const escaped = name.replace(/\$/g, '\\$')
  return !new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(context.code)
})

const classify = (comment, context) => {
  const text = normalize(comment.text)
  if (text === '' || notAComment(comment, text, context.blanked)) return undefined
  if (DECISION_RECORD.test(text)) return undefined
  if (EXCUSE_MARKER.test(text) || EXCUSE.test(text)) return { rule: 'comment-excuse', text }
  if (isTautology(comment, text, context)) return { rule: 'comment-tautology', text }
  if (isStale(text, context)) return { rule: 'comment-stale', text }
  return undefined
}

const DECLARATION_GAP = /^(?:\s|export\b|default\b|declare\b|const\b|let\b|var\b)*$/

const labelOf = (symbol, symbols) => {
  if (symbol.isClass) return symbol.name
  const owner = symbols
    .filter(other => other.isClass && other.start < symbol.start && other.end >= symbol.end)
    .sort((a, b) => b.start - a.start)[0]
  const direct = owner && !symbols.some(other => !other.isClass && other.start < symbol.start && other.end >= symbol.end && other.start > owner.start)
  return direct ? `${owner.name}.${symbol.name}()` : `${symbol.name}()`
}

const locate = (comment, symbols, blanked) => {
  const next = symbols.find(symbol => symbol.start >= comment.end)
  if (next && DECLARATION_GAP.test(blanked.subarray(comment.end, next.start).toString('utf8'))) return labelOf(next, symbols)
  const container = symbols
    .filter(symbol => symbol.start <= comment.start && symbol.end >= comment.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
  return container ? labelOf(container, symbols) : MODULE_LOCATION
}

export const reportComment = violation => {
  const { type, action } = ACTIONS[violation.rule]
  return `${violation.rule} ${violation.file}:${violation.location} (${type}) — ${action}`
}

export const isCommentRule = rule => Object.hasOwn(ACTIONS, rule)

export const commentViolations = (root, files) => {
  const sources = new Map()
  for (const file of files) {
    if (!COMMENT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    const bytes = readSource(path.join(root, file))
    if (bytes !== undefined && !bytes.subarray(0, 8000).includes(0)) sources.set(file, bytes)
  }
  if (sources.size === 0) return []
  const found = []
  for (const [file, { comments, symbols }] of scan(root, [...sources.keys()])) {
    symbols.sort((a, b) => a.start - b.start)
    const bytes = sources.get(file)
    const blanked = blank(bytes, comments)
    const code = blanked.toString('utf8')
    const context = { blanked, code, lines: bytes.toString('utf8').split('\n'), blankedLines: code.split('\n') }
    for (const comment of comments.sort((a, b) => a.start - b.start)) {
      const verdict = classify(comment, context)
      if (!verdict) continue
      found.push({ rule: verdict.rule, file, location: locate(comment, symbols, blanked), fingerprint: fingerprint(verdict.text), line: comment.line + 1 })
    }
  }
  return found
}
