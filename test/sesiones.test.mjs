import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { format, parseAgy, parseClaude, parsePi, printable } from '../src/sesiones.mjs'
import { cleanup, cli, tempDir, write } from './helpers.mjs'

const jsonl = records => records.map(r => JSON.stringify(r)).join('\n') + '\n'
const big = 'x'.repeat(16_000)

const claude = jsonl([
  { type: 'user', timestamp: '2026-10-06T10:00:00Z', cwd: '/repo', message: { role: 'user', content: 'hacé el ticket 5' } },
  {
    type: 'assistant',
    timestamp: '2026-10-06T10:01:00Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
  },
  {
    type: 'user',
    timestamp: '2026-10-06T10:02:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }, { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: big }] }] },
  },
  { type: 'user', timestamp: '2026-10-06T10:03:00Z', message: { role: 'user', content: '<task-notification>done</task-notification>' } },
  { type: 'user', timestamp: '2026-10-06T10:04:00Z', message: { role: 'user', content: [{ type: 'text', text: 'y ahora el 6' }] } },
])

const pi = jsonl([
  { type: 'session', id: 's', timestamp: '2026-10-06T11:00:00Z', cwd: '/repo' },
  { type: 'message', timestamp: '2026-10-06T11:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'hacé el ticket 5' }] } },
  { type: 'message', timestamp: '2026-10-06T11:00:02Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'grep', arguments: {} }, { type: 'text', text: 'hm' }] } },
  { type: 'message', timestamp: '2026-10-06T11:00:03Z', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'grep', isError: true, content: [{ type: 'text', text: 'no such file' }] } },
])

describe('parsers', () => {
  test('parseClaude: cwd, span, user messages without noise, calls, errors and big results', () => {
    const s = parseClaude(claude)
    assert.equal(s.cwd, '/repo')
    assert.equal(s.start, '2026-10-06T10:00:00Z')
    assert.equal(s.end, '2026-10-06T10:04:00Z')
    assert.deepEqual(s.users, ['hacé el ticket 5', 'y ahora el 6'])
    assert.deepEqual(s.calls, { Bash: 1, Read: 1 })
    assert.deepEqual(s.errors, ['Bash: boom'])
    assert.deepEqual(s.big, ['Read 16k'])
  })

  test('parseClaude tolerates a broken line', () => {
    assert.deepEqual(parseClaude('garbage\n{"type":"user","message":{"content":"hola"}}\n').users, ['hola'])
  })

  test('parsePi: header cwd, toolCall items, toolResult errors', () => {
    const s = parsePi(pi)
    assert.equal(s.cwd, '/repo')
    assert.deepEqual(s.users, ['hacé el ticket 5'])
    assert.deepEqual(s.calls, { grep: 1 })
    assert.deepEqual(s.errors, ['grep: no such file'])
  })

  test('parseAgy: task text, steps and errors from the printable runs of the protobuf payloads', () => {
    const task = Buffer.concat([Buffer.from([8, 1, 18]), Buffer.from('=== TASK ===\nRead brief 79\n'), Buffer.from([0, 1])])
    const failure = Buffer.concat([Buffer.from([0]), Buffer.from('target content not found')])
    const rows = [
      { idx: 0, step_type: 14, error_details: null, step_payload: task },
      { idx: 1, step_type: 132, error_details: failure, step_payload: Buffer.from('x') },
      { idx: 2, step_type: 132, error_details: null, step_payload: null },
    ]
    const s = parseAgy(rows, '2026-10-06T05:00:00.000Z', '2026-10-06T05:30:00.000Z')
    assert.deepEqual(s.users, ['Read brief 79'])
    assert.deepEqual(s.calls, { 'paso 132': 2 })
    assert.deepEqual(s.errors, ['paso 132: target content not found'])
    assert.equal(printable(Buffer.from([1, 2, 3])), '')
  })
})

describe('format', () => {
  test('one compact block with the tool, cwd, span, top tools, users, errors and big results', () => {
    const out = format(parseClaude(claude))
    assert.match(out, /^## claude · \/repo\n2026-10-06 10:00 → 2026-10-06 10:04 · 2 llamadas \(Bash 1, Read 1\)\n/)
    assert.match(out, /usuario:\n {2}- hacé el ticket 5\n {2}- y ahora el 6/)
    assert.match(out, /errores \(1\):\n {2}- Bash: boom/)
    assert.match(out, /resultados de más de 15k caracteres: Read 16k/)
  })

  test('user messages are cut to about 300 characters', () => {
    const s = parseClaude(jsonl([{ type: 'user', timestamp: '2026-10-06T10:00:00Z', message: { content: 'a'.repeat(1000) } }]))
    assert.ok(format(s).split('\n').find(l => l.startsWith('  - ')).length < 310)
  })
})

describe('orca-stack sesiones', () => {
  let home
  beforeEach(() => {
    home = tempDir('sesiones')
  })
  afterEach(() => cleanup(home))

  test('lists Claude and Pi sessions, skips the Claude copy of a Pi run, honours --limite', () => {
    write(path.join(home, '.claude', 'projects', 'p1', 'a.jsonl'), claude.replace('ticket 5', 'ticket 4'))
    write(path.join(home, '.claude', 'projects', 'p1', 'bridge.jsonl'), jsonl([{ type: 'user', timestamp: '2026-10-06T11:00:00Z', message: { content: 'hacé el ticket 5' } }]))
    write(path.join(home, '.pi', 'agent', 'sessions', '--x--', 's.jsonl'), pi)
    write(path.join(home, 'otra', 'projects', 'p', 'b.jsonl'), jsonl([{ type: 'user', timestamp: '2026-10-06T12:00:00Z', cwd: '/otra', message: { content: 'cuenta de pi' } }]))
    write(path.join(home, '.orca-stack', 'config.json'), JSON.stringify({ agentes: { pi: { claudeConfigDir: path.join(home, 'otra') } } }))
    const all = cli(home, ['sesiones', '--desde', '2020-01-01'])
    assert.equal(all.status, 0, all.out)
    assert.equal((all.out.match(/^## /gm) ?? []).length, 3)
    assert.match(all.out, /## pi · \/repo/)
    assert.match(all.out, /## claude · \/otra/)
    assert.equal((all.out.match(/hacé el ticket 5/g) ?? []).length, 1, 'the Pi session only, not its bridge copy')
    assert.equal((all.out.match(/hacé el ticket 4/g) ?? []).length, 1)
    const one = cli(home, ['sesiones', '--desde=2020-01-01', '--limite', '1'])
    assert.equal((one.out.match(/^## /gm) ?? []).length, 1)
    assert.match(one.out, /## claude · \/otra/, 'newest first')
  })

  test('the default window is the last two days; bad flags fail', () => {
    const file = path.join(home, '.claude', 'projects', 'p1', 'a.jsonl')
    write(file, claude)
    assert.match(cli(home, ['sesiones']).out, /## claude · \/repo/)
    const old = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(file, old, old)
    assert.match(cli(home, ['sesiones']).out, /No hay sesiones en ese rango/)
    assert.equal(cli(home, ['sesiones', '--desde', 'ayer']).status, 1)
    assert.equal(cli(home, ['sesiones', '--limite', '0']).status, 1)
  })
})
