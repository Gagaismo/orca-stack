import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { runAstGrepJson } from './ast-grep.mjs'
import { LANGUAGE_EXTENSIONS, languageOf } from './lint-graph.mjs'

export const COMMENT_EXTENSIONS = LANGUAGE_EXTENSIONS.js
export const MODULE_LOCATION = '<módulo>'

const ACTIONS = {
  'comment-excuse': { type: 'Excuse', action: 'borralo y abrí un issue para arreglar la implementación' },
  'comment-tautology': { type: 'Tautology', action: 'borralo' },
  'comment-stale': { type: 'Stale', action: 'borralo' },
}

const JS_LANGUAGES = ['javascript', 'typescript', 'tsx']
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

const JS_RULES = JS_LANGUAGES.flatMap(language => [
  `id: comment-${language}\nlanguage: ${language}\nrule:\n  kind: comment`,
  symbolRule(language),
]).join('\n---\n')

const GO_RULES = [
  'id: comment-go\nlanguage: go\nrule:\n  kind: comment',
  [
    'id: symbol-go',
    'language: go',
    'rule:',
    '  has:',
    '    field: name',
    '    pattern: $NAME',
    '  any:',
    '    - kind: function_declaration',
    '    - kind: method_declaration',
    '    - kind: type_spec',
  ].join('\n'),
].join('\n---\n')

const RULES_BY_LANG = { js: JS_RULES, go: GO_RULES }

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
const GO_RECV = /^func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)/

const scan = (root, files, lang) => {
  const rules = RULES_BY_LANG[lang]
  const byFile = new Map(files.map(file => [file, { comments: [], symbols: [] }]))
  for (const batch of batches(files)) {
    for (const match of runAstGrepJson(['scan', '--inline-rules', rules, '--json=compact', '--', ...batch], { cwd: root })) {
      const found = byFile.get(relative(root, match.file))
      if (!found) continue
      const { start, end } = match.range.byteOffset
      if (match.ruleId.startsWith('comment-')) {
        found.comments.push({ text: match.text, start, end, line: match.range.start.line, endLine: match.range.end.line })
      } else if (lang === 'go') {
        const name = match.metaVariables.single.NAME.text
        const recv = GO_RECV.exec(match.text)?.[1]
        const isClass = !match.text.startsWith('func')
        found.symbols.push({ name: recv ? `${recv}.${name}` : name, start, end, isClass })
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
const GO_DIRECTIVE = /^(?:go:[a-z]|\+build\b|nolint\b|line\s|#cgo\b|export\s|code generated\b.*do not edit)/i
const JSDOC_TYPE = /@(?:type|typedef|param|arg|argument|returns?|template|callback|property|prop|enum|this|satisfies|implements|extends|augments|overload|import|throws|yields)\b/
const LICENSE = /\b(?:license[ds]?|copyright|spdx-license-identifier)\b|©/i
const DECISION_RECORD = /(?<![\w&])#\d+\b|\badr[ -]?\d{4}\b|docs\/adr\/\d{4}-/i
const EXCUSE_MARKER = /(?<![\p{L}\p{N}_])(?:TODO|FIXME|HACK|XXX)(?![\p{L}\p{N}_])/u
const EXCUSE = /\b(?:hack|workarounds?|for now|upgrade when)\b|\btemporary\b(?!\s+(?:files?|dir(?:ector(?:y|ies))?|folders?|paths?|homes?|repos?|cop(?:y|ies)|names?|worktrees?)\b)|\bshortcut:/i

const isLicenseHeader = (comment, text, blanked) => LICENSE.test(text) && blanked.subarray(0, comment.start).toString('utf8').trim() === ''

// #422: a golint-style package doc comment is the contiguous comment group right above `package <name>` starting with `Package `.
const isGoPackageDoc = (comment, context) => {
  if (context.lang !== 'go') return false
  const afterBlanked = context.blanked.subarray(comment.end).toString('utf8')
  const pkg = /^\s*package\s+([A-Za-z_]\w*)\b/.exec(afterBlanked)
  if (!pkg) return false
  const rawGap = context.bytes.subarray(comment.end, comment.end + pkg[0].length).toString('utf8')
  if (/\r?\n[ \t]*\r?\n/.test(rawGap)) return false
  let firstLine = comment.line
  while (firstLine > 0 && commentOnly(context.lines, context.blankedLines, firstLine - 1)) firstLine -= 1
  return new RegExp(`^Package\\s+${pkg[1]}\\b`).test(normalize(lineOf(context.lines, firstLine).trim()))
}

const notAComment = (comment, text, context) => DIRECTIVE.test(text)
  || (context.lang === 'go' && (GO_DIRECTIVE.test(text) || isGoPackageDoc(comment, context)))
  || (comment.text.startsWith('/**') && JSDOC_TYPE.test(text))
  || isLicenseHeader(comment, text, context.blanked)

const STOP_WORDS = new Set(['the', 'a', 'an', 'this', 'that', 'it', 'its', 'to', 'of', 'value', 'variable', 'by', 'one'])
const GO_DOC_FILLER = new Set(['does', 'do', 'is', 'are', 'function', 'method', 'struct', 'type', 'returns', 'gets', 'sets', 'creates', 'runs', 'handles', 'performs'])
const GO_DECL_NAME = /^(?:func\s+(?:\([^)]*\)\s+)?|type\s+)([A-Za-z_]\w*)\b/
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

const isGoDocTautology = (text, statement) => {
  const decl = GO_DECL_NAME.exec(statement)
  if (!decl) return false
  const nameWords = words(decl[1])
  const all = words(text)
  if (all.length <= nameWords.length || !nameWords.every((w, i) => all[i] === w)) return false
  const nameStems = new Set(nameWords.map(stem))
  const meaningful = all.filter(word => !STOP_WORDS.has(word) && !GO_DOC_FILLER.has(word))
  return meaningful.length >= 1 && meaningful.every(word => nameStems.has(stem(word)))
}

const isTautology = (comment, text, context) => {
  const { lines, blankedLines } = context
  if (!comment.text.startsWith('//') || comment.line !== comment.endLine) return false
  if (lineOf(blankedLines, comment.line).trim() !== '') return false
  if (commentOnly(lines, blankedLines, comment.line - 1) || commentOnly(lines, blankedLines, comment.line + 1)) return false
  const statement = lineOf(blankedLines, comment.line + 1).replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').trim()
  if (statement === '') return false
  if (context.lang === 'go' && isGoDocTautology(text, statement)) return true
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
  if (text === '' || notAComment(comment, text, context)) return undefined
  if (DECISION_RECORD.test(text)) return undefined
  if (EXCUSE_MARKER.test(text) || EXCUSE.test(text)) return { rule: 'comment-excuse', text }
  if (isTautology(comment, text, context)) return { rule: 'comment-tautology', text }
  if (isStale(text, context)) return { rule: 'comment-stale', text }
  return undefined
}

const DECLARATION_GAP = /^(?:\s|export\b|default\b|declare\b|const\b|let\b|var\b|type\b)*$/

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
  const byLang = new Map()
  for (const file of files) {
    const lang = languageOf(file)
    if (!lang || !RULES_BY_LANG[lang]) continue
    const bytes = readSource(path.join(root, file))
    if (bytes === undefined || bytes.subarray(0, 8000).includes(0)) continue
    if (!byLang.has(lang)) byLang.set(lang, new Map())
    byLang.get(lang).set(file, bytes)
  }
  const found = []
  for (const [lang, sources] of byLang) {
    for (const [file, { comments, symbols }] of scan(root, [...sources.keys()], lang)) {
      symbols.sort((a, b) => a.start - b.start)
      const bytes = sources.get(file)
      const blanked = blank(bytes, comments)
      const code = blanked.toString('utf8')
      const context = { lang, bytes, blanked, code, lines: bytes.toString('utf8').split('\n'), blankedLines: code.split('\n') }
      for (const comment of comments.sort((a, b) => a.start - b.start)) {
        const verdict = classify(comment, context)
        if (!verdict) continue
        found.push({ rule: verdict.rule, file, location: locate(comment, symbols, blanked), fingerprint: fingerprint(verdict.text), line: comment.line + 1, endLine: comment.endLine + 1, lang })
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}
