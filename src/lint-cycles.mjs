import { createHash } from 'node:crypto'

import { runAstGrepJson } from './ast-grep.mjs'
import { goImportGraph } from './lint-go.mjs'
import { batches, components, languageOf, relative, resolve } from './lint-graph.mjs'

export const CYCLE_RULE = 'module-cycle'
const LOCATION = 'cycle'
const LANGUAGES = ['javascript', 'typescript', 'tsx']

const RULES = LANGUAGES.flatMap(language => [
  [
    `id: import-${language}`,
    `language: ${language}`,
    'rule:',
    '  any:',
    '    - kind: import_statement',
    '    - kind: export_statement',
    '  has:',
    '    field: source',
    '    pattern: $SRC',
  ].join('\n'),
  [
    `id: require-${language}`,
    `language: ${language}`,
    'rule:',
    '  pattern: require($SRC)',
    'constraints:',
    '  SRC:',
    '    kind: string',
  ].join('\n'),
]).join('\n---\n')

// #420: `import type` and `export type … from` are erased by TypeScript, so they never form a cycle.
const TYPE_ONLY = /^(?:import|export)\s+type\s+(?!from\b)[\w$*{]/

const importGraph = (root, files) => {
  const known = new Set(files)
  const graph = new Map(files.map(file => [file, new Set()]))
  for (const batch of batches(files)) {
    for (const match of runAstGrepJson(['scan', '--inline-rules', RULES, '--json=compact', '--', ...batch], { cwd: root })) {
      const file = relative(root, match.file)
      if (!graph.has(file) || TYPE_ONLY.test(match.text)) continue
      const target = resolve(file, match.metaVariables.single.SRC.text.slice(1, -1), known)
      if (target !== undefined) graph.get(file).add(target)
    }
  }
  return new Map([...graph].map(([file, targets]) => [file, [...targets].sort()]))
}

const shortestPath = (graph, inside, from, wanted) => {
  const previous = new Map([[from, undefined]])
  const queue = [from]
  while (queue.length > 0) {
    const node = queue.shift()
    for (const target of graph.get(node)) {
      if (!inside.has(target)) continue
      if (wanted(target)) {
        const route = [target]
        for (let step = node; step !== from; step = previous.get(step)) route.unshift(step)
        return route
      }
      if (previous.has(target)) continue
      previous.set(target, node)
      queue.push(target)
    }
  }
  return []
}

// #420: the report walks every member of the component, nearest unvisited member first, and closes at the smallest one.
const closedWalk = (graph, members) => {
  const inside = new Set(members)
  const [start] = members
  const walk = [start]
  const seen = new Set([start])
  while (seen.size < members.length) {
    const route = shortestPath(graph, inside, walk[walk.length - 1], target => !seen.has(target))
    route.forEach(node => seen.add(node))
    walk.push(...route)
  }
  walk.push(...shortestPath(graph, inside, walk[walk.length - 1], target => target === start))
  return walk
}

const memberPrint = members => `sha256:${createHash('sha256').update([...members].sort().join('\n')).digest('hex').slice(0, 16)}`

export const isCycleEntry = entry => entry.rule === CYCLE_RULE

export const validCycleEntry = entry => Array.isArray(entry.members) && entry.members.length > 0
  && entry.members.every(member => typeof member === 'string' && member !== '')

const cyclesOf = (graph, lang) => {
  const cycles = components(graph)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(members => ({ rule: CYCLE_RULE, file: members[0], location: LOCATION, fingerprint: memberPrint(members), members, walk: closedWalk(graph, members), lang }))
  const selfImports = [...graph].filter(([file, targets]) => targets.includes(file)).map(([file]) => file)
  return { cycles, selfImports }
}

export const moduleCycles = (root, files) => {
  const jsFiles = files.filter(file => languageOf(file) === 'js')
  const goFiles = files.filter(file => languageOf(file) === 'go')
  const cycles = []
  const selfImports = new Set()
  const addGraph = (graph, lang) => {
    const found = cyclesOf(graph, lang)
    cycles.push(...found.cycles)
    for (const item of found.selfImports) selfImports.add(item)
  }
  if (jsFiles.length > 0) addGraph(importGraph(root, jsFiles), 'js')
  if (goFiles.length > 0) addGraph(goImportGraph(root, goFiles), 'go')
  cycles.sort((a, b) => a.file.localeCompare(b.file))
  return { cycles, selfImports }
}

// #420: a cycle matches every entry holding all its members, so a shrunken cycle keeps its entry. Per A7 an entry is
// stale only when no current cycle holds two of its members or one that imports itself, even through other modules.
export const matchCycles = ({ cycles, selfImports }, entries) => {
  const covered = cycle => entries.some(entry => cycle.members.every(member => entry.members.includes(member)))
  const alive = entry => entry.members.some(member => selfImports.has(member))
    || cycles.some(cycle => cycle.members.filter(member => entry.members.includes(member)).length >= 2)
  return { unmatched: cycles.filter(cycle => !covered(cycle)), stale: entries.filter(entry => !alive(entry)) }
}

export const cycleEntry = ({ rule, file, location, fingerprint, members }) => ({ rule, file, location, fingerprint, members })

export const reportCycle = cycle => `${CYCLE_RULE} ${cycle.walk.join(' → ')} — dale una dirección a los módulos`
