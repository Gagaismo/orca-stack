import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import { main } from '../src/cli.mjs'
import { renderBrief } from '../src/despacho.mjs'
import { PACKAGE_ROOT } from '../src/util.mjs'
import { cleanup, cli, tempDir } from './helpers.mjs'

const read = rel => readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8')
const section = (text, heading) => (text.split(`\n${heading}\n`)[1]?.split('\n### ')[0] ?? '').trim()
const MAILBOX_CMD = 'orca orchestration send --to dispatch:<id> --subject "<issue>: reglas cambiadas" --body "<url-del-comentario>"'

describe('removal of orca-stack avisar (#384)', () => {
  test('R1: orca-stack avisar fails like any unknown command and its module, help and tests are gone', async () => {
    const oldLog = console.log
    const oldError = console.error
    let outAvisar = ''
    let outUnknown = ''
    console.log = v => { outAvisar += `${v}\n` }
    console.error = v => { outAvisar += `${v}\n` }
    let codeAvisar
    try {
      codeAvisar = await main(['avisar', '12', 'https://github.com/Gagaismo/orca-stack/issues/12#issuecomment-1'])
    } finally {
      console.log = oldLog
      console.error = oldError
    }

    console.log = v => { outUnknown += `${v}\n` }
    console.error = v => { outUnknown += `${v}\n` }
    let codeUnknown
    try {
      codeUnknown = await main(['comando-inexistente', '12', 'https://github.com/Gagaismo/orca-stack/issues/12#issuecomment-1'])
    } finally {
      console.log = oldLog
      console.error = oldError
    }

    assert.equal(codeAvisar, 2)
    assert.equal(codeAvisar, codeUnknown)
    assert.match(outAvisar, /^Comando desconocido: avisar\n/)
    assert.equal(
      outAvisar.replace('Comando desconocido: avisar', 'Comando desconocido: <cmd>'),
      outUnknown.replace('Comando desconocido: comando-inexistente', 'Comando desconocido: <cmd>'),
    )

    assert.equal(existsSync(path.join(PACKAGE_ROOT, 'src', 'avisar.mjs')), false)
    assert.equal(existsSync(path.join(PACKAGE_ROOT, 'test', 'avisar.test.mjs')), false)

    const cliSrc = read('src/cli.mjs')
    assert.doesNotMatch(cliSrc, /avisar\.mjs|avisarCommand|case 'avisar'/)

    const home = tempDir('avisar-removed-help')
    try {
      const rootHelp = cli(home, ['--help'])
      assert.equal(rootHelp.status, 0)
      assert.doesNotMatch(rootHelp.stdout, /^\s+avisar\s/m)
      assert.doesNotMatch(rootHelp.stdout, /\bavisar\b/)
    } finally {
      cleanup(home)
    }
  })

  test('R2: contract, MAIN.md Despacho, briefs, manual and README send rule changes through the Run mailbox without naming avisar', () => {
    const contract = read('assets/stack/CONTRATO.md')
    const agents = read('AGENTS.md')
    const mainDoc = read('assets/stack/MAIN.md')
    const despacho = section(mainDoc, '### Despacho')
    const manual = read('docs/manual.md')
    const readme = read('README.md')

    for (const [name, text] of [['CONTRATO.md', contract], ['AGENTS.md', agents], ['MAIN.md Despacho', despacho]]) {
      assert.ok(text.includes(MAILBOX_CMD), `${name} must include the Run mailbox send command`)
      assert.doesNotMatch(text, /\bavisar\b/i, `${name} must not mention avisar`)
    }

    for (const briefFile of ['assets/stack/brief-ticket.md', 'assets/stack/brief-rebote.md', 'assets/stack/brief-rdd.md']) {
      const text = read(briefFile)
      assert.ok(text.includes('reglas cambiadas'), `${briefFile} must describe the reglas cambiadas Run mailbox message`)
      assert.doesNotMatch(text, /\bavisar\b/i, `${briefFile} must not mention avisar`)
    }

    const rendered = renderBrief('ticket', { AGENT: 'agy', ISSUE: '384', REPO: 'orca-stack', BASE: 'main', BRANCH: 'branch' })
    assert.ok(rendered.includes('reglas cambiadas'))
    assert.doesNotMatch(rendered, /\bavisar\b/i)

    const manualBody = manual.split('## 7. Qué hay solo en `main`')[0]
    assert.doesNotMatch(manualBody, /#### `avisar`/)
    assert.doesNotMatch(manualBody, /orca-stack avisar/)
    assert.doesNotMatch(readme, /orca-stack avisar/)
    assert.doesNotMatch(readme, /\bavisar 42\b/)
    assert.doesNotMatch(readme, /- `avisar /)
  })

  test('R4: manual section 7 notes that avisar was removed and how rule changes are delivered now', () => {
    const manual = read('docs/manual.md')
    const sec7 = manual.split('## 7. Qué hay solo en `main`')[1] ?? ''
    assert.match(sec7, /avisar/i)
    assert.ok(sec7.includes(MAILBOX_CMD))
  })

  test('PRESERVE: CLI main still routes other commands and rejects unknown ones', async () => {
    const oldLog = console.log
    const oldError = console.error
    let out = ''
    console.log = v => { out += `${v}\n` }
    console.error = v => { out += `${v}\n` }
    try {
      assert.equal(await main(['--version']), 0)
      assert.match(out.trim(), /^\d+\.\d+\.\d+/)
      out = ''
      assert.equal(await main(['--help']), 0)
      assert.match(out, /\n  reanudar\s+/)
      assert.match(out, /\n  vigilar\s+/)
      out = ''
      assert.equal(await main(['no-existe']), 2)
      assert.match(out, /^Comando desconocido: no-existe\n/)
    } finally {
      console.log = oldLog
      console.error = oldError
    }
  })
})
