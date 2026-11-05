// Review finding 1 on PR #307 (#304 rule 4): the read-only tool lists of the consult and the pi review workers must
// let Pi read the shared Engram memory, and only read it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { PI_TOOLS } from '../src/despacho.mjs'
import { ROOT } from './helpers.mjs'

const MEMORY_READ = ['mem_current_project', 'mem_context', 'mem_search', 'mem_get_observation']
const consultTools = () => {
  const source = readFileSync(path.join(ROOT, 'mods', 'puente-gentle', 'hooks', 'puente.ts'), 'utf8')

  return source.match(/export const READ_ONLY_TOOLS = '([^']+)'/)[1].split(',')
}

test('pi review can search shared memory', () => {
  assert.ok(PI_TOOLS.review.split(',').includes('mem_search'))
})

test('pi consult can search shared memory', () => {
  assert.ok(consultTools().includes('mem_search'))
})

test('issue 304 rule 4: the consult and pi reviews get the Engram read tools and no Engram write tool', () => {
  for (const tools of [PI_TOOLS.review.split(','), consultTools()]) {
    for (const name of MEMORY_READ) {
      assert.ok(tools.includes(name), `${name} in ${tools}`)
    }
    assert.deepEqual(tools.filter(name => name.startsWith('mem_') && !MEMORY_READ.includes(name)), [])
  }
})
