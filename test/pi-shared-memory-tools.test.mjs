// Review finding 1 on PR #307 (#304 rule 4): the read-only tool list of pi review workers must
// let Pi read the shared Engram memory, and only read it.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PI_TOOLS } from '../src/despacho.mjs'

const MEMORY_READ = ['mem_current_project', 'mem_context', 'mem_search', 'mem_get_observation']

test('pi review can search shared memory', () => {
  assert.ok(PI_TOOLS.review.split(',').includes('mem_search'))
})

test('issue 304 rule 4: pi reviews get the Engram read tools and no Engram write tool', () => {
  const tools = PI_TOOLS.review.split(',')
  for (const name of MEMORY_READ) {
    assert.ok(tools.includes(name), `${name} in ${tools}`)
  }
  assert.deepEqual(tools.filter(name => name.startsWith('mem_') && !MEMORY_READ.includes(name)), [])
})
