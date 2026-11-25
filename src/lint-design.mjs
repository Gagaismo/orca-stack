import { createHash } from 'node:crypto'
import path from 'node:path'

import { COMMENT_EXTENSIONS } from './lint-comments.mjs'
import { components } from './lint-graph.mjs'
import { classShape, fieldUses, isInside, symbolGraph } from './lint-symbols.mjs'

export const TANGLE_RULE = 'tangle'
const LEAK_RULE = 'field-leak'
const SHALLOW_RULE = 'shallow-module'
// #421: HELD_IN_MIND and BREAK_EVEN are deslop-please's (src/lint/mod.rs, src/lint/shallow.rs).
const HELD_IN_MIND = 7
const BREAK_EVEN = 1
const INDEX = /^index\.(?:[cm]?[jt]s|[jt]sx)$/

const print = text => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

const tangles = ({ nodes, edges }) => {
  const graph = new Map([...edges].map(([id, targets]) => [id, [...targets].sort()]))
  return components(graph).flatMap(members => {
    const things = members.filter(id => nodes.get(id).thing).sort()
    const modules = new Set(things.map(id => nodes.get(id).file))
    if (modules.size < 2 && things.length <= HELD_IN_MIND) return []
    return [{ rule: TANGLE_RULE, file: nodes.get(things[0]).file, location: 'tangle', fingerprint: print(things.join('\n')), members: things, modules: modules.size }]
  }).sort((a, b) => a.members[0].localeCompare(b.members[0]))
}

// #421: a class guards its fields when a method of its own, not the constructor, uses one that no outsider touches.
const leaks = graph => {
  const uses = fieldUses(graph)
  const found = []
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'class') continue
    const { fields, usedByMethods } = classShape(graph, node.id)
    const outside = uses.filter(use => use.owner === node.id && fields.has(use.field) && !isInside(graph, node.id, use))
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
      found.push({ rule: LEAK_RULE, file: node.file, location, fingerprint: print(location), owner: node.name, places: places.length, modules, kept })
    }
  }
  return found
}

const moduleOf = indexDirs => file => {
  for (let dir = path.posix.dirname(file); ; dir = path.posix.dirname(dir)) {
    if (indexDirs.has(dir)) return dir === '.' ? './' : `${dir}/`
    if (dir === '.') return file
  }
}

const shallowModules = ({ byFile, nodes, users }) => {
  const of = moduleOf(new Set([...byFile.keys()].filter(file => INDEX.test(path.posix.basename(file))).map(file => path.posix.dirname(file))))
  const modules = new Map()
  for (const node of nodes.values()) {
    if (node.kind !== 'function') continue
    const module = of(node.file)
    if (!modules.has(module)) modules.set(module, [])
    modules.get(module).push(node)
  }
  return [...modules].flatMap(([module, functions]) => {
    const shown = functions.filter(node => [...users.get(node.id)].some(file => of(file) !== module)).map(node => node.name).sort()
    const hidden = functions.length - shown.length
    if (shown.length <= HELD_IN_MIND || hidden > shown.length * BREAK_EVEN) return []
    return [{ rule: SHALLOW_RULE, file: module, location: 'module', fingerprint: print(module), shown, hidden }]
  }).sort((a, b) => a.file.localeCompare(b.file))
}

export const designChecks = (root, files) => {
  const sources = files.filter(file => COMMENT_EXTENSIONS.has(path.extname(file).toLowerCase()))
  if (sources.length === 0) return { tangles: [], violations: [] }
  const graph = symbolGraph(root, sources)
  return { tangles: tangles(graph), violations: [...leaks(graph), ...shallowModules(graph)] }
}

export const reportTangle = ({ members, modules }) => `${TANGLE_RULE} ${members.join(', ')}: ${plural(members.length, 'cosa', 'cosas')} en ${plural(modules, 'módulo', 'módulos')} (máximo ${HELD_IN_MIND} cosas en un solo módulo) — ¿cuál es la capa de abstracción buscada? ¿Qué módulo va en qué capa?`

export const DESIGN_REPORT = {
  [LEAK_RULE]: ({ file, location, owner, places, modules, kept }) => `${LEAK_RULE} ${file}:${location}: se trabaja fuera de ${owner} en ${plural(places, 'lugar', 'lugares')} de ${plural(modules.length, 'módulo', 'módulos')} (${modules.join(', ')}; máximo 0), y ${owner} se guarda ${kept.join(', ')} — ¿por qué existe este campo? ¿Cuáles son sus patrones de uso? ¿Se puede esconder detrás de una interfaz angosta?`,
  [SHALLOW_RULE]: ({ file, shown, hidden }) => `${SHALLOW_RULE} ${file}: muestra ${shown.length} de ${shown.length + hidden} funciones (${shown.join(', ')}) y esconde ${hidden} (máximo ${HELD_IN_MIND} mostradas, o más escondidas que mostradas) — ¿por qué existen estas funciones? ¿Cuáles son sus patrones de uso? ¿Se pueden esconder detrás de una interfaz angosta?`,
}
