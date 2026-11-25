import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
const isExported = name => /^[A-Z]/.test(name)

const DEFINITION_RULES = [
  ['package', { all: [{ kind: 'package_clause' }, { has: { kind: 'package_identifier', pattern: '$NAME' } }] }],
  ['import', { kind: 'import_spec' }],
  ['type', { all: [{ kind: 'type_spec' }, { has: { field: 'name', pattern: '$NAME' } }, { inside: { kind: 'type_declaration', inside: { kind: 'source_file' } } }] }],
  ['field', { all: [{ kind: 'field_identifier' }, { inside: { kind: 'field_declaration', field: 'name' } }] }],
  ['func', { all: [{ kind: 'function_declaration' }, { has: { field: 'name', pattern: '$NAME' } }, { inside: { kind: 'source_file' } }] }],
  ['method', { all: [{ kind: 'method_declaration' }, { has: { field: 'name', pattern: '$NAME' } }, { inside: { kind: 'source_file' } }] }],
  ['selector', { all: [
    { kind: 'selector_expression' },
    { has: { field: 'operand', kind: 'identifier', pattern: '$OBJ' } },
    { has: { field: 'field', kind: 'field_identifier', pattern: '$FIELD' } },
  ] }],
  ['qualified', { all: [
    { kind: 'qualified_type' },
    { has: { field: 'package', pattern: '$OBJ' } },
    { has: { field: 'name', pattern: '$FIELD' } },
  ] }],
  ['ref', { any: [{ kind: 'identifier' }, { kind: 'type_identifier' }] }],
  ['param', { all: [{ kind: 'parameter_declaration' }, { inside: { kind: 'parameter_list', inside: { any: [{ kind: 'function_declaration' }, { kind: 'method_declaration' }], field: 'parameters' } } }] }],
  ['short-var', { kind: 'short_var_declaration' }],
  ['var-spec', { kind: 'var_spec' }],
].map(([id, rule]) => JSON.stringify({ id: `${id}:go`, language: 'go', rule })).join('\n---\n')

const GO_ACCESS = { all: [
  { kind: 'selector_expression' },
  { has: { field: 'operand', kind: 'identifier', pattern: '$V' } },
  { has: { field: 'field', kind: 'field_identifier', pattern: '$F' } },
] }

const GO_MUTATION = { all: [GO_ACCESS, { any: [
  { inside: { kind: 'expression_list', inside: { kind: 'assignment_statement', field: 'left' } } },
  { inside: { any: [{ kind: 'index_expression' }, { kind: 'selector_expression' }], field: 'operand', inside: { kind: 'expression_list', inside: { kind: 'assignment_statement', field: 'left' } } } },
  { inside: { kind: 'inc_statement' } },
  { inside: { kind: 'dec_statement' } },
] }] }

const MUTATION_RULES = [
  JSON.stringify({ id: 'access:go', language: 'go', rule: GO_ACCESS }),
  JSON.stringify({ id: 'mutation:go', language: 'go', rule: GO_MUTATION }),
].join('\n---\n')

const scan = (root, files, rules) => batches(files, COMMAND_LINE - 2 * rules.length)
  .flatMap(batch => runAstGrepJson(['scan', '--inline-rules', rules, '--json=compact', '--', ...batch], { cwd: root }))

const findGoMod = (root, dir, cache) => {
  if (cache.has(dir)) return cache.get(dir)
  const modFile = dir === '.' ? path.join(root, 'go.mod') : path.join(root, dir, 'go.mod')
  let found
  if (existsSync(modFile)) {
    const match = /^\s*module\s+(?:"([^"]+)"|(\S+))/m.exec(readFileSync(modFile, 'utf8'))
    if (match) found = { modDir: dir, modPath: match[1] ?? match[2] }
  }
  if (!found && dir !== '.') found = findGoMod(root, path.posix.dirname(dir), cache)
  cache.set(dir, found)
  return found
}

const IMPORT_RE = /^(?:([A-Za-z_]\w*|\.)\s+)?["`]([^"`]+)["`]$/
const RECV_RE = /^func\s*\(\s*(?:([A-Za-z_]\w*)\s+)?\*?([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)/
const PARAM_RE = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+\*?([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/
const SHORT_VAR_RE = /^([A-Za-z_]\w*)\s*:=\s*(?:&?\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\{|new\(\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\))/
const VAR_SPEC_RE = /^([A-Za-z_]\w*)\s+(?:\*?([A-Za-z_]\w*)\.([A-Za-z_]\w*)|=\s*(?:&?\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\{|new\(\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\)))/

const emptyFile = file => ({
  file,
  dir: path.posix.dirname(file),
  pkgName: undefined,
  pkgKey: undefined,
  imports: [],
  importMap: new Map(),
  types: [],
  fields: [],
  funcs: [],
  methods: [],
  selectors: [],
  refs: [],
  bindings: [],
})

const collectGo = (root, files) => {
  const byFile = new Map(files.map(file => [file, emptyFile(file)]))
  for (const match of scan(root, files, DEFINITION_RULES)) {
    const facts = byFile.get(relative(root, match.file))
    if (!facts) continue
    const kind = match.ruleId.split(':')[0]
    const name = match.metaVariables?.single?.NAME?.text
    const at = span(match)
    if (kind === 'package') facts.pkgName = name
    else if (kind === 'import') {
      const parsed = IMPORT_RE.exec(match.text.trim())
      if (parsed) facts.imports.push({ alias: parsed[1], path: parsed[2], ...at })
    } else if (kind === 'type') {
      const isStruct = /\bstruct\s*\{/.test(match.text)
      facts.types.push({ kind: isStruct ? 'struct' : 'type', name, ...at })
    } else if (kind === 'field') facts.fields.push({ name: match.text, ...at })
    else if (kind === 'func') facts.funcs.push({ name, ...at })
    else if (kind === 'method') {
      const recv = RECV_RE.exec(match.text)
      if (recv) facts.methods.push({ recvVar: recv[1], recvType: recv[2], name, ...at })
    } else if (kind === 'selector' || kind === 'qualified') {
      facts.selectors.push({ obj: match.metaVariables.single.OBJ.text, field: match.metaVariables.single.FIELD.text, ...at })
    } else if (kind === 'ref') facts.refs.push({ name: match.text, ...at })
    else if (kind === 'param') {
      const parsed = PARAM_RE.exec(match.text.trim())
      if (parsed) {
        for (const varName of parsed[1].split(',').map(part => part.trim())) {
          facts.bindings.push({ varName, pkgAlias: parsed[2], typeName: parsed[3], ...at })
        }
      }
    } else if (kind === 'short-var') {
      const parsed = SHORT_VAR_RE.exec(match.text.trim())
      if (parsed) facts.bindings.push({ varName: parsed[1], pkgAlias: parsed[2] ?? parsed[4], typeName: parsed[3] ?? parsed[5], ...at })
    } else if (kind === 'var-spec') {
      const parsed = VAR_SPEC_RE.exec(match.text.trim())
      if (parsed) facts.bindings.push({ varName: parsed[1], pkgAlias: parsed[2] ?? parsed[4] ?? parsed[6], typeName: parsed[3] ?? parsed[5] ?? parsed[7], ...at })
    }
  }

  // #422: external test packages (`package foo_test`) live in the same dir as `package foo` without forming a self-cycle.
  const pkgByDir = new Map()
  for (const facts of byFile.values()) {
    const isExtTest = facts.file.endsWith('_test.go') && facts.pkgName?.endsWith('_test')
    facts.pkgKey = isExtTest ? `${facts.dir} [${facts.pkgName}]` : facts.dir
    if (!isExtTest && !pkgByDir.has(facts.dir)) pkgByDir.set(facts.dir, { pkgKey: facts.dir, pkgName: facts.pkgName ?? path.posix.basename(facts.dir) })
  }

  const modCache = new Map()
  const resolveImport = (facts, importPath) => {
    const mod = findGoMod(root, facts.dir, modCache)
    if (!mod) return undefined
    let targetDir
    if (importPath === mod.modPath) targetDir = mod.modDir
    else if (importPath.startsWith(`${mod.modPath}/`)) {
      const sub = importPath.slice(mod.modPath.length + 1)
      targetDir = mod.modDir === '.' ? sub : `${mod.modDir}/${sub}`
    } else return undefined
    return pkgByDir.get(targetDir)
  }

  for (const facts of byFile.values()) {
    for (const imp of facts.imports) {
      const target = resolveImport(facts, imp.path)
      if (!target) continue
      imp.target = target.pkgKey
      if (imp.alias === '_') continue
      const localName = imp.alias && imp.alias !== '.' ? imp.alias : target.pkgName
      facts.importMap.set(localName, target.pkgKey)
    }
  }
  return { byFile, pkgByDir }
}

export const goImportGraph = (root, files) => {
  const { byFile } = collectGo(root, files)
  const graph = new Map()
  for (const facts of byFile.values()) {
    if (!graph.has(facts.pkgKey)) graph.set(facts.pkgKey, new Set())
    for (const imp of facts.imports) {
      if (imp.target !== undefined) graph.get(facts.pkgKey).add(imp.target)
    }
  }
  return new Map([...graph].map(([pkg, targets]) => [pkg, [...targets].sort()]))
}

const buildGoGraph = (root, files) => {
  const { byFile } = collectGo(root, files)
  const nodes = new Map()
  const structFields = new Map()
  const usedByMethods = new Map()

  for (const facts of byFile.values()) {
    for (const type of facts.types) {
      const id = `${facts.pkgKey}:${type.name}`
      if (!nodes.has(id)) nodes.set(id, { id, pkg: facts.pkgKey, file: facts.pkgKey, name: type.name, kind: type.kind, exported: isExported(type.name), thing: true })
      if (type.kind === 'struct') {
        if (!structFields.has(id)) structFields.set(id, new Set())
        for (const field of facts.fields) {
          if (within(field, type)) structFields.get(id).add(field.name)
        }
      }
    }
    for (const fn of facts.funcs) {
      const id = `${facts.pkgKey}:${fn.name}`
      if (!nodes.has(id)) nodes.set(id, { id, pkg: facts.pkgKey, file: facts.pkgKey, name: fn.name, kind: 'function', exported: isExported(fn.name), thing: isExported(fn.name) })
    }
  }

  const edges = new Map([...nodes.keys()].map(id => [id, new Set()]))
  const users = new Map([...nodes.keys()].map(id => [id, new Set()]))

  for (const facts of byFile.values()) {
    const containers = [
      ...facts.types.map(t => ({ id: `${facts.pkgKey}:${t.name}`, start: t.start, end: t.end })),
      ...facts.funcs.map(f => ({ id: `${facts.pkgKey}:${f.name}`, start: f.start, end: f.end })),
      ...facts.methods.map(m => ({ id: `${facts.pkgKey}:${m.recvType}`, start: m.start, end: m.end })),
    ].filter(c => nodes.has(c.id))
    const ownerOf = at => containers.find(c => within(at, c))?.id

    for (const method of facts.methods) {
      const ownerId = `${facts.pkgKey}:${method.recvType}`
      if (!structFields.has(ownerId) || !method.recvVar) continue
      if (!usedByMethods.has(ownerId)) usedByMethods.set(ownerId, new Set())
      for (const sel of facts.selectors) {
        if (sel.obj === method.recvVar && within(sel, method) && structFields.get(ownerId).has(sel.field)) {
          usedByMethods.get(ownerId).add(sel.field)
        }
      }
    }

    const selectorFieldSpans = facts.selectors.map(sel => ({ start: sel.end - sel.field.length, end: sel.end }))
    for (const sel of facts.selectors) {
      const targetPkg = facts.importMap.get(sel.obj)
      if (!targetPkg) continue
      const to = `${targetPkg}:${sel.field}`
      if (!nodes.has(to)) continue
      const from = ownerOf(sel)
      if (from && from !== to) edges.get(from).add(to)
      if (targetPkg !== facts.pkgKey) users.get(to).add(facts.pkgKey)
    }

    for (const ref of facts.refs) {
      if (selectorFieldSpans.some(at => at.start === ref.start && at.end === ref.end)) continue
      const to = `${facts.pkgKey}:${ref.name}`
      if (!nodes.has(to)) continue
      const from = ownerOf(ref)
      if (from && from !== to) edges.get(from).add(to)
    }
  }

  return { root, byFile, nodes, edges, users, structFields, usedByMethods }
}

const goTangles = ({ nodes, edges }) => {
  const graph = new Map([...edges].map(([id, targets]) => [id, [...targets].sort()]))
  return components(graph).flatMap(members => {
    const things = members.filter(id => nodes.get(id).thing).sort()
    const modules = new Set(things.map(id => nodes.get(id).pkg))
    if (modules.size < 2 && things.length <= HELD_IN_MIND) return []
    return [{ rule: TANGLE_RULE, file: nodes.get(things[0]).pkg, location: 'tangle', fingerprint: print(things.join('\n')), members: things, modules: modules.size, lang: 'go' }]
  }).sort((a, b) => a.members[0].localeCompare(b.members[0]))
}

const goLeaks = ({ root, byFile, nodes, structFields, usedByMethods }) => {
  const scopesByFile = new Map()
  for (const facts of byFile.values()) {
    const scopes = [...facts.funcs, ...facts.methods]
    const resolved = []
    for (const b of facts.bindings) {
      const targetPkg = facts.importMap.get(b.pkgAlias)
      if (!targetPkg || targetPkg === facts.pkgKey) continue
      const ownerId = `${targetPkg}:${b.typeName}`
      if (!structFields.has(ownerId)) continue
      const enclosing = scopes.find(s => within(b, s))
      resolved.push({ varName: b.varName, ownerId, scope: enclosing })
    }
    if (resolved.length > 0) scopesByFile.set(facts.file, { pkg: facts.pkgKey, bindings: resolved })
  }
  if (scopesByFile.size === 0) return []

  const outsideByOwner = new Map()
  for (const match of scan(root, [...scopesByFile.keys()].sort(), MUTATION_RULES)) {
    const file = relative(root, match.file)
    const info = scopesByFile.get(file)
    if (!info) continue
    const varName = match.metaVariables.single.V.text
    const field = match.metaVariables.single.F.text
    const at = span(match)
    const binding = info.bindings.find(b => b.varName === varName && (!b.scope || within(at, b.scope)))
    if (!binding) continue
    if (!structFields.get(binding.ownerId).has(field)) continue
    if (!outsideByOwner.has(binding.ownerId)) outsideByOwner.set(binding.ownerId, [])
    outsideByOwner.get(binding.ownerId).push({ pkg: info.pkg, field, mutates: match.ruleId.startsWith('mutation:') })
  }

  const found = []
  for (const [ownerId, fields] of structFields) {
    const node = nodes.get(ownerId)
    const used = usedByMethods.get(ownerId) ?? new Set()
    const outside = outsideByOwner.get(ownerId) ?? []
    const touched = new Set(outside.map(item => item.field))
    const kept = [...used].filter(field => fields.has(field) && !touched.has(field)).sort()
    const worked = new Map()
    for (const use of outside.filter(item => item.mutates && isExported(item.field) && (used.has(item.field) || kept.length > 0))) {
      if (!worked.has(use.field)) worked.set(use.field, [])
      worked.get(use.field).push(use)
    }
    for (const [field, places] of [...worked].sort(([a], [b]) => a.localeCompare(b))) {
      const location = `${node.name}.${field}`
      const modules = [...new Set(places.map(place => place.pkg))].sort()
      found.push({ rule: LEAK_RULE, file: node.pkg, location, fingerprint: print(location), owner: node.name, places: places.length, modules, kept, lang: 'go' })
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.location.localeCompare(b.location))
}

const goShallowModules = ({ nodes, users }) => {
  const modules = new Map()
  for (const node of nodes.values()) {
    if (node.kind !== 'function') continue
    if (!modules.has(node.pkg)) modules.set(node.pkg, [])
    modules.get(node.pkg).push(node)
  }
  return [...modules].flatMap(([pkg, functions]) => {
    const shown = functions.filter(node => [...users.get(node.id)].some(callerPkg => callerPkg !== pkg)).map(node => node.name).sort()
    const hidden = functions.length - shown.length
    if (shown.length <= HELD_IN_MIND || hidden > shown.length * BREAK_EVEN) return []
    return [{ rule: SHALLOW_RULE, file: pkg, location: 'module', fingerprint: print(pkg), shown, hidden, lang: 'go' }]
  }).sort((a, b) => a.file.localeCompare(b.file))
}

export const goDesignChecks = (root, files) => {
  if (files.length === 0) return { tangles: [], violations: [] }
  const graph = buildGoGraph(root, files)
  return { tangles: goTangles(graph), violations: [...goLeaks(graph), ...goShallowModules(graph)] }
}
