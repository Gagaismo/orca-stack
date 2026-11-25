import { createHash } from 'node:crypto'
import path from 'node:path'

import { runAstGrepJson } from './ast-grep.mjs'
import { batches, components, relative } from './lint-graph.mjs'

const TANGLE_RULE = 'tangle'
const LEAK_RULE = 'field-leak'
const SHALLOW_RULE = 'shallow-module'
const HELD_IN_MIND = 7
const BREAK_EVEN = 1
const COMMAND_LINE = 30000

const print = text => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
const span = match => ({ start: match.range.byteOffset.start, end: match.range.byteOffset.end })
const within = (inner, outer) => outer.start <= inner.start && inner.end <= outer.end
const innermost = (list, at) => list.filter(item => within(at, item)).sort((a, b) => b.start - a.start)[0]

const TOP_LEVEL = { any: [{ inside: { kind: 'module' } }, { inside: { kind: 'decorated_definition', inside: { kind: 'module' } } }] }
const CLASS_MEMBER = { any: [
  { inside: { kind: 'block', inside: { kind: 'class_definition' } } },
  { inside: { kind: 'decorated_definition', inside: { kind: 'block', inside: { kind: 'class_definition' } } } },
] }

const DEFINITION_RULES = [
  ['import', { kind: 'import_statement' }],
  ['import-from', { kind: 'import_from_statement' }],
  ['class', { all: [{ kind: 'class_definition' }, { has: { field: 'name', pattern: '$NAME' } }, TOP_LEVEL] }],
  ['function', { all: [{ kind: 'function_definition' }, { has: { field: 'name', pattern: '$NAME' } }, TOP_LEVEL] }],
  ['method', { all: [{ kind: 'function_definition' }, { has: { field: 'name', pattern: '$NAME' } }, CLASS_MEMBER] }],
  ['class-field', { all: [
    { kind: 'assignment' },
    { has: { field: 'left', kind: 'identifier', pattern: '$NAME' } },
    { inside: { kind: 'expression_statement', inside: { kind: 'block', inside: { kind: 'class_definition' } } } },
  ] }],
  ['self-attr', { all: [
    { kind: 'attribute' },
    { has: { field: 'object', kind: 'identifier', regex: '^self$' } },
    { has: { field: 'attribute', kind: 'identifier', pattern: '$NAME' } },
  ] }],
  ['attr', { all: [
    { kind: 'attribute' },
    { has: { field: 'object', kind: 'identifier', pattern: '$OBJ' } },
    { has: { field: 'attribute', kind: 'identifier', pattern: '$FIELD' } },
  ] }],
  ['ref', { kind: 'identifier' }],
  ['new', { all: [
    { kind: 'assignment' },
    { has: { field: 'left', kind: 'identifier', pattern: '$NAME' } },
    { has: { field: 'right', kind: 'call', has: { field: 'function', pattern: '$CALLEE' } } },
  ] }],
].map(([id, rule]) => JSON.stringify({ id: `${id}:python`, language: 'python', rule })).join('\n---\n')

const PY_ACCESS = { all: [
  { kind: 'attribute' },
  { has: { field: 'object', kind: 'identifier', pattern: '$V' } },
  { has: { field: 'attribute', kind: 'identifier', pattern: '$F' } },
] }

const PY_MUTATION = { all: [PY_ACCESS, { any: [
  { inside: { any: [{ kind: 'assignment' }, { kind: 'augmented_assignment' }], field: 'left' } },
  { inside: { kind: 'subscript', field: 'value', inside: { any: [{ kind: 'assignment' }, { kind: 'augmented_assignment' }], field: 'left' } } },
  { inside: { kind: 'attribute', field: 'object', inside: { any: [{ kind: 'assignment' }, { kind: 'augmented_assignment' }], field: 'left' } } },
  { inside: { kind: 'delete_statement' } },
  { inside: { kind: 'attribute', field: 'object', inside: { kind: 'call', field: 'function' } } },
] }] }

const MUTATION_RULES = [
  JSON.stringify({ id: 'access:python', language: 'python', rule: PY_ACCESS }),
  JSON.stringify({ id: 'mutation:python', language: 'python', rule: PY_MUTATION }),
].join('\n---\n')

const scan = (root, files, rules) => batches(files, COMMAND_LINE - 2 * rules.length)
  .flatMap(batch => runAstGrepJson(['scan', '--inline-rules', rules, '--json=compact', '--', ...batch], { cwd: root }))

const findPyFile = (base, known) => {
  const clean = base.replace(/^\/+|\/+$/g, '')
  if (clean === '' || clean === '.') return known.has('__init__.py') ? '__init__.py' : undefined
  const candidates = [`${clean}.py`, `${clean}/__init__.py`]
  return candidates.find(candidate => known.has(candidate))
}

const resolveAbsolute = (dotted, known) => {
  const rel = dotted.split('.').filter(Boolean).join('/')
  return findPyFile(rel, known) ?? findPyFile(`src/${rel}`, known)
}

const resolveRelative = (from, dots, dotted, known) => {
  let dir = path.posix.dirname(from)
  for (let i = 1; i < dots; i += 1) {
    if (dir === '.' || dir === '') return undefined
    dir = path.posix.dirname(dir)
  }
  const parts = dotted ? dotted.split('.').filter(Boolean) : []
  const base = dir === '.' ? parts.join('/') : [dir, ...parts].join('/')
  return base === '' ? (known.has('__init__.py') ? '__init__.py' : undefined) : findPyFile(base, known)
}

const cleanClause = text => text.replace(/\\\r?\n/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()

const parseItems = clause => clause.split(',').map(part => part.trim()).filter(Boolean).map(part => {
  const [name, alias] = part.split(/\s+as\s+/)
  return { name: name.trim(), local: (alias ?? name).trim() }
})

const parseImport = (text, from, known) => {
  const flat = cleanClause(text)
  const edges = []
  const bindings = []
  const stars = []
  const plain = /^import\s+(.+)$/.exec(flat)
  if (plain) {
    for (const { name, local } of parseItems(plain[1])) {
      const target = resolveAbsolute(name, known)
      if (!target) continue
      edges.push(target)
      bindings.push({ local: local.split('.')[0], target, namespace: true })
    }
    return { edges, bindings, stars }
  }
  const fromMatch = /^from\s+(\.*)\s*([\w.]*)\s+import\s+(.+)$/.exec(flat)
  if (!fromMatch) return { edges, bindings, stars }
  const dots = fromMatch[1].length
  const mod = fromMatch[2]
  const modTarget = dots > 0 ? resolveRelative(from, dots, mod, known) : (mod ? resolveAbsolute(mod, known) : undefined)
  for (const { name, local } of parseItems(fromMatch[3])) {
    if (name === '*') {
      if (modTarget) {
        edges.push(modTarget)
        stars.push(modTarget)
      }
      continue
    }
    const subDotted = mod ? `${mod}.${name}` : name
    const subTarget = dots > 0 ? resolveRelative(from, dots, subDotted, known) : resolveAbsolute(subDotted, known)
    if (subTarget) {
      edges.push(subTarget)
      bindings.push({ local, target: subTarget, namespace: true })
    } else if (modTarget) {
      edges.push(modTarget)
      bindings.push({ local, target: modTarget, name })
    }
  }
  return { edges, bindings, stars }
}

const emptyFile = () => ({
  nodes: [],
  methods: [],
  fields: [],
  selfAccess: [],
  attrs: [],
  refs: [],
  importEdges: new Set(),
  importSpans: [],
  imports: new Map(),
  stars: [],
  instances: [],
})

const collectPython = (root, files) => {
  const known = new Set(files)
  const byFile = new Map(files.map(file => [file, emptyFile()]))
  for (const match of scan(root, files, DEFINITION_RULES)) {
    const file = relative(root, match.file)
    const facts = byFile.get(file)
    if (!facts) continue
    const kind = match.ruleId.split(':')[0]
    const name = match.metaVariables?.single?.NAME?.text
    const at = span(match)
    if (kind === 'import' || kind === 'import-from') {
      facts.importSpans.push(at)
      const parsed = parseImport(match.text, file, known)
      for (const target of parsed.edges) facts.importEdges.add(target)
      for (const binding of parsed.bindings) facts.imports.set(binding.local, binding)
      facts.stars.push(...parsed.stars)
    } else if (kind === 'class' || kind === 'function') facts.nodes.push({ kind, name, ...at })
    else if (kind === 'method') facts.methods.push({ name, ...at })
    else if (kind === 'class-field') facts.fields.push({ name, ...at })
    else if (kind === 'self-attr') facts.selfAccess.push({ name, ...at })
    else if (kind === 'attr') facts.attrs.push({ obj: match.metaVariables.single.OBJ.text, field: match.metaVariables.single.FIELD.text, ...at })
    else if (kind === 'ref') facts.refs.push({ name: match.text, ...at })
    else if (kind === 'new') facts.instances.push({ name, callee: match.metaVariables.single.CALLEE.text, ...at })
  }
  return byFile
}

export const pythonImportGraph = (root, files) => {
  const byFile = collectPython(root, files)
  return new Map([...byFile].map(([file, facts]) => [file, [...facts.importEdges].sort()]))
}

const buildPythonGraph = (root, files) => {
  const byFile = collectPython(root, files)
  const nodes = new Map()
  for (const [file, facts] of byFile) {
    facts.nodes.sort((a, b) => a.start - b.start)
    for (const node of facts.nodes) {
      const id = `${file}:${node.name}`
      if (nodes.has(id)) continue
      const exported = !node.name.startsWith('_')
      nodes.set(id, { ...node, id, file, exported, thing: node.kind !== 'function' || exported })
    }
  }

  const local = (file, name) => (nodes.has(`${file}:${name}`) ? `${file}:${name}` : undefined)
  const exportedNode = (file, name, seen = new Set()) => {
    const facts = byFile.get(file)
    if (!facts || seen.has(`${file}\0${name}`)) return undefined
    seen.add(`${file}\0${name}`)
    const own = local(file, name)
    if (own) return own
    const imp = facts.imports.get(name)
    if (imp && !imp.namespace) return exportedNode(imp.target, imp.name, seen)
    for (const target of facts.stars) {
      const found = exportedNode(target, name, seen)
      if (found) return found
    }
    return undefined
  }

  const edges = new Map([...nodes.keys()].map(id => [id, new Set()]))
  const users = new Map([...nodes.keys()].map(id => [id, new Set()]))

  for (const [file, facts] of byFile) {
    const owned = [...nodes.values()].filter(node => node.file === file)
    const ownerOf = at => owned.find(node => within(at, node))

    for (const attr of facts.attrs) {
      if (facts.importSpans.some(outer => within(attr, outer))) continue
      const binding = facts.imports.get(attr.obj)
      if (!binding || !binding.namespace) continue
      const to = exportedNode(binding.target, attr.field)
      if (!to) continue
      const from = ownerOf(attr)
      if (from && from.id !== to) edges.get(from.id).add(to)
      if (nodes.get(to).file !== file) users.get(to).add(file)
    }

    for (const ref of facts.refs) {
      if (facts.importSpans.some(outer => within(ref, outer))) continue
      const binding = facts.imports.get(ref.name)
      const to = binding ? (binding.namespace ? undefined : exportedNode(binding.target, binding.name)) : local(file, ref.name)
      if (!to) continue
      const from = ownerOf(ref)
      if (from?.id === to) continue
      if (from) edges.get(from.id).add(to)
      if (nodes.get(to).file !== file) users.get(to).add(file)
    }
  }

  const resolveClass = (file, callee) => {
    const facts = byFile.get(file)
    let id
    if (callee.includes('.')) {
      const [obj, name] = callee.split('.')
      const binding = facts.imports.get(obj)
      if (binding?.namespace) id = exportedNode(binding.target, name)
    } else {
      const binding = facts.imports.get(callee)
      id = binding ? (binding.namespace ? undefined : exportedNode(binding.target, binding.name)) : local(file, callee)
    }
    return id !== undefined && nodes.get(id).kind === 'class' ? id : undefined
  }

  return { root, byFile, nodes, edges, users, resolveClass }
}

const pyTangles = ({ nodes, edges }) => {
  const graph = new Map([...edges].map(([id, targets]) => [id, [...targets].sort()]))
  return components(graph).flatMap(members => {
    const things = members.filter(id => nodes.get(id).thing).sort()
    const modules = new Set(things.map(id => nodes.get(id).file))
    if (modules.size < 2 && things.length <= HELD_IN_MIND) return []
    return [{ rule: TANGLE_RULE, file: nodes.get(things[0]).file, location: 'tangle', fingerprint: print(things.join('\n')), members: things, modules: modules.size, lang: 'python' }]
  }).sort((a, b) => a.members[0].localeCompare(b.members[0]))
}

const pyClassShape = ({ byFile, nodes }, id) => {
  const node = nodes.get(id)
  const facts = byFile.get(node.file)
  const classes = [...nodes.values()].filter(other => other.file === node.file && other.kind === 'class')
  const mine = item => within(item, node) && innermost(classes, item)?.id === id
  const methods = facts.methods.filter(mine)
  const methodNames = new Set(methods.map(method => method.name))
  const access = facts.selfAccess.filter(mine)
  const fields = new Set([...facts.fields.filter(mine), ...access].map(item => item.name).filter(name => !methodNames.has(name)))
  const usedByMethods = new Set(access.filter(item => methods.some(method => method.name !== '__init__' && within(item, method))).map(item => item.name))
  return { fields, usedByMethods }
}

const pyLeaks = graph => {
  const instances = new Map()
  for (const [file, facts] of graph.byFile) {
    for (const { name, callee } of facts.instances) {
      const id = graph.resolveClass(file, callee)
      if (!id) continue
      if (!instances.has(file)) instances.set(file, new Map())
      instances.get(file).set(name, id)
    }
  }
  if (instances.size === 0) return []
  const uses = []
  for (const match of scan(graph.root, [...instances.keys()].sort(), MUTATION_RULES)) {
    const file = relative(graph.root, match.file)
    const owner = instances.get(file)?.get(match.metaVariables.single.V.text)
    if (!owner) continue
    uses.push({ file, owner, field: match.metaVariables.single.F.text, mutates: match.ruleId.startsWith('mutation:'), ...span(match) })
  }

  const found = []
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'class') continue
    const { fields, usedByMethods } = pyClassShape(graph, node.id)
    const outside = uses.filter(use => use.owner === node.id && fields.has(use.field) && !(use.file === node.file && within(use, node)))
    const touched = new Set(outside.map(use => use.field))
    const kept = [...usedByMethods].filter(field => fields.has(field) && !touched.has(field)).sort()
    if (kept.length === 0) continue
    const worked = new Map()
    for (const use of outside.filter(item => item.mutates)) {
      if (!worked.has(use.field)) worked.set(use.field, [])
      worked.get(use.field).push(use)
    }
    for (const [field, places] of [...worked].sort(([a], [b]) => a.localeCompare(b))) {
      const location = `${node.name}.${field}`
      const modules = [...new Set(places.map(place => place.file))].sort()
      found.push({ rule: LEAK_RULE, file: node.file, location, fingerprint: print(location), owner: node.name, places: places.length, modules, kept, lang: 'python' })
    }
  }
  return found
}

const pyModuleOf = initDirs => file => {
  for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
    if (initDirs.has(dir)) return dir === '.' ? './' : `${dir}/`
    if (dir === '.') return file
  }
}

const pyShallowModules = ({ byFile, nodes, users }) => {
  const of = pyModuleOf(new Set([...byFile.keys()].filter(file => path.posix.basename(file) === '__init__.py').map(file => path.posix.dirname(file))))
  const modules = new Map()
  for (const node of nodes.values()) {
    if (node.kind !== 'function') continue
    const mod = of(node.file)
    if (!modules.has(mod)) modules.set(mod, [])
    modules.get(mod).push(node)
  }
  return [...modules].flatMap(([mod, functions]) => {
    const shown = functions.filter(node => [...users.get(node.id)].some(file => of(file) !== mod)).map(node => node.name).sort()
    const hidden = functions.length - shown.length
    if (shown.length <= HELD_IN_MIND || hidden > shown.length * BREAK_EVEN) return []
    return [{ rule: SHALLOW_RULE, file: mod, location: 'module', fingerprint: print(mod), shown, hidden, lang: 'python' }]
  }).sort((a, b) => a.file.localeCompare(b.file))
}

export const pythonDesignChecks = (root, files) => {
  if (files.length === 0) return { tangles: [], violations: [] }
  const graph = buildPythonGraph(root, files)
  return { tangles: pyTangles(graph), violations: [...pyLeaks(graph), ...pyShallowModules(graph)] }
}
