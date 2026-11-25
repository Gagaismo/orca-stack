import path from 'node:path'

const RESOLVE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx']
const TS_SIBLINGS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

export const LANGUAGE_EXTENSIONS = {
  js: new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']),
  go: new Set(['.go']),
  python: new Set(['.py']),
  shell: new Set(['.sh', '.bash']),
}

export const languageOf = file => {
  const ext = path.extname(file).toLowerCase()
  for (const [lang, extensions] of Object.entries(LANGUAGE_EXTENSIONS)) {
    if (extensions.has(ext)) return lang
  }
  return undefined
}

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
