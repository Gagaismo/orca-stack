import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { main, parseArgs } from '../src/cli.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'
import { cleanup, cli, tempDir } from './helpers.mjs'

const read = rel => readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8')

describe('removal of orca-stack consultas and vigilar --consultas (#467)', () => {
  test('R1: orca-stack consultas fails like any unknown command', async () => {
    const oldLog = console.log
    const oldError = console.error
    let outConsultas = ''
    let outUnknown = ''
    console.log = v => { outConsultas += `${v}\n` }
    console.error = v => { outConsultas += `${v}\n` }
    let codeConsultas
    try {
      codeConsultas = await main(['consultas', '42'])
    } finally {
      console.log = oldLog
      console.error = oldError
    }

    console.log = v => { outUnknown += `${v}\n` }
    console.error = v => { outUnknown += `${v}\n` }
    let codeUnknown
    try {
      codeUnknown = await main(['comando-inexistente', '42'])
    } finally {
      console.log = oldLog
      console.error = oldError
    }

    assert.equal(codeConsultas, 2)
    assert.equal(codeConsultas, codeUnknown)
    assert.match(outConsultas, /^Comando desconocido: consultas\n/)
    assert.equal(
      outConsultas.replace('Comando desconocido: consultas', 'Comando desconocido: <cmd>'),
      outUnknown.replace('Comando desconocido: comando-inexistente', 'Comando desconocido: <cmd>'),
    )
  })

  test('R2: orca-stack vigilar <n> --consultas fails like any unknown option', async () => {
    assert.throws(() => parseArgs(['vigilar', '7', '--consultas']), /^Error: Opción desconocida: --consultas$/)
    assert.throws(() => parseArgs(['vigilar', '7', '--opcion-inexistente']), /^Error: Opción desconocida: --opcion-inexistente$/)

    const oldError = console.error
    let errConsultas = ''
    let errUnknown = ''
    console.error = v => { errConsultas += `${v}\n` }
    let codeConsultas
    try {
      codeConsultas = await main(['vigilar', '7', '--consultas'])
    } finally {
      console.error = oldError
    }

    console.error = v => { errUnknown += `${v}\n` }
    let codeUnknown
    try {
      codeUnknown = await main(['vigilar', '7', '--opcion-inexistente'])
    } finally {
      console.error = oldError
    }

    assert.equal(codeConsultas, 2)
    assert.equal(codeConsultas, codeUnknown)
    assert.match(errConsultas, /^Opción desconocida: --consultas\n/)
    assert.equal(
      errConsultas.replace('--consultas', '<flag>'),
      errUnknown.replace('--opcion-inexistente', '<flag>'),
    )
  })

  test('R3: consultas module, store handling, tests, help and manual references are deleted', () => {
    assert.equal(existsSync(path.join(PACKAGE_ROOT, 'src', 'consultas.mjs')), false)
    assert.equal(existsSync(path.join(PACKAGE_ROOT, 'test', 'consultas.test.mjs')), false)

    const vigilarSrc = read('src/vigilar.mjs')
    assert.doesNotMatch(vigilarSrc, /consultas\.mjs|checkConsultas|--consultas|VIGILAR_CONSULTAS_DEPRECATION/)

    const cliSrc = read('src/cli.mjs')
    assert.doesNotMatch(cliSrc, /consultas\.mjs|consultasCommand|--consultas|consultas-reportadas\.json/)

    const home = tempDir('consultas-removed-help')
    try {
      const rootHelp = cli(home, ['--help'])
      assert.equal(rootHelp.status, 0)
      assert.doesNotMatch(rootHelp.stdout, /^\s+consultas\s/m)
      assert.doesNotMatch(rootHelp.stdout, /--consultas/)
      assert.doesNotMatch(rootHelp.stdout, /\bconsultas\b/)

      const vigilarHelp = cli(home, ['vigilar', '--help'])
      assert.equal(vigilarHelp.status, 0)
      assert.doesNotMatch(vigilarHelp.stdout, /--consultas/)
      assert.doesNotMatch(vigilarHelp.stdout, /orca-stack consultas/)
      assert.match(vigilarHelp.stdout, /consulta #<n> <agente> <message_id>/)
    } finally {
      cleanup(home)
    }

    const manual = read('docs/manual.md')
    assert.doesNotMatch(manual, /#### `consultas`/)
    assert.doesNotMatch(manual, /orca-stack consultas/)
    assert.doesNotMatch(manual, /--consultas/)
    assert.doesNotMatch(manual, /consultas-reportadas\.json/)

    const readme = read('README.md')
    assert.doesNotMatch(readme, /orca-stack consultas/)
    assert.doesNotMatch(readme, /--consultas/)
    assert.doesNotMatch(readme, /consultas-reportadas\.json/)

    const marchas = read('assets/stack/MARCHAS.md')
    assert.doesNotMatch(marchas, /--consultas/)
  })
})
