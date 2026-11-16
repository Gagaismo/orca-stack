import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { orderBlockers, registryPath, reserve } from '../src/migraciones.mjs'
import { cleanup, tempDir, write } from './helpers.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const okRes = stdout => ({ status: 0, stdout, stderr: '' })
const fail = stderr => ({ status: 1, stdout: '', stderr })
const CONFIG = { migraciones: { glob: 'db/migrations/*.sql', numero: '^(\\d+)_' } }

let commonDir
// origin/main holds `baseFiles`; issues not in `states` are open; `prs` answers gh pr list --state all.
const fakeIo = ({ baseFiles = ['db/migrations/00011_users.sql', 'db/migrations/00012_roles.sql'], states = {}, prs = [], lsTree } = {}) => {
  const calls = []
  const io = {
    now: () => Date.parse('2026-11-15T12:00:00Z'),
    exists: existsSync,
    readFile: file => readFileSync(file, 'utf8'),
    writeFile: (file, text) => write(file, text),
    mkdirp: () => {},
    rename: renameSync,
    sh: (cmd, args) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'git' && args[0] === 'ls-tree') return lsTree ?? okRes(baseFiles.map(file => `${file}\n`).join(''))
      if (cmd === 'gh' && args[0] === 'issue') return json({ state: states[args[2]] ?? 'OPEN' })
      if (cmd === 'gh' && args[0] === 'pr') return json(prs)
      return fail(`unexpected call: ${cmd} ${args.join(' ')}`)
    },
  }

  return { io, calls }
}
const reserveFor = (issue, env, extra = {}) => reserve({ issue, config: CONFIG, base: 'main', commonDir, root: commonDir, io: env.io, ...extra })
const saved = () => JSON.parse(readFileSync(registryPath(commonDir), 'utf8')).reservas

describe('main-autonomo-2 S2: the migration reservation registry', () => {
  before(() => {
    commonDir = tempDir('migraciones')
  })
  after(() => cleanup(commonDir))

  test('S2: next = highest on origin/main + 1, padded to its width, written to <common dir>/orca-stack/migraciones.json', () => {
    const env = fakeIo()
    assert.deepEqual(reserveFor('7', env), { numero: 13, texto: '00013', reused: false })
    assert.equal(registryPath(commonDir), path.join(commonDir, 'orca-stack', 'migraciones.json'))
    assert.deepEqual(saved(), { 7: { numero: 13, texto: '00013', at: '2026-11-15T12:00:00.000Z' } })
    assert.ok(env.calls.includes('git ls-tree -r --name-only origin/main -- db/migrations'))
    assert.ok(!existsSync(`${registryPath(commonDir)}.${process.pid}.tmp`))
  })

  test('S2: a second issue goes above the open reservation, not above the base only', () => {
    assert.deepEqual(reserveFor('8', fakeIo()), { numero: 14, texto: '00014', reused: false })
  })

  test('S2 negative: reserving again for the same issue keeps its first number and changes nothing', () => {
    const before = readFileSync(registryPath(commonDir), 'utf8')
    const env = fakeIo()
    assert.deepEqual(reserveFor('7', env), { numero: 13, texto: '00013', reused: true })
    assert.equal(readFileSync(registryPath(commonDir), 'utf8'), before)
    assert.ok(!env.calls.some(call => call.startsWith('git ls-tree')))
  })

  test('S2 negative: dryRun computes the number and writes nothing', () => {
    const before = readFileSync(registryPath(commonDir), 'utf8')
    assert.deepEqual(reserveFor('9', fakeIo(), { dryRun: true }), { numero: 15, texto: '00015', reused: false })
    assert.equal(readFileSync(registryPath(commonDir), 'utf8'), before)
  })

  test('S2 negative: a closed issue and an issue whose PRs are all merged or closed are released; a failed gh keeps it', () => {
    write(registryPath(commonDir), JSON.stringify({ reservas: { 7: { numero: 13, texto: '00013' }, 8: { numero: 14, texto: '00014' }, 10: { numero: 15, texto: '00015' } } }))
    const env = fakeIo({ states: { 7: 'CLOSED' }, prs: [{ number: 40, state: 'MERGED', body: 'Closes #8' }, { number: 41, state: 'CLOSED', body: 'fixes #10' }, { number: 42, state: 'OPEN', body: 'Closes #10' }] })
    assert.deepEqual(reserveFor('11', env), { numero: 16, texto: '00016', reused: false })
    assert.deepEqual(Object.keys(saved()).sort(), ['10', '11'])

    const blind = fakeIo()
    blind.io.sh = (cmd, args) => (cmd === 'gh' ? fail('gh: HTTP 502') : okRes('db/migrations/00012_roles.sql\n'))
    assert.deepEqual(reserveFor('12', blind), { numero: 17, texto: '00017', reused: false })
    assert.deepEqual(Object.keys(saved()).sort(), ['10', '11', '12'])
  })

  test('S2: without migraciones nothing is reserved; an unreadable registry or base listing refuses', () => {
    cleanup(path.join(commonDir, 'orca-stack'))
    assert.equal(reserve({ issue: '7', config: {}, base: 'main', commonDir, root: commonDir, io: fakeIo().io }), undefined)
    assert.equal(existsSync(registryPath(commonDir)), false)
    assert.throws(() => reserveFor('7', fakeIo({ lsTree: fail('fatal: Not a valid object name origin/main') })), {
      message: 'No pude leer las migraciones de origin/main para reservar un número: fatal: Not a valid object name origin/main',
    })
    assert.equal(existsSync(registryPath(commonDir)), false)
    write(registryPath(commonDir), '{"reservas": []}')
    assert.throws(() => reserveFor('7', fakeIo()), { message: `No reservo número de migración: no pude leer el registro de migraciones ${registryPath(commonDir)}. Arreglalo o borralo a mano.` })
    assert.equal(readFileSync(registryPath(commonDir), 'utf8'), '{"reservas": []}')
  })

  test('S2: orderBlockers names each other PR or reservation below this PR\'s lowest migration, lowest first', () => {
    const items = orderBlockers({
      mine: { file: 'db/migrations/00015_x.sql', numero: 15 },
      selfIssue: '7',
      selfPr: 70,
      others: [{ number: 70, body: 'Closes #7', added: [1] }, { number: 71, body: 'Closes #8', added: [14] }, { number: 72, body: 'Closes #9', added: [] }, { number: 73, body: '', added: [16] }],
      reservas: { 7: { numero: 2 }, 8: { numero: 13 }, 9: { numero: 12 }, 10: { numero: 11 }, 11: { numero: 20 } },
    })
    assert.deepEqual(items, [
      'migración db/migrations/00015_x.sql (15): esperá el merge de #10 (migración 11 reservada antes)',
      'migración db/migrations/00015_x.sql (15): esperá el merge de #72 (migración 12 reservada antes)',
      'migración db/migrations/00015_x.sql (15): esperá el merge de #71 (migración 13 reservada antes)',
    ])
  })
})
