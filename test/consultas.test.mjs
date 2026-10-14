import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { consultasCommand } from '../src/consultas.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'
import { ROOT, cli, tempDir, cleanup, write } from './helpers.mjs'

const json = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })

const fakeIo = ({
  user = 'stack-bot',
  commonDir = '/repo/.git',
  commentsByNumber = {},
  existingFiles = {},
} = {}) => {
  const files = { ...existingFiles }
  const outputs = []
  return {
    cwd: '/repo',
    home: '/home',
    out: msg => outputs.push(msg),
    outputs,
    files,
    exists: p => p in files,
    readFile: p => {
      if (p in files) return files[p]
      throw new Error(`File not found: ${p}`)
    },
    writeFile: (p, text) => {
      files[p] = text
    },
    mkdirp: () => {},
    sh: (cmd, args) => {
      if (cmd === 'git') {
        if (args.includes('--git-common-dir')) {
          return { status: 0, stdout: `/repo/.git\n${commonDir}\n/repo\n`, stderr: '' }
        }
      }
      if (cmd === 'gh') {
        if (args[0] === 'api' && args[1] === 'user') {
          return json({ login: user })
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          const num = args[2]
          if (commentsByNumber[num] !== undefined) {
            return json({ comments: commentsByNumber[num] })
          }
          return { status: 1, stdout: '', stderr: `issue #${num} not found` }
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          const num = args[2]
          if (commentsByNumber[num] !== undefined) {
            return json({ comments: commentsByNumber[num] })
          }
          return { status: 1, stdout: '', stderr: `PR #${num} not found` }
        }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  }
}

describe('orca-stack consultas (issue #165)', () => {
  test('Rule 1: A comment from the stack\'s account, Consulta: claude — ¿uso X o Y?, on in-flight #42: the filter prints consulta nueva en #42 once, and a second run with no new comments prints nothing', async () => {
    const io = fakeIo({
      user: 'stack-account',
      commentsByNumber: {
        '42': [
          { id: 'c1', author: { login: 'stack-account' }, body: 'Consulta: claude — ¿uso X o Y?' },
        ],
      },
    })
    await consultasCommand({}, ['42'], io)
    assert.deepEqual(io.outputs, ['consulta nueva en #42'])

    // Second run with no new comments prints nothing
    io.outputs.length = 0
    await consultasCommand({}, ['42'], io)
    assert.deepEqual(io.outputs, [])
  })

  test('Rule 2: A comment starting with Consulta: from any other account is ignored', async () => {
    const io = fakeIo({
      user: 'stack-account',
      commentsByNumber: {
        '42': [
          { id: 'c1', author: { login: 'stranger-user' }, body: 'Consulta: intruder — ¿puedo cambiar algo?' },
        ],
      },
    })
    await consultasCommand({}, ['42'], io)
    assert.deepEqual(io.outputs, [])
  })

  test('Rule 3: A comment from the stack\'s account that does not start with Consulta:, such as Respuesta de main: …, is ignored', async () => {
    const io = fakeIo({
      user: 'stack-account',
      commentsByNumber: {
        '42': [
          { id: 'c1', author: { login: 'stack-account' }, body: 'Respuesta de main: usá X' },
          { id: 'c2', author: { login: 'stack-account' }, body: 'Respuesta del humano: usá Y' },
          { id: 'c3', author: { login: 'stack-account' }, body: 'Nota: todo listo' },
        ],
      },
    })
    await consultasCommand({}, ['42'], io)
    assert.deepEqual(io.outputs, [])
  })

  test('Rule 4: A Consulta: from a relaunched author on PR #57 prints consulta nueva en #57', async () => {
    const io = fakeIo({
      user: 'stack-account',
      commentsByNumber: {
        // Not found on issue view, but found on pr view
        '57': [
          { id: 'c99', author: { login: 'stack-account' }, body: 'Consulta: agy — el test CI falló por timeout' },
        ],
      },
    })
    // Simulate issue view failing but PR view succeeding:
    const originalSh = io.sh
    io.sh = (cmd, args) => {
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view' && args[2] === '57') {
        return { status: 1, stdout: '', stderr: 'not an issue' }
      }
      return originalSh(cmd, args)
    }

    await consultasCommand({}, ['57'], io)
    assert.deepEqual(io.outputs, ['consulta nueva en #57'])
  })

  test('Idempotency and storage: reports are recorded in .git/orca-stack/consultas-reportadas.json and multiple items are supported', async () => {
    const storePath = path.join('/repo/.git', 'orca-stack', 'consultas-reportadas.json')
    const io = fakeIo({
      user: 'stack-account',
      commonDir: '/repo/.git',
      commentsByNumber: {
        '42': [
          { id: 'c1', author: { login: 'stack-account' }, body: 'Consulta: claude — pregunta 1' },
          { id: 'c2', author: { login: 'stack-account' }, body: 'Consulta: claude — pregunta 2' },
        ],
        '57': [
          { id: 'c3', author: { login: 'stack-account' }, body: 'Consulta: agy — pregunta 3' },
        ],
      },
    })

    await consultasCommand({}, ['#42', '57'], io)
    assert.deepEqual(io.outputs, [
      'consulta nueva en #42',
      'consulta nueva en #42',
      'consulta nueva en #57',
    ])

    assert.ok(storePath in io.files, 'Storage file must be written in common git dir')
    const stored = JSON.parse(io.files[storePath])
    assert.deepEqual(stored.sort(), ['c1', 'c2', 'c3'].sort())

    // Subsequent run
    io.outputs.length = 0
    await consultasCommand({}, ['42', '57'], io)
    assert.deepEqual(io.outputs, [])
  })

  test('CLI help and USAGE include consultas command', () => {
    const home = tempDir('consultas-help')
    try {
      const help = cli(home, ['consultas', '--help'])
      assert.equal(help.status, 0)
      assert.match(help.out, /orca-stack consultas/i)
      assert.match(help.out, /Consulta:/)

      const usage = cli(home, ['--help'])
      assert.match(usage.out, /consultas\s+Filtra/)
    } finally {
      cleanup(home)
    }
  })

  test('README documents the consultas command', () => {
    const readme = readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8')
    assert.match(readme, /consultas/)
  })
})
