import path from 'node:path'

import { defaultIo } from './despacho.mjs'
import { startsWithMarker } from './marcas.mjs'
import { getCommonDir, getStackAccount } from './repo.mjs'

export const STORE_REL = ['orca-stack', 'consultas-reportadas.json']
export const CONSULTAS_DEPRECATION = '⚠ orca-stack consultas está deprecado (ADR 0004): los workers le preguntan a main por el buzón del Run. Se saca en la próxima release.'

export const loadReportedConsultas = (storePath, io) => {
  if (!io.exists(storePath)) return new Set()
  try {
    const raw = JSON.parse(io.readFile(storePath))
    if (Array.isArray(raw)) return new Set(raw)
  } catch {}

  return new Set()
}

export const saveReportedConsultas = (storePath, reported, io) => {
  io.mkdirp(path.dirname(storePath))
  io.writeFile(storePath, JSON.stringify([...reported], null, 2) + '\n')
}

export const fetchComments = (item, root, io) => {
  const issueRes = io.sh('gh', ['issue', 'view', String(item), '--json', 'comments'], { cwd: root })
  if (issueRes.status === 0 && issueRes.stdout) {
    try {
      return JSON.parse(issueRes.stdout)?.comments ?? []
    } catch {}
  }
  const prRes = io.sh('gh', ['pr', 'view', String(item), '--json', 'comments'], { cwd: root })
  if (prRes.status === 0 && prRes.stdout) {
    try {
      return JSON.parse(prRes.stdout)?.comments ?? []
    } catch {}
  }

  throw new Error(`No pude leer los comentarios de #${item}: ${(issueRes.stderr || prRes.stderr || issueRes.stdout || prRes.stdout || '').trim()}`)
}

export const isConsultaComment = (comment, stackAccount) => {
  const author = comment?.author?.login?.trim().toLowerCase()
  if (author !== stackAccount) return false

  // A BOM or blank lines before the marker do not hide it (#365); a quoted `> Consulta:` is not one.
  return startsWithMarker(comment?.body, 'Consulta')
}

export const checkConsultas = async (flags = {}, items = [], io = defaultIo()) => {
  const targets = (items || []).map(x => String(x).trim().replace(/^#/, '')).filter(x => /^\d+$/.test(x))
  if (targets.length === 0) return 0

  const { commonDir, root } = getCommonDir(io)
  const storePath = path.join(commonDir, ...STORE_REL)
  const reported = loadReportedConsultas(storePath, io)
  const stackAccount = getStackAccount(io)

  let changed = false
  for (const item of targets) {
    const comments = fetchComments(item, root, io)
    for (const comment of comments) {
      if (!isConsultaComment(comment, stackAccount)) continue
      const commentId = String(comment.id ?? comment.url ?? `${item}:${comment.body}`)
      if (reported.has(commentId)) continue
      reported.add(commentId)
      changed = true
      io.out(`consulta nueva en #${item}`)
    }
  }

  if (changed && !flags.dryRun) {
    saveReportedConsultas(storePath, reported, io)
  }

  return 0
}

export const consultasCommand = async (flags = {}, items = [], io = defaultIo()) => {
  const warn = io.err ?? (message => console.error(message))
  warn(CONSULTAS_DEPRECATION)

  return checkConsultas(flags, items, io)
}
