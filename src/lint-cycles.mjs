import { createHash } from 'node:crypto'
import path from 'node:path'

import { runAstGrepJson } from './ast-grep.mjs'
import { COMMENT_EXTENSIONS } from './lint-comments.mjs'

export const CYCLE_RULE = 'module-cycle'
const LOCATION = 'cycle'
const LANGUAGES = ['javascript', 'typescript', 'tsx']
const RESOLVE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx']
const TS_SIBLINGS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

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

// #419: Windows caps a command line at 32,767 characters, so file paths go to ast-grep in batches.
const ARG_BUDGET = 24000

export const batches = (files, budget = ARG_BUDGET) => {
  const out = []
  let current = []
  let size = 0
  for (const file of files) {
    if (current.length > 0 && size + file.length + 3 > budget) {
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

export const relative = (root, file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/')

export const resolve = (from, specifier, known) => {
  if (!/^\.\.?(?:\/|$)/.test(specifier)) return undefined
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\/$/, '')
  if (base === '..' || base.startsWith('../')) return undefined
  const index = RESOLVE_EXTENSIONS.map(ext => (base === '.' ? `index${ext}` : `${base}/index${ext}`))
  const extension = path.posix.extname(base)
  const siblings = (TS_SIBLINGS[extension] ?? []).map(sibling => `${base.slice(0, -extension.length)}${sibling}`)
  const candidates = base === '.' ? index : [base, ...siblings, ...RESOLVE_EXTENSIONS.map(ext => `${base}${ext}`), ...index]
  return candidates.find(candidate => known.has(candidate))
}

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

// #420: Tarjan's algorithm without recursion, so a long import chain never overflows the stack.
export const components = graph => {
  const index = new Map()
  const low = new Map()
  const stack = []
  const onStack = new Set()
  const found = []
  let next = 0
  for (const start of graph.keys()) {
    if (index.has(start)) continue
    const work = [[start, 0]]
    index.set(start, next)
    low.set(start, next++)
    stack.push(start)
    onStack.add(start)
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const [node, i] = frame
      const targets = graph.get(node)
      if (i < targets.length) {
        frame[1]++
        const target = targets[i]
        if (!index.has(target)) {
          index.set(target, next)
          low.set(target, next++)
          stack.push(target)
          onStack.add(target)
          work.push([target, 0])
        } else if (onStack.has(target)) {
          low.set(node, Math.min(low.get(node), index.get(target)))
        }
        continue
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1][0]
        low.set(parent, Math.min(low.get(parent), low.get(node)))
      }
      if (low.get(node) !== index.get(node)) continue
      const members = []
      let member
      do {
        member = stack.pop()
        onStack.delete(member)
        members.push(member)
      } while (member !== node)
      if (members.length > 1 || targets.includes(node)) found.push(members.sort())
    }
  }
  return found
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

export const moduleCycles = (root, files) => {
  const sources = files.filter(file => COMMENT_EXTENSIONS.has(path.extname(file).toLowerCase()))
  if (sources.length === 0) return { cycles: [], selfImports: new Set() }
  const graph = importGraph(root, sources)
  const cycles = components(graph)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(members => ({ rule: CYCLE_RULE, file: members[0], location: LOCATION, fingerprint: memberPrint(members), members, walk: closedWalk(graph, members) }))
  const selfImports = new Set([...graph].filter(([file, targets]) => targets.includes(file)).map(([file]) => file))
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
