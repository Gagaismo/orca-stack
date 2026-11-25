import { readFileSync } from 'node:fs'
import path from 'node:path'

import { runAstGrepJson } from './ast-grep.mjs'
import { batches, relative, resolve } from './lint-graph.mjs'

const GRAMMARS = {
  javascript: { classes: ['class_declaration'], field: ['field_definition', 'property'] },
  typescript: { classes: ['class_declaration', 'abstract_class_declaration'], field: ['public_field_definition', 'name'] },
  tsx: { classes: ['class_declaration', 'abstract_class_declaration'], field: ['public_field_definition', 'name'] },
}
const FUNCTION_VALUES = ['arrow_function', 'function_expression', 'generator_function']
const ASSIGNMENTS = ['assignment_expression', 'augmented_assignment_expression']

const kinds = list => ({ any: list.map(kind => ({ kind })) })
const topLevel = { any: [{ inside: { kind: 'program' } }, { inside: { kind: 'export_statement', inside: { kind: 'program' } } }] }
const named = { has: { field: 'name', pattern: '$NAME' } }
const binding = value => ({ all: [
  { kind: 'variable_declarator' },
  { has: { field: 'name', kind: 'identifier', pattern: '$NAME' } },
  { has: { field: 'value', ...value } },
  { inside: { all: [kinds(['lexical_declaration', 'variable_declaration']), topLevel] } },
] })

const definitionRules = ({ classes, field: [fieldKind, fieldName] }) => ({
  class: { all: [kinds(classes), named, topLevel] },
  function: { all: [kinds(['function_declaration', 'generator_function_declaration']), named, topLevel] },
  'function-binding': binding(kinds(FUNCTION_VALUES)),
  'object-binding': binding({ kind: 'object' }),
  'class-binding': binding({ kind: 'class' }),
  export: { all: [{ kind: 'export_statement' }, { inside: { kind: 'program' } }] },
  import: { all: [{ kind: 'import_statement' }, { inside: { kind: 'program' } }] },
  ref: kinds(['identifier', 'shorthand_property_identifier']),
  field: { all: [{ kind: fieldKind }, { has: { field: fieldName, pattern: '$NAME' } }] },
  method: { all: [{ kind: 'method_definition' }, named, { inside: { kind: 'class_body' } }] },
  this: { all: [{ kind: 'member_expression' }, { has: { field: 'object', kind: 'this' } }, { has: { field: 'property', pattern: '$NAME' } }] },
  new: { all: [
    { kind: 'variable_declarator' },
    { has: { field: 'name', kind: 'identifier', pattern: '$NAME' } },
    { has: { field: 'value', kind: 'new_expression', has: { field: 'constructor', kind: 'identifier', pattern: '$CLASS' } } },
  ] },
})

const access = { all: [
  { kind: 'member_expression' },
  { has: { field: 'object', kind: 'identifier', pattern: '$V' } },
  { has: { field: 'property', kind: 'property_identifier', pattern: '$F' } },
] }

// #421: what counts as working on a field: writing it, or writing, indexing, bumping or calling a method on what it holds.
const mutation = { all: [access, { any: [
  { inside: { ...kinds(ASSIGNMENTS), field: 'left' } },
  { inside: { kind: 'update_expression' } },
  { inside: { kind: 'unary_expression', regex: '^delete\\b' } },
  { inside: { ...kinds(['member_expression', 'subscript_expression']), field: 'object', inside: { ...kinds(ASSIGNMENTS), field: 'left' } } },
  { inside: { ...kinds(['member_expression', 'subscript_expression']), field: 'object', inside: { kind: 'update_expression' } } },
  { inside: { kind: 'member_expression', field: 'object', inside: { kind: 'call_expression', field: 'function' } } },
] }] }

const inline = rules => Object.keys(GRAMMARS).flatMap(language => Object.entries(rules(GRAMMARS[language]))
  .map(([id, rule]) => JSON.stringify({ id: `${id}:${language}`, language, rule }))).join('\n---\n')

// #421: Windows caps a command line at 32,767 characters and escapes every quote of the inline rules, so they eat into the file batch.
const COMMAND_LINE = 30000

const scan = (root, files, rules) => batches(files, COMMAND_LINE - 2 * rules.length).flatMap(batch => runAstGrepJson(['scan', '--inline-rules', rules, '--json=compact', '--', ...batch], { cwd: root }))

const span = match => ({ start: match.range.byteOffset.start, end: match.range.byteOffset.end })
const within = (inner, outer) => outer.start <= inner.start && inner.end <= outer.end
const innermost = (list, at) => list.filter(item => within(at, item)).sort((a, b) => b.start - a.start)[0]

const EXPORT_NAME = /^export\s+default\s+([\w$]+)\s*;?\s*$/
const EXPORT_CLAUSE = /^export\s*(?:type\s*)?\{([^}]*)\}\s*;?\s*$/
const REEXPORT_CLAUSE = /^export\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/
const REEXPORT_ALL = /^export\s*\*\s*from\s*(['"])([^'"]+)\1/
const IMPORT = /^import\s+([\s\S]+?)\s+from\s+(['"])([^'"]+)\2/
const NAMESPACE_MEMBER = /^\s*\.\s*([A-Za-z_$][\w$]*)/

const specifiers = list => list.split(',').map(item => item.trim()).filter(item => item !== '' && !/^type\s/.test(item))
  .map(item => {
    const [name, alias] = item.split(/\s+as\s+/)
    return [name.trim(), (alias ?? name).trim()]
  })

const parseImport = (text, from, known) => {
  const found = IMPORT.exec(text)
  if (!found || /^type\s/.test(found[1])) return []
  const target = resolve(from, found[3], known)
  if (target === undefined) return []
  const clause = found[1].trim()
  const bindings = []
  const namespace = /\*\s*as\s+([\w$]+)/.exec(clause)
  if (namespace) bindings.push({ local: namespace[1], target, namespace: true })
  const named = /\{([^}]*)\}/.exec(clause)
  if (named) for (const [name, local] of specifiers(named[1])) bindings.push({ local, target, name })
  const fallback = /^([\w$]+)\s*(?:,|$)/.exec(clause)
  if (fallback) bindings.push({ local: fallback[1], target, name: 'default' })
  return bindings
}

const fileOf = () => ({ nodes: [], exportSpans: [], exportNames: new Map(), stars: [], imports: new Map(), importSpans: [], refs: [], fields: [], methods: [], thisAccess: [], instances: [] })

const NODE_KINDS = { class: 'class', 'class-binding': 'class', function: 'function', 'function-binding': 'function', 'object-binding': 'object' }

const collect = (root, files) => {
  const known = new Set(files)
  const byFile = new Map(files.map(file => [file, fileOf()]))
  for (const match of scan(root, files, inline(definitionRules))) {
    const file = byFile.get(relative(root, match.file))
    if (!file) continue
    const kind = match.ruleId.split(':')[0]
    const name = match.metaVariables?.single?.NAME?.text
    const at = span(match)
    if (NODE_KINDS[kind]) file.nodes.push({ kind: NODE_KINDS[kind], name, ...at })
    else if (kind === 'export') {
      file.exportSpans.push({ ...at, default: /^export\s+default\b/.test(match.text) })
      const local = EXPORT_NAME.exec(match.text)
      if (local) file.exportNames.set('default', local[1])
      const clause = EXPORT_CLAUSE.exec(match.text)
      if (clause) for (const [inner, outer] of specifiers(clause[1])) file.exportNames.set(outer, inner)
      const from = relative(root, match.file)
      const reexport = REEXPORT_CLAUSE.exec(match.text)
      const reexportTarget = reexport && resolve(from, reexport[3], known)
      if (reexportTarget) for (const [inner, outer] of specifiers(reexport[1])) file.exportNames.set(outer, { target: reexportTarget, name: inner })
      const star = REEXPORT_ALL.exec(match.text)
      const starTarget = star && resolve(from, star[2], known)
      if (starTarget) file.stars.push(starTarget)
    } else if (kind === 'import') {
      file.importSpans.push(at)
      for (const entry of parseImport(match.text, relative(root, match.file), known)) file.imports.set(entry.local, entry)
    } else if (kind === 'ref') file.refs.push({ name: match.text, ...at })
    else if (kind === 'field') file.fields.push({ name, ...at })
    else if (kind === 'method') file.methods.push({ name, ...at })
    else if (kind === 'this') file.thisAccess.push({ name, ...at })
    else if (kind === 'new') file.instances.push({ name, className: match.metaVariables.single.CLASS.text })
  }
  return byFile
}

const buildNodes = byFile => {
  const nodes = new Map()
  for (const [file, facts] of byFile) {
    facts.nodes.sort((a, b) => a.start - b.start)
    for (const node of facts.nodes) {
      const exportSpan = facts.exportSpans.find(outer => within(node, outer))
      if (exportSpan) {
        facts.exportNames.set(node.name, node.name)
        if (exportSpan.default) facts.exportNames.set('default', node.name)
      }
    }
    const exported = new Set([...facts.exportNames.values()].filter(value => typeof value === 'string'))
    for (const node of facts.nodes) {
      const id = `${file}:${node.name}`
      if (nodes.has(id)) continue
      const isExported = exported.has(node.name)
      nodes.set(id, { ...node, id, file, exported: isExported, thing: node.kind !== 'function' || isExported })
    }
  }
  return nodes
}

export const symbolGraph = (root, files) => {
  const byFile = collect(root, files)
  const nodes = buildNodes(byFile)
  const local = (file, name) => (nodes.has(`${file}:${name}`) ? `${file}:${name}` : undefined)
  const exportedNode = (file, name, seen = new Set()) => {
    const facts = byFile.get(file)
    if (!facts || seen.has(`${file}\0${name}`)) return undefined
    seen.add(`${file}\0${name}`)
    const entry = facts.exportNames.get(name)
    if (typeof entry === 'string') return local(file, entry)
    if (entry) return exportedNode(entry.target, entry.name, seen)
    for (const target of facts.stars) {
      const found = exportedNode(target, name, seen)
      if (found !== undefined) return found
    }
    return undefined
  }
  const bytes = new Map()
  const textAfter = (root_, file, end) => {
    if (!bytes.has(file)) bytes.set(file, readFileSync(path.join(root_, file)))
    return bytes.get(file).subarray(end, end + 256).toString('utf8')
  }
  // #421: a name that resolves to nothing known (a package, a dynamic access, a computed import) is skipped, never an error.
  const target = (file, facts, ref) => {
    const binding = facts.imports.get(ref.name)
    if (!binding) return local(file, ref.name)
    if (!binding.namespace) return exportedNode(binding.target, binding.name)
    const member = NAMESPACE_MEMBER.exec(textAfter(root, file, ref.end))
    return member ? exportedNode(binding.target, member[1]) : undefined
  }
  const edges = new Map([...nodes.keys()].map(id => [id, new Set()]))
  const users = new Map([...nodes.keys()].map(id => [id, new Set()]))
  for (const [file, facts] of byFile) {
    const owned = [...nodes.values()].filter(node => node.file === file)
    for (const ref of facts.refs) {
      if (facts.importSpans.some(outer => within(ref, outer))) continue
      const to = target(file, facts, ref)
      if (to === undefined) continue
      const from = owned.find(node => within(ref, node))
      if (from?.id === to) continue
      if (from) edges.get(from.id).add(to)
      if (nodes.get(to).file !== file) users.get(to).add(file)
    }
  }
  const resolveClass = (file, name) => {
    const binding = byFile.get(file).imports.get(name)
    const id = binding ? (binding.namespace ? undefined : exportedNode(binding.target, binding.name)) : local(file, name)
    return id !== undefined && nodes.get(id).kind === 'class' ? id : undefined
  }
  return { root, byFile, nodes, edges, users, resolveClass }
}

// #421: a receiver is known to be an instance of a class only when the same file binds it with `const v = new C()`.
export const fieldUses = ({ root, byFile, resolveClass }) => {
  const instances = new Map()
  for (const [file, facts] of byFile) {
    for (const { name, className } of facts.instances) {
      const id = resolveClass(file, className)
      if (id === undefined) continue
      if (!instances.has(file)) instances.set(file, new Map())
      instances.get(file).set(name, id)
    }
  }
  if (instances.size === 0) return []
  const rules = inline(() => ({ access, mutation }))
  const uses = []
  for (const match of scan(root, [...instances.keys()].sort(), rules)) {
    const file = relative(root, match.file)
    const owner = instances.get(file)?.get(match.metaVariables.single.V.text)
    if (owner === undefined) continue
    uses.push({ file, owner, field: match.metaVariables.single.F.text, mutates: match.ruleId.startsWith('mutation:'), ...span(match) })
  }
  return uses
}

export const classShape = ({ byFile, nodes }, id) => {
  const node = nodes.get(id)
  const facts = byFile.get(node.file)
  const classes = [...nodes.values()].filter(other => other.file === node.file && other.kind === 'class')
  const mine = item => within(item, node) && innermost(classes, item)?.id === id
  const methods = facts.methods.filter(mine)
  const methodNames = new Set(methods.map(method => method.name))
  const access = facts.thisAccess.filter(mine)
  const fields = new Set([...facts.fields.filter(mine), ...access].map(item => item.name).filter(name => !methodNames.has(name)))
  const usedByMethods = new Set(access.filter(item => methods.some(method => method.name !== 'constructor' && within(item, method))).map(item => item.name))
  return { fields, usedByMethods }
}

export const isInside = ({ nodes }, id, use) => use.file === nodes.get(id).file && within(use, nodes.get(id))
