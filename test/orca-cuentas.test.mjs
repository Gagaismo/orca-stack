import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { pendingAfterSwitch, switchAccount } from '../src/orca.mjs'

// #431: a fake Orca with claude accounts c1..cN (select moves the active one) and an in-memory common dir.
const COMMON = '/repo/.git'
const FILE = path.join(COMMON, 'orca-stack', 'cuentas.json')
const fake = (...ids) => {
  const files = {}
  const selects = []
  let active = ids[0]
  const io = {
    now: () => 1000,
    readFile: file => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`)
      return files[file]
    },
    writeFile: (file, text) => { files[file] = text },
    rename: (from, to) => { files[to] = files[from]; delete files[from] },
    mkdirp: () => {},
    sh: (cmd, args) => {
      if (args[1] === 'select') {
        active = args[args.indexOf('--account') + 1]
        selects.push(active)
      }
      return { status: 0, stdout: JSON.stringify({ ok: true, result: { claude: { accounts: ids.map(id => ({ id })), activeAccountId: active } } }), stderr: '' }
    },
  }
  const episode = () => JSON.parse(files[FILE]).claude

  return { io, selects, episode, files }
}

test('S12: a second switch in the episode keeps the workers still pending from the first', () => {
  const { io, selects } = fake('c1', 'c2', 'c3')
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 7), { line: 'cuenta cambiada: claude c1 → c2' })
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 8), { line: 'cuenta cambiada: claude c1 → c2' })
  assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 7, true), true)
  // #7, relaunched on c2, is cut again: c2 -> c3. #8 still waits for reanudar and resumes on c3.
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 7), { line: 'cuenta cambiada: claude c2 → c3' })
  assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 8), true)
  assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 7), true)
  assert.deepEqual(selects, ['c2', 'c3'])
})

test('S10: the same quota stop reported twice before reanudar does not exhaust the new account', () => {
  const { io, selects, episode } = fake('c1', 'c2')
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 7), { line: 'cuenta cambiada: claude c1 → c2' })
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 7), { line: 'cuenta cambiada: claude c1 → c2' })
  assert.deepEqual(selects, ['c2'])
  assert.deepEqual(episode().exhausted, ['c1'])
  assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 7), true)
  // launchedNow (despachar) still counts as a stop on the active account.
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 9, { launchedNow: true }), {})
  assert.deepEqual(episode().exhausted, ['c1', 'c2'])
})

test('S10: a worker launched on the new account that hits quota after it is exhausted stays blocked', () => {
  const { io, selects, episode } = fake('A', 'B')
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 1), { line: 'cuenta cambiada: claude A → B' })
  assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 1, true), true)
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 1), {})
  // #2 was dispatched normally on B: its stop gets no line toward the exhausted B.
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 2), {})
  assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 2), false)
  assert.deepEqual(selects, ['B'])
  assert.deepEqual(episode().exhausted, ['A', 'B'])
})

test('S10: a pending stop reported again after its target is exhausted gets no line and is no longer pending', () => {
  const { io, selects } = fake('A', 'B')
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 7), { line: 'cuenta cambiada: claude A → B' })
  // despachar's own worker on B hits quota: B is exhausted while #7 still waits for reanudar.
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 9, { launchedNow: true }), {})
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 7), {})
  assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 7), false)
  assert.deepEqual(selects, ['B'])
})

for (const [name, text] of [
  ['a partial record', JSON.stringify({ claude: { at: 1000 } })],
  ['resumed: null', JSON.stringify({ claude: { at: 1000, exhausted: [], resumed: null } })],
  ['resumed as an array', JSON.stringify({ claude: { at: 1000, exhausted: [], resumed: [true] } })],
  ['exhausted as a string', JSON.stringify({ claude: { at: 1000, exhausted: 'B', resumed: {} } })],
  ['at not a number', JSON.stringify({ claude: { at: '1000', exhausted: ['A'], resumed: { 5: true } } })],
  ['a top-level array', JSON.stringify([{ at: 1000 }])],
  ['a top-level string', JSON.stringify('claude')],
]) {
  test(`S11: a malformed cuentas.json (${name}) starts a fresh episode instead of throwing`, () => {
    const { io, selects, episode, files } = fake('A', 'B')
    files[FILE] = text
    assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 5), false)
    assert.deepEqual(switchAccount(io, COMMON, 'claude', 5), { line: 'cuenta cambiada: claude A → B' })
    assert.deepEqual(selects, ['B'])
    assert.deepEqual(episode(), { at: 1000, exhausted: ['A'], resumed: { 5: true }, from: 'A', to: 'B' })
    const saved = JSON.parse(files[FILE])
    assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved))
    if (name.startsWith('a top-level')) assert.deepEqual(Object.keys(saved), ['claude'])
  })
}

test('S10: workers still pending toward an account that became exhausted are not relaunched', () => {
  const { io, selects, episode } = fake('A', 'B')
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 1), { line: 'cuenta cambiada: claude A → B' })
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 2), { line: 'cuenta cambiada: claude A → B' })
  // #3, dispatched on B by despachar, hits quota before reanudar relaunched #1 or #2: no account is left.
  assert.deepEqual(switchAccount(io, COMMON, 'claude', 3, { launchedNow: true }), {})
  const before = JSON.stringify(episode())
  assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 2), false)
  assert.equal(pendingAfterSwitch(io, COMMON, 'claude', 1, true), false)
  assert.equal(JSON.stringify(episode()), before)
  assert.deepEqual(selects, ['B'])
})
