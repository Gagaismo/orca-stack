import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { ROOT, cleanup, cli, tempDir } from './helpers.mjs'

const dirs = []
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop())
})
const doc = file => readFileSync(path.join(ROOT, file), 'utf8')
const help = command => {
  const home = tempDir('perfil-pi-help')
  dirs.push(home)

  return cli(home, [command, '--help']).out
}

describe('#276 Rule 8: docs and help describe the fail-closed pi profile', () => {
  test('README, the setup guide, the manual and the help use opus-sonnet and describe the new behavior', () => {
    const readme = doc('README.md')
    const guide = doc('docs/guia-setup.md')
    const manual = doc('docs/manual.md')
    const texts = { readme, guide, manual, despachar: help('despachar'), revisar: help('revisar'), rebote: help('rebote'), reanudar: help('reanudar') }
    for (const [name, text] of Object.entries(texts)) assert.doesNotMatch(text, /opus-haiku/, name)
    assert.match(readme, /Falta el perfil de Pi: pasá --perfil-pi <nombre>/)
    assert.match(readme, /guardia-despacho: no hay perfil de Pi elegido; preguntale al humano y repetí con --perfil-pi <nombre>\./)
    assert.match(readme, /Perfil `opus-sonnet`/)
    assert.match(guide, /`opus-sonnet`/)
    assert.match(guide, /nunca cae al perfil activo global/)
    assert.match(manual, /--perfil-pi opus-sonnet/)
    assert.match(texts.despachar, /--perfil-pi opus-sonnet/)
    assert.match(texts.despachar, /agentes\.pi\.perfil: "global"/)
    assert.match(texts.despachar, /perfil de Pi: <nombre> \(fuente: flag \| config \|\s+pin \| global\)/)
    assert.match(texts.revisar, /--perfil-pi <nombre>/)
    assert.match(texts.rebote, /sin ninguno se niega como despachar/)
    assert.match(texts.reanudar, /\[--perfil-pi <nombre>\]/)
  })
})
