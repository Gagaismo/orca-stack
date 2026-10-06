import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { homeDir, layout } from './util.mjs'

const BIG_RESULT = 15_000
const NOISE = /^\s*<(task-notification|system-reminder|local-command)/
const cut = (text, max) => {
  const flat = String(text).replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
const textOf = content =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter(i => i?.type === 'text').map(i => i.text ?? '').join('\n') : ''

// One accumulator for every tool: the parsers only say what happened.
const newSession = tool => ({ tool, cwd: '', start: '', end: '', users: [], calls: {}, errors: [], big: [], names: {} })
const stamp = (s, time) => {
  if (typeof time === 'string' && time !== '') {
    s.start = s.start === '' || time < s.start ? time : s.start
    s.end = time > s.end ? time : s.end
  }
}
const user = (s, text) => {
  if (text.trim() !== '' && !NOISE.test(text)) s.users.push(text)
}
const call = (s, id, name) => {
  s.calls[name] = (s.calls[name] ?? 0) + 1
  s.names[id] = name
}
const result = (s, id, text, isError) => {
  const name = s.names[id] ?? '?'
  if (isError) s.errors.push(`${name}: ${cut(text, 200)}`)
  if (text.length > BIG_RESULT) s.big.push(`${name} ${Math.round(text.length / 1000)}k`)
}
const records = text =>
  text.split('\n').flatMap(line => {
    try {
      return line.trim() === '' ? [] : [JSON.parse(line)]
    } catch {
      return []
    }
  })

// Claude Code transcript: user/assistant records; tool calls are tool_use items, results are tool_result items.
export const parseClaude = text => {
  const s = newSession('claude')
  for (const r of records(text)) {
    stamp(s, r.timestamp)
    s.cwd ||= r.cwd ?? ''
    const items = Array.isArray(r.message?.content) ? r.message.content : []
    if (r.type === 'user' && !r.isMeta) user(s, textOf(r.message?.content))
    for (const i of items) {
      if (i?.type === 'tool_use') call(s, i.id, i.name)
      else if (i?.type === 'tool_result') result(s, i.tool_use_id, textOf(i.content), i.is_error === true)
    }
  }

  return s
}

// Pi session: `session` header, then `message` records (toolCall items; toolResult messages with isError).
export const parsePi = text => {
  const s = newSession('pi')
  for (const r of records(text)) {
    stamp(s, r.timestamp)
    if (r.type === 'session') s.cwd = r.cwd ?? ''
    const m = r.type === 'message' ? r.message : undefined
    if (m?.role === 'user') user(s, textOf(m.content))
    else if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const i of m.content) if (i?.type === 'toolCall') call(s, i.id, i.name)
    } else if (m?.role === 'toolResult') result(s, m.toolCallId, textOf(m.content), m.isError === true)
  }

  return s
}

// agy payloads are protobuf: keep the printable ASCII runs. The first step carries `=== TASK ===` and the task text.
export const printable = buffer => (Buffer.from(buffer ?? []).toString('latin1').match(/[\x20-\x7e\n]{6,}/g) ?? []).join('\n')

// rows: [{ idx, step_type, error_details, step_payload }] in order; birth/mtime stand in for the missing timestamps.
export const parseAgy = (rows, birth, mtime) => {
  const s = newSession('agy')
  s.start = birth
  s.end = mtime
  for (const row of rows) {
    const body = printable(row.step_payload)
    const at = body.indexOf('=== TASK ===')
    if (at >= 0) user(s, body.slice(at + 12).split('\n').filter(l => l.trim() !== '').join(' '))
    else s.calls[`paso ${row.step_type}`] = (s.calls[`paso ${row.step_type}`] ?? 0) + 1
    if (row.error_details) s.errors.push(`paso ${row.step_type}: ${cut(printable(row.error_details), 200)}`)
  }

  return s
}

export const format = s => {
  const total = Object.values(s.calls).reduce((a, b) => a + b, 0)
  const top = Object.entries(s.calls).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n} ${c}`).join(', ')
  const when = s => s.slice(0, 16).replace('T', ' ')
  const lines = [`## ${s.tool} · ${s.cwd || '(cwd desconocido)'}`, `${when(s.start)} → ${when(s.end)} · ${total} ${s.tool === 'agy' ? 'pasos' : 'llamadas'}${top ? ` (${top})` : ''}`]
  if (s.users.length) lines.push('usuario:', ...s.users.map(t => `  - ${cut(t, 300)}`))
  if (s.errors.length) lines.push(`errores (${s.errors.length}):`, ...s.errors.map(e => `  - ${e}`))
  if (s.big.length) lines.push(`resultados de más de 15k caracteres: ${s.big.join(', ')}`)

  return lines.join('\n')
}

const walk = (dir, depth) => {
  if (!existsSync(dir)) return []

  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (depth > 0 ? walk(path.join(dir, e.name), depth - 1) : []) : [path.join(dir, e.name)],
  )
}
const since = (files, ext, from) =>
  files.filter(f => f.endsWith(ext)).map(f => ({ f, st: statSync(f) })).filter(({ st }) => st.mtimeMs >= from)

export const listSessions = async ({ home, from, limit, claudeDirs, say = () => {} }) => {
  const L = layout(home)
  const found = []
  for (const dir of claudeDirs) {
    for (const { f } of since(walk(path.join(dir, 'projects'), 1), '.jsonl', from)) found.push(parseClaude(readFileSync(f, 'utf8')))
  }
  const pis = since(walk(path.join(L.piAgent, 'sessions'), 3), '.jsonl', from).map(({ f }) => parsePi(readFileSync(f, 'utf8')))
  // Pi runs through claude-bridge leave a Claude transcript too: same first user message, skip the Claude copy.
  const piFirst = new Set(pis.map(s => s.users[0]).filter(Boolean))
  const all = [...found.filter(s => !piFirst.has(s.users[0])), ...pis]
  const agy = since(walk(path.join(home, '.gemini', 'antigravity-cli', 'conversations'), 0), '.db', from)
  if (agy.length > 0) {
    let sqlite
    try {
      sqlite = await import('node:sqlite')
    } catch {
      say('agy omitido: este Node no trae node:sqlite (hace falta Node 22.13 o más nuevo).')
    }
    for (const { f, st } of sqlite ? agy : []) {
      const db = new sqlite.DatabaseSync(f, { readOnly: true })
      try {
        all.push(parseAgy(db.prepare('select idx, step_type, error_details, step_payload from steps order by idx').all(), st.birthtime.toISOString(), st.mtime.toISOString()))
      } finally {
        db.close()
      }
    }
  }

  return all.filter(s => s.end !== '').sort((a, b) => (a.end < b.end ? 1 : -1)).slice(0, limit)
}

export const sesionesCommand = async flags => {
  const days = new Date(Date.now() - 2 * 86_400_000)
  const from = flags.desde === undefined ? days : new Date(`${flags.desde}T00:00:00`)
  if (Number.isNaN(from.getTime())) throw new Error('--desde necesita una fecha AAAA-MM-DD.')
  const limit = flags.limite === undefined ? 10 : Number(flags.limite)
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limite necesita un número entero positivo.')
  const home = homeDir()
  let extra
  try {
    extra = JSON.parse(readFileSync(layout(home).config, 'utf8').replace(/^﻿/, '')).agentes?.pi?.claudeConfigDir
  } catch {
    extra = undefined
  }
  const dirs = [layout(home).claudeDir, ...(typeof extra === 'string' && extra !== '' ? [extra.replace(/^~(?=$|[\\/])/, home)] : [])]
  const sessions = await listSessions({ home, from: from.getTime(), limit, claudeDirs: dirs, say: console.log })
  console.log(sessions.length === 0 ? 'No hay sesiones en ese rango.' : sessions.map(format).join('\n\n'))

  return 0
}
