import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'

import { pendingAfterSwitch, switchAccount } from '../src/orca.mjs'

// #431: a fake Orca with claude accounts c1..cN (select moves the active one) and an in-memory common dir.
const COMMON = '/repo/.git'
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
  const episode = () => JSON.parse(files[path.join(COMMON, 'orca-stack', 'cuentas.json')]).claude

  return { io, selects, episode }
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
